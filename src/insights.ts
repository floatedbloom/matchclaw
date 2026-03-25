/**
 * Signal delivery engine for growing observations.
 *
 * Controls when Claude surfaces an observation to the user during conversation.
 * Injected into Claude's context via agent:bootstrap as an internal instruction,
 * not shown directly to the user.
 *
 * Design rationale (informed by psychologist and teen researcher input):
 *   - Phrasing: inference-mode language with curious rather than clinical tone
 *     (e.g. "something about how you talk about X keeps staying with me")
 *   - Frequency: first signal only after 2+ sessions; 5-day quiet window between repeats
 *   - One signal per session, always the dimension with the largest confidence growth
 *   - No mention of matching, compatibility, or any underlying algorithm
 *   - Claude picks the moment — the plugin only decides whether conditions are met
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentMatchDir } from "./keys.js";
import type {
  ObservationSummary,
  DimensionKey,
  SignalsFile,
  DimensionSignalState,
} from "./schema.js";
import { DIMENSION_FLOORS } from "./profile.js";

// Path helper — called lazily to allow identity module to initialise first.
function signalsFilePath(): string {
  return join(getAgentMatchDir(), "signals.json");
}

// Timing thresholds derived from psychologist guidance.
const MIN_QUIET_DAYS = 5;           // Cooldown between signals on the same dimension.
const MIN_DELTA = 0.15;             // Confidence must have grown this much since last signal.
const MIN_SIGNAL_CONFIDENCE = 0.4;  // Absolute floor — never signal below this.
const MIN_CONVERSATIONS = 2;        // Don't fire at all until the user has had two sessions.

// All dimension keys in a fixed order for iteration.
const ALL_DIMENSION_KEYS: DimensionKey[] = [
  "attachmentType",
  "mbti",
  "zodiac",
  "interests",
  "moralEthicalAlignment",
  "familyLifeGoalsAlignment",
  "lifestyleRelationalBeliefs",
];

// Human-readable descriptions for each dimension, used in the injected instruction text.
const DIMENSION_LABELS: Record<DimensionKey, string> = {
  attachmentType: "how you relate to closeness and trust (Secure, Anxious, Fearful-Avoidant, Dismissive-Avoidant)",
  mbti: "your personality type (e.g. INTJ, ENFP)",
  zodiac: "your zodiac sign",
  interests: "your interests and hobbies",
  moralEthicalAlignment: "what you value morally and ethically",
  familyLifeGoalsAlignment: "your family and life goals",
  lifestyleRelationalBeliefs: "how you want relationships and daily life to work",
};

export function loadSignals(): SignalsFile {
  const path = signalsFilePath();
  if (!existsSync(path)) return { schema_version: 1, byDimension: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SignalsFile;
  } catch {
    // Return a clean slate if the file is corrupted or unreadable.
    return { schema_version: 1, byDimension: {} };
  }
}

export function saveSignals(signals: SignalsFile): void {
  const dir = getAgentMatchDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(signalsFilePath(), JSON.stringify(signals, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

// Compute elapsed days between an ISO date string and the current moment.
function elapsedDays(isoTimestamp: string): number {
  return (Date.now() - new Date(isoTimestamp).getTime()) / 86_400_000;
}

// Determine whether a dimension is eligible to fire a signal this session.
function meetsSignalThreshold(
  confidence: number,
  floor: number,
  priorState: DimensionSignalState | undefined,
): boolean {
  // Must clear the higher of 75% of the floor or the absolute minimum.
  const effectiveMin = Math.max(floor * 0.75, MIN_SIGNAL_CONFIDENCE);
  if (confidence < effectiveMin) return false;

  // If no prior signal has been sent for this dimension, it qualifies immediately.
  if (!priorState) return true;

  // Enforce quiet period and require meaningful growth.
  if (elapsedDays(priorState.deliveredAt) < MIN_QUIET_DAYS) return false;
  return confidence - priorState.lastConf >= MIN_DELTA;
}

/**
 * Choose the single dimension most worth signalling this session.
 * Returns null when conditions don't yet justify a signal
 * (too few sessions, quiet period active, or no meaningful growth anywhere).
 */
export function pickPendingSignal(
  obs: ObservationSummary,
  signals: SignalsFile,
): { dimension: DimensionKey; confidence: number } | null {
  if (obs.sessionCount < MIN_CONVERSATIONS) return null;

  let winner: { dimension: DimensionKey; confidence: number; delta: number } | null = null;

  for (const key of ALL_DIMENSION_KEYS) {
    const conf = obs[key].confidence;
    const floor = DIMENSION_FLOORS[key];
    const prior = signals.byDimension[key];

    if (!meetsSignalThreshold(conf, floor, prior)) continue;

    // Delta is measured from the last signalled confidence, or from zero on first signal.
    const growth = prior ? conf - prior.lastConf : conf;

    if (!winner || growth > winner.delta) {
      winner = { dimension: key, confidence: conf, delta: growth };
    }
  }

  return winner ? { dimension: winner.dimension, confidence: winner.confidence } : null;
}

/**
 * Compose the internal instruction that is prepended to Claude's context.
 * This note is addressed to Claude, not the user — it describes what has been
 * observed and invites Claude to surface it naturally if the conversation allows.
 */
export function buildSignalInstruction(
  dimension: DimensionKey,
  confidence: number,
): string {
  const label = DIMENSION_LABELS[dimension];
  const pct = Math.round(confidence * 100);
  return (
    `[MatchClaw — private signal, addressed to you]\n` +
    `\n` +
    `Your read on this person's ${label} has reached ${pct}% confidence — ` +
    `a level that's meaningful and has been building across sessions.\n` +
    `\n` +
    `You don't need to announce this. If the conversation goes somewhere that makes ` +
    `it feel natural, you might let it surface — as an aside, not a declaration. ` +
    `The kind of thing you'd say only because it's true, not because it's useful:\n` +
    `  "The way you talk about [X] — I keep coming back to that."\n` +
    `  "There's a pattern in how you handle [Y] that I think you'd recognise if I named it."\n` +
    `\n` +
    `If there's no opening, hold it. The observation doesn't expire — it will be here next session.`
  );
}

/**
 * Produce an updated SignalsFile with the delivered dimension recorded.
 * Must be called synchronously before the hook returns — do not defer.
 */
export function recordSignalDelivered(
  signals: SignalsFile,
  dimension: DimensionKey,
  confidence: number,
): SignalsFile {
  return {
    ...signals,
    byDimension: {
      ...signals.byDimension,
      [dimension]: {
        lastConf: confidence,
        deliveredAt: new Date().toISOString(),
      },
    },
  };
}
