#!/usr/bin/env node
/**
 * Single-shot Nostr relay poller — invoked by the bridge daemon on each tick.
 *
 * Subscribes to kind-1059 (NIP-17 gift wrap) events addressed to this agent's
 * public key since the last recorded watermark, decrypts each one, validates it
 * as a MatchClaw protocol message, and emits a JSONL record to stdout.
 *
 * JSONL record shape (one object per line):
 *   { thread_id, peer_pubkey, type, content, round_count }
 *
 * Note: peer_pubkey = sender's npub hex; round_count = outgoing sentRounds from local thread.
 *
 * Diagnostic output goes exclusively to stderr. stdout carries only JSONL.
 *
 * Exit codes:
 *   0 — completed (may have produced zero lines)
 *   1 — fatal: identity file missing or unreadable
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SimplePool, type Event, type Filter } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { getAgentMatchDir } from "./keys.js";
import { DEFAULT_RELAYS, parseIncomingMatchClawEvent } from "./relay.js";
import type {
  AgentMatchMessage,
  AgentMatchIdentity,
  NegotiationState,
} from "./schema.js";

// File paths — derived fresh so directory overrides take effect at runtime.
const agentDir = getAgentMatchDir();
const IDENTITY_FILE = join(agentDir, "identity.json");
const WATERMARK_FILE = join(agentDir, "poll-state.json");
const THREADS_DIR = join(agentDir, "threads");

const GIFT_WRAP_KIND = 1059;
// Thread IDs must be UUID v4 — rejects path traversal attempts.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Hard cap on events processed in a single run.
const FETCH_LIMIT = 100;
// Overlap applied to the watermark timestamp to catch boundary-edge events.
const BOUNDARY_OVERLAP_SECONDS = 30;
// How long to wait for relay EOSE before giving up and proceeding.
const EOSE_TIMEOUT_MS = Number(process.env["MATCHCLAW_POLL_EOSE_TIMEOUT_MS"]) || 20_000;

interface PollState {
  last_poll_at: number; // Unix seconds
}

// ── MessageFilter ─────────────────────────────────────────────────────────────
//
// Validates and normalises events coming off the relay before they enter the
// main processing pipeline. Stateless — instantiated once per run.

class MessageFilter {
  private readonly seenIds = new Set<string>();

  /** Returns false when this event id has been seen before (relay dedup). */
  isFirstSeen(eventId: string): boolean {
    if (this.seenIds.has(eventId)) return false;
    this.seenIds.add(eventId);
    return true;
  }

  /** Returns true when the event falls inside the active fetch window. */
  isInWindow(createdAt: number, windowStart: number): boolean {
    return createdAt >= windowStart;
  }

  /** Returns true when the thread_id is a valid UUID v4 string. */
  isValidThreadId(threadId: string): boolean {
    return UUID_V4_RE.test(threadId);
  }
}

// ── Watermark persistence ─────────────────────────────────────────────────────

function readWatermark(): PollState {
  const fallback: PollState = { last_poll_at: Math.floor(Date.now() / 1000) - 3600 };
  if (!existsSync(WATERMARK_FILE)) return fallback;
  try {
    return JSON.parse(readFileSync(WATERMARK_FILE, "utf8")) as PollState;
  } catch {
    return fallback;
  }
}

function writeWatermark(state: PollState): void {
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  writeFileSync(WATERMARK_FILE, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

// ── Identity and thread state readers ────────────────────────────────────────

function readIdentity(): AgentMatchIdentity | null {
  if (!existsSync(IDENTITY_FILE)) return null;
  try {
    return JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) as AgentMatchIdentity;
  } catch {
    return null;
  }
}

function readThreadState(threadId: string): NegotiationState | null {
  const threadPath = join(THREADS_DIR, `${threadId}.json`);
  if (!existsSync(threadPath)) return null;
  try {
    return JSON.parse(readFileSync(threadPath, "utf8")) as NegotiationState;
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const identity = readIdentity();
  if (!identity) {
    process.stderr.write("poll: identity not found — run matchclaw setup\n");
    process.exit(1);
  }

  const savedWatermark = readWatermark();
  const sinceOverride = process.env["MATCHCLAW_POLL_SINCE_OVERRIDE"];
  const windowStart = sinceOverride
    ? parseInt(sinceOverride, 10)
    : savedWatermark.last_poll_at - BOUNDARY_OVERLAP_SECONDS;
  const isRecoveryRun = Boolean(sinceOverride);
  const runEpoch = Math.floor(Date.now() / 1000);

  const pool = new SimplePool();
  const filter = new MessageFilter();
  const outputLines: string[] = [];
  let capHit = false;
  let timedOut = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    let eventsAccepted = 0;

    const eoseGuard = setTimeout(() => {
      if (!settled) {
        settled = true;
        timedOut = true;
        process.stderr.write(
          `poll: EOSE timeout after ${EOSE_TIMEOUT_MS}ms — proceeding with ${outputLines.length} messages\n`,
        );
        sub.close();
        pool.close(DEFAULT_RELAYS);
        resolve();
      }
    }, EOSE_TIMEOUT_MS);

    const relayFilter: Filter = {
      kinds: [GIFT_WRAP_KIND],
      "#p": [identity.npub],
      since: windowStart,
      limit: FETCH_LIMIT,
    };

    const sub = pool.subscribeMany(DEFAULT_RELAYS, relayFilter, {
      onevent: (ev: Event) => {
        if (settled) return;

        // Skip duplicate events delivered by multiple relays.
        if (!filter.isFirstSeen(ev.id)) return;

        // Drop events that predate the fetch window.
        if (!filter.isInWindow(ev.created_at, windowStart)) return;

        eventsAccepted++;
        if (eventsAccepted > FETCH_LIMIT) {
          if (!capHit) {
            capHit = true;
            process.stderr.write(
              `poll: FETCH_LIMIT (${FETCH_LIMIT}) reached — watermark held, reduce POLL_INTERVAL\n`,
            );
          }
          return;
        }

        const parsed = parseIncomingMatchClawEvent(
          ev,
          hexToBytes(identity.nsec),
          identity.npub,
        );
        if (!parsed) return;

        const { senderNpub, message } = parsed;

        // Validate thread ID before any filesystem interaction.
        if (!filter.isValidThreadId(message.thread_id)) return;

        const threadSnapshot = readThreadState(message.thread_id);
        const sentRounds = threadSnapshot?.sentRounds ?? 0;

        outputLines.push(
          JSON.stringify({
            thread_id: message.thread_id,
            peer_pubkey: senderNpub,
            type: message.type,
            content: message.content,
            round_count: sentRounds,
          }),
        );
      },
      oneose: () => {
        // Settle as soon as any relay signals EOSE — waiting for all relays
        // means one slow or unresponsive relay stalls the entire poll cycle.
        // The 30-second boundary overlap catches anything a slow relay held back.
        if (!settled) {
          settled = true;
          clearTimeout(eoseGuard);
          sub.close();
          pool.close(DEFAULT_RELAYS);
          resolve();
        }
      },
    });
  });

  // Emit JSONL records.
  for (const line of outputLines) {
    process.stdout.write(line + "\n");
  }

  // Advance the watermark only when the fetch was complete and reliable:
  // - Not a one-off recovery fetch (MATCHCLAW_POLL_SINCE_OVERRIDE)
  // - Not capped (partial result; retry from same point)
  // - Not timed-out at all (any timeout means at least one relay may have had
  //   unseen events; hold the watermark so we retry from the same point)
  if (!isRecoveryRun && !capHit && !timedOut) {
    writeWatermark({ last_poll_at: runEpoch });
  }

  // Force exit — SimplePool keeps WebSocket connections alive, blocking the bridge loop.
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `poll: fatal error — ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
