/**
 * Strategic negotiation augmentations: confidence-based signaling, dimensional
 * focus areas, and targeted question prompts.
 *
 * These utilities layer strategic decision guidance on top of free-form
 * negotiation by examining where dimensional confidence is weakest.
 */

import type { ObservationSummary, MatchNarrative } from "./schema.js";
import { DIMENSION_FLOORS } from "./profile.js";
import type { DimensionKey } from "./scoring.js";

/**
 * Categorised view of confidence levels across all tracked dimensions,
 * used to steer negotiation strategy toward the weakest signal areas.
 */
export interface ConfidenceAnalysis {
  high_confidence: DimensionKey[]; // >= 0.75
  medium_confidence: DimensionKey[]; // >= floor, < 0.75
  low_confidence: DimensionKey[]; // < floor
  uncertain_but_critical: DimensionKey[]; // < floor + 0.1 and in T1/T2
}

// Tier-1 and Tier-2 dimensions where being below the floor is most consequential.
const CRITICAL_DIMENSION_SET: Set<DimensionKey> = new Set([
  "moralEthicalAlignment",
  "familyLifeGoalsAlignment",
  "lifestyleRelationalBeliefs",
  "attachmentType",
]);

const ALL_TRACKED_DIMS: DimensionKey[] = [
  "attachmentType",
  "mbti",
  "zodiac",
  "interests",
  "moralEthicalAlignment",
  "familyLifeGoalsAlignment",
  "lifestyleRelationalBeliefs",
];

// ConfidenceProfile encapsulates the bucketed analysis result and exposes
// derived properties so call sites don't need to re-compute them.
class ConfidenceProfile {
  readonly highTier: DimensionKey[];
  readonly midTier: DimensionKey[];
  readonly lowTier: DimensionKey[];
  readonly nearFloorCritical: DimensionKey[];

  constructor(obs: ObservationSummary) {
    const hi: DimensionKey[] = [];
    const mid: DimensionKey[] = [];
    const low: DimensionKey[] = [];
    const critical: DimensionKey[] = [];

    for (const dim of ALL_TRACKED_DIMS) {
      const confValue = obs[dim].confidence;
      const floorValue = DIMENSION_FLOORS[dim];

      if (confValue >= 0.75) {
        hi.push(dim);
      } else if (confValue >= floorValue) {
        mid.push(dim);
      } else {
        low.push(dim);
        if (
          CRITICAL_DIMENSION_SET.has(dim) &&
          confValue < floorValue + 0.1 &&
          confValue > floorValue * 0.7
        ) {
          critical.push(dim);
        }
      }
    }

    this.highTier = hi;
    this.midTier = mid;
    this.lowTier = low;
    this.nearFloorCritical = critical;
  }

  toAnalysis(): ConfidenceAnalysis {
    return {
      high_confidence: this.highTier,
      medium_confidence: this.midTier,
      low_confidence: this.lowTier,
      uncertain_but_critical: this.nearFloorCritical,
    };
  }
}

/**
 * Bucket each dimension's confidence value into high / medium / low categories
 * and flag any critical dimensions that are near — but still below — their floor.
 */
export function analyzeConfidence(obs: ObservationSummary): ConfidenceAnalysis {
  return new ConfidenceProfile(obs).toAnalysis();
}

/**
 * Compose a strategy guidance string for the current negotiation round,
 * blending phase-based direction with confidence-gap observations.
 */
export function buildNegotiationGuidance(
  round: number,
  ourConfidence: ConfidenceAnalysis,
): string {
  const profile = new ConfidenceProfile(
    // Reconstruct a synthetic profile from the pre-bucketed analysis so the
    // pipeline helpers below can consume a ConfidenceProfile directly.
    // Since the caller already holds a ConfidenceAnalysis we adapt it inline.
    null as never,
  );
  // Override the profile fields with the caller-supplied analysis so we don't
  // need to re-run obs parsing. We use a cast here because the constructor is
  // the canonical path, but guidance composition only needs the bucket arrays.
  const adapted = ourConfidence;

  const phaseBlurb = (() => {
    if (round <= 3) {
      return "**EARLY ROUNDS (1-3):** Focus on moral/ethical alignment, family goals, and lifestyle beliefs. Ask about dealbreakers, life priorities, and relationship expectations.";
    }
    if (round <= 7) {
      return "**MID ROUNDS (4-7):** Explore attachment style, interests, MBTI, and zodiac. Ask about closeness needs, hobbies, personality fit, and communication style.";
    }
    return "**LATE ROUNDS (8-12):** Decision zone. If MVE is met and peer proposes, propose immediately. If not confident, articulate specific remaining uncertainties before declining.";
  })();

  const priorityBlurb =
    adapted.uncertain_but_critical.length > 0
      ? `\n**PRIORITY QUESTIONS:** You're near the threshold on critical dimensions: ${adapted.uncertain_but_critical.join(", ")}. Ask targeted questions to push these above the floor before proposing.`
      : "";

  const riskBlurb =
    round >= 5 && adapted.low_confidence.length > 3
      ? `\n**RISK ASSESSMENT:** Round ${round} with ${adapted.low_confidence.length} dimensions still below floor. Consider whether you can reach MVE by round 12, or if early termination is appropriate.`
      : "";

  return [phaseBlurb, priorityBlurb, riskBlurb].filter(Boolean).join("\n");
}

// Pipeline enrichment functions. Each receives the current narrative and the
// profile, then returns an updated narrative. They are composed via reduce.
type NarrativeEnricher = (
  narrative: MatchNarrative,
  profile: ConfidenceProfile,
) => MatchNarrative;

const enrichStrengths: NarrativeEnricher = (narrative, profile) => ({
  ...narrative,
  strongDims: profile.highTier,
});

const enrichWatchPoints: NarrativeEnricher = (narrative, profile) => ({
  ...narrative,
  weakDims: [
    ...profile.nearFloorCritical,
    ...profile.lowTier,
  ].slice(0, 3),
});

// Identity pass — reserved for future dimensional metadata injection.
const enrichDimensions: NarrativeEnricher = (narrative, _profile) => narrative;

/**
 * Attach dimensional confidence metadata to a base match narrative.
 * The enhanced narrative communicates which dimensions are well-understood
 * and which still carry uncertainty.
 */
export function buildEnhancedNarrative(
  baseNarrative: MatchNarrative,
  ourConfidence: ConfidenceAnalysis,
): MatchNarrative {
  // Reconstruct a ConfidenceProfile-compatible shape from the pre-bucketed analysis
  // so the pipeline enrichers can operate on it without re-parsing obs.
  const syntheticProfile = Object.assign(
    Object.create(ConfidenceProfile.prototype) as ConfidenceProfile,
    {
      highTier: ourConfidence.high_confidence,
      midTier: ourConfidence.medium_confidence,
      lowTier: ourConfidence.low_confidence,
      nearFloorCritical: ourConfidence.uncertain_but_critical,
    },
  );

  const enrichmentPipeline: NarrativeEnricher[] = [
    enrichStrengths,
    enrichWatchPoints,
    enrichDimensions,
  ];

  return enrichmentPipeline.reduce(
    (narrative, fn) => fn(narrative, syntheticProfile),
    baseNarrative,
  );
}

/**
 * Produce a targeted focus prompt for select negotiation rounds (2, 5, 8).
 * Returns null for all other rounds to avoid over-prescribing the agent's approach.
 */
export function generateFocusPrompt(
  round: number,
  analysis: ConfidenceAnalysis,
): string | null {
  if (![2, 5, 8].includes(round)) return null;

  if (round === 2 && analysis.uncertain_but_critical.length > 0) {
    return (
      `[Negotiation Focus] Round ${round}: You're uncertain on ${analysis.uncertain_but_critical.join(", ")}. ` +
      `Consider asking about these areas to inform your proposal decision.`
    );
  }

  if (round === 5 && analysis.low_confidence.length > 2) {
    return (
      `[Negotiation Focus] Round ${round}: Still low confidence on ${analysis.low_confidence.length} dimensions. ` +
      `Focus your questions on the most critical gaps: ${analysis.uncertain_but_critical.slice(0, 2).join(", ")}.`
    );
  }

  if (round === 8) {
    const readyToDecide =
      analysis.low_confidence.length <= 1 && analysis.uncertain_but_critical.length === 0;

    if (readyToDecide) {
      return `[Negotiation Focus] Round ${round}: You have strong confidence across dimensions. If peer proposes, counter-propose immediately. If not, consider proposing next round.`;
    }

    const gapSummary =
      analysis.uncertain_but_critical.length > 0
        ? analysis.uncertain_but_critical.join(", ")
        : analysis.low_confidence.slice(0, 2).join(", ");

    return (
      `[Negotiation Focus] Round ${round}: Final clarity window. You need more signal on ${gapSummary}. ` +
      `Ask directly or accept that you'll propose with partial uncertainty.`
    );
  }

  return null;
}
