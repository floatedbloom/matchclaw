/**
 * Persistent negotiation outcome tracking.
 *
 * Captures the result of each negotiation so the agent can:
 * 1. Skip re-matching with peers it recently declined or let expire
 * 2. Correlate dimensional confidence snapshots with match success
 * 3. Surface patterns in failed or expired negotiations
 * 4. Refine candidate selection criteria over time
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentMatchDir } from "./keys.js";
import { debugLog } from "./config.js";
import type { ObservationSummary, NegotiationState } from "./schema.js";
import type { DimensionKey } from "./scoring.js";

export interface NegotiationRecord {
  counterKey: string;
  thread_id: string;
  openedAt: string;
  ended_at: string;
  outcome: "matched" | "declined_by_us" | "declined_by_peer" | "expired";
  rounds_completed: number;
  closeReason?: string;
  // Dimensional confidence values captured at negotiation start, used for learning
  confidence_snapshot: Record<DimensionKey, number>;
}

export interface NegotiationHistory {
  records: NegotiationRecord[];
  last_updated: string;
}

// Maximum number of records to retain on disk before trimming the oldest.
const RECORD_CAP = 100;
// Number of days a peer remains in the cooldown window after a terminal outcome.
const PEER_COOLDOWN_DAYS = 7;
// Maximum age (days) before a record is pruned from history.
const RETENTION_DAYS = 90;

// HistoryStore encapsulates all file I/O for the negotiation history log.
class HistoryStore {
  private readonly filePath: string;
  private readonly baseDir: string;

  constructor() {
    this.baseDir = getAgentMatchDir();
    this.filePath = join(this.baseDir, "negotiation_history.json");
  }

  async read(): Promise<NegotiationHistory> {
    if (!existsSync(this.filePath)) {
      return { records: [], last_updated: new Date().toISOString() };
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as NegotiationHistory;
    } catch {
      return { records: [], last_updated: new Date().toISOString() };
    }
  }

  async write(payload: NegotiationHistory): Promise<void> {
    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    }
    await writeFile(
      this.filePath,
      JSON.stringify({ ...payload, last_updated: new Date().toISOString() }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

// Module-level singleton; constructed on first use.
const historyStore = new HistoryStore();

// Build a confidence snapshot from an ObservationSummary by reducing over known keys.
const TRACKED_DIMENSIONS: DimensionKey[] = [
  "attachmentType",
  "mbti",
  "zodiac",
  "interests",
  "moralEthicalAlignment",
  "familyLifeGoalsAlignment",
  "lifestyleRelationalBeliefs",
];

function snapshotConfidence(obs: ObservationSummary): Record<DimensionKey, number> {
  return TRACKED_DIMENSIONS.reduce<Record<DimensionKey, number>>(
    (acc, dim) => {
      acc[dim] = obs[dim].confidence;
      return acc;
    },
    {} as Record<DimensionKey, number>,
  );
}

// Map a thread's terminal status to a canonical outcome string, or return null
// when the thread is still active and should not be recorded.
function resolveOutcome(
  thread: NegotiationState,
): NegotiationRecord["outcome"] | null {
  switch (thread.status) {
    case "matched":
      return "matched";
    case "declined":
      return thread.ourProposal ? "declined_by_peer" : "declined_by_us";
    case "expired":
      return "expired";
    default:
      return null;
  }
}

/**
 * Read the negotiation history file from disk.
 * Returns an empty history object when the file does not exist or is unreadable.
 */
export async function loadHistory(): Promise<NegotiationHistory> {
  return historyStore.read();
}

/**
 * Append the result of a finished negotiation to the history log.
 * Threads still marked "in_progress" are silently skipped.
 */
export async function recordNegotiationOutcome(
  thread: NegotiationState,
  obs: ObservationSummary,
  reason?: string,
): Promise<void> {
  const resolvedOutcome = resolveOutcome(thread);
  if (resolvedOutcome === null) return;

  const storedHistory = await historyStore.read();

  const freshEntry: NegotiationRecord = {
    counterKey: thread.remoteKey,
    thread_id: thread.thread_id,
    openedAt: thread.openedAt,
    ended_at: thread.touchedAt,
    outcome: resolvedOutcome,
    rounds_completed: thread.sentRounds,
    closeReason: reason,
    confidence_snapshot: snapshotConfidence(obs),
  };

  const trimmedRecords = [...storedHistory.records, freshEntry].slice(-RECORD_CAP);
  await historyStore.write({ ...storedHistory, records: trimmedRecords });

  debugLog("negotiation-history", "Recorded negotiation outcome", {
    outcome: resolvedOutcome,
    rounds: thread.sentRounds,
    peer: thread.remoteKey.slice(0, 16),
  });
}

/**
 * Determine whether a peer should be excluded from new match attempts based on
 * recent negotiation history. Returns true when the peer should be skipped.
 */
export async function shouldAvoidPeer(peerPubkey: string): Promise<boolean> {
  const storedHistory = await historyStore.read();
  const cutoffMs = PEER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

  const recentEntries = storedHistory.records.filter(
    (rec) =>
      rec.counterKey === peerPubkey &&
      Date.now() - new Date(rec.ended_at).getTime() < cutoffMs,
  );

  const avoidanceTriggered = recentEntries.some(
    (rec) => rec.outcome === "declined_by_us" || rec.outcome === "expired",
  );

  if (avoidanceTriggered) {
    debugLog("negotiation-history", "Avoiding peer due to recent history", {
      peer: peerPubkey.slice(0, 16),
      recent_negotiations: recentEntries.length,
    });
  }

  return avoidanceTriggered;
}

/**
 * Compute aggregate statistics across all recorded negotiations.
 */
export async function getNegotiationStats(): Promise<{
  total: number;
  matched: number;
  declined_by_us: number;
  declined_by_peer: number;
  expired: number;
  avg_rounds_to_match: number;
  avg_rounds_to_decline: number;
}> {
  const storedHistory = await historyStore.read();

  type Accumulator = {
    matched: NegotiationRecord[];
    declined_by_us: NegotiationRecord[];
    declined_by_peer: NegotiationRecord[];
    expired: NegotiationRecord[];
  };

  const buckets = storedHistory.records.reduce<Accumulator>(
    (acc, rec) => {
      acc[rec.outcome].push(rec);
      return acc;
    },
    { matched: [], declined_by_us: [], declined_by_peer: [], expired: [] },
  );

  const meanRounds = (subset: NegotiationRecord[]): number =>
    subset.length === 0
      ? 0
      : subset.reduce((sum, r) => sum + r.rounds_completed, 0) / subset.length;

  return {
    total: storedHistory.records.length,
    matched: buckets.matched.length,
    declined_by_us: buckets.declined_by_us.length,
    declined_by_peer: buckets.declined_by_peer.length,
    expired: buckets.expired.length,
    avg_rounds_to_match: Math.round(meanRounds(buckets.matched) * 10) / 10,
    avg_rounds_to_decline: Math.round(meanRounds(buckets.declined_by_us) * 10) / 10,
  };
}

/**
 * Remove negotiation records older than 90 days to keep the history file lean.
 * Returns the number of records that were deleted.
 */
export async function pruneOldRecords(): Promise<number> {
  const storedHistory = await historyStore.read();
  const earliestAllowedMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const { kept, dropped } = storedHistory.records.reduce<{
    kept: NegotiationRecord[];
    dropped: number;
  }>(
    (acc, rec) => {
      if (new Date(rec.ended_at).getTime() > earliestAllowedMs) {
        acc.kept.push(rec);
      } else {
        acc.dropped += 1;
      }
      return acc;
    },
    { kept: [], dropped: 0 },
  );

  if (dropped > 0) {
    await historyStore.write({ ...storedHistory, records: kept });
    debugLog("negotiation-history", "Pruned old records", {
      pruned: dropped,
      remaining: kept.length,
    });
  }

  return dropped;
}
