import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { getAgentMatchDir } from "./keys.js";
import {
  loadSignals,
  saveSignals,
  pickPendingSignal,
  buildSignalInstruction,
  recordSignalDelivered,
} from "./insights.js";
import {
  loadPendingNotification,
  deletePendingNotification,
  buildMatchNotificationContext,
  getActiveHandoffContext,
} from "./introduction.js";
import { emptyObservation } from "./profile.js";
import {
  buildStaleObservationPrompt,
  buildBootstrapObservationPrompt,
  buildSessionEndObservationPrompt,
} from "./prompts.js";
import {
  loadPreferences,
  loadPreferencesSync,
  savePreferences,
  formatPreferences,
} from "./filters.js";
import { loadRegistrationSync } from "./pool.js";
import type { ObservationSummary } from "./schema.js";

// Reads the persisted observation summary for this user from disk.
// Returns null if the file is absent or cannot be parsed.
function readObservationFromDisk(): ObservationSummary | null {
  const filePath = join(getAgentMatchDir(), "observation.json");
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as ObservationSummary;
  } catch {
    return null;
  }
}

// Shape of the event object passed to every lifecycle hook by the runtime.
interface PluginEvent {
  type: string;
  action: string;
  messages: string[];
  sessionKey?: string;
}

// What before_prompt_build handlers may return to inject context into the LLM turn.
interface PluginHookBeforePromptBuildResult {
  prependContext?: string;
  systemPrompt?: string;
}

// Minimal surface of the OpenClaw plugin API that this plugin uses.
interface PluginAPI {
  // Typed overload for before_prompt_build — the runtime collects and merges return values.
  on(
    event: "before_prompt_build",
    handler: (
      event: PluginEvent,
    ) =>
      | PluginHookBeforePromptBuildResult
      | void
      | Promise<PluginHookBeforePromptBuildResult | void>,
  ): void;
  // Typed overloads for session/gateway lifecycle hooks — return values are ignored.
  on(
    event: "session_start" | "session_end" | "gateway_start" | "gateway_stop",
    handler: (event: PluginEvent) => void | Promise<void>,
  ): void;
  // Generic string-event hook registration — return values are always discarded.
  registerHook(
    event: string,
    handler: (event: PluginEvent) => void,
    meta?: { name?: string; description?: string },
  ): void;
  // Registers a tool that command-dispatch: tool can invoke.
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      id: string,
      params: { command?: string },
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }): void;
}

// Tracks which injections have already fired for each active session.
// Keyed by sessionKey (or "default"). Cleared and re-initialized on session_start
// so before_prompt_build — which runs on every LLM invocation — doesn't repeat them.
interface SessionState {
  signalDelivered: boolean;
  notificationDelivered: boolean;
  setupDelivered: boolean;
  observeUpdatePromptDelivered: boolean;
}

class SessionTracker {
  private readonly sessions = new Map<string, SessionState>();

  reset(key: string): void {
    this.sessions.set(key, {
      signalDelivered: false,
      notificationDelivered: false,
      setupDelivered: false,
      observeUpdatePromptDelivered: false,
    });
  }

  get(key: string): SessionState {
    if (!this.sessions.has(key)) this.reset(key);
    return this.sessions.get(key)!;
  }
}

// Persists across the lifetime of the gateway process.
// Sentinel files prevent these flags from causing repeated prompts after the first time.
class BootState {
  needsSetup = false;
  needsPreferences = false;

  checkIdentityFiles(matchDir: string): void {
    const identityPath = join(matchDir, "identity.json");
    const prefsPath = join(matchDir, "preferences.json");
    if (!existsSync(identityPath)) {
      this.needsSetup = true;
    } else if (!existsSync(prefsPath)) {
      this.needsPreferences = true;
    }
  }
}

// Builds the assembled context string from ordered fragments.
// Fragments are joined with the standard separator used throughout before_prompt_build.
class ContextBuilder {
  private readonly parts: string[] = [];

  add(fragment: string): this {
    this.parts.push(fragment);
    return this;
  }

  get count(): number {
    return this.parts.length;
  }

  build(): string | undefined {
    return this.parts.length > 0 ? this.parts.join("\n\n---\n\n") : undefined;
  }
}

// Handles invocations of the /matchclaw-prefs slash command.
// The model is structurally excluded from this turn (command-dispatch: tool),
// so no behavioral signal is inadvertently captured here.
//
// With no arguments: shows the current preferences.
// With arguments: updates whichever fields are present and saves.
class PrefsCommandHandler {
  // Parses key=value pairs out of raw slash-command argument strings.
  // Handles quoted values, e.g. location="New York, NY".
  // Walks the string character-by-character rather than using a regex so the
  // behaviour of each branch (quoted vs bare value, key boundaries) is explicit.
  private parseArgs(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    let i = 0;
    while (i < raw.length) {
      // skip leading whitespace
      while (i < raw.length && raw[i] === " ") i++;
      // find the next '='
      const eq = raw.indexOf("=", i);
      if (eq === -1) break;
      const key = raw.slice(i, eq).trim();
      i = eq + 1;
      let value: string;
      if (raw[i] === '"') {
        // quoted value — consume until closing '"'
        i++;
        const close = raw.indexOf('"', i);
        if (close === -1) {
          value = raw.slice(i);
          i = raw.length;
        } else {
          value = raw.slice(i, close);
          i = close + 1;
        }
      } else {
        // bare value — runs until next space
        const space = raw.indexOf(" ", i);
        if (space === -1) {
          value = raw.slice(i);
          i = raw.length;
        } else {
          value = raw.slice(i, space);
          i = space;
        }
      }
      if (key) result[key] = value;
    }
    return result;
  }

  async handle(rawArgs: string): Promise<string> {
    const currentPrefs = await loadPreferences();
    const argStr = rawArgs.trim();

    if (!argStr) {
      return (
        `Preferences panel — conversation here is purely logistical and ` +
        `does not register as a behavioral signal.\n\n` +
        `Preferences currently saved: ${formatPreferences(currentPrefs)}\n\n` +
        `To make changes: /matchclaw-prefs <field>=<value>\n` +
        `  location="City, Country"    the city or region you're based in\n` +
        `  distance=city               city (~50 km) | travel (~300 km) | anywhere\n` +
        `  age_min=25 age_max=35       age bracket; either end is optional\n` +
        `  gender=anyone               or a comma-separated list: man,woman,nonbinary`
      );
    }

    const fields = this.parseArgs(argStr);
    let anyFieldChanged = false;

    if (fields["location"] !== undefined) {
      currentPrefs.location = fields["location"];
      anyFieldChanged = true;
    }

    if (fields["distance"] !== undefined) {
      const distanceInput = fields["distance"].toLowerCase();
      if (distanceInput === "city") {
        currentPrefs.max_radius_km = 50;
      } else if (distanceInput === "travel") {
        currentPrefs.max_radius_km = 300;
      } else if (distanceInput === "anywhere") {
        delete currentPrefs.max_radius_km;
      } else {
        return `Unknown distance value "${fields["distance"]}". Use: city, travel, or anywhere.`;
      }
      anyFieldChanged = true;
    }

    if (fields["age_min"] !== undefined || fields["age_max"] !== undefined) {
      const ageRange = currentPrefs.age_range ?? {};
      if (fields["age_min"] !== undefined) {
        const parsed = parseInt(fields["age_min"], 10);
        if (isNaN(parsed)) return `Invalid age_min value: "${fields["age_min"]}"`;
        ageRange.min = parsed;
      }
      if (fields["age_max"] !== undefined) {
        const parsed = parseInt(fields["age_max"], 10);
        if (isNaN(parsed)) return `Invalid age_max value: "${fields["age_max"]}"`;
        ageRange.max = parsed;
      }
      currentPrefs.age_range = ageRange;
      anyFieldChanged = true;
    }

    if (fields["gender"] !== undefined) {
      const genderInput = fields["gender"].toLowerCase();
      currentPrefs.gender_filter =
        genderInput === "anyone" || genderInput === "any" || genderInput === ""
          ? []
          : genderInput
              .split(",")
              .map((token) => token.trim())
              .filter(Boolean);
      anyFieldChanged = true;
    }

    if (!anyFieldChanged) {
      return `No recognized fields in args. Supported fields: location, distance, age_min, age_max, gender.`;
    }

    await savePreferences(currentPrefs);

    return (
      `Done — preferences saved. Returning to the regular conversation, where behavioral signals apply again.\n\n` +
      `Preferences now on file: ${formatPreferences(currentPrefs)}`
    );
  }
}

// Resolves the state base directory and CLI/poll entrypoint paths from the environment.
// Computed once at module load so path strings are stable throughout the process lifetime.
function resolveCliPaths() {
  const base = process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw");
  return {
    base,
    cli: `node ${join(base, "extensions", "matchclaw-plugin", "dist", "index.js")}`,
    poll: join(base, "extensions", "matchclaw-plugin", "dist", "inbox.js"),
  };
}

const PATHS = resolveCliPaths();

// How many days an observation can sit unchanged before we nudge Claude to refresh it.
// Configurable via MATCHCLAW_OBSERVE_UPDATE_DAYS; defaults to 1.
const STALENESS_THRESHOLD_DAYS = parseInt(
  process.env["MATCHCLAW_OBSERVE_UPDATE_DAYS"] ?? "1",
  10,
);

// Registers the background heartbeat cron job by writing directly to jobs.json.
// There is no api.registerCron() — direct file write is the documented approach.
// This MUST run synchronously: OpenClaw loads cron jobs only at startup, so any
// job written after the scheduler initialises won't run until the next restart.
function registerHeartbeatCron(stateBaseDir: string, matchDir: string): void {
  try {
    const cronStorageDir = join(stateBaseDir, "cron");
    const cronJobsPath = join(cronStorageDir, "jobs.json");
    if (!existsSync(cronStorageDir)) {
      mkdirSync(cronStorageDir, { recursive: true });
    }

    // CronStoreFile on disk is either { version, jobs } or a bare array (legacy).
    type CronJobEntry = { id?: string; name?: string; [k: string]: unknown };
    type CronStoreFile = { version?: number; jobs: CronJobEntry[] };
    const diskContent = existsSync(cronJobsPath)
      ? (JSON.parse(readFileSync(cronJobsPath, "utf8")) as
          | CronStoreFile
          | CronJobEntry[])
      : { version: 1, jobs: [] };
    const jobStore: CronStoreFile = Array.isArray(diskContent)
      ? { version: 1, jobs: diskContent }
      : diskContent;

    const heartbeatAlreadyExists = jobStore.jobs.some(
      (entry) => entry.name === "matchclaw-heartbeat",
    );

    if (!heartbeatAlreadyExists) {
      // Default poll interval is 1 minute — keeps negotiations responsive.
      // The registry TTL is 24h so polling this frequently is fine.
      const heartbeatIntervalMs = parseInt(
        process.env["MATCHCLAW_CRON_INTERVAL_MS"] ?? "60000",
        10,
      );
      const creationTimestamp = Date.now();
      jobStore.jobs.push({
        id: randomUUID(),
        name: "matchclaw-heartbeat",
        enabled: true,
        createdAtMs: creationTimestamp,
        updatedAtMs: creationTimestamp,
        // Fixed interval schedule — fires every everyMs milliseconds.
        schedule: { kind: "every", everyMs: heartbeatIntervalMs },
        // Isolated sessions run without a user present in the conversation.
        sessionTarget: "isolated",
        // Match notifications are surfaced by before_prompt_build on the next
        // user message instead of announce mode, which requires a configured
        // channel and fails silently when that's missing.
        delivery: { mode: "none" },
        // "now" fires the job as soon as its schedule is due,
        // rather than waiting for the gateway heartbeat cycle.
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message:
            `MatchClaw data dir: ${matchDir} — thread files located at ${matchDir}/threads/<thread_id>.json (use this path for direct file reads; prefer agentmatch match --messages --thread <id>). ` +
            "Execute the MatchClaw background routine in order: " +
            `Step A — ${PATHS.cli} observe --show: retrieve your current observation for this user. ` +
            `Step B — ${PATHS.cli} heartbeat: renew registration. ` +
            `Step C — node "${PATHS.poll}": ` +
            `process each JSONL line — call ${PATHS.cli} match --receive '<content>' --thread <thread_id> --peer <peer_pubkey> --type <type> for each message. Handle per the protocol. ` +
            `Step D — ${PATHS.cli} match --status: review all active threads. ` +
            "Step E — When no active negotiation threads exist and matchclaw status reports poolEligible=true, " +
            `call ${PATHS.cli} match --start to locate a new candidate. ` +
            "Report only when a match has been confirmed — stay quiet if nothing has changed.",
        },
      });
      writeFileSync(cronJobsPath, JSON.stringify(jobStore, null, 2));
    }
  } catch {
    // Non-fatal — if file I/O fails, the heartbeat just won't be registered this boot.
  }
}

// Module-level instances — one per gateway process lifetime.
const tracker = new SessionTracker();
const boot = new BootState();
const prefsHandler = new PrefsCommandHandler();

export default {
  id: "matchclaw-plugin",
  name: "MatchClaw",
  description:
    "AI agent dating network — matched on who you actually are, not who you think you are",
  version: "0.1.22",
  kind: "lifecycle",

  register(api: PluginAPI): void {
    // ── Tool: matchclaw_update_prefs ────────────────────────────────────────────────
    // Wired up via command-dispatch: tool in skills/preferences/SKILL.md.
    // Because this is a tool turn, the model never sees the conversation during it,
    // so no behavioral observation can happen — this boundary is structural.
    api.registerTool({
      name: "matchclaw_update_prefs",
      description:
        "Modify MatchClaw matching preferences — location, distance radius, age range, and gender. " +
        "This executes as a tool turn, keeping the model out of the conversation so no behavioral signals are recorded.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "Raw slash-command args, e.g. 'location=\"London, UK\" distance=city age_min=25'",
          },
        },
        required: [],
      },
      execute: async (_id, params) => {
        const responseText = await prefsHandler.handle(params.command ?? "");
        return { content: [{ type: "text" as const, text: responseText }] };
      },
    });

    // ── Hook: gateway_start ────────────────────────────────────────────────────
    // Runs once when the gateway process initializes, after all plugins and channels load.
    // Sets boot-time flags that before_prompt_build uses to surface first-run guidance
    // on the next real user message — this approach works across all delivery surfaces
    // (WhatsApp, Telegram, Discord, group chats) unlike command:new which needs /new.
    api.on("gateway_start", (_evt) => {
      boot.checkIdentityFiles(getAgentMatchDir());
      registerHeartbeatCron(PATHS.base, getAgentMatchDir());
    });

    // ── Hook: session_start ────────────────────────────────────────────────────
    // Clears per-session delivery state at the beginning of each new session.
    // before_prompt_build fires on every LLM invocation within a session, so without
    // this reset signals and notifications would only ever fire on the very first session.
    api.on("session_start", (evt) => {
      const sessionId = evt.sessionKey ?? "default";
      tracker.reset(sessionId);
    });

    // ── Hook: before_prompt_build ──────────────────────────────────────────────
    // Invoked on every LLM turn. Assembles context fragments in priority order and
    // returns them as prependContext, which the runtime injects before the conversation.
    //
    // IMPORTANT: api.registerHook() silently discards return values — its handler type
    // is void only. api.on("before_prompt_build") is the sole correct API here because
    // the runtime's runBeforePromptBuild collects and merges its return values.
    //
    // Injection priority (first applicable wins for one-time items):
    //   0. Known preferences + contact channel (always, to prevent re-asking)
    //   0a. First-time setup or preferences-only guidance (once per gateway boot)
    //   1. Pending match notification (once per session)
    //   2. Active handoff round framing (every turn when applicable)
    //   3. Personality signal to surface naturally (once per session, gated)
    //   4. Stale observation refresh prompt, or bootstrap from history (once per session)
    api.on(
      "before_prompt_build",
      (evt: PluginEvent): PluginHookBeforePromptBuildResult | void => {
        const sessionId = evt.sessionKey ?? "default";
        const session = tracker.get(sessionId);
        const ctx = new ContextBuilder();

        // Always inject known preferences and contact so the agent never asks for
        // information it already has, even if setup ran in a different session.
        const userPrefs = loadPreferencesSync();
        const hasKnownPrefs =
          userPrefs.location ||
          (userPrefs.gender_filter && userPrefs.gender_filter.length > 0) ||
          userPrefs.age_range;

        if (hasKnownPrefs) {
          ctx.add(
            `[MatchClaw] Preferences on file (collected during setup — these are known, skip asking): ${formatPreferences(userPrefs)}`,
          );
          // If there's no observation yet, clarify what "nothing" means so the agent
          // doesn't falsely claim it has no information about the user.
          const existingObs = readObservationFromDisk();
          if (!existingObs) {
            ctx.add(
              `[MatchClaw] When asked what you know about the user: preferences are already on file from setup; behavioral observations accumulate through conversation over time. Saying you have "nothing" would be inaccurate — preferences count as information.`,
            );
          }
        }

        const registration = loadRegistrationSync();
        if (registration?.contact_channel) {
          const { type: channelType } = registration.contact_channel;
          ctx.add(
            `[MatchClaw] Contact channel already configured: ${channelType} — no need to request this`,
          );
        }

        // First-time setup or missing-preferences guidance — fires once per gateway boot.
        // before_prompt_build is used (not command:new) so it works on all message surfaces.
        if (!session.setupDelivered) {
          if (boot.needsSetup) {
            boot.needsSetup = false;
            session.setupDelivered = true;

            // If we already injected preferences/contact above, tell the agent to skip
            // re-collecting whatever it already has.
            const alreadyHaveNote =
              ctx.count > 1
                ? `\n\nSetup already complete above — do NOT ask for any of this again.\n\n`
                : ctx.count > 0
                  ? `\n\nIf preferences above are already complete, skip to contact only.\n\n`
                  : "";

            ctx.add(
              `[MatchClaw] First-time setup — Tone: trusted relationship guide; empathetic and precise; substantive over verbose; warm without being performative.${alreadyHaveNote}` +
                `Cover both steps in a single session — consolidate, do not spread across five separate questions:\n\n` +
                `Step 1 — Gather all four preference fields in one message: location, distance (city / travel / anywhere → 50 / 300 / omit), age range (optional), gender preference ([] if open to everyone). The user can answer everything at once; parse accordingly. Follow up only when a specific field is missing.\n\n` +
                `Step 2 — Once preferences are settled, ask separately about contact: briefly explain how introductions work and that both sides agree before anything is exchanged; then collect contact type and value (email, WhatsApp, Telegram, iMessage, Discord, Signal, Instagram, Twitter, LinkedIn, Matrix, LINE, phone number, or other).\n\n` +
                `Accept open or no-preference answers without challenge. Fields already on file should not be requested again.\n\n` +
                `Finish by running:\n` +
                `  ${PATHS.cli} setup --contact-type <type> --contact-value '<value>'\n` +
                `  ${PATHS.cli} preferences --set '<json>'`,
            );
            return { prependContext: ctx.build() };
          }

          if (boot.needsPreferences) {
            boot.needsPreferences = false;
            session.setupDelivered = true;

            const alreadyHaveNote = ctx.count > 0
              ? `\n\nPreferences above are already set — do NOT ask for them again. Skip collection.\n\n`
              : "";

            ctx.add(
              `[MatchClaw] Preferences have not been set. Tone: clear, warm, and grounded — relationship-guide energy.${alreadyHaveNote}` +
                `Request all four fields in a single message: location, distance (50 / 300 / omit), age range, and gender preference. The user can answer in one go; parse whatever they provide. Circle back only for genuinely missing pieces.\n\n` +
                `Take open or no-preference responses at face value — no pushback — then persist them:\n` +
                `  ${PATHS.cli} preferences --set '<json>'\n\n` +
                `Should they attempt to adjust preferences inside the main conversation later, calmly point them to /matchclaw-prefs instead.`,
            );
            return { prependContext: ctx.build() };
          }
        }

        // Inject a pending match notification exactly once per session.
        // The notification is deleted before being surfaced to prevent re-delivery
        // even if the session ends abnormally after this point.
        if (!session.notificationDelivered) {
          const pendingNotification = loadPendingNotification();
          if (pendingNotification) {
            deletePendingNotification();
            session.notificationDelivered = true;
            ctx.add(buildMatchNotificationContext(pendingNotification));
          }
        }

        // Inject active handoff framing on every turn where a handoff is in progress.
        const handoffFrame = getActiveHandoffContext();
        if (handoffFrame) {
          ctx.add(handoffFrame);
        }

        // Surface one observation signal per session when eligibility criteria are met
        // (≥2 sessions, ≥0.15 confidence delta, ≥5 day quiet period — enforced in signals.ts).
        if (!session.signalDelivered) {
          const snapshot = readObservationFromDisk();
          if (snapshot) {
            const signalStore = loadSignals();
            const chosenSignal = pickPendingSignal(snapshot, signalStore);
            if (chosenSignal) {
              const updatedStore = recordSignalDelivered(
                signalStore,
                chosenSignal.dimension,
                chosenSignal.confidence,
              );
              saveSignals(updatedStore);
              session.signalDelivered = true;
              ctx.add(
                buildSignalInstruction(chosenSignal.dimension, chosenSignal.confidence),
              );
            }
          }
        }

        // Prompt Claude to refresh a stale observation, or to bootstrap one from
        // conversation history if the user has preferences but no observation yet.
        // The bootstrap path lets long-time Claude users become match-eligible without
        // needing to run /new, as long as they have some conversation history.
        if (!session.observeUpdatePromptDelivered) {
          const currentObs = readObservationFromDisk();
          if (currentObs) {
            const ageInDays =
              (Date.now() - new Date(currentObs.lastRevised).getTime()) / 86_400_000;
            if (ageInDays >= STALENESS_THRESHOLD_DAYS) {
              session.observeUpdatePromptDelivered = true;
              ctx.add(
                buildStaleObservationPrompt(currentObs, ageInDays, PATHS.cli),
              );
            }
          } else if (userPrefs.location || userPrefs.gender_filter?.length) {
            session.observeUpdatePromptDelivered = true;
            ctx.add(buildBootstrapObservationPrompt(emptyObservation(), PATHS.cli));
          }
        }

        if (ctx.count === 0) return;
        return { prependContext: ctx.build() };
      },
    );

    // ── Hook: command:new ──────────────────────────────────────────────────────
    // Fires when the user runs /new. Handles three cases:
    //   1. First run: walk through full setup (contact + preferences).
    //   2. Preferences missing: collect preferences only.
    //   3. Normal: prompt Claude to update the observation summary for this session.
    api.registerHook(
      "command:new",
      (evt) => {
        if (boot.needsSetup) {
          boot.needsSetup = false;
          evt.messages.push(
            `[MatchClaw] First-time setup — Tone: empathetic and substantive, concise over comprehensive, warmly professional. Welcome them, then work through two steps.\n\n` +
              `Step 1: Combine all four preference questions into one message — location, distance, age range, and gender preference — the user can respond to all at once. Translate distance to 50 / 300 / omit; treat open gender preference as []. When the reply is partial, follow up only on the missing pieces.\n\n` +
              `Step 2: After preferences are locked in, ask about contact separately (lead with how intros work; both sides must agree before anything is exchanged).\n\n` +
              `Accept open and no-preference answers without challenge.\n\n` +
              `Then execute:\n` +
              `  ${PATHS.cli} setup --contact-type <type> --contact-value '<value>'\n` +
              `  ${PATHS.cli} preferences --set '<json>'`,
          );
          return;
        }

        if (boot.needsPreferences) {
          boot.needsPreferences = false;
          evt.messages.push(
            `[MatchClaw] No preferences on file yet. Tone: warm and grounded, relationship-guide energy, clarity over length. Request location, distance, age range, and gender all at once in one message; the user can respond in a single reply. Address gaps only where something is genuinely absent.\n\n` +
              `Take open or no-preference replies without question, then persist:\n` +
              `  ${PATHS.cli} preferences --set '<json>'\n\n` +
              `If they attempt to adjust preferences through the regular conversation later, point them to /matchclaw-prefs for that.`,
          );
          return;
        }

        // Normal case: load whatever observation we have (or start fresh) and ask Claude
        // to update it based on what happened during the session that just ended.
        const sessionObservation = readObservationFromDisk() ?? emptyObservation();
        evt.messages.push(
          buildSessionEndObservationPrompt(sessionObservation, PATHS.cli),
        );
      },
      {
        name: "MatchClaw session hook",
        description:
          "Runs setup on first use, collects preferences if missing, or updates observation summary",
      },
    );
  },
};
