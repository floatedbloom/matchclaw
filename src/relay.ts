import { SimplePool, verifyEvent, type Event, type Filter } from "nostr-tools";
import { unwrapEvent, wrapManyEvents } from "nostr-tools/nip17";
import { hexToBytes } from "nostr-tools/utils";
import { getNostrRelays, debugLog, THREAD_EXPIRY_MS } from "./config.js";
import type { AgentMatchMessage } from "./schema.js";

// Load relay list from configuration at module init time.
export const DEFAULT_RELAYS = getNostrRelays();

// NIP-17 event kinds used for private DM gift wrapping.
const GIFT_WRAP_KIND = 1059;
const PRIVATE_DM_KIND = 14;

const RE_HEX64 = /^[0-9a-f]{64}$/;

/** Lowercase hex so strfry / `#p` indexing matches published gift wraps. */
export function normalizeNostrPubkeyHex(pubkey: string): string {
  const lower = pubkey.trim().toLowerCase();
  if (!RE_HEX64.test(lower)) {
    throw new Error("npub must be 64 lowercase hex characters");
  }
  return lower;
}

/**
 * Strfry rejects REQ with `since: null` (e.g. when NaN was JSON-serialized). Always finite.
 */
export function safeFilterSinceUnix(
  candidate: number | undefined,
  fallbackSecondsAgo: number,
): number {
  const now = Math.floor(Date.now() / 1000);
  const floor = now - fallbackSecondsAgo;
  if (candidate === undefined || !Number.isFinite(candidate)) return floor;
  return Math.floor(Math.max(0, candidate));
}

/** Single filter for kind 1059 + `#p` (NIP-01). Optional limit for one-shot poll queries. */
export function buildGiftWrapFilter(
  recipientPubkeyHex: string,
  sinceUnix: number,
  options?: { limit?: number },
): Filter {
  const pk = normalizeNostrPubkeyHex(recipientPubkeyHex);
  const since = safeFilterSinceUnix(
    sinceUnix,
    Math.ceil(THREAD_EXPIRY_MS / 1000),
  );
  const filter: Filter = {
    kinds: [GIFT_WRAP_KIND],
    "#p": [pk],
    since,
  };
  if (
    options?.limit !== undefined &&
    Number.isFinite(options.limit) &&
    options.limit > 0
  ) {
    filter.limit = Math.floor(options.limit);
  }
  return filter;
}

// ── Result type ───────────────────────────────────────────────────────────────

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

function err(error: string): Err {
  return { ok: false, error };
}

// ── RelayPool ─────────────────────────────────────────────────────────────────
//
// Wraps SimplePool with lifecycle management and convenience methods.
// Each instance owns one pool that is closed after use — callers should not
// hold instances open across unrelated operations.

class RelayPool {
  private readonly pool = new SimplePool();
  private readonly endpoints: string[];

  constructor(relayUrls: string[]) {
    this.endpoints = relayUrls;
  }

  /**
   * Publish a pre-built event to all configured relays.
   * Returns Ok when at least one relay accepted the event, Err otherwise.
   */
  async broadcast(evt: Event): Promise<Result<number>> {
    const outcomes = await Promise.allSettled(this.pool.publish(this.endpoints, evt));
    const accepted = outcomes.filter((r: PromiseSettledResult<unknown>) => r.status === "fulfilled").length;
    if (accepted === 0) {
      return err("Failed to publish to any relay");
    }
    return ok(accepted);
  }

  /**
   * Open a subscription for gift-wrapped events addressed to recipientNpub.
   * Returns a cleanup function that unsubscribes and closes the pool.
   */
  subscribe(
    recipientNpub: string,
    lookbackTs: number,
    handlers: {
      onevent: (event: Event) => Promise<void>;
      oneose?: () => void;
    },
  ): () => void {
    const filter = buildGiftWrapFilter(recipientNpub, lookbackTs);
    const sub = this.pool.subscribeMany(this.endpoints, filter, {
      onevent: handlers.onevent,
      oneose: () => handlers.oneose?.(),
    });

    return () => {
      sub.close();
      this.pool.close(this.endpoints);
    };
  }

  /**
   * Probe each relay with a bare WebSocket connection.
   * Returns a map of relay URL → reachability boolean.
   */
  async probeConnectivity(): Promise<Record<string, boolean>> {
    const report: Record<string, boolean> = {};

    await Promise.all(
      this.endpoints.map(async (url) => {
        const result = await this.pingRelay(url);
        report[url] = result.ok;
      }),
    );

    return report;
  }

  private async pingRelay(url: string): Promise<Result<void>> {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("timeout"));
        }, 5000);

        socket.onopen = () => {
          clearTimeout(timer);
          socket.close();
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("connection failed"));
        };
      });
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : "unknown error");
    }
  }

  close(): void {
    this.pool.close(this.endpoints);
  }
}

// ── MatchClaw message parsing ──────────────────────────────────────────────────────

// Type guard: confirm an unknown value is a MatchClaw protocol message.
function checkIsMatchClawMessage(candidate: unknown): candidate is AgentMatchMessage {
  if (typeof candidate !== "object" || candidate === null) return false;
  if (!("matchclaw" in candidate)) return false;
  return (candidate as AgentMatchMessage).matchclaw === "1.0";
}

/**
 * Attempt to decode a MatchClaw protocol message from a NIP-17 gift-wrapped event
 * (kind 1059 outer, kind 14 inner rumor). Events where the rumor sender matches
 * the recipient pubkey are skipped — those are the sender's own inbox copy.
 */
export function parseIncomingMatchClawEvent(
  event: Event,
  recipientNsec: Uint8Array,
  recipientNpub: string,
): { senderNpub: string; message: AgentMatchMessage } | null {
  // Reject events that fail signature verification or have the wrong outer kind.
  if (!verifyEvent(event) || event.kind !== GIFT_WRAP_KIND) return null;

  try {
    const rumor = unwrapEvent(event, recipientNsec);

    // Inner rumor must be a private DM and must not be from ourselves.
    if (rumor.kind !== PRIVATE_DM_KIND) return null;
    if (rumor.pubkey.toLowerCase() === recipientNpub.toLowerCase()) return null;

    let body: unknown;
    try {
      body = JSON.parse(rumor.content) as unknown;
    } catch {
      return null;
    }

    if (!checkIsMatchClawMessage(body)) return null;
    return { senderNpub: rumor.pubkey, message: body };
  } catch {
    return null;
  }
}

// ── Exported API ──────────────────────────────────────────────────────────────

export async function publishMessage(
  senderNsec: string,
  recipientNpub: string,
  message: AgentMatchMessage,
  relays: string[] = DEFAULT_RELAYS,
): Promise<void> {
  debugLog("nostr", "Publishing message (NIP-17)", {
    type: message.type,
    thread_id: message.thread_id,
    recipient: recipientNpub.slice(0, 16),
    relay_count: relays.length,
  });

  if (relays.length === 0) return;

  const signingKey = hexToBytes(senderNsec);
  const serialized = JSON.stringify(message);
  const peerHex = normalizeNostrPubkeyHex(recipientNpub);

  const wrappedEvents = wrapManyEvents(
    signingKey,
    [{ publicKey: peerHex }],
    serialized,
    undefined,
    undefined,
  );

  const relay = new RelayPool(relays);
  try {
    for (const wrapped of wrappedEvents) {
      const result = await relay.broadcast(wrapped);
      if (!result.ok) {
        throw new Error(result.error);
      }
    }
  } finally {
    relay.close();
  }
}

// Bound on how many event IDs to keep in the deduplication set before clearing it.
const MAX_SEEN_IDS = 1000;

export async function subscribeToMessages(
  recipientNsec: string,
  recipientNpub: string,
  onMessage: (from: string, message: AgentMatchMessage) => Promise<void>,
  relays: string[] = DEFAULT_RELAYS,
  since?: number,
  onEose?: () => void,
): Promise<() => void> {
  const seenIds = new Set<string>();
  const nsecBytes = hexToBytes(recipientNsec);
  const npubHex = normalizeNostrPubkeyHex(recipientNpub);

  const fallbackAgo = Math.ceil(THREAD_EXPIRY_MS / 1000);
  const lookbackTs =
    since !== undefined && Number.isFinite(since)
      ? Math.floor(since)
      : Math.floor(Date.now() / 1000) - fallbackAgo;

  const relay = new RelayPool(relays);

  return relay.subscribe(npubHex, lookbackTs, {
    onevent: async (event: Event) => {
      const parsed = parseIncomingMatchClawEvent(event, nsecBytes, npubHex);
      if (!parsed) return;

      // Deduplicate — ignore events we've already handled.
      if (seenIds.has(event.id)) return;
      if (seenIds.size >= MAX_SEEN_IDS) seenIds.clear();
      seenIds.add(event.id);

      // Swallow errors from the message handler to keep the subscription alive.
      await onMessage(parsed.senderNpub, parsed.message).catch(() => {});
    },
    oneose: onEose,
  });
}

export async function checkRelayConnectivity(
  relays: string[] = DEFAULT_RELAYS,
): Promise<Record<string, boolean>> {
  const probe = new RelayPool(relays);
  return probe.probeConnectivity();
}
