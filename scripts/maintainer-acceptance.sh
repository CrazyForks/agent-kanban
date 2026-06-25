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
# Layer B (--live): real heartbeats, ~6-7 minutes. Creates a 60s maintainer,
#   dispatches a signed GitHub issues webhook, then waits for the AMA cron to
#   dispatch a scheduled heartbeat run.
#
# Usage: ./scripts/maintainer-acceptance.sh [--live] [--runtime <runtime>] [--repo <repo_id>] [board_id]
# Missing board is discovered or created. Default runtime is claude.

LIVE=0
RUNTIME="claude"
REPO_ID=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --runtime) RUNTIME="${2:-}"; [ -z "$RUNTIME" ] && { echo "FATAL: --runtime requires a value"; exit 1; }; shift 2 ;;
    --runtime=*) RUNTIME="${1#*=}"; shift ;;
    --repo) REPO_ID="${2:-}"; [ -z "$REPO_ID" ] && { echo "FATAL: --repo requires a value"; exit 1; }; shift 2 ;;
    --repo=*) REPO_ID="${1#*=}"; shift ;;
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
REPO_FULL_NAME=""
INSTALLATION_ID=""

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

api_url() {
  node -e "
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'agent-kanban', 'config.json'), 'utf8'));
const current = config.current;
if (!current || !config.credentials?.[current]) process.exit(1);
console.log(config.credentials[current]['api-url'].replace(/\\/$/, ''));
"
}

dev_var() {
  # $1 = env var name. Values are intentionally not echoed except to callers.
  node -e "
const fs = require('fs');
const key = process.argv[1];
const file = 'apps/web/.dev.vars';
if (!fs.existsSync(file)) process.exit(1);
const line = fs.readFileSync(file, 'utf8').split(/\\r?\\n/).find((item) => item.startsWith(key + '='));
if (!line) process.exit(1);
let value = line.slice(key.length + 1).trim();
if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith(\"'\") && value.endsWith(\"'\"))) {
  value = value.slice(1, -1);
}
console.log(value);
" "$1"
}

repo_field() {
  # $1 = repo id, $2 = field
  ak get repo "$1" -o json | json_query "data['$2']"
}

discover_installation_id() {
  # Local acceptance uses the dev D1 database. For repository_selection=all,
  # selected-repo rows are intentionally absent.
  (cd apps/web && npx wrangler d1 execute agent-kanban-db --local --json --command \
    "SELECT installation_id FROM github_installations WHERE owner_id = '$(ak get repo "$REPO_ID" -o json | json_query "data.owner_id")' AND suspended_at IS NULL ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null) \
    | json_query "data[0]?.results?.[0]?.installation_id"
}

post_github_issue_event() {
  # $1 = maintainer id, $2 = unique suffix
  local maintainer_id="$1"
  local suffix="$2"
  local base_url secret payload signature delivery before after elapsed timeout
  base_url="$(api_url)"
  secret="$(dev_var GITHUB_APP_WEBHOOK_SECRET)"
  delivery="maintainer-acceptance-${TIMESTAMP}-${suffix}"
  before=$(ak get maintainer "$maintainer_id" --board "$BOARD_ID" --runs -o json | json_query "(data.data || []).length" || echo "0")
  payload=$(node -e "
const payload = {
  action: 'opened',
  installation: { id: Number(process.argv[1]) },
  repository: { id: 1, full_name: process.argv[2] },
  issue: {
    id: Date.now(),
    number: 1,
    title: 'Maintainer acceptance heartbeat',
    html_url: 'https://github.com/' + process.argv[2] + '/issues/1',
    user: { login: 'agent-kanban-acceptance' },
  },
};
process.stdout.write(JSON.stringify(payload));
" "$INSTALLATION_ID" "$REPO_FULL_NAME")
  signature=$(node -e "
const crypto = require('crypto');
const secret = process.argv[1];
const payload = process.argv[2];
process.stdout.write('sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex'));
" "$secret" "$payload")
  curl -fsS -X POST "$base_url/api/webhooks/github-app" \
    -H "content-type: application/json" \
    -H "x-github-event: issues" \
    -H "x-github-delivery: $delivery" \
    -H "x-hub-signature-256: $signature" \
    --data "$payload" >/dev/null

  elapsed=0
  timeout=90
  while [ "$elapsed" -lt "$timeout" ]; do
    after=$(ak get maintainer "$maintainer_id" --board "$BOARD_ID" --runs -o json | json_query "(data.data || []).length" || echo "0")
    if [ "${after:-0}" -gt "${before:-0}" ]; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}

# ── Preflight ────────────────────────────────────────────────────────────────

echo "=== Maintainer Acceptance ($([ "$LIVE" = 1 ] && echo "Layer A + B (live)" || echo "Layer A")) ==="

case "$RUNTIME" in
  codex | claude | copilot) ;;
  *) echo "FATAL: runtime must be codex, claude, or copilot, got: $RUNTIME"; exit 1 ;;
esac

if [ -z "$BOARD_ID" ]; then BOARD_ID="$(discover_board 2>/dev/null || true)"; fi
if [ -z "$BOARD_ID" ]; then BOARD_ID="$(create_board)"; fi

DAEMON_STATUS=$(ak status 2>&1 || true)
DAEMON_STATUS=${DAEMON_STATUS%%$'\n'*}
if [[ "$DAEMON_STATUS" != *running* ]]; then
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
if [ -n "$REPO_ID" ]; then
  REPO_FULL_NAME="$(repo_field "$REPO_ID" full_name)"
  echo "  Repo:    $REPO_ID ($REPO_FULL_NAME)"
  if [ "$LIVE" = 1 ]; then
    INSTALLATION_ID="$(discover_installation_id 2>/dev/null || true)"
    if [ -z "$INSTALLATION_ID" ]; then
      echo "FATAL: could not discover GitHub App installation id for repo $REPO_ID"
      exit 1
    fi
    echo "  GitHub installation: $INSTALLATION_ID"
  fi
fi
echo ""

# ── Layer A: contract ────────────────────────────────────────────────────────

echo "[Layer A] CLI/API contract"

REPO_ARGS=()
if [ -n "$REPO_ID" ]; then REPO_ARGS=(--repo "$REPO_ID"); fi

MAINTAINER_ID=$(ak create maintainer \
  --board "$BOARD_ID" \
  --agent "$AGENT_ID" \
  --name "Acceptance maintainer $TIMESTAMP" \
  --prompt "Inspect the board and report. Do not create or modify anything." \
  "${REPO_ARGS[@]}" \
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

if [ -n "$REPO_ID" ]; then
  [ "$(maintainer_field "$MAINTAINER_ID" repository_id)" = "$REPO_ID" ] \
    && pass "created maintainer is bound to repo" || fail "created maintainer repo binding missing"
fi

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

DELETE_OK=$(ak delete maintainer "$MAINTAINER_ID" --board "$BOARD_ID" -o json 2>/dev/null | json_query "data.ok" || echo "")
if [ "$DELETE_OK" = "true" ]; then
  pass "maintainer deleted"
else
  fail "maintainer delete did not return ok"
fi
LIST_AFTER_JSON=$(ak get maintainer --board "$BOARD_ID" -o json)
if [ "$(printf '%s' "$LIST_AFTER_JSON" | json_query "data.every((m) => m.id !== '$MAINTAINER_ID')")" = "true" ]; then
  pass "deleted maintainer no longer appears in active list"
else
  fail "deleted maintainer still appears in list"
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
    "${REPO_ARGS[@]}" \
    --interval-seconds 60 \
    -o json | json_query "data.id")
  echo "  Maintainer: $LIVE_MAINTAINER_ID (interval 60s)"

  if [ -n "$REPO_ID" ]; then
    if post_github_issue_event "$LIVE_MAINTAINER_ID" "issue"; then
      pass "GitHub issues webhook dispatched an HTTP heartbeat run"
    else
      fail "GitHub issues webhook did not create an HTTP heartbeat run"
    fi
  fi

  RUN_FOUND=0
  HTTP_BASELINE=$(ak get maintainer "$LIVE_MAINTAINER_ID" --board "$BOARD_ID" --runs -o json | json_query "(data.data || []).length" || echo "0")
  ELAPSED=0
  TIMEOUT=420
  while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
    COUNT=$(ak get maintainer "$LIVE_MAINTAINER_ID" --board "$BOARD_ID" --runs -o json 2>/dev/null | json_query "(data.data || []).length" || echo "0")
    if [ "${COUNT:-0}" -gt "${HTTP_BASELINE:-0}" ]; then RUN_FOUND=1; break; fi
    sleep 15
    ELAPSED=$((ELAPSED + 15))
  done

  if [ "$RUN_FOUND" = 1 ]; then
    pass "scheduled heartbeat run dispatched within ${ELAPSED}s"
    RUN_STATUS=$(ak get maintainer "$LIVE_MAINTAINER_ID" --board "$BOARD_ID" --runs -o json 2>/dev/null | json_query "data.data[0].status" || echo "")
    echo "    latest run status: ${RUN_STATUS:-unknown}"
  else
    fail "no scheduled heartbeat run after ${TIMEOUT}s"
  fi
  echo ""
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo "==============================="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "==============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
