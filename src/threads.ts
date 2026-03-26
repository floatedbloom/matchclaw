import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentMatchDir } from "./keys.js";
import { publishMessage } from "./relay.js";
import {
  ROUND_LIMIT,
  THREAD_EXPIRY_MS,
  debugLog,
} from "./config.js";
import type {
  ContactType,
  NegotiationState,
  NegotiationMessage,
  AgentMatchMessage,
  MatchNarrative,
  ContactChannel,
} from "./schema.js";
import { VALID_CONTACT_TYPES } from "./schema.js";

// Cap on how many active inbound threads a single unknown peer may open.
// Prevents disk-exhaustion attacks from peers spamming distinct thread IDs.
const MAX_INBOUND_THREADS_PER_PEER = 3;

// Re-export under original name for backward compatibility
export const MAX_ROUNDS = ROUND_LIMIT;

// ── ThreadStore ───────────────────────────────────────────────────────────────
//
// Encapsulates all filesystem access for negotiation threads.
// dirPath() is re-evaluated on every call so MATCHER_DIR_OVERRIDE overrides
// that tests inject via getAgentMatchDir() are respected without any caching.

class ThreadStore {
  /** Compute the threads directory path fresh on each invocation. */
  dirPath(): string {
    return join(getAgentMatchDir(), "threads");
  }

  /** Create the threads directory if it does not already exist. */
  async ensureDir(): Promise<void> {
    await mkdir(this.dirPath(), { recursive: true, mode: 0o700 });
  }

  /**
   * Build the full file path for a thread and validate the UUID before
   * letting it touch the filesystem.
   *
   * UUID v4 validation without a regex constant:
   *   - Split on '-' → expect 5 groups with hex lengths [8,4,4,4,12]
   *   - Group[2][0] must be '4'  (version digit)
   *   - Group[3][0] must be one of '8','9','a','b'  (variant bits)
   */
  filePath(tid: string): string {
    const groups = tid.toLowerCase().split("-");
    const lengths = [8, 4, 4, 4, 12];
    const hexChars = new Set("0123456789abcdef");
    const valid =
      groups.length === 5 &&
      groups.every((g, i) => g.length === lengths[i] && [...g].every((c) => hexChars.has(c))) &&
      groups[2]![0] === "4" &&
      new Set(["8", "9", "a", "b"]).has(groups[3]![0]!);

    if (!valid) {
      throw new Error(`Invalid thread_id format: ${tid}`);
    }
    return join(this.dirPath(), `${tid}.json`);
  }

  /** Load a thread by ID. Returns null when the file does not exist or is unreadable. */
  async load(tid: string): Promise<NegotiationState | null> {
    const path = this.filePath(tid);
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as NegotiationState;
    } catch {
      return null;
    }
  }

  /** Persist a thread state to disk, creating the directory as needed. */
  async save(state: NegotiationState): Promise<void> {
    await this.ensureDir();
    await writeFile(
      this.filePath(state.thread_id),
      JSON.stringify(state, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  /**
   * Return all threads with status === "in_progress".
   * Reads all .json files in parallel via Promise.all rather than sequentially.
   */
  async list(): Promise<NegotiationState[]> {
    await this.ensureDir();
    const entries = await readdir(this.dirPath());

    const jsonEntries = entries.filter((e) => e.endsWith(".json"));

    const results = await Promise.all(
      jsonEntries.map(async (entry) => {
        try {
          const raw = await readFile(join(this.dirPath(), entry), "utf8");
          return JSON.parse(raw) as NegotiationState;
        } catch {
          // Skip files that cannot be parsed rather than aborting the full scan
          return null;
        }
      }),
    );

    return results.filter(
      (s): s is NegotiationState => s !== null && s.status === "in_progress",
    );
  }
}

// Module-level singleton — all exported functions delegate here.
const store = new ThreadStore();

// ── Exported thin wrappers ────────────────────────────────────────────────────

export async function loadThread(
  thread_id: string,
): Promise<NegotiationState | null> {
  return store.load(thread_id);
}

export async function saveThread(state: NegotiationState): Promise<void> {
  return store.save(state);
}

export async function listActiveThreads(): Promise<NegotiationState[]> {
  return store.list();
}

// ── Complex logic (delegates to store for I/O) ────────────────────────────────

// Marks threads that have been idle beyond the expiry window as expired.
// Returns the collection of threads that were transitioned (for history recording).
export async function expireStaleThreads(
  nsec: string,
  relays: string[],
): Promise<NegotiationState[]> {
  const liveThreads = await store.list();
  const nowMs = Date.now();
  const justExpired: NegotiationState[] = [];

  for (const t of liveThreads) {
    const idleMs = nowMs - new Date(t.touchedAt).getTime();
    if (idleMs <= THREAD_EXPIRY_MS) continue;

    debugLog("negotiation", "Expiring stale thread", {
      thread_id: t.thread_id,
      remoteKey: t.remoteKey.slice(0, 16),
    });

    // Persist the expired state before attempting to notify the peer.
    // That way, a relay failure won't result in duplicate end messages on the next cycle.
    t.status = "expired";
    t.touchedAt = new Date().toISOString();
    await store.save(t);
    justExpired.push(t);

    try {
      await transmitEnd(nsec, t.remoteKey, t.thread_id, relays);
    } catch {
      // Relay unreachable — state is already recorded locally; the peer will time out naturally
    }
  }

  return justExpired;
}

// Allocates a new outbound negotiation thread and persists it.
// `threadId` must come from the registry (POST /negotiations) so both peers share one id.
// The opening message is NOT sent here — Claude writes and sends it via `matchclaw match --send`.
export async function initiateNegotiation(
  peerNpub: string,
  threadId: string,
  compatibilityScore?: number,
): Promise<NegotiationState> {
  const tid = threadId;
  const stamp = new Date().toISOString();

  const freshState: NegotiationState = {
    thread_id: tid,
    remoteKey: peerNpub,
    sentRounds: 0,
    weInitiated: true,
    ourProposal: false,
    theirProposal: false,
    openedAt: stamp,
    touchedAt: stamp,
    status: "in_progress",
    messages: [],
    preflightScore: compatibilityScore,
  };

  debugLog("negotiation", "Initiated new thread", {
    thread_id: tid,
    peer: peerNpub.slice(0, 16),
    preflightScore: compatibilityScore?.toFixed(3),
  });

  await store.save(freshState);
  return freshState;
}

// Record an incoming peer message onto the appropriate thread
export async function receiveMessage(
  thread_id: string,
  peerNpub: string,
  content: string,
  type: string,
): Promise<NegotiationState | null> {
  // Wire-supplied IDs are validated before any disk access; failures are silent
  // to avoid leaking thread existence information to callers.
  let validId: boolean;
  try {
    store.filePath(thread_id); // throws on invalid UUID
    validId = true;
  } catch {
    validId = false;
  }
  if (!validId) return null;

  await store.ensureDir();
  const stamp = new Date().toISOString();

  let currentState = await store.load(thread_id);

  if (!currentState) {
    // An "end" arriving for an unknown thread is a protocol no-op.
    // Silently reject to prevent disk-write DoS via "end" floods and to avoid
    // leaking whether the thread exists.
    if (type === "end") return null;

    // First contact from this peer on this thread ID.
    // Rate-limit inbound thread creation to prevent disk exhaustion.
    const openThreads = await store.list();
    const countFromPeer = openThreads.filter(
      (t) => t.remoteKey === peerNpub && !t.weInitiated,
    ).length;
    if (countFromPeer >= MAX_INBOUND_THREADS_PER_PEER) return null;

    // Bootstrap a new inbound thread
    currentState = {
      thread_id,
      remoteKey: peerNpub,
      sentRounds: 0,
      weInitiated: false,
      ourProposal: false,
      theirProposal: false,
      openedAt: stamp,
      touchedAt: stamp,
      status: "in_progress",
      messages: [],
    };
  } else if (peerNpub !== currentState.remoteKey) {
    // Sender does not match the thread's registered peer — reject without exposing
    // any details about the thread or its owner.
    return null;
  } else if (currentState.status !== "in_progress") {
    // Messages on closed threads (declined, matched, expired) are ignored
    return null;
  }

  currentState.touchedAt = stamp;
  // sentRounds reflects only outbound messages — receiving does not increment it

  const inboundMsg: NegotiationMessage = {
    role: "peer",
    content,
    timestamp: stamp,
  };
  currentState.messages.push(inboundMsg);

  if (type === "end") {
    currentState.status = "declined";
  } else if (type === "match_propose") {
    currentState.theirProposal = true;
    try {
      const payload = JSON.parse(content) as Record<string, unknown>;
      // Preferred format: { narrative: MatchNarrative, contact: ContactChannel }
      if (payload["narrative"] && typeof payload["narrative"] === "object") {
        const narrativeObj = payload["narrative"] as Record<string, unknown>;
        // Validate minimum structure before trusting the narrative.
        // Without this, a malformed object would reach buildMatchNotificationContext,
        // which calls .map() on narrative.strengths and would throw if undefined.
        if (
          typeof narrativeObj["summary"] === "string" &&
          Array.isArray(narrativeObj["strengths"]) &&
          Array.isArray(narrativeObj["tensions"]) &&
          typeof narrativeObj["compatSummary"] === "string"
        ) {
          currentState.sharedNarrative =
            narrativeObj as unknown as MatchNarrative;
        }
        const contactObj = payload["contact"];
        if (
          contactObj &&
          typeof contactObj === "object" &&
          "type" in (contactObj as object) &&
          "value" in (contactObj as object) &&
          typeof (contactObj as Record<string, unknown>)["type"] === "string" &&
          VALID_CONTACT_TYPES.has(
            (contactObj as Record<string, unknown>)["type"] as ContactType,
          ) &&
          typeof (contactObj as Record<string, unknown>)["value"] ===
            "string" &&
          ((contactObj as Record<string, unknown>)["value"] as string).length <=
            512
        ) {
          currentState.remoteContact = contactObj as ContactChannel;
        }
      } else {
        // Legacy wire format: bare MatchNarrative JSON without contact — validate before storing
        if (
          typeof payload["summary"] === "string" &&
          Array.isArray(payload["strengths"]) &&
          Array.isArray(payload["tensions"]) &&
          typeof payload["compatSummary"] === "string"
        ) {
          currentState.sharedNarrative = payload as unknown as MatchNarrative;
        }
      }
    } catch {
      // content was plain text rather than JSON; theirProposal is still set above
    }
    // Both sides have now proposed — the double-lock is cleared and the match is confirmed
    if (currentState.ourProposal) {
      currentState.status = "matched";
    }
  }

  await store.save(currentState);
  return currentState;
}

// Transmit a free-form negotiation message to the peer
export async function sendMessage(
  nsec: string,
  thread_id: string,
  content: string,
  relays: string[],
): Promise<void> {
  const existing = await store.load(thread_id);
  if (!existing) throw new Error(`Thread ${thread_id} not found`);
  if (existing.status !== "in_progress") {
    throw new Error(
      `Thread ${thread_id} is not in progress (status: ${existing.status})`,
    );
  }
  if (existing.sentRounds >= MAX_ROUNDS) {
    throw new Error(
      `Thread ${thread_id} has reached the ${MAX_ROUNDS}-round cap`,
    );
  }

  const stamp = new Date().toISOString();

  const envelope: AgentMatchMessage = {
    matchclaw: "1.0",
    thread_id,
    type: "negotiation",
    timestamp: stamp,
    content,
  };

  await publishMessage(nsec, existing.remoteKey, envelope, relays);

  existing.messages.push({ role: "us", content, timestamp: stamp });
  existing.sentRounds += 1;
  existing.touchedAt = stamp;
  await store.save(existing);
}

// Propose a match to the peer (double-lock: match is only confirmed when the peer also proposes)
export async function proposeMatch(
  nsec: string,
  thread_id: string,
  narrative: MatchNarrative,
  relays: string[],
  myContact?: ContactChannel,
): Promise<NegotiationState> {
  const existing = await store.load(thread_id);
  if (!existing) throw new Error(`Thread ${thread_id} not found`);
  if (existing.status !== "in_progress") {
    throw new Error(
      `Thread ${thread_id} is not in progress (status: ${existing.status})`,
    );
  }
  if (existing.ourProposal)
    throw new Error(`Already proposed on thread ${thread_id}`);

  const stamp = new Date().toISOString();
  // Bundle our contact into the proposal so the peer can store it at match-confirmation time.
  // Messages travel as NIP-17 gift wraps (NIP-44 encrypted).
  const body = JSON.stringify(
    myContact ? { narrative, contact: myContact } : narrative,
  );

  const envelope: AgentMatchMessage = {
    matchclaw: "1.0",
    thread_id,
    type: "match_propose",
    timestamp: stamp,
    content: body,
  };

  await publishMessage(nsec, existing.remoteKey, envelope, relays);

  existing.messages.push({ role: "us", content: body, timestamp: stamp });
  existing.sentRounds += 1;
  existing.touchedAt = stamp;
  existing.ourProposal = true;

  // Peer already proposed earlier — the double-lock is now cleared and match is confirmed.
  // Note: existing.remoteContact (populated by receiveMessage when the peer's proposal arrived)
  // is preserved here because we loaded the full persisted state with store.load. Do NOT
  // reconstruct the state from scratch in this function — that would silently discard it.
  if (existing.theirProposal) {
    existing.status = "matched";
  }

  await store.save(existing);
  return existing;
}

// End our participation in a negotiation thread and notify the peer
export async function declineMatch(
  nsec: string,
  thread_id: string,
  relays: string[],
  reason?: string,
): Promise<void> {
  const existing = await store.load(thread_id);
  if (!existing) throw new Error(`Thread ${thread_id} not found`);
  if (existing.status !== "in_progress") {
    throw new Error(
      `Thread ${thread_id} is not in progress (status: ${existing.status})`,
    );
  }

  debugLog("negotiation", "Declining match", {
    thread_id,
    reason: reason ?? "no reason provided",
    rounds: existing.sentRounds,
  });

  await transmitEnd(nsec, existing.remoteKey, thread_id, relays);

  existing.status = "declined";
  existing.touchedAt = new Date().toISOString();
  if (reason) {
    existing.closeReason = reason;
  }
  await store.save(existing);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function transmitEnd(
  nsec: string,
  recipient: string,
  tid: string,
  relays: string[],
): Promise<void> {
  await publishMessage(
    nsec,
    recipient,
    {
      matchclaw: "1.0",
      thread_id: tid,
      type: "end",
      timestamp: new Date().toISOString(),
      content: "",
    },
    relays,
  );
}
