/**
 * Central constants for the MatchClaw plugin.
 *
 * All timing values, expiry thresholds, and configuration defaults live here
 * so they stay consistent across modules and are easy to adjust in one place.
 */

// ── Protocol ──────────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = "1.0";

// ── Lifecycle & Expiry ────────────────────────────────────────────────────────

/**
 * Standard 60-hour expiry window expressed in milliseconds.
 * Applies to:
 *   - Negotiation threads awaiting a peer response (negotiation.ts)
 *   - User consent windows after a match is confirmed (handoff.ts)
 *   - Staleness checks for observation data (observation.ts)
 */
export const THREAD_EXPIRY_MS = 60 * 60 * 60 * 1000; // 60 hours
export const EXPIRY_WINDOW_HOURS = 60;

/**
 * How long the agent waits for Round 1 of the handoff to complete.
 * After this window the debrief phase is considered timed out.
 */
export const ROUND1_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Hard cap on back-and-forth negotiation rounds before the thread is terminated.
 */
export const ROUND_LIMIT = 12;

/**
 * How often the background cron task fires to poll for new messages
 * and refresh the agent's registration with the registry.
 */
export const HEARTBEAT_INTERVAL_MS = 12 * 60 * 1000; // 12 minutes

// ── Nostr Relay Configuration ─────────────────────────────────────────────────

/**
 * Fallback relay list used when MATCHCLAW_NOSTR_RELAYS is not set.
 * These relays handle negotiation and coordination messages.
 */
export const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relays.nostr.info",
];

/**
 * Returns the relay list the agent should connect to.
 * Reads MATCHCLAW_NOSTR_RELAYS from the environment (comma-separated URLs).
 * Only entries with a ws:// or wss:// scheme are accepted; others are silently dropped.
 * Falls back to DEFAULT_NOSTR_RELAYS when the env var is absent or empty.
 */
export function getNostrRelays(): string[] {
  const envValue = process.env["MATCHCLAW_NOSTR_RELAYS"];
  if (!envValue) return DEFAULT_NOSTR_RELAYS;

  const parsed = envValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("wss://") || entry.startsWith("ws://"));

  if (parsed.length === 0) {
    console.error(
      "[MatchClaw] MATCHCLAW_NOSTR_RELAYS is set but contains no valid ws:// or wss:// URLs — falling back to defaults",
    );
    return DEFAULT_NOSTR_RELAYS;
  }

  return parsed;
}

// ── Debug Logging ─────────────────────────────────────────────────────────────

/**
 * Set of module names for which debug output is enabled.
 * Populated once at startup from MATCHCLAW_DEBUG_MODULES (comma-separated) or,
 * when MATCHCLAW_DEBUG=1, set to the sentinel value "*" meaning all modules.
 */
const DEBUG_NAMESPACES: Set<string> | "*" = (() => {
  if (process.env["MATCHCLAW_DEBUG"] === "1") return "*";
  const moduleList = process.env["MATCHCLAW_DEBUG_MODULES"];
  if (!moduleList) return new Set<string>();
  return new Set(moduleList.split(",").map((m) => m.trim()).filter(Boolean));
})();

/**
 * Returns true when debug output is enabled globally (MATCHCLAW_DEBUG=1).
 */
export function isDebugEnabled(): boolean {
  return DEBUG_NAMESPACES === "*";
}

/**
 * Emits a structured debug line to stderr when debug mode is active for the
 * given module. Silently no-ops in production.
 *
 * Example: debugLog("negotiation", "Received message from peer", { thread_id });
 */
export function debugLog(
  module: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  const active =
    DEBUG_NAMESPACES === "*" || DEBUG_NAMESPACES.has(module);
  if (!active) return;
  const ts = new Date().toISOString();
  const suffix = context ? ` ${JSON.stringify(context)}` : "";
  console.error(`[MatchClaw:${module}] ${ts} ${message}${suffix}`);
}

// ── Dev-only CLI ──────────────────────────────────────────────────────────────

/**
 * Synthetic personas, forced thread resets, and double-lock repair require
 * MATCHCLAW_DEV=1 so production installs do not expose these accidentally.
 */
export function isMatchclawDevEnabled(): boolean {
  return process.env["MATCHCLAW_DEV"] === "1";
}

export function assertMatchclawDevEnabled(feature: string): void {
  if (isMatchclawDevEnabled()) return;
  console.error(
    `${feature} requires MATCHCLAW_DEV=1 (local development or authorized recovery).`,
  );
  process.exit(1);
}
