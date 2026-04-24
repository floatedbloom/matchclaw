#!/usr/bin/env bash
# agent relay daemon
#
# Wakes on a fixed interval, fetches encrypted NIP-17 messages from Nostr relays,
# and feeds each one into Claude via `claude --continue -p`. Claude reads the
# on-disk negotiation thread, reasons about the incoming message, and acts using
# the matchclaw CLI:
#
#   matchclaw match --send '<reply>' --thread <id>
#   matchclaw match --propose --thread <id> --write '<narrative-json>'
#   matchclaw match --decline --thread <id>
#
# Usage:
#   ~/.matchclaw/bridge.sh [--project-dir <path>]
#
# Requirements:
#   - plugin built (npm run build in agent/plugin/)
#   - matchclaw setup completed
#   - CLAUDE_PROJECT_DIR set or provided via --project-dir

set -euo pipefail

TICK_SECONDS=${MATCHCLAW_POLL_INTERVAL:-15}
HEARTBEAT_SECONDS=${MATCHCLAW_HEARTBEAT_INTERVAL:-5400}
BASE_DIR="${MATCHER_DIR_OVERRIDE:-${MATCHCLAWDIR:-$HOME/.matchclaw}}"
AGENT_PERSONA_FILE="${BASE_DIR}/persona.md"
MSG_STAGING_FILE="${BASE_DIR}/message-queue.jsonl"
WORK_DIR="${CLAUDE_PROJECT_DIR:-}"

# Accept --project-dir to override CLAUDE_PROJECT_DIR at runtime
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      WORK_DIR="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$WORK_DIR" ]]; then
  echo "ERROR: set CLAUDE_PROJECT_DIR or pass --project-dir <path>" >&2
  exit 1
fi

# Verify required commands are available before doing anything
for cmd in node claude matchclaw; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found in PATH" >&2
    case "$cmd" in
      matchclaw) echo "  Run: npm install -g matchclaw-plugin" >&2 ;;
      claude)    echo "  Install Claude Code: https://claude.ai/code" >&2 ;;
      node)      echo "  Install Node.js 20+: https://nodejs.org" >&2 ;;
    esac
    exit 1
  fi
done

# Ensure BASE_DIR exists before writing any files into it
mkdir -p "$BASE_DIR"

# Write the agent persona if it hasn't been created yet.
# This file is appended to every headless Claude session as system context.
if [[ ! -f "$AGENT_PERSONA_FILE" ]]; then
  cat > "$AGENT_PERSONA_FILE" <<'PERSONA'
You are a MatchClaw matching agent working on behalf of your user. Your function
during peer negotiations is to act as a rigorous, honest evaluator — not an
optimistic closer. A bad match introduced is worse than no match at all.

Operating principles:
- Before replying, read the full thread history from the threads/ directory
- When sharing what you know about your user, speak in inferences — never quote
  raw evidence or evidence_summary content verbatim
- After every peer exchange, explicitly ask: what would cause this match to fail?
- Before issuing a proposal, run a counter-argument review across all 9 dimensions:
    attachment, core_values, communication, emotional_regulation, humor,
    life_velocity, dealbreakers, conflict_resolution, interdependence_model
  Decline if any score falls below its floor:
    dealbreakers / emotional_regulation: 0.60
    attachment / core_values / communication / conflict_resolution: 0.55
    all others: 0.50
- Reply to the peer with:   matchclaw match --send '<text>' --thread <id>
- Propose a match with:     matchclaw match --propose --thread <id> --write '<json>'
- End a negotiation with:   matchclaw match --decline --thread <id>
PERSONA
  echo "Agent persona written to $AGENT_PERSONA_FILE"
fi

# Ensure the staging file exists before the loop starts
touch "$MSG_STAGING_FILE"

echo "Relay daemon active — tick every ${TICK_SECONDS}s, heartbeat every ${HEARTBEAT_SECONDS}s"
echo "Working directory: $WORK_DIR"

# Tracks when we last sent a heartbeat (0 forces one on the first iteration)
LAST_HB_TS=0

# Deliver a single message to Claude for processing
handle_message() {
  local tid="$1"
  local peer="$2"
  local kind="$3"
  local body="$4"
  local exchanges="$5"

  # Touch thread state so Claude can confirm the thread exists before replying
  matchclaw match --status --thread "$tid" > /dev/null 2>&1 || true

  # Write the prompt to a temp file so shell quoting doesn't mangle the content
  local tmp_prompt
  tmp_prompt=$(mktemp)
  printf '%s\n' \
    "[MatchClaw] Incoming peer message from ${peer:0:12}:" \
    "Thread: ${tid}" \
    "Exchange: ${exchanges} / 10" \
    "Kind: ${kind}" \
    "" \
    "$body" \
    "" \
    "Review the thread at ${BASE_DIR}/threads/${tid}.json, then respond via the matchclaw CLI." \
    > "$tmp_prompt"

  echo "Dispatching thread ${tid:0:8}... (exchange $exchanges)"

  # Run Claude headlessly within the project directory.
  # The subshell keeps the daemon's cwd unchanged.
  (cd "$WORK_DIR" && claude --continue \
    --append-system-prompt "$(cat "$AGENT_PERSONA_FILE")" \
    -p "$(cat "$tmp_prompt")" \
    --output-format text \
    2>&1) || echo "Claude returned non-zero for thread $tid"

  rm -f "$tmp_prompt"
}

# Resolve poll.js relative to this script — it's always ../dist/poll.js
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLL_SCRIPT="${SCRIPT_DIR}/../dist/poll.js"

if [[ ! -f "$POLL_SCRIPT" ]]; then
  echo "ERROR: poll.js not found at ${POLL_SCRIPT} — run 'npm run build' in the plugin directory" >&2
  exit 1
fi

# Main loop
while true; do
  # Emit a heartbeat on startup and at every HEARTBEAT_SECONDS interval so
  # this agent remains visible in the matching registry (TTL 24h, window 2h).
  CURRENT_TS=$(date +%s)
  if (( CURRENT_TS - LAST_HB_TS >= HEARTBEAT_SECONDS )); then
    matchclaw heartbeat >> "${BASE_DIR}/bridge.log" 2>&1 || true
    LAST_HB_TS=$CURRENT_TS
  fi

  # Run the poller; JSONL lines land in the staging file, errors in bridge.log
  if node "$POLL_SCRIPT" >> "$MSG_STAGING_FILE" 2>>"${BASE_DIR}/bridge.log"; then
    if [[ -s "$MSG_STAGING_FILE" ]]; then
      while IFS= read -r raw_line; do
        [[ -z "$raw_line" ]] && continue

        # Parse the JSON record using Node so we don't depend on jq.
        # Fields are delimited by ASCII 0x01, which cannot appear in valid UTF-8 content.
        parsed_fields=$(printf '%s' "$raw_line" | node -e "
          try {
            const rec = JSON.parse(require('fs').readFileSync(0, 'utf8'));
            process.stdout.write([
              rec.thread_id    || '',
              rec.peer_pubkey  || '',
              rec.type         || 'negotiation',
              rec.content      || '',
              String(rec.round_count ?? 0)
            ].join('\x01') + '\n');
          } catch (_) {
            process.stdout.write('\x01\x01\x01\x010\n');
          }
        ")
        IFS=$'\001' read -r thread_id peer_pubkey msg_type content round_count <<< "$parsed_fields"

        if [[ -n "$thread_id" ]]; then
          # Register the inbound message via matchclaw before Claude sees it.
          # Body on stdin avoids shell interpolation and env-staged payloads (quoting-safe).
          mt="${msg_type:-negotiation}"
          printf '%s' "$content" | matchclaw match --receive - --thread "$thread_id" --peer "$peer_pubkey" --type "$mt"
          receive_exit=${PIPESTATUS[1]}

          if [[ $receive_exit -eq 0 ]]; then
            handle_message "$thread_id" "$peer_pubkey" "$msg_type" "$content" "$round_count"
          else
            echo "matchclaw match --receive failed (exit $receive_exit) — skipping Claude for thread ${thread_id:0:8}..." >&2
          fi
        fi
      done < "$MSG_STAGING_FILE"

      # Clear staging after all records are dispatched
      > "$MSG_STAGING_FILE"
    fi
  fi

  sleep "$TICK_SECONDS"
done
