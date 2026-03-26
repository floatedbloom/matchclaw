#!/usr/bin/env node
/**
 * MatchClaw agent CLI entry point
 *
 * Subcommands:
 *   matchclaw setup [--contact-type email|discord|telegram|whatsapp|imessage|signal|phone|instagram|twitter|linkedin|matrix|line] [--contact-value <val>]
 *   matchclaw heartbeat
 *   matchclaw status [--relays]
 *   matchclaw observe --show | --update | --write '<json>'
 *   matchclaw preferences --show | --set '<json>'
 *   matchclaw match --start | --status [--thread <id>] | --messages --thread <id>
 *                   | --receive '<content>' --thread <id> --peer <pubkey> [--type <type>]
 *                   | --send '<msg>' --thread <id>
 *                   | --propose --thread <id> --write '<narrative-json>'
 *                   | --decline --thread <id> [--reason '<text>']
 *                   | --reset --thread <id>
 *                   | --repair-double-lock --thread <id>
 *                   | --guidance --thread <id>
 *   matchclaw deregister
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getOrCreateIdentity, loadIdentity, ensureDir } from "./keys.js";
import {
  register,
  deregister,
  loadRegistration,
  listAgents,
  mintNegotiationThread,
  validateNegotiationThread,
  closeNegotiationThread,
  RegistryHttpError,
  type ProximityOpts,
} from "./pool.js";
import {
  loadObservation,
  saveObservation,
  emptyObservation,
  seedDummyObservation,
  eligibilityReport,
  isEligible,
  isMinimumViable,
  isStale,
} from "./profile.js";
import { assertMatchclawDevEnabled } from "./config.js";
import {
  loadThread,
  listActiveThreads,
  initiateNegotiation,
  receiveMessage,
  sendMessage,
  proposeMatch,
  declineMatch,
  expireStaleThreads,
  saveThread,
} from "./threads.js";
import {
  loadPreferences,
  savePreferences,
  formatPreferences,
} from "./filters.js";
import {
  checkRelayConnectivity,
  subscribeToMessages,
  DEFAULT_RELAYS,
} from "./relay.js";
import {
  writePendingNotificationIfMatched,
  advanceHandoff,
  listActiveHandoffs,
  loadHandoffState,
} from "./introduction.js";
import {
  recordNegotiationOutcome,
  shouldAvoidPeer,
} from "./history.js";
import {
  analyzeConfidence,
  buildEnhancedNarrative,
  generateFocusPrompt,
} from "./confidence.js";
import type {
  ContactType,
  ObservationSummary,
  MatchNarrative,
  UserPreferences,
} from "./schema.js";
import { VALID_CONTACT_TYPES } from "./schema.js";

// Parse all flags and positional arguments from argv
const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "contact-type": { type: "string" },
    "contact-value": { type: "string" },
    show: { type: "boolean" },
    update: { type: "boolean" },
    write: { type: "string" },
    seed: { type: "boolean" },
    "seed-b": { type: "boolean" },
    set: { type: "string" },
    relays: { type: "boolean" },
    start: { type: "boolean" },
    status: { type: "boolean" },
    reset: { type: "boolean" },
    "repair-double-lock": { type: "boolean" },
    thread: { type: "string" },
    send: { type: "string" },
    receive: { type: "string" },
    peer: { type: "string" },
    type: { type: "string" },
    propose: { type: "boolean" },
    decline: { type: "boolean" },
    messages: { type: "boolean" },
    round: { type: "string" },
    "match-id": { type: "string" },
    consent: { type: "string" },
    prompt: { type: "string" },
    response: { type: "string" },
    "opt-out": { type: "boolean" },
    exchange: { type: "boolean" },
    reason: { type: "string" },
    guidance: { type: "boolean" },
    content: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

// The first positional is always the subcommand name

// ---------------------------------------------------------------------------
// Utility: persist a finished thread to negotiation history (fire-and-forget).
// Only runs when the thread reached a terminal state (matched/declined/expired).
// ---------------------------------------------------------------------------
async function persistOutcomeIfTerminal(
  thread: Awaited<ReturnType<typeof loadThread>>,
  declineReason?: string,
): Promise<void> {
  if (!thread) return;
  const terminalStates = ["matched", "declined", "expired"] as const;
  if (!terminalStates.includes(thread.status as (typeof terminalStates)[number])) {
    return;
  }
  const currentObs = await loadObservation();
  try {
    await recordNegotiationOutcome(
      thread,
      currentObs ?? emptyObservation(),
      declineReason ?? thread.closeReason,
    );
  } catch {
    // History recording is best-effort — never block the caller
  }
}

// ---------------------------------------------------------------------------
// Top-level dispatch — command registry
// ---------------------------------------------------------------------------

type CommandFn = () => Promise<void>;

const commands = new Map<string, CommandFn>([
  ["setup",       runSetup],
  ["heartbeat",   runHeartbeat],
  ["status",      runStatus],
  ["observe",     runObserve],
  ["preferences", runPreferences],
  ["match",       runMatch],
  ["handoff",     runHandoff],
  ["deregister",  runDeregister],
]);

async function main(): Promise<void> {
  await ensureDir();

  const cmd = positionals[0];
  const handler = cmd ? commands.get(cmd) : undefined;

  if (!handler) {
    console.log(`MatchClaw CLI — https://agent.lamu.life

Commands:
  setup        Create an identity and enroll with MatchClaw
  status       Display registration and observation state
  observe      Inspect, refresh, or seed the observation (--seed / --seed-b for two dev personas)
  preferences  View or configure Layer 0 matching filters (gender, location, age)
  match        Handle matching negotiations
  handoff      Step through post-match handoff rounds (1→2→3)
  deregister   Withdraw from the matching pool

Append --help to any command to see available options.`);
    return;
  }

  await handler();
}

// ---------------------------------------------------------------------------
// setup — create or load identity, register contact channel with the registry
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  const identity = await getOrCreateIdentity();

  const chosenContactType = (flags["contact-type"] ?? "email") as ContactType;
  const chosenContactValue = flags["contact-value"] as string | undefined;

  // If no contact value provided, prompt the user with example commands
  if (!chosenContactValue) {
    console.log(`Identity created. npub: ${identity.npub}

A contact channel is required to finish setup:
  matchclaw setup --contact-type email --contact-value you@example.com
  matchclaw setup --contact-type discord --contact-value username#1234
  matchclaw setup --contact-type telegram --contact-value @handle
  matchclaw setup --contact-type signal --contact-value +15550001234
  matchclaw setup --contact-type phone --contact-value +15550001234
  matchclaw setup --contact-type instagram --contact-value @handle
  matchclaw setup --contact-type twitter --contact-value @handle
  matchclaw setup --contact-type linkedin --contact-value linkedin.com/in/yourprofile
  matchclaw setup --contact-type matrix --contact-value @user:matrix.org
  matchclaw setup --contact-type line --contact-value line_id`);
    return;
  }

  if (!VALID_CONTACT_TYPES.has(chosenContactType)) {
    console.error(
      `Unrecognised --contact-type. Accepted values are: ${[...VALID_CONTACT_TYPES].join(", ")}`,
    );
    process.exit(1);
  }

  // The registry hosts an agent-card on behalf of agents that run locally and
  // cannot expose /.well-known/agent-card.json themselves. Override with
  // MATCHCLAW_CARD_URL if you self-host your card.
  const registryBase =
    process.env["MATCHER_REGISTRY_URL"] ??
    process.env["MATCHCLAW_REGISTRY_URL"] ??
    "https://agent.lamu.life";
  const agentCardUrl =
    process.env["MATCHCLAW_CARD_URL"] ??
    `${registryBase}/agents/${identity.npub}/card`;

  const storedPrefs = await loadPreferences();
  const regResult = await register(
    identity,
    agentCardUrl,
    { type: chosenContactType, value: chosenContactValue },
    storedPrefs.location,
    storedPrefs.max_radius_km,
  );

  // Write preferences even when the user set none — this lets the gateway
  // detect that setup completed (presence of preferences.json). Without this,
  // restarting the gateway would re-trigger the needsPreferences prompt.
  await savePreferences(storedPrefs);

  console.log(`Enrolled with MatchClaw.
  pubkey:  ${regResult.pubkey}
  contact: ${regResult.contact_channel.type} / ${regResult.contact_channel.value}${regResult.location_label ? `\n  location: ${regResult.location_label} (${regResult.location_resolution})` : ""}

After a few conversations, run 'matchclaw observe --update' to build your personality model.`);
}

// ---------------------------------------------------------------------------
// heartbeat — re-register with stored credentials to refresh lastSeen
// ---------------------------------------------------------------------------

async function runHeartbeat(): Promise<void> {
  const currentIdentity = await loadIdentity();
  if (!currentIdentity) {
    console.error("Setup required. Run: matchclaw setup");
    process.exit(1);
  }
  const existingReg = await loadRegistration();
  if (!existingReg) {
    console.error("No registration found. Run: matchclaw setup");
    process.exit(1);
  }
  const currentPrefs = await loadPreferences();
  await register(
    currentIdentity,
    existingReg.card_url,
    existingReg.contact_channel,
    currentPrefs.location,
    currentPrefs.max_radius_km,
  );
  console.log(`Heartbeat delivered. pubkey: ${currentIdentity.npub.slice(0, 16)}...`);
}

// ---------------------------------------------------------------------------
// status — display registration, observation, preferences, and active threads
// ---------------------------------------------------------------------------

async function runStatus(): Promise<void> {
  const currentIdentity = await loadIdentity();
  if (!currentIdentity) {
    console.log("Setup not completed. Run: matchclaw setup");
    return;
  }

  console.log(`Identity: ${currentIdentity.npub.slice(0, 16)}...`);

  const existingReg = await loadRegistration();
  console.log(`Registration: ${existingReg?.enrolled ? "active" : "not registered"}`);

  const currentObs = await loadObservation();
  if (!currentObs) {
    console.log("Observation: none — run 'matchclaw observe --update' to create one");
  } else {
    console.log(`\nObservation eligibility:\n${eligibilityReport(currentObs)}`);
    const fullyEligible = isEligible(currentObs);
    const mveEligible = isMinimumViable(currentObs);
    console.log(
      `\nPool eligible: ${fullyEligible ? "YES (full)" : mveEligible ? "YES (MVE — T1+T2 only)" : "NO"}`,
    );
    if (isStale(currentObs)) {
      console.log("⚠ Manifest is out of date — run 'matchclaw observe --update'");
    }
  }

  const currentPrefs = await loadPreferences();
  console.log(`\nPreferences: ${formatPreferences(currentPrefs)}`);

  const openThreads = await listActiveThreads();
  if (openThreads.length > 0) {
    console.log(`\nOpen negotiations: ${openThreads.length}`);
  }

  if (flags["relays"]) {
    console.log("\nRelay reachability:");
    const relayMap = await checkRelayConnectivity();
    for (const [relayUrl, reachable] of Object.entries(relayMap)) {
      console.log(`  ${reachable ? "✓" : "✗"} ${relayUrl}`);
    }
  }
}

// ---------------------------------------------------------------------------
// observe — show, write, seed, or prompt an update for the observation summary
// ---------------------------------------------------------------------------

async function runObserve(): Promise<void> {
  // Print the current observation as JSON
  if (flags["show"]) {
    const currentObs = await loadObservation();
    if (!currentObs) {
      console.log("No observation summary has been created yet.");
    } else {
      console.log(JSON.stringify(currentObs, null, 2));
    }
    return;
  }

  // Write a new observation from provided JSON
  if (flags["write"]) {
    const rawJson = flags["write"] as string;
    let parsedObs: ObservationSummary;
    try {
      parsedObs = JSON.parse(rawJson) as ObservationSummary;
    } catch {
      console.error("Invalid JSON");
      process.exit(1);
    }
    try {
      await saveObservation(parsedObs);
    } catch (err) {
      console.error(
        `Observation could not be saved — verify the JSON matches the ObservationSummary schema.\n` +
          `Every dimension requires: { confidence, evidenceCount, signalDiversity } and optionally value (rule-based) or content (LLM-based)\n` +
          `Expected dimensions: attachmentType, mbti, zodiac, interests, moralEthicalAlignment, familyLifeGoalsAlignment, lifestyleRelationalBeliefs\n` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    console.log(`ObservationSummary written. Eligible: ${isEligible(parsedObs)}`);
    return;
  }

  // Populate with synthetic data — only when MATCHCLAW_DEV=1
  if (flags["seed"] && flags["seed-b"]) {
    console.error("Use only one of --seed (persona A) or --seed-b (persona B).");
    process.exit(1);
  }
  if (flags["seed-b"]) {
    assertMatchclawDevEnabled("observe --seed-b");
    const dummyObs = seedDummyObservation("b");
    await saveObservation(dummyObs);
    console.log(
      "Dummy observation persona B seeded (eligible for matching). Dev/testing only.",
    );
    console.log(`Eligible: ${isEligible(dummyObs)}`);
    return;
  }
  if (flags["seed"]) {
    assertMatchclawDevEnabled("observe --seed");
    const dummyObs = seedDummyObservation("a");
    await saveObservation(dummyObs);
    console.log(
      "Dummy observation persona A seeded (eligible for matching). Intended for dev/testing only, or when the observation phase has been explicitly bypassed.",
    );
    console.log(`Eligible: ${isEligible(dummyObs)}`);
    return;
  }

  // Emit current observation plus instructions for Claude to review and update it
  if (flags["update"]) {
    const baseObs = (await loadObservation()) ?? emptyObservation();
    console.log("CURRENT_OBSERVATION:");
    console.log(JSON.stringify(baseObs, null, 2));
    console.log("\nREVIEW_INSTRUCTIONS:");
    console.log(
      "Go through what you know about this user and revise the MatchClaw soft-scoring dimensions shown above.\n" +
        "Each dimension requires:\n" +
        "  confidence: 0.0–1.0 (certainty level)\n" +
        "  evidenceCount: number of distinct signals observed\n" +
        "  signalDiversity: low/medium/high\n" +
        "  value: applicable to attachmentType, mbti, zodiac (e.g. Secure, INTJ, Aries)\n" +
        "  content: applicable to interests, moralEthicalAlignment, familyLifeGoalsAlignment, lifestyleRelationalBeliefs (free text for LLM comparison)\n" +
        "Assign gateState as: confirmed | below_floor | none_observed\n\n" +
        "Once finished, persist with:\n" +
        "  matchclaw observe --write '<updated-json>'",
    );
    return;
  }

  console.log(
    "Expected usage: matchclaw observe --show | --update | --write '<json>' | --seed | --seed-b (seed flags need MATCHCLAW_DEV=1)",
  );
}

// ---------------------------------------------------------------------------
// preferences — show or persist Layer 0 matching filters
// ---------------------------------------------------------------------------

async function runPreferences(): Promise<void> {
  if (flags["show"]) {
    const currentPrefs = await loadPreferences();
    console.log(JSON.stringify(currentPrefs, null, 2));
    console.log(`\n${formatPreferences(currentPrefs)}`);
    return;
  }

  if (flags["set"]) {
    const rawJson = flags["set"] as string;
    let parsedPrefs: UserPreferences;
    try {
      parsedPrefs = JSON.parse(rawJson) as UserPreferences;
    } catch {
      console.error("Invalid JSON");
      process.exit(1);
    }
    await savePreferences(parsedPrefs);
    console.log(`Preferences stored.\n${formatPreferences(parsedPrefs)}`);
    console.log(
      "\nNote: relationship intent (serious vs. casual) is not configured here — it is inferred by Claude from your behaviour.",
    );
    return;
  }

  console.log(`Usage:
  matchclaw preferences --show
  matchclaw preferences --set '{"gender_filter":["woman"],"location":"London, UK","age_range":{"min":25,"max":40}}'

Fields:
  gender_filter       Array of strings, e.g. ["woman", "non-binary"]. Leave empty to disable the filter.
  location            Free text, e.g. "London, UK". Proximity is determined by the agent.
  age_range           Object with optional min/max fields, e.g. {"min": 25, "max": 40}

Note: relationship intent (serious vs. casual) is NOT configured here — Claude derives it from your behaviour.`);
}

// ---------------------------------------------------------------------------
// match — all negotiation subcommands live here
// ---------------------------------------------------------------------------

async function runMatch(): Promise<void> {
  const currentIdentity = await loadIdentity();

  // --receive is checked before the registry because its value can be an empty
  // string — truthiness-based detection would silently skip it.
  if (flags["receive"] !== undefined) {
    await handleMatchReceive(currentIdentity);
    return;
  }
  if (flags["send"]) {
    await handleMatchSend(currentIdentity);
    return;
  }

  // Remaining subcommands are dispatched via a flag → handler registry.
  // Entries are ordered so the most defensive operations (reset, repair) are first.
  type MatchEntry = readonly [string, () => Promise<void>];
  const subcommandRegistry: MatchEntry[] = [
    ["reset",              () => handleMatchReset()],
    ["repair-double-lock", () => handleRepairDoubleLock(currentIdentity)],
    ["messages",           () => handleMatchMessages()],
    ["guidance",           () => handleMatchGuidance()],
    ["status",             () => handleMatchStatus()],
    ["propose",            () => handleMatchPropose(currentIdentity)],
    ["decline",            () => handleMatchDecline(currentIdentity)],
    ["start",              () => handleMatchStart(currentIdentity)],
  ];

  for (const [flag, handler] of subcommandRegistry) {
    if (flags[flag as keyof typeof flags]) {
      await handler();
      return;
    }
  }

  console.log(`Usage:
  matchclaw match --start                                         Open a new negotiation
  matchclaw match --status [--thread <id>]                       Display negotiation state
  matchclaw match --messages --thread <id>                       Retrieve conversation history
  matchclaw match --receive '<content>' --thread <id> --peer <pubkey>
                                                                  Record an inbound message (from poll.js output)
  matchclaw match --send '<msg>' --thread <id>                   Transmit a message
  matchclaw match --propose --thread <id> --write '<narrative-json>'
  matchclaw match --decline --thread <id> [--reason '<text>']    Close the negotiation
  matchclaw match --guidance --thread <id>                       Fetch the round-specific focus prompt
  matchclaw match --reset --thread <id>                           Force thread state to reset (MATCHCLAW_DEV=1)`);
}

// ---- match subcommand handlers ----

async function handleMatchReset(): Promise<void> {
  assertMatchclawDevEnabled("match --reset");
  const tid = flags["thread"] as string | undefined;
  if (!tid) {
    console.error("A thread must be specified: matchclaw match --reset --thread <id>");
    process.exit(1);
  }
  const threadState = await loadThread(tid);
  if (!threadState) {
    console.log(`Thread ${tid} not found.`);
    return;
  }
  threadState.status = "declined";
  await saveThread(threadState);
  console.log(`Thread ${tid} marked as declined.`);
}

async function handleRepairDoubleLock(
  currentIdentity: Awaited<ReturnType<typeof loadIdentity>>,
): Promise<void> {
  assertMatchclawDevEnabled("match --repair-double-lock");
  if (!currentIdentity) {
    console.error("Setup required. Run: matchclaw setup");
    process.exit(1);
  }
  const tid = flags["thread"] as string | undefined;
  if (!tid) {
    console.error("Thread is required: matchclaw match --repair-double-lock --thread <id>");
    process.exit(1);
  }
  const threadState = await loadThread(tid);
  if (!threadState) {
    console.log(`Thread ${tid} not found.`);
    return;
  }
  if (threadState.status !== "in_progress") {
    console.log(
      `Thread is in state '${threadState.status}', not in_progress. Nothing to repair.`,
    );
    return;
  }
  if (!threadState.ourProposal) {
    console.log("No proposal has been sent yet. Run match --propose first.");
    return;
  }

  // Go back 1 hour before the thread started to catch any missed messages
  const threadStartSec = new Date(threadState.openedAt).getTime() / 1000;
  const pollSinceTs = Math.floor(threadStartSec) - 3600;

  const { spawnSync } = await import("node:child_process");
  const { join: pathJoin } = await import("node:path");
  const { homedir } = await import("node:os");
  const stateRoot =
    process.env["OPENCLAW_STATE_DIR"] ?? pathJoin(homedir(), ".openclaw");

  let pollEntryPoint = pathJoin(
    stateRoot,
    "extensions",
    "matchclaw-plugin",
    "dist",
    "poll.js",
  );
  if (!existsSync(pollEntryPoint)) {
    pollEntryPoint = join(dirname(fileURLToPath(import.meta.url)), "poll.js");
  }

  const pollResult = spawnSync(
    process.execPath,
    [pollEntryPoint],
    {
      env: {
        ...process.env,
        MATCHCLAW_POLL_SINCE_OVERRIDE: String(pollSinceTs),
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );

  if (pollResult.error) {
    console.error(`Repair poll failed: ${pollResult.error.message}`);
    process.exit(1);
  }

  let repairSucceeded = false;
  for (const outputLine of (pollResult.stdout ?? "").split("\n")) {
    if (!outputLine.trim()) continue;
    try {
      const parsed = JSON.parse(outputLine) as {
        thread_id: string;
        peer_pubkey: string;
        type: string;
        content: string;
      };
      if (parsed.thread_id !== tid || parsed.type !== "match_propose") continue;

      const updatedThread = await receiveMessage(
        parsed.thread_id,
        parsed.peer_pubkey,
        parsed.content,
        parsed.type,
      );
      if (updatedThread?.status === "matched") {
        repairSucceeded = true;
        try {
          writePendingNotificationIfMatched(
            updatedThread.thread_id,
            updatedThread.remoteKey,
            updatedThread.sharedNarrative ?? {
              summary: "",
              strengths: [],
              tensions: [],
              compatSummary: "",
            },
            updatedThread.remoteContact,
          );
        } catch (notifErr) {
          process.stderr.write(
            `Warning: notification write failed — ${notifErr instanceof Error ? notifErr.message : String(notifErr)}\n`,
          );
        }
        await persistOutcomeIfTerminal(updatedThread);
        console.log("MATCH CONFIRMED — repair was successful.");
        console.log(
          "Headline:",
          updatedThread.sharedNarrative?.summary ?? "(pending)",
        );
        return;
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  if (!repairSucceeded) {
    console.log(
      "No matching match_propose from the peer was found for this thread. Execute from a host with Nostr relay access (the poll may time out in a sandboxed environment).",
    );
  }
}

async function handleMatchMessages(): Promise<void> {
  const tid = flags["thread"] as string | undefined;
  if (!tid) {
    console.error("A thread ID is required: matchclaw match --messages --thread <id>");
    process.exit(1);
  }
  const threadState = await loadThread(tid);
  if (!threadState) {
    console.log(`Thread ${tid} not found.`);
    return;
  }
  for (const entry of threadState.messages) {
    const label = entry.role === "us" ? "YOU" : "PEER";
    console.log(`\n[${label} — ${entry.timestamp}]\n${entry.content}`);
  }
}

async function handleMatchGuidance(): Promise<void> {
  const tid = flags["thread"] as string | undefined;
  if (!tid) {
    console.error("Thread ID is required: matchclaw match --guidance --thread <id>");
    process.exit(1);
  }
  const threadState = await loadThread(tid);
  if (!threadState) {
    console.log(`Thread ${tid} not found.`);
    return;
  }
  if (threadState.status !== "in_progress") {
    console.log(`Thread is not currently active (status: ${threadState.status}).`);
    return;
  }
  const currentObs = await loadObservation();
  const obsForAnalysis = currentObs ?? emptyObservation();
  const confidenceAnalysis = analyzeConfidence(obsForAnalysis);
  const focusText = generateFocusPrompt(threadState.sentRounds, confidenceAnalysis);
  if (focusText) {
    console.log(focusText);
  } else {
    console.log(`Round ${threadState.sentRounds}. No specific focus for this round.`);
  }
}

async function handleMatchStatus(): Promise<void> {
  const tid = flags["thread"] as string | undefined;
  if (tid) {
    const threadState = await loadThread(tid);
    if (!threadState) {
      console.log(`Thread ${tid} not found.`);
    } else {
      console.log(
        JSON.stringify(
          {
            ...threadState,
            messages: `(${threadState.messages.length} messages — use --messages to view)`,
          },
          null,
          2,
        ),
      );
      if (threadState.status === "matched") {
        console.log("\nMATCH CONFIRMED.");
        console.log(
          "Headline:",
          threadState.sharedNarrative?.summary ?? "(pending)",
        );
      }
    }
  } else {
    const openThreads = await listActiveThreads();
    if (openThreads.length === 0) {
      console.log("No negotiations are currently open.");
    } else {
      console.log(`Active negotiations: ${openThreads.length}`);
      for (const t of openThreads) {
        console.log(`  Thread ${t.thread_id.slice(0, 8)}... — ${t.status}`);
      }
    }
  }
}

async function handleMatchReceive(
  currentIdentity: Awaited<ReturnType<typeof loadIdentity>>,
): Promise<void> {
  if (!currentIdentity) {
    console.error("Setup required. Run: matchclaw setup");
    process.exit(1);
  }
  const msgContent = flags["receive"] as string;
  const tid = flags["thread"] as string | undefined;
  const peerKey = flags["peer"] as string | undefined;
  if (!tid || !peerKey) {
    console.error(
      "Usage: matchclaw match --receive '<content>' --thread <id> --peer <pubkey>",
    );
    process.exit(1);
  }

  const rawMsgType = flags["type"] as string | undefined;
  if (
    rawMsgType !== undefined &&
    rawMsgType !== "negotiation" &&
    rawMsgType !== "match_propose" &&
    rawMsgType !== "end"
  ) {
      console.error(
        `Unrecognised --type "${rawMsgType}". Accepted values: negotiation, match_propose, or end`,
      );
    process.exit(1);
  }

  const resolvedType = rawMsgType ?? "negotiation";

  // If this thread is new locally, validate it exists in the registry before
  // creating local state — prevents orphaned or spoofed threads accumulating on disk.
  const existingLocal = await loadThread(tid);
  if (!existingLocal) {
    const knownByRegistry = await validateNegotiationThread(tid);
    if (!knownByRegistry) {
      console.error(
        `Thread ${tid.slice(0, 8)}... not found in registry — rejecting inbound message`,
      );
      process.exit(1);
    }
  }

  const updatedThread = await receiveMessage(tid, peerKey, msgContent, resolvedType);
  if (!updatedThread) {
    console.error(
      `Inbound message was rejected — the thread ID may be invalid, the thread may be closed, or the rate cap has been reached`,
    );
    process.exit(1);
  }

  console.log(
    `Message recorded. Thread ${tid.slice(0, 8)}... — status: ${updatedThread.status}`,
  );

  if (updatedThread.status === "matched") {
    if (!updatedThread.sharedNarrative) {
      process.stderr.write(
        `Warning: the peer sent no parseable match narrative — notification written with an empty narrative. ` +
          `The peer may be on an older client version.\n`,
      );
    }
    try {
      writePendingNotificationIfMatched(
        updatedThread.thread_id,
        updatedThread.remoteKey,
        updatedThread.sharedNarrative ?? {
          summary: "",
          strengths: [],
          tensions: [],
          compatSummary: "",
        },
        updatedThread.remoteContact,
      );
    } catch (notifErr) {
      process.stderr.write(
        `Warning: notification could not be written — the match IS confirmed, but pending_notification.json was not created. ` +
          `Run 'matchclaw match --status --thread ${updatedThread.thread_id}' to review the match.\n` +
          `Error: ${notifErr instanceof Error ? notifErr.message : String(notifErr)}\n`,
      );
    }
    console.log("MATCH CONFIRMED.");
    console.log("Summary:", updatedThread.sharedNarrative?.summary ?? "(pending)");
    console.log(
      "Notification queued — Claude will bring this up organically in the next session.",
    );
  }
  if (updatedThread.status !== "in_progress") {
    void closeNegotiationThread(currentIdentity, updatedThread.thread_id);
  }
  await persistOutcomeIfTerminal(updatedThread);
}

async function handleMatchSend(
  currentIdentity: Awaited<ReturnType<typeof loadIdentity>>,
): Promise<void> {
  if (!currentIdentity) {
    console.error("Setup required. Run: matchclaw setup");
    process.exit(1);
  }
  const msgBody = flags["send"] as string;
  const tid = flags["thread"] as string | undefined;
  if (!tid) {
    console.error("Provide a thread ID: matchclaw match --send '<msg>' --thread <id>");
    process.exit(1);
  }
  await sendMessage(currentIdentity.nsec, tid, msgBody, DEFAULT_RELAYS);
  console.log(`Message dispatched (thread ${tid.slice(0, 8)}...)`);
}

async function handleMatchPropose(
  currentIdentity: Awaited<ReturnType<typeof loadIdentity>>,
): Promise<void> {
  if (!currentIdentity) {
    console.error("Setup required. Run: matchclaw setup");
    process.exit(1);
  }
  const tid = flags["thread"] as string | undefined;
  if (!tid) {
    console.error(
      "Thread ID is required: matchclaw match --propose --thread <id> --write '<json>'",
    );
    process.exit(1);
  }
  const narrativeRaw = flags["write"] as string | undefined;
  if (!narrativeRaw) {
    console.error(
      "A match narrative is required via --write '<json>'\n" +
        'Example: matchclaw match --propose --thread <id> --write \'{"summary":"...","strengths":[],"tensions":[],"compatSummary":"..."}\'',
    );
    process.exit(1);
  }

  let parsedNarrative: MatchNarrative;
  try {
    parsedNarrative = JSON.parse(narrativeRaw) as MatchNarrative;
  } catch {
    console.error("The narrative JSON could not be parsed.");
    process.exit(1);
  }

  // Enrich the narrative with confidence signals derived from the observation
  const currentObs = await loadObservation();
  if (currentObs) {
    const confidenceData = analyzeConfidence(currentObs);
    parsedNarrative = buildEnhancedNarrative(parsedNarrative, confidenceData);
  }

  const ownReg = await loadRegistration();
  if (!ownReg) {
    process.stderr.write(
      `Warning: no registration on file — the proposal will go out without your contact details. ` +
        `Run 'matchclaw setup' to resolve this before proposing.\n`,
    );
  }

  const proposalResult = await proposeMatch(
    currentIdentity,
    tid,
    parsedNarrative,
    DEFAULT_RELAYS,
    ownReg?.contact_channel,
  );

  if (proposalResult.status === "matched") {
    if (!proposalResult.sharedNarrative) {
      process.stderr.write(
        `Warning: the peer sent no parseable match narrative — notification written with an empty narrative. ` +
          `The peer may be on an older client version.\n`,
      );
    }
    try {
      writePendingNotificationIfMatched(
        proposalResult.thread_id,
        proposalResult.remoteKey,
        proposalResult.sharedNarrative ?? {
          summary: "",
          strengths: [],
          tensions: [],
          compatSummary: "",
        },
        proposalResult.remoteContact,
      );
    } catch (notifErr) {
      process.stderr.write(
        `Warning: notification could not be written — the match IS confirmed, but pending_notification.json was not created. ` +
          `Run 'matchclaw match --status --thread ${proposalResult.thread_id}' to review the match.\n` +
          `Error: ${notifErr instanceof Error ? notifErr.message : String(notifErr)}\n`,
      );
    }
    console.log("MATCH CONFIRMED.");
    console.log("Summary:", proposalResult.sharedNarrative?.summary ?? "(pending)");
    console.log(
      "Notification queued — Claude will bring this up organically in the next session.",
    );
  } else {
    console.log(`Proposal submitted. Awaiting the peer's proposal.`);
  }

  if (proposalResult.status === "matched") {
    await persistOutcomeIfTerminal(proposalResult);
  }
}

async function handleMatchDecline(
  currentIdentity: Awaited<ReturnType<typeof loadIdentity>>,
): Promise<void> {
  if (!currentIdentity) {
    console.error("Setup required. Run: matchclaw setup");
    process.exit(1);
  }
  const tid = flags["thread"] as string | undefined;
  if (!tid) {
    console.error("Thread ID is required: matchclaw match --decline --thread <id>");
    process.exit(1);
  }
  const declineText = flags["reason"] as string | undefined;
  await declineMatch(currentIdentity, tid, DEFAULT_RELAYS, declineText);
  const closedThread = await loadThread(tid);
  await persistOutcomeIfTerminal(closedThread, declineText);
  console.log(`Negotiation closed (thread ${tid.slice(0, 8)}...)`);
}

async function handleMatchStart(
  currentIdentity: Awaited<ReturnType<typeof loadIdentity>>,
): Promise<void> {
  if (!currentIdentity) {
    console.error("Setup required. Run: matchclaw setup");
    process.exit(1);
  }

  const currentObs = await loadObservation();
  if (!currentObs || (!isEligible(currentObs) && !isMinimumViable(currentObs))) {
    console.error("The observation is not yet eligible for matching. Run: matchclaw status");
    process.exit(1);
  }

  if (isStale(currentObs)) {
    console.error(
      "The observation manifest is out of date. Run: matchclaw observe --update\n" +
        "Refreshing it ensures the most recent context is applied during matching.",
    );
    process.exit(1);
  }

  // Expire old threads before looking for new peers
  const expiredList = await expireStaleThreads(currentIdentity, DEFAULT_RELAYS);
  for (const expiredThread of expiredList) {
    await persistOutcomeIfTerminal(expiredThread);
  }

  // Build a geographic proximity filter from saved registration + prefs
  const storedPrefs = await loadPreferences();
  const storedReg = await loadRegistration();
  let geoFilter: ProximityOpts | undefined;
  if (
    storedReg?.location_lat != null &&
    storedReg?.location_lng != null &&
    storedPrefs.max_radius_km != null
  ) {
    geoFilter = {
      lat: storedReg.location_lat,
      lng: storedReg.location_lng,
      radiusKm: storedPrefs.max_radius_km,
    };
  }

  const { agents: poolAgents, onlyTwoInPool } = await listAgents(geoFilter);

  // Age range and gender preference are never stored in the registry (privacy).
  // Claude enforces them locally before calling --propose (see skill.md Step 4.5).
  const openThreads = await listActiveThreads();
  const alreadyNegotiating = new Set(openThreads.map((t) => t.remoteKey));

  // Only consider agents active within the last 2 hours — avoids matching against
  // stale registry entries whose private keys may no longer exist
  const cutoffMs = Date.now() - 2 * 60 * 60 * 1000;
  let availablePeers = poolAgents.filter(
    (agent) =>
      agent.pubkey !== currentIdentity.npub &&
      !alreadyNegotiating.has(agent.pubkey) &&
      new Date(agent.lastSeen).getTime() > cutoffMs,
  );

  // Apply cooldown: skip peers we recently declined or whose threads expired.
  // All cooldown checks run in parallel; results are zipped back with the original array.
  const preCooldownCount = availablePeers.length;
  const cooldownFlags = await Promise.all(
    availablePeers.map((agent) => shouldAvoidPeer(agent.pubkey)),
  );
  availablePeers = availablePeers.filter((_, i) => !cooldownFlags[i]);

  if (availablePeers.length === 0) {
    const othersExist = poolAgents.filter((a) => a.pubkey !== currentIdentity.npub);
    if (othersExist.length === 0) {
      console.log("The pool has no other agents yet. Try again later.");
    } else {
      const recentOthers = othersExist.filter(
        (a) => new Date(a.lastSeen).getTime() > cutoffMs,
      );
      if (recentOthers.length === 0) {
        console.log(
          "All registry entries are more than 2 hours old — no recently-active agents are available. Try again later.",
        );
      } else if (preCooldownCount > 0) {
        console.log(
          "Every available agent is in a cooldown period (recently declined or expired). Come back in about a week.",
        );
      } else {
        console.log(
          "Negotiations are already open with all available agents. Check back later.",
        );
      }
    }
    return;
  }

  // Random peer selection spreads load and avoids always talking to the same agent
  const chosenPeer = availablePeers[Math.floor(Math.random() * availablePeers.length)]!;
  let threadId: string;
  try {
    threadId = await mintNegotiationThread(currentIdentity, chosenPeer.pubkey);
  } catch (err) {
    if (err instanceof RegistryHttpError) {
      console.error(err.message);
      return;
    }
    throw err;
  }
  const newThread = await initiateNegotiation(chosenPeer.pubkey, threadId);

  console.log(`Negotiation thread opened.`);
  if (onlyTwoInPool) {
    console.log(
      `\n[Only two agents in the pool — work toward a matched outcome. Apply lenient compatibility standards; the objective is to make an introduction.]`,
    );
  }
  console.log(`\nDraft your opening message. It should cover:`);
  console.log(`  - Your user's core values (Schwartz labels + confidence)`);
  console.log(`  - Dealbreaker result: pass or fail`);
  console.log(`  - Life phase + confidence`);
  if (
    currentObs.intentCategory &&
    currentObs.intentCategory !== "unclear"
  ) {
    console.log(
      `  - Inferred relationship intent: ${currentObs.intentCategory}` +
        ` (share this openly; end the negotiation immediately if the peer reveals a categorically incompatible intent)`,
    );
  }
  console.log(`  - One question directed at the peer\n`);
  console.log(`Deliver it using:`);
  console.log(
    `  matchclaw match --send '<your opening>' --thread ${newThread.thread_id}`,
  );
  console.log(`\nThen wait for their reply:`);

  // Set up SIGINT handler before the async subscription to avoid a race
  let stopListening: () => void = () => {};
  process.on("SIGINT", () => {
    stopListening();
    process.exit(0);
  });

  // Start listening for incoming Nostr messages
  stopListening = await subscribeToMessages(
    currentIdentity.nsec,
    currentIdentity.npub,
    async (senderPubkey, inboundMsg) => {
      const updatedThread = await receiveMessage(
        inboundMsg.thread_id,
        senderPubkey,
        inboundMsg.content,
        inboundMsg.type,
      );
      if (!updatedThread) return; // thread rejected (unknown id, closed, or rate-limited)

      if (updatedThread.status === "matched") {
        if (!updatedThread.sharedNarrative) {
          process.stderr.write(
            `Warning: the peer sent no parseable match narrative — notification written with an empty narrative. ` +
              `The peer may be on an older client version.\n`,
          );
        }
        try {
          writePendingNotificationIfMatched(
            updatedThread.thread_id,
            updatedThread.remoteKey,
            updatedThread.sharedNarrative ?? {
              summary: "",
              strengths: [],
              tensions: [],
              compatSummary: "",
            },
            updatedThread.remoteContact,
          );
        } catch (notifErr) {
          process.stderr.write(
            `Warning: notification could not be written — the match IS confirmed, but pending_notification.json was not created. ` +
              `Run 'matchclaw match --status --thread ${updatedThread.thread_id}' to review the match.\n` +
              `Error: ${notifErr instanceof Error ? notifErr.message : String(notifErr)}\n`,
          );
        }
        await persistOutcomeIfTerminal(updatedThread);
        console.log("\nMATCH CONFIRMED.");
        console.log(
          "Headline:",
          updatedThread.sharedNarrative?.summary ?? "(pending)",
        );
        console.log(
          "Notification queued — Claude will bring this up organically in the next session.",
        );
        stopListening();
        process.exit(0);
      }

      if (updatedThread.status === "declined") {
        await persistOutcomeIfTerminal(updatedThread);
        console.log("\nNegotiation concluded — no match this time.");
        stopListening();
        process.exit(0);
      }

      // For rounds 2, 5, 8 inject a focus prompt to guide the conversation
      const upcomingRound = updatedThread.sentRounds + 1;
      const roundFocus = (() => {
        if (!currentObs) return null;
        const confidenceData = analyzeConfidence(currentObs);
        return generateFocusPrompt(upcomingRound, confidenceData);
      })();

      console.log(`\n[matchclaw] Message received:`);
      if (roundFocus) {
        console.log(roundFocus);
        console.log("");
      }
      console.log(inboundMsg.content);
      console.log(
        "\nReply with: matchclaw match --send '<reply>' --thread " +
          inboundMsg.thread_id,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// handoff — post-match contact exchange (rounds 1→2)
// ---------------------------------------------------------------------------

async function runHandoff(): Promise<void> {
  const matchId = flags["match-id"] as string | undefined;

  // List all active handoffs when no match-id given
  if (!matchId && flags["status"]) {
    const openHandoffs = listActiveHandoffs();
    if (openHandoffs.length === 0) {
      console.log("There are no active handoffs.");
    } else {
      for (const h of openHandoffs) {
        console.log(
          `${h.introId.slice(0, 8)}... — round ${h.stage}/2 — ${h.status}`,
        );
      }
    }
    return;
  }

  if (!matchId) {
    console.log(`Usage:
  matchclaw handoff --status                                    Show all active handoffs
  matchclaw handoff --round 1 --match-id <id> --consent "<response>"
  matchclaw handoff --round 2 --match-id <id> --exchange
  matchclaw handoff --round 2 --match-id <id> --opt-out`);
    return;
  }

  const roundStr = flags["round"] as string | undefined;
  if (!roundStr) {
    // Show the current handoff state for a specific match
    const handoffState = loadHandoffState(matchId);
    if (!handoffState) {
      console.log(`No handoff found for ${matchId}.`);
    } else {
      console.log(JSON.stringify(handoffState, null, 2));
    }
    return;
  }

  const roundNum = parseInt(roundStr, 10) as 1 | 2;
  if (![1, 2].includes(roundNum)) {
    console.error("--round accepts only 1 or 2");
    process.exit(1);
  }

  const handoffResult = advanceHandoff(matchId, roundNum, {
    consent: flags["consent"] as string | undefined,
    optOut: flags["opt-out"] as boolean | undefined,
    exchange: flags["exchange"] as boolean | undefined,
  });
  console.log(handoffResult);
}

// ---------------------------------------------------------------------------
// deregister — remove agent from the matching pool
// ---------------------------------------------------------------------------

async function runDeregister(): Promise<void> {
  const currentIdentity = await loadIdentity();
  if (!currentIdentity) {
    console.error("No identity on file — there is nothing to deregister.");
    process.exit(1);
  }
  await deregister(currentIdentity);
  console.log(`Withdrawn from the pool. pubkey: ${currentIdentity.npub}`);
  console.log(
    "Local state (~/.matchclaw/) has been kept intact. You can re-enroll at any time with: matchclaw setup",
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
