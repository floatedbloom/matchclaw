/**
 * Compatibility scoring and candidate selection.
 *
 * Replaces naive random candidate selection with a scoring model that weighs
 * dimensional confidence levels, complementary knowledge gaps, and the risk of
 * hitting a hard constraint mismatch during negotiation.
 */

import type { ObservationSummary, DimensionKey } from "./schema.js";
import { debugLog } from "./config.js";

// Re-export DimensionKey so callers that previously imported it from here
// do not need to change their import paths.
export type { DimensionKey };

/**
 * Result of the pre-flight compatibility check run before negotiation begins.
 * Avoids wasted negotiation rounds by filtering out poor matches early.
 */
export interface CompatibilityPreflight {
  score: number;                             // 0-1; higher means better alignment
  compatible: boolean;                       // Whether negotiation is worth attempting
  alignedDims: DimensionKey[];               // Both agents confident and aligned here
  unknownDims: DimensionKey[];               // Negotiation will explore these
  riskLevel: "low" | "medium" | "high";     // Likelihood of a hard constraint clash
  reason?: string;                           // Explanation when compatible === false
}

/**
 * Record of a completed negotiation, persisted locally to inform future
 * candidate selection via outcome-based learning.
 */
export interface NegotiationOutcome {
  counterKey: string;
  openedAt: string;
  ended_at: string;
  outcome: "matched" | "declined_by_us" | "declined_by_peer" | "expired";
  rounds_completed: number;
  reason?: string;
  // Snapshot of our confidence at negotiation start, used for learning.
  our_confidence_snapshot: Record<DimensionKey, number>;
}

/**
 * Pair of observation summaries passed together through the scoring pipeline.
 */
interface ScoringContext {
  self: ObservationSummary;
  peer: ObservationSummary;
}

// Normalised 0–1 weights for each dimension.
const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  attachmentType: 0.10,
  mbti: 0.10,
  zodiac: 0.05,
  interests: 0.10,
  moralEthicalAlignment: 0.15,
  familyLifeGoalsAlignment: 0.25,
  lifestyleRelationalBeliefs: 0.25,
};

// Per-dimension minimum confidence thresholds (mirrors observation.ts DIMENSION_FLOORS).
const DIMENSION_FLOORS: Record<DimensionKey, number> = {
  attachmentType: 0.50,
  mbti: 0.45,
  zodiac: 0.40,
  interests: 0.50,
  moralEthicalAlignment: 0.55,
  familyLifeGoalsAlignment: 0.60,
  lifestyleRelationalBeliefs: 0.60,
};

// Value-heavy dimensions use a more conservative alignment probability when
// both parties exceed the confidence floor, because mismatches there are
// more consequential.
const CONSERVATIVE_ALIGNMENT_DIMS = new Set<DimensionKey>([
  "moralEthicalAlignment",
  "familyLifeGoalsAlignment",
  "lifestyleRelationalBeliefs",
]);

// Alignment probability constants used in the reduce pipeline.
const PROB_STRONG_STANDARD = 0.85;
const PROB_STRONG_CONSERVATIVE = 0.70;
const PROB_COMPLEMENTARY = 0.65;
const PROB_UNCERTAIN = 0.30;

// Ordered list of dimension keys — drives the reduce pipeline.
const ALL_DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[];

/**
 * Compute a 0-1 compatibility score between two observation profiles.
 *
 * Uses a weighted reduce pipeline over all seven dimensions.  For each
 * dimension the alignment probability is chosen based on whether both, one,
 * or neither party clears the confidence floor.
 */
export function calculateCompatibilityScore(
  ourObs: ObservationSummary,
  theirObs: ObservationSummary,
): number {
  const ctx: ScoringContext = { self: ourObs, peer: theirObs };

  const { weightedSum } = ALL_DIMENSIONS.reduce(
    (acc, dimKey) => {
      const selfConf = ctx.self[dimKey].confidence;
      const peerConf = ctx.peer[dimKey].confidence;
      const floorVal = DIMENSION_FLOORS[dimKey];
      const dimWeight = DIMENSION_WEIGHTS[dimKey];

      const selfClears = selfConf >= floorVal;
      const peerClears = peerConf >= floorVal;

      let alignmentProb: number;
      if (selfClears && peerClears) {
        alignmentProb = CONSERVATIVE_ALIGNMENT_DIMS.has(dimKey)
          ? PROB_STRONG_CONSERVATIVE
          : PROB_STRONG_STANDARD;
      } else if (selfClears || peerClears) {
        // One side confident, one not — complementary discovery opportunity.
        alignmentProb = PROB_COMPLEMENTARY;
      } else {
        // Neither side has reached floor — proceed with caution.
        alignmentProb = PROB_UNCERTAIN;
      }

      return {
        weightedSum: acc.weightedSum + dimWeight * alignmentProb,
      };
    },
    { weightedSum: 0 },
  );

  // Weights already sum to 1.0, so no division needed.
  return weightedSum;
}

/**
 * Run pre-flight compatibility analysis before committing to a negotiation round.
 * Returns a structured result describing alignment, risk, and whether to proceed.
 */
export function preflightCheck(
  ourObs: ObservationSummary,
  theirObs: ObservationSummary,
): CompatibilityPreflight {
  const overallScore = calculateCompatibilityScore(ourObs, theirObs);

  // Partition dimensions into strong vs uncertain using a reduce.
  const { strongDims, uncertainDims } = ALL_DIMENSIONS.reduce(
    (acc, dimKey) => {
      const selfConf = ourObs[dimKey].confidence;
      const peerConf = theirObs[dimKey].confidence;
      const floorVal = DIMENSION_FLOORS[dimKey];

      if (selfConf >= floorVal && peerConf >= floorVal) {
        acc.strongDims.push(dimKey);
      } else {
        acc.uncertainDims.push(dimKey);
      }
      return acc;
    },
    { strongDims: [] as DimensionKey[], uncertainDims: [] as DimensionKey[] },
  );

  // Dealbreaker risk is anchored on the two highest-consequence value dims.
  const moralMinConf = Math.min(
    ourObs.moralEthicalAlignment.confidence,
    theirObs.moralEthicalAlignment.confidence,
  );
  const familyMinConf = Math.min(
    ourObs.familyLifeGoalsAlignment.confidence,
    theirObs.familyLifeGoalsAlignment.confidence,
  );
  const criticalFloor = DIMENSION_FLOORS.moralEthicalAlignment;

  let riskLevel: "low" | "medium" | "high";
  if (moralMinConf < criticalFloor || familyMinConf < criticalFloor) {
    riskLevel = "high";
  } else if (ourObs.gateState !== "confirmed") {
    riskLevel = "medium";
  } else {
    riskLevel = "low";
  }

  // Compatibility threshold set lower than double-lock to allow exploratory matches.
  const isCompatible = overallScore >= 0.55 && riskLevel !== "high";

  let rejectionReason: string | undefined;
  if (!isCompatible) {
    rejectionReason =
      riskLevel === "high"
        ? "Insufficient constraint confidence for safe negotiation"
        : `Low compatibility score: ${overallScore.toFixed(2)}`;
  }

  debugLog("compatibility", "Pre-flight check completed", {
    score: overallScore.toFixed(3),
    compatible: isCompatible,
    alignedDims: strongDims.length,
    unknownDims: uncertainDims.length,
    riskLevel,
  });

  return {
    score: overallScore,
    compatible: isCompatible,
    alignedDims: strongDims,
    unknownDims: uncertainDims,
    riskLevel,
    reason: rejectionReason,
  };
}

/**
 * Score and sort a list of candidates against our observation profile.
 * Returns the full ranked list, highest-scoring first.
 */
export function rankCandidates(
  ourObs: ObservationSummary,
  candidates: Array<{ pubkey: string; observation: ObservationSummary }>,
): Array<{
  pubkey: string;
  observation: ObservationSummary;
  score: number;
  preflight: CompatibilityPreflight;
}> {
  const evaluatedPool = candidates.map((entry) => {
    const flightResult = preflightCheck(ourObs, entry.observation);
    return {
      pubkey: entry.pubkey,
      observation: entry.observation,
      score: flightResult.score,
      preflight: flightResult,
    };
  });

  // Descending order — best matches at the front.
  evaluatedPool.sort((lhs, rhs) => rhs.score - lhs.score);

  return evaluatedPool;
}

/**
 * Pick the single highest-scoring compatible candidate from a pool.
 * Returns null if the pool is empty or every candidate fails the pre-flight check.
 */
export function selectBestCandidate(
  ourObs: ObservationSummary,
  candidates: Array<{ pubkey: string; observation: ObservationSummary }>,
): { pubkey: string; observation: ObservationSummary; score: number } | null {
  if (candidates.length === 0) return null;

  const rankedPool = rankCandidates(ourObs, candidates);
  const passingCandidates = rankedPool.filter((entry) => entry.preflight.compatible);

  if (passingCandidates.length === 0) {
    debugLog("compatibility", "No compatible candidates found", {
      total_candidates: candidates.length,
      all_rejected: true,
    });
    return null;
  }

  const topMatch = passingCandidates[0];
  if (!topMatch) return null;

  debugLog("compatibility", "Best candidate selected", {
    score: topMatch.score.toFixed(3),
    alignedDims: topMatch.preflight.alignedDims.length,
    unknownDims: topMatch.preflight.unknownDims.length,
  });

  return {
    pubkey: topMatch.pubkey,
    observation: topMatch.observation,
    score: topMatch.score,
  };
}
