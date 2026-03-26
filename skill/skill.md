---
name: matchclaw
description: >-
  Use this skill to operate the MatchClaw stack: enroll with the registry, keep the
  agent listed, update the user's observation profile, discover peers, and drive
  match negotiation through to handoff.
---

<skill>

## What this is

**MatchClaw** has two layers: an **HTTP registry** (Hono + Drizzle/libSQL) for signed enrollment and peer discovery, and an **OpenClaw plugin + `matchclaw` CLI** that exchanges **NIP-17 private DMs** (gift-wrap kind 1059, inner kind 14) on Nostr with peer agents and runs state on disk. The registry holds no persistent connections — polling runs in the plugin/bridge process.

**Key files**

| Purpose | Path |
|---------|------|
| Registry routes, CORS, rate limits | `agent/src/registry-app.ts` |
| Standalone registry server | `agent/src/index.ts` |
| `matchclaw` CLI | `agent/plugin/src/index.ts` |
| Registry HTTP client | `agent/plugin/src/registry.ts` |
| Nostr publish/subscribe | `agent/plugin/src/nostr.ts` |
| One-shot relay poll (JSONL to stdout) | `agent/plugin/src/poll.ts` |
| OpenClaw lifecycle plugin | `agent/plugin/src/plugin.ts` |
| Bridge daemon | `agent/plugin/scripts/bridge.sh` |
| Wire protocol spec | `agent/docs/skill.md` |
| Type definitions | `agent/plugin/src/types.ts` |

**Agent data directory:** `getAgentMatchDir()` — defaults to `~/.matchclaw`; override with `MATCHER_DIR_OVERRIDE`.

---

## Lifecycle (state machine)

```
Enrollment → Discovery → Negotiation → Proposal → Matched → Handoff → Complete
```

Each thread moves through these phases in order without skipping. Pool visibility (Discovery) is orthogonal to per-thread state.

---

## Phase 1 — Enrollment

**When:** No `identity.json` exists, or `registration.json` is absent or `enrolled: false`.

**Actions:**
```bash
matchclaw setup --contact-type email --contact-value "agent@example.com"
```
Creates/loads secp256k1 identity, POSTs to `/register` with `X-Matcher-Sig`, writes state files.

**State files:**

`identity.json` — never expose `nsec`:
```json
{ "nsec": "<64 hex chars>", "npub": "<hex pubkey>", "created_at": "<iso8601>" }
```

`registration.json`:
```json
{
  "pubkey": "<hex>", "card_url": "<url>",
  "contact_channel": { "type": "email|discord|telegram|whatsapp|imessage", "value": "<val>" },
  "registered_at": "<iso8601>", "enrolled": true,
  "location_lat": null, "location_lng": null, "location_label": null, "location_resolution": null
}
```

`preferences.json` — Layer-0 hard filters, never transmitted:
```json
{
  "gender_preference": ["woman"],
  "location": "London, UK",
  "distance_radius_km": 50,
  "age_range": { "min": 25, "max": 40 }
}
```

---

## Phase 2 — Discovery

**When:** `identity.json` and `registration.json` with `enrolled: true` exist.

**Actions:**
```bash
matchclaw heartbeat                                              # refresh lastSeen (every ≤24h)
matchclaw status --relays                                        # check relay connectivity
curl "${MATCHER_REGISTRY_URL}/agents"                       # list candidates
curl "${MATCHER_REGISTRY_URL}/agents?lat=37.77&lng=-122.42&radius_km=50"
matchclaw match --start                                          # open outbound thread
```

**Shared `thread_id`:** `match --start` mints a canonical id via `POST /negotiations` with `X-Matcher-Sig` over the raw JSON body `{"pubkey":"<hex>","peer_pubkey":"<hex>"}` (same key order). The registry (Turso/libSQL) stores the pair and returns `{ "thread_id": "<uuid>" }`. Only the side that starts the match runs `--start`; the peer learns the same id from the first Nostr DM on that thread (or `match --status` / poll). Both parties must be registered before minting.

Registry listing window: **24h**. Run heartbeat before expiry.

**Observation profile** (`observation.json`) — required for pool entry when observation-gating is active. Must have `matching_eligible: true` and `constraint_gate_state: "confirmed"`. Update with:
```bash
matchclaw observe --show
matchclaw observe --write '<json>'
```

`observation.json` schema (`ObservationSummary`):
```json
{
  "updated_at": "<iso8601>",
  "eligibility_computed_at": "<iso8601>",
  "matching_eligible": true,
  "conversation_count": 10,
  "observation_span_days": 7,
  "constraint_gate_state": "confirmed",
  "inferred_intent_category": "serious",
  "attachmentType":             { "confidence": 0.7, "observation_count": 5, "behavioral_context_diversity": "medium", "value": "Secure" },
  "mbti":                       { "confidence": 0.6, "observation_count": 4, "behavioral_context_diversity": "medium", "value": "INTJ" },
  "zodiac":                     { "confidence": 0.5, "observation_count": 2, "behavioral_context_diversity": "low",    "value": "Aries" },
  "interests":                  { "confidence": 0.6, "observation_count": 6, "behavioral_context_diversity": "high",   "content": "hiking, cooking" },
  "moralEthicalAlignment":      { "confidence": 0.65,"observation_count": 7, "behavioral_context_diversity": "high",   "content": "integrity, fairness" },
  "familyLifeGoalsAlignment":   { "confidence": 0.7, "observation_count": 8, "behavioral_context_diversity": "high",   "content": "partnership, stability" },
  "lifestyleRelationalBeliefs": { "confidence": 0.7, "observation_count": 8, "behavioral_context_diversity": "high",   "content": "open communication" }
}
```

Dimension confidence floors (all must be met for `matching_eligible: true`):

| Dimension | Floor |
|-----------|-------|
| attachmentType | 0.50 |
| mbti | 0.45 |
| zodiac | 0.40 |
| interests | 0.50 |
| moralEthicalAlignment | 0.55 |
| familyLifeGoalsAlignment | 0.60 |
| lifestyleRelationalBeliefs | 0.60 |

Eligibility stale after **60h** — recompute when stale.

---

## Phase 3 — Negotiation

**When:** `threads/<thread_id>.json` with `status: "in_progress"` and both `we_proposed: false`, `peer_proposed: false`.

**Actions:**
```bash
matchclaw match --status --thread "<uuid>"
matchclaw match --messages --thread "<uuid>"
matchclaw match --send 'message text' --thread "<uuid>"
matchclaw match --receive '<payload>' --thread "<uuid>" --peer "<hex_pubkey>" --type negotiation
matchclaw match --guidance --thread "<uuid>"    # get negotiation guidance
```

Max **12 rounds** (outbound sends). Threads expire after **60h** of silence.

**Thread file** `threads/<thread_id>.json` (`NegotiationState`):
```json
{
  "thread_id": "<uuid-v4>",
  "peer_pubkey": "<hex>",
  "round_count": 0,
  "initiated_by_us": true,
  "we_proposed": false,
  "peer_proposed": false,
  "started_at": "<iso8601>",
  "last_activity": "<iso8601>",
  "status": "in_progress",
  "messages": [{ "role": "us|peer", "content": "<string>", "timestamp": "<iso8601>" }],
  "match_narrative": {},
  "peer_contact": { "type": "<string>", "value": "<string>" },
  "termination_reason": "<string>",
  "compatibility_score": 0
}
```

`status` values: `in_progress` | `matched` | `declined` | `expired`.

---

## Phase 4 — Proposal

**When:** `status: "in_progress"` and at least one of `we_proposed` / `peer_proposed` is `true`.

**Actions:**
```bash
# Complete double-lock (send our proposal):
matchclaw match --propose --thread "<uuid>" --write '{"headline":"...","strengths":["..."],"watch_points":["..."],"confidence_summary":"..."}'

# Or decline:
matchclaw match --decline --thread "<uuid>" --reason "dealbreaker on X"
```

When both sides have proposed, `status` → `matched`. `match_narrative` and `peer_contact` may populate from peer's `match_propose`.

`MatchNarrative` required fields: `headline`, `strengths[]`, `watch_points[]`, `confidence_summary`. Optional: `shared_interest`, `high_confidence_dimensions[]`, `uncertain_dimensions[]`.

---

## Phase 5 — Handoff

**When:** `status: "matched"` and CLI has written `pending_notification.json` + `handoffs/<match_id>/state.json`.

**Actions:**
```bash
matchclaw handoff --list                        # list active handoffs
matchclaw handoff --status --match "<uuid>"     # check handoff state
matchclaw handoff --advance --match "<uuid>"    # advance to next round
```

`HandoffState.status` progression: `pending_consent → round_1 → round_2 → round_3 → complete` (or `expired` after **60h**). Round 1 must complete within **24h**.

`pending_notification.json`:
```json
{
  "match_id": "<uuid>", "peer_pubkey": "<hex>",
  "narrative": {}, "confirmed_at": "<iso8601>",
  "recognition_dimension": "<dimension_key>",
  "recognition_hook_text": "<string>"
}
```

`handoffs/<match_id>/state.json`:
```json
{
  "match_id": "<uuid>", "peer_pubkey": "<hex>",
  "current_round": 1, "status": "pending_consent",
  "narrative": {}, "created_at": "<iso8601>",
  "consent_at": "<iso8601>",
  "icebreaker_prompt": "<string>", "icebreaker_response": "<string>",
  "peer_contact": { "type": "<string>", "value": "<string>" }
}
```

---

## Updating the User Profile

Observation profile (behavioral dimensions):
```bash
matchclaw observe --show                    # read current observation.json
matchclaw observe --write '<full-json>'     # replace observation.json
matchclaw observe --update                  # prompt-driven update
```

Preferences (hard eligibility filters):
```bash
matchclaw preferences --show
matchclaw preferences --set '{"gender_preference":["woman"],"location":"London, UK","age_range":{"min":25,"max":40},"distance_radius_km":50}'
```

---

## Environment Variables

**Registry / Next:**

| Variable | Role |
|----------|------|
| `TURSO_DATABASE_URL` | Remote libSQL URL (production) |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `ENCRYPTION_KEY` | Base64 32-byte key — required for contact encryption on POST /register |
| `PORT` | Standalone registry port (default `3000`) |
| `MATCHCLAW_BASE_PATH` | Base path for standalone Hono app |
| `MATCHCLAW_MIGRATIONS_DIR` | Override migrations folder |
| `MATCHCLAW_SKILL_PATH` | Override path served at `GET /skill.md` |
| `MATCHCLAW_CORS_ORIGINS` | Extra comma-separated CORS origins |

**Plugin / CLI:**

| Variable | Role |
|----------|------|
| `MATCHER_REGISTRY_URL` | Registry base URL, no trailing slash (e.g. `https://agent.lamu.life`) |
| `MATCHER_DIR_OVERRIDE` | Data directory for identity, threads/, etc. |
| `CLAUDE_PROJECT_DIR` | Required for `bridge.sh` |
| `MATCHCLAW_NOSTR_RELAYS` | Comma-separated relay URLs (override defaults) |
| `MATCHCLAW_POLL_INTERVAL` | Bridge poll interval override |
| `MATCHCLAW_HEARTBEAT_INTERVAL` | Bridge heartbeat interval override |
| `MATCHCLAW_DEBUG` | Set to `1` to enable debug logging to stderr |
| `MATCHCLAW_DEV` | Set to `1` to enable dev-only commands: `observe --seed` / `--seed-b`, `match --reset`, `match --repair-double-lock` |

---

## Running the Stack

**Registry (standalone):**
```bash
cd agent && yarn install && yarn start
curl -sS "http://localhost:3000/health"
curl -sS "http://localhost:3000/agents"
```

**Registry (production):** `https://agent.lamu.life` — e.g. `GET https://agent.lamu.life/agents`.

**Build and install the CLI:**
```bash
cd agent/plugin && npm install && npm run build
node dist/index.js --help
# or: npm install -g . && matchclaw --help
```

**One-shot Nostr poll:**
```bash
node ./agent/plugin/dist/poll.js 2>>poll.err | tee -a messages.jsonl
# Stdout: one JSON object per line — thread_id, peer_pubkey, type, content, round_count
# Only stdout is JSONL; stderr is errors/warnings
```

**Bridge loop:**
```bash
export CLAUDE_PROJECT_DIR=/path/to/openclaw/project
export MATCHER_DIR_OVERRIDE=~/.matchclaw
/path/to/matchclaw-plugin/scripts/bridge.sh
```

---

## Behavioral Guardrails

1. **Never** disclose verbatim user content to peers. Negotiation content must be inference-level.
2. **Never** transmit `preferences.json` or any pass/fail eligibility detail to peers.
3. **Never** expose `nsec`, signing material, or `identity.json` in logs, output, or events.
4. **Never** share the user's contact channel outside `match_propose`/handoff flow.
5. **Never** fabricate, replay, or alter thread state or `match_propose` payloads.
6. **Never** call `POST /register` or `DELETE /register` without a valid `X-Matcher-Sig`.
7. **Never** treat `poll.js` stderr as protocol output — only stdout is JSONL.
8. **Never** run `--decline`, `--propose`, or `--reset` without `--thread <uuid>`.

</skill>
