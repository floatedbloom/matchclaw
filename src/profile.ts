import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentMatchDir } from "./keys.js";
import { EXPIRY_WINDOW_HOURS, debugLog } from "./config.js";
import type { ObservationSummary, DimensionMeta } from "./schema.js";

// Resolve the path to the observation manifest at call time.
function observationFilePath(): string {
  return join(getAgentMatchDir(), "observation.json");
}

// Per-dimension minimum confidence thresholds.
// Weights: attachment 10%, mbti 10%, zodiac 5%, interests 10%, moral 15%, family 25%, lifestyle 25%.
export const DIMENSION_FLOORS = {
  attachmentType: 0.5,
  mbti: 0.45,
  zodiac: 0.4,
  interests: 0.5,
  moralEthicalAlignment: 0.55,
  familyLifeGoalsAlignment: 0.6,
  lifestyleRelationalBeliefs: 0.6,
} as const;

// How long an eligibility computation stays fresh before the bridge should re-synthesise.
export const ELIGIBILITY_FRESHNESS_HOURS = EXPIRY_WINDOW_HOURS;

export async function loadObservation(): Promise<ObservationSummary | null> {
  if (!existsSync(observationFilePath())) return null;
  try {
    const text = await readFile(observationFilePath(), "utf8");
    return JSON.parse(text) as ObservationSummary;
  } catch {
    return null;
  }
}

export async function saveObservation(obs: ObservationSummary): Promise<void> {
  const timestamp = new Date().toISOString();

  // Recompute eligibility and stamp both timestamps before writing.
  const persisted: ObservationSummary = {
    ...obs,
    lastRevised: timestamp,
    eligibilityAt: timestamp,
    poolEligible: isPoolEligible(obs),
  };

  const dir = getAgentMatchDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 });

  await writeFile(observationFilePath(), JSON.stringify(persisted, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

// Check all seven dimensions against their floors — full eligibility gate.
export function isEligible(obs: ObservationSummary): boolean {
  if (obs.gateState === "below_floor") return false;
  if (obs.gateState === "none_observed") return false;

  return (
    obs.attachmentType.confidence >= DIMENSION_FLOORS.attachmentType &&
    obs.mbti.confidence >= DIMENSION_FLOORS.mbti &&
    obs.zodiac.confidence >= DIMENSION_FLOORS.zodiac &&
    obs.interests.confidence >= DIMENSION_FLOORS.interests &&
    obs.moralEthicalAlignment.confidence >= DIMENSION_FLOORS.moralEthicalAlignment &&
    obs.familyLifeGoalsAlignment.confidence >= DIMENSION_FLOORS.familyLifeGoalsAlignment &&
    obs.lifestyleRelationalBeliefs.confidence >= DIMENSION_FLOORS.lifestyleRelationalBeliefs
  );
}

// Pool entry gate: requires the four heaviest-weight dimensions (moral, family, lifestyle, attachment).
export function isPoolEligible(obs: ObservationSummary): boolean {
  if (obs.gateState === "below_floor") return false;
  if (obs.gateState === "none_observed") return false;

  return (
    obs.moralEthicalAlignment.confidence >= DIMENSION_FLOORS.moralEthicalAlignment &&
    obs.familyLifeGoalsAlignment.confidence >= DIMENSION_FLOORS.familyLifeGoalsAlignment &&
    obs.lifestyleRelationalBeliefs.confidence >= DIMENSION_FLOORS.lifestyleRelationalBeliefs &&
    obs.attachmentType.confidence >= DIMENSION_FLOORS.attachmentType
  );
}

// Minimum viable evidence: constraint gate must be confirmed and pool eligibility must pass.
export function isMinimumViable(obs: ObservationSummary): boolean {
  if (obs.gateState !== "confirmed") return false;
  return isPoolEligible(obs);
}

// True when the eligibility timestamp is older than the configured freshness window.
export function isStale(obs: ObservationSummary): boolean {
  const computedMs = new Date(obs.eligibilityAt).getTime();
  return Date.now() - computedMs > ELIGIBILITY_FRESHNESS_HOURS * 60 * 60 * 1000;
}

/** Which synthetic observation template `seedDummyObservation` uses. */
export type DummyObservationPersona = "a" | "b";

function makeDummyDim(conf: number, value?: string, content?: string): DimensionMeta {
  return {
    confidence: conf,
    evidenceCount: 3,
    signalDiversity: "medium",
    ...(value && { value }),
    ...(content && { content }),
  };
}

/**
 * Produce a fully-eligible dummy observation for development or when the observation
 * phase is being skipped intentionally.
 *
 * **`a`** and **`b`** differ in stated traits and narrative text but both clear all
 * confidence floors so they remain pool-eligible and pass `preflightCheck` pairwise.
 */
export function seedDummyObservation(persona: DummyObservationPersona = "a"): ObservationSummary {
  const ts = new Date().toISOString();

  if (persona === "b") {
    return {
      lastRevised: ts,
      eligibilityAt: ts,
      poolEligible: true,
      sessionCount: 5,
      spanDays: 12,
      attachmentType: makeDummyDim(0.62, "Secure"),
      mbti: makeDummyDim(0.52, "ENFP"),
      zodiac: makeDummyDim(0.48, "Libra"),
      interests: makeDummyDim(0.58, undefined, "live music, photography, weekend trips"),
      moralEthicalAlignment: makeDummyDim(0.62, undefined, "kindness, transparency, mutual respect"),
      familyLifeGoalsAlignment: makeDummyDim(0.68, undefined, "long-term partnership, emotional availability, shared adventure"),
      lifestyleRelationalBeliefs: makeDummyDim(0.66, undefined, "affection, space to grow individually, direct communication"),
      gateState: "confirmed",
      intentCategory: "serious",
    };
  }

  return {
    lastRevised: ts,
    eligibilityAt: ts,
    poolEligible: true,
    sessionCount: 3,
    spanDays: 7,
    attachmentType: makeDummyDim(0.6, "Secure"),
    mbti: makeDummyDim(0.5, "INTJ"),
    zodiac: makeDummyDim(0.45, "Aries"),
    interests: makeDummyDim(0.55, undefined, "hiking, cooking, reading"),
    moralEthicalAlignment: makeDummyDim(0.6, undefined, "integrity, honesty, fairness"),
    familyLifeGoalsAlignment: makeDummyDim(0.65, undefined, "partnership, growth, stability"),
    lifestyleRelationalBeliefs: makeDummyDim(0.65, undefined, "balanced independence, open communication"),
    gateState: "confirmed",
    intentCategory: "unclear",
  };
}

// Produce a zeroed-out observation suitable as a starting template.
export function emptyObservation(): ObservationSummary {
  const ts = new Date().toISOString();

  const zeroDim: DimensionMeta = {
    confidence: 0,
    evidenceCount: 0,
    signalDiversity: "low",
  };

  return {
    lastRevised: ts,
    eligibilityAt: ts,
    poolEligible: false,
    sessionCount: 0,
    spanDays: 0,
    attachmentType: { ...zeroDim },
    mbti: { ...zeroDim },
    zodiac: { ...zeroDim },
    interests: { ...zeroDim },
    moralEthicalAlignment: { ...zeroDim },
    familyLifeGoalsAlignment: { ...zeroDim },
    lifestyleRelationalBeliefs: { ...zeroDim },
    gateState: "none_observed",
    intentCategory: "unclear",
  };
}

export function eligibilityReport(obs: ObservationSummary): string {
  const lines: string[] = [];

  // Helper to append a pass/fail line.
  const addCheck = (label: string, passed: boolean, detail: string) =>
    lines.push(`${passed ? "✓" : "✗"} ${label}: ${detail}`);

  // Session count and span are informational — they don't gate eligibility directly.
  lines.push(`ℹ Conversations: ${obs.sessionCount} sessions observed`);
  lines.push(`ℹ Observation span: ${obs.spanDays} days`);

  addCheck(
    "Constraint gate",
    obs.gateState !== "below_floor" &&
      obs.gateState !== "none_observed",
    obs.gateState,
  );

  // Table of dimension names, their observed values, and the required floor.
  const dimensionRows: [string, DimensionMeta, number][] = [
    ["Attachment", obs.attachmentType, DIMENSION_FLOORS.attachmentType],
    ["MBTI", obs.mbti, DIMENSION_FLOORS.mbti],
    ["Zodiac", obs.zodiac, DIMENSION_FLOORS.zodiac],
    ["Interests", obs.interests, DIMENSION_FLOORS.interests],
    ["Moral/Ethical", obs.moralEthicalAlignment, DIMENSION_FLOORS.moralEthicalAlignment],
    ["Family/Life Goals", obs.familyLifeGoalsAlignment, DIMENSION_FLOORS.familyLifeGoalsAlignment],
    ["Lifestyle/Relational", obs.lifestyleRelationalBeliefs, DIMENSION_FLOORS.lifestyleRelationalBeliefs],
  ];

  for (const [name, dim, floor] of dimensionRows) {
    const diversityNote = dim.signalDiversity !== "low" ? "" : " [low diversity]";
    addCheck(
      name,
      dim.confidence >= floor,
      `confidence ${dim.confidence.toFixed(2)} / ${floor.toFixed(2)} required (${dim.evidenceCount} signals)${diversityNote}`,
    );
  }

  if (isStale(obs)) {
    lines.push(
      `⚠ Manifest stale — last computed ${obs.eligibilityAt}. Run: matchclaw observe --update`,
    );
  }

  return lines.join("\n");
}
