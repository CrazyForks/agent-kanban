#!/usr/bin/env bash
set -euo pipefail

# Board maintainer acceptance test.
#
# The daemon smoke test covers the per-task lifecycle. Maintainers are a
# different shape — board-level, scheduled (AMA fires them on a ~5-minute cron),
# and run through AMA scheduled triggers rather than the daemon task poll — so
# they get their own acceptance here.
#
# Layer A (default): CLI/API contract, seconds.
#   create -> list -> get -> update (pause/resume/interval/prompt) -> runs -> delete.
# Layer B (--live): real heartbeat, ~6-7 minutes. Creates a 60s maintainer and
#   waits for the AMA cron to dispatch a heartbeat run, then asserts a run lands.
#
# Usage: ./scripts/maintainer-acceptance.sh [--live] [--runtime <runtime>] [board_id]
# Missing board is discovered or created. Default runtime is claude.

LIVE=0
RUNTIME="claude"
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --runtime) RUNTIME="${2:-}"; [ -z "$RUNTIME" ] && { echo "FATAL: --runtime requires a value"; exit 1; }; shift 2 ;;
    --runtime=*) RUNTIME="${1#*=}"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
BOARD_ID="${ARGS[0]:-}"

PASS=0
FAIL=0
TIMESTAMP=$(date +%s)
AGENT_ID=""
MAINTAINER_ID=""
LIVE_MAINTAINER_ID=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  if [ -n "$MAINTAINER_ID" ]; then ak delete maintainer "$MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$LIVE_MAINTAINER_ID" ]; then ak delete maintainer "$LIVE_MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$AGENT_ID" ]; then ak delete agent "$AGENT_ID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

json_query() {
  node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const result = ($1);
if (result === undefined || result === null) process.exit(1);
if (typeof result === 'object') console.log(JSON.stringify(result));
else console.log(result);
"
}

discover_board() {
  ak get board -o json | json_query "data.find((b) => b.name === 'Demo' && b.type === 'dev')?.id || data.find((b) => b.type === 'dev')?.id || data[0]?.id"
}
create_board() { ak create board --name "Demo" --type dev -o json | json_query "data.id"; }

maintainer_field() {
  # $1 = maintainer id, $2 = field
  ak get maintainer "$1" --board "$BOARD_ID" -o json | json_query "data['$2']"
}

# ── Preflight ────────────────────────────────────────────────────────────────

echo "=== Maintainer Acceptance ($([ "$LIVE" = 1 ] && echo "Layer A + B (live)" || echo "Layer A")) ==="

case "$RUNTIME" in
  codex | claude | copilot) ;;
  *) echo "FATAL: runtime must be codex, claude, or copilot, got: $RUNTIME"; exit 1 ;;
esac

if [ -z "$BOARD_ID" ]; then BOARD_ID="$(discover_board 2>/dev/null || true)"; fi
if [ -z "$BOARD_ID" ]; then BOARD_ID="$(create_board)"; fi

DAEMON_STATUS=$(ak status 2>&1 | head -1)
if ! echo "$DAEMON_STATUS" | grep -q "running"; then
  echo "FATAL: machine runner is not running (needed for an online $RUNTIME environment). Start with: ak start"
  exit 1
fi

AGENT_ID=$(ak create agent \
  --name "Maintainer Probe $TIMESTAMP" \
  --username "maintainer-probe-$TIMESTAMP" \
  --runtime "$RUNTIME" \
  --role "board-maintainer" \
  --bio "Agent used by maintainer acceptance" \
  -o json | json_query "data.id")

echo "  Board:   $BOARD_ID"
echo "  Agent:   $AGENT_ID ($RUNTIME)"
echo ""

# ── Layer A: contract ────────────────────────────────────────────────────────

echo "[Layer A] CLI/API contract"

MAINTAINER_ID=$(ak create maintainer \
  --board "$BOARD_ID" \
  --agent "$AGENT_ID" \
  --name "Acceptance maintainer $TIMESTAMP" \
  --prompt "Inspect the board and report. Do not create or modify anything." \
  --interval-seconds 3600 \
  -o json | json_query "data.id")
if [ -n "$MAINTAINER_ID" ]; then
  pass "create maintainer ($MAINTAINER_ID)"
else
  fail "create maintainer"
  echo "==== Passed: $PASS  Failed: $((FAIL + 1)) ===="
  exit 1
fi

[ "$(maintainer_field "$MAINTAINER_ID" status)" = "active" ] \
  && pass "created maintainer is active" || fail "created maintainer is not active"

LIST_JSON=$(ak get maintainer --board "$BOARD_ID" -o json)
if [ "$(printf '%s' "$LIST_JSON" | json_query "data.some((m) => m.id === '$MAINTAINER_ID')")" = "true" ]; then
  pass "maintainer appears in list"
else
  fail "maintainer missing from list"
fi

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --status paused >/dev/null 2>&1
[ "$(maintainer_field "$MAINTAINER_ID" status)" = "paused" ] \
  && pass "maintainer paused via update" || fail "maintainer did not pause"

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --status active >/dev/null 2>&1
[ "$(maintainer_field "$MAINTAINER_ID" status)" = "active" ] \
  && pass "maintainer resumed via update" || fail "maintainer did not resume"

ak update maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --interval-seconds 120 --name "Renamed $TIMESTAMP" >/dev/null 2>&1
if [ "$(maintainer_field "$MAINTAINER_ID" interval_seconds)" = "120" ] \
  && [ "$(maintainer_field "$MAINTAINER_ID" name)" = "Renamed $TIMESTAMP" ]; then
  pass "maintainer interval + name updated"
else
  fail "maintainer interval/name update not reflected"
fi

if [ "$(ak get maintainer "$MAINTAINER_ID" --board "$BOARD_ID" --runs -o json | json_query "Array.isArray(data.data)")" = "true" ]; then
  pass "maintainer runs history is listable"
else
  fail "maintainer runs history not listable"
fi

DELETE_STATUS=$(ak delete maintainer "$MAINTAINER_ID" --board "$BOARD_ID" -o json 2>/dev/null | json_query "data.status" || echo "")
if [ "$DELETE_STATUS" = "archived" ]; then
  pass "maintainer deleted (archived)"
else
  fail "maintainer not archived on delete (got: ${DELETE_STATUS:-none})"
fi
LIST_AFTER_JSON=$(ak get maintainer --board "$BOARD_ID" -o json)
if [ "$(printf '%s' "$LIST_AFTER_JSON" | json_query "data.every((m) => m.id !== '$MAINTAINER_ID' || m.status === 'archived')")" = "true" ]; then
  pass "deleted maintainer no longer active in list"
else
  fail "deleted maintainer still active in list"
fi
MAINTAINER_ID=""
echo ""

# ── Layer B: live heartbeat ──────────────────────────────────────────────────

if [ "$LIVE" = 1 ]; then
  echo "[Layer B] Live heartbeat (AMA cron ~5m — this can take 6-7 minutes)"
  LIVE_MAINTAINER_ID=$(ak create maintainer \
    --board "$BOARD_ID" \
    --agent "$AGENT_ID" \
    --name "Live maintainer $TIMESTAMP" \
    --prompt "Inspect the board state and report a one-line summary. Do not create or modify any tasks." \
    --interval-seconds 60 \
    -o json | json_query "data.id")
  echo "  Maintainer: $LIVE_MAINTAINER_ID (interval 60s)"

  RUN_FOUND=0
  ELAPSED=0
  TIMEOUT=420
  while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
    COUNT=$(ak get maintainer "$LIVE_MAINTAINER_ID" --board "$BOARD_ID" --runs -o json 2>/dev/null | json_query "(data.data || []).length" || echo "0")
    if [ "${COUNT:-0}" -gt 0 ]; then RUN_FOUND=1; break; fi
    sleep 15
    ELAPSED=$((ELAPSED + 15))
  done

  if [ "$RUN_FOUND" = 1 ]; then
    pass "heartbeat run dispatched within ${ELAPSED}s"
    RUN_STATUS=$(ak get maintainer "$LIVE_MAINTAINER_ID" --board "$BOARD_ID" --runs -o json 2>/dev/null | json_query "data.data[0].status" || echo "")
    echo "    latest run status: ${RUN_STATUS:-unknown}"
  else
    fail "no heartbeat run after ${TIMEOUT}s"
  fi
  echo ""
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo "==============================="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "==============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
