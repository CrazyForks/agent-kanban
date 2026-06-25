#!/usr/bin/env bash
set -euo pipefail

# Board maintainer smoke test.
#
# This script is intentionally manual. It validates the maintainer workflow
# end-to-end against the currently configured AK environment without adding a CI
# job.
#
# Layer A (default, seconds): CLI/API contract and repo auth surface.
#   - creates a worker agent with role=board-maintainer
#   - ensures the board can discover its repositories via `ak get repo --board`
#   - creates/lists/gets/updates/deletes a board-level maintainer
#   - verifies maintainers are not bound to repository_id
#   - verifies `ak github auth <repo-id>` can print a token without leaking it
#   - verifies git credential writes are guarded outside AK_WORKER and work in an
#     isolated worker HOME
#
# Layer B (--live, minutes): real AMA maintainer runs.
#   - sends a signed GitHub issues webhook for the board repository
#   - waits for the event-triggered maintainer to create a deterministic marker task
#   - creates a second scheduled maintainer and waits for its marker task
#
# Usage:
#   ./scripts/maintainer-smoke-test.sh [--live] [--keep-artifacts] [--runtime <runtime>] [--repo <repo_id>] [board_id]
#
# Missing board/repo arguments are discovered from the current AK account.
# Defaults target a dev board named Demo, a repository named slink, and the
# local codex runtime. Live maintainer execution requires an active machine
# runner from `ak start`.

LIVE=0
KEEP_ARTIFACTS=0
RUNTIME="codex"
REPO_ID=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --live)
      LIVE=1
      shift
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --runtime)
      RUNTIME="${2:-}"
      [ -z "$RUNTIME" ] && { echo "FATAL: --runtime requires a value"; exit 1; }
      shift 2
      ;;
    --runtime=*)
      RUNTIME="${1#*=}"
      shift
      ;;
    --repo)
      REPO_ID="${2:-}"
      [ -z "$REPO_ID" ] && { echo "FATAL: --repo requires a value"; exit 1; }
      shift 2
      ;;
    --repo=*)
      REPO_ID="${1#*=}"
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

BOARD_ID="${ARGS[0]:-}"
PASS=0
FAIL=0
TIMESTAMP=$(date +%s)
ORIGINAL_HOME="${HOME:-}"
export AK_WORKER=1

AGENT_ID=""
MAINTAINER_ID=""
HTTP_MAINTAINER_ID=""
SCHEDULED_MAINTAINER_ID=""
REPO_FULL_NAME=""
INSTALLATION_ID=""
BOARD_REPO_TASK_ID=""
HTTP_MARKER_TASK_ID=""
SCHEDULED_MARKER_TASK_ID=""
TEMP_WORKER_HOME=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  if [ -n "$MAINTAINER_ID" ]; then ak delete maintainer "$MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$HTTP_MAINTAINER_ID" ]; then ak delete maintainer "$HTTP_MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$SCHEDULED_MAINTAINER_ID" ]; then ak delete maintainer "$SCHEDULED_MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ "$KEEP_ARTIFACTS" != 1 ]; then
    if [ -n "$HTTP_MARKER_TASK_ID" ]; then ak task cancel "$HTTP_MARKER_TASK_ID" >/dev/null 2>&1 || true; ak delete task "$HTTP_MARKER_TASK_ID" >/dev/null 2>&1 || true; fi
    if [ -n "$SCHEDULED_MARKER_TASK_ID" ]; then ak task cancel "$SCHEDULED_MARKER_TASK_ID" >/dev/null 2>&1 || true; ak delete task "$SCHEDULED_MARKER_TASK_ID" >/dev/null 2>&1 || true; fi
  fi
  if [ -n "$BOARD_REPO_TASK_ID" ]; then ak task cancel "$BOARD_REPO_TASK_ID" >/dev/null 2>&1 || true; ak delete task "$BOARD_REPO_TASK_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$AGENT_ID" ]; then ak delete agent "$AGENT_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$TEMP_WORKER_HOME" ]; then rm -rf "$TEMP_WORKER_HOME"; fi
}
trap cleanup EXIT

json_query() {
  local query="$1"
  node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const result = ($query);
if (result === undefined || result === null) process.exit(1);
if (typeof result === 'object') console.log(JSON.stringify(result));
else console.log(result);
"
}

discover_board() {
  ak get board -o json | json_query "data.find((b) => b.name === 'Demo' && b.type === 'dev')?.id || data.find((b) => b.type === 'dev')?.id"
}

create_board() {
  ak create board --name "Demo" --type dev -o json | json_query "data.id"
}

board_field() {
  ak get board "$1" -o json | json_query "data['$2']"
}

discover_repo() {
  ak get repo -o json | json_query "data.find((r) => r.name === 'slink' || r.full_name === 'saltbo/slink')?.id || data[0]?.id"
}

repo_field() {
  ak get repo "$1" -o json | json_query "data['$2']"
}

maintainer_field() {
  ak get maintainer "$1" --board "$BOARD_ID" -o json | json_query "data['$2']"
}

runtime_default_model() {
  local runtime="$1"
  case "$runtime" in
    claude) ak get model --runtime "$runtime" -o json | json_query "data.find((m) => m.id.includes('opus'))?.id || data[0]?.id" ;;
    *) ak get model --runtime "$runtime" -o json | json_query "data[0]?.id" ;;
  esac
}

create_smoke_agent() {
  local runtime="$1"
  local model
  local model_args=()
  model="$(runtime_default_model "$runtime" 2>/dev/null || true)"
  if [ -n "$model" ]; then model_args=(--model "$model"); fi
  ak create agent \
    --name "Maintainer Smoke $TIMESTAMP" \
    --username "maintainer-smoke-$TIMESTAMP" \
    --runtime "$runtime" \
    "${model_args[@]}" \
    --role "board-maintainer" \
    --bio "Worker agent used by maintainer smoke tests" \
    -o json | json_query "data.id"
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
  local key="$1"
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
" "$key"
}

discover_installation_id() {
  local owner_id
  owner_id="$(repo_field "$REPO_ID" owner_id)"
  (cd apps/web && npx wrangler d1 execute agent-kanban-db --local --json --command \
    "SELECT installation_id FROM github_installations WHERE owner_id = '$owner_id' AND suspended_at IS NULL ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null) \
    | json_query "data[0]?.results?.[0]?.installation_id"
}

ensure_board_repo_mapping() {
  local has_repo
  has_repo=$(ak get repo --board "$BOARD_ID" -o json | json_query "data.some((r) => r.id === '$REPO_ID')" 2>/dev/null || echo "false")
  if [ "$has_repo" = "true" ]; then
    pass "board repository mapping already exists"
    return 0
  fi

  BOARD_REPO_TASK_ID=$(ak create task \
    --board "$BOARD_ID" \
    --repo "$REPO_ID" \
    --title "maintainer-smoke-map-$TIMESTAMP" \
    --description "Temporary task used by maintainer smoke test to record board repository scope." \
    -o json | json_query "data.id")

  has_repo=$(ak get repo --board "$BOARD_ID" -o json | json_query "data.some((r) => r.id === '$REPO_ID')" 2>/dev/null || echo "false")
  if [ "$has_repo" = "true" ]; then
    pass "board repository mapping created through task repo association"
  else
    fail "board repository mapping missing after task repo association"
  fi
}

task_id_by_title() {
  local title="$1"
  ak get task --board "$BOARD_ID" -o json 2>/dev/null \
    | TITLE="$title" node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const title = process.env.TITLE;
const task = data.find((item) => item.title === title);
if (!task) process.exit(1);
console.log(task.id);
" || true
}

wait_for_marker_task() {
  local title="$1"
  local timeout="${2:-600}"
  local elapsed=0
  local id=""
  while [ "$elapsed" -lt "$timeout" ]; do
    id="$(task_id_by_title "$title")"
    if [ -n "$id" ]; then
      echo "$id"
      return 0
    fi
    sleep 10
    elapsed=$((elapsed + 10))
  done
  return 1
}

post_github_issue_event() {
  local suffix="$1"
  local base_url secret payload signature delivery
  base_url="$(api_url)"
  secret="$(dev_var GITHUB_APP_WEBHOOK_SECRET)"
  delivery="maintainer-smoke-${TIMESTAMP}-${suffix}"
  payload=$(node -e "
const payload = {
  action: 'opened',
  installation: { id: Number(process.argv[1]) },
  repository: { id: 1, full_name: process.argv[2] },
  issue: {
    id: Date.now(),
    number: 1,
    title: 'Maintainer smoke issue',
    html_url: 'https://github.com/' + process.argv[2] + '/issues/1',
    user: { login: 'agent-kanban-smoke' },
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
}

maintainer_runs_count() {
  ak get maintainer "$1" --board "$BOARD_ID" --runs -o json 2>/dev/null | json_query "(data.data || []).length" || echo "0"
}

latest_run_summary() {
  ak get maintainer "$1" --board "$BOARD_ID" --runs -o json 2>/dev/null \
    | json_query "data.data?.[0] ? { id: data.data[0].id, status: data.data[0].status, error_message: data.data[0].error_message || null, session_id: data.data[0].session_id || null } : null" || true
}

require_machine_runner() {
  local status first_line
  status="$(ak status 2>&1 || true)"
  first_line="${status%%$'\n'*}"
  if [[ "$first_line" == *"not running"* || "$first_line" != *running* ]]; then
    echo "FATAL: machine runner is not running; maintainer smoke for runtime $RUNTIME requires an active local runner."
    echo "Start it with: ak start"
    exit 1
  fi
}

# ── Preflight ────────────────────────────────────────────────────────────────

echo "=== Maintainer Smoke Test ($([ "$LIVE" = 1 ] && echo "contract + live" || echo "contract")) ==="

case "$RUNTIME" in
  codex | claude | copilot | ama) ;;
  *) echo "FATAL: runtime must be codex, claude, copilot, or ama; got: $RUNTIME"; exit 1 ;;
esac

if ! ak whoami >/dev/null 2>&1; then
  echo "FATAL: ak is not authenticated. Run ak config set/use or agent identity setup first."
  exit 1
fi

case "$RUNTIME" in
  codex | claude | copilot) require_machine_runner ;;
esac

if [ -z "$BOARD_ID" ]; then BOARD_ID="$(discover_board 2>/dev/null || true)"; fi
if [ -z "$BOARD_ID" ]; then BOARD_ID="$(create_board)"; fi

BOARD_TYPE="$(board_field "$BOARD_ID" type)"
if [ "$BOARD_TYPE" != "dev" ]; then
  echo "FATAL: maintainer smoke requires a dev board so repository workflow can be validated; board $BOARD_ID is $BOARD_TYPE"
  exit 1
fi

if [ -z "$REPO_ID" ]; then REPO_ID="$(discover_repo 2>/dev/null || true)"; fi
if [ -z "$REPO_ID" ]; then
  echo "FATAL: no repository found. Register a GitHub App-backed repo first, or pass --repo <repo_id>."
  exit 1
fi
REPO_FULL_NAME="$(repo_field "$REPO_ID" full_name)"

AGENT_ID="$(create_smoke_agent "$RUNTIME")"

echo "  Board:   $BOARD_ID"
echo "  Repo:    $REPO_ID ($REPO_FULL_NAME)"
echo "  Agent:   $AGENT_ID ($RUNTIME, role=board-maintainer)"
echo ""

# ── Layer A: contract ────────────────────────────────────────────────────────

echo "[Layer A] CLI/API contract"

ensure_board_repo_mapping

BOARD_REPOS_JSON=$(ak get repo --board "$BOARD_ID" -o json)
if [ "$(printf '%s' "$BOARD_REPOS_JSON" | json_query "data.some((r) => r.id === '$REPO_ID' && r.full_name === '$REPO_FULL_NAME')")" = "true" ]; then
  pass "ak get repo --board returns target repository"
else
  fail "ak get repo --board does not return target repository"
fi

MAINTAINER_ID=$(ak create maintainer \
  --board "$BOARD_ID" \
  --agent "$AGENT_ID" \
  --name "Smoke maintainer $TIMESTAMP" \
  --prompt "Inspect the board and repository scope. Do not create or modify anything." \
  --interval-seconds 3600 \
  -o json | json_query "data.id")
if [ -n "$MAINTAINER_ID" ]; then
  pass "create board-level maintainer ($MAINTAINER_ID)"
else
  fail "create board-level maintainer"
  echo "==== Passed: $PASS  Failed: $((FAIL + 1)) ===="
  exit 1
fi

[ "$(maintainer_field "$MAINTAINER_ID" status)" = "active" ] \
  && pass "created maintainer is active" || fail "created maintainer is not active"

if [ "$(ak get maintainer "$MAINTAINER_ID" --board "$BOARD_ID" -o json | json_query "Object.prototype.hasOwnProperty.call(data, 'repository_id')")" = "false" ]; then
  pass "maintainer has no repository_id binding"
else
  fail "maintainer still exposes repository_id"
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

if token_output="$(ak github auth "$REPO_ID" --print-token 2>&1)"; then
  if printf '%s' "$token_output" | grep -Eq 'gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_'; then
    pass "ak github auth --print-token returns an installation token"
  else
    fail "ak github auth --print-token succeeded but token shape was not recognized"
  fi
else
  fail "ak github auth --print-token failed"
fi
unset token_output

if AK_WORKER=0 ak github auth "$REPO_ID" --git-only >/tmp/maintainer-smoke-git-only.out 2>&1; then
  fail "ak github auth --git-only modified credentials outside AK_WORKER"
else
  if grep -q "Refusing to modify global GitHub credentials" /tmp/maintainer-smoke-git-only.out; then
    pass "ak github auth --git-only refuses outside AK_WORKER"
  else
    fail "ak github auth --git-only failed for unexpected reason outside AK_WORKER"
  fi
fi
rm -f /tmp/maintainer-smoke-git-only.out

TEMP_WORKER_HOME="$(mktemp -d)"
if AK_WORKER=1 \
  HOME="$TEMP_WORKER_HOME" \
  XDG_CONFIG_HOME="$ORIGINAL_HOME/.config" \
  XDG_STATE_HOME="$ORIGINAL_HOME/.local/state" \
  XDG_DATA_HOME="$ORIGINAL_HOME/.local/share" \
  ak github auth "$REPO_ID" --git-only >/dev/null 2>&1; then
  if [ -f "$TEMP_WORKER_HOME/.git-credentials" ] \
    && grep -q "x-access-token:" "$TEMP_WORKER_HOME/.git-credentials" \
    && [ -f "$TEMP_WORKER_HOME/.gitconfig" ] \
    && grep -q "helper = store" "$TEMP_WORKER_HOME/.gitconfig"; then
    pass "ak github auth --git-only configures isolated worker git credentials"
  else
    fail "worker git credential files were not written as expected"
  fi
else
  fail "ak github auth --git-only failed inside AK_WORKER"
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

# ── Layer B: live runs ───────────────────────────────────────────────────────

if [ "$LIVE" = 1 ]; then
  echo "[Layer B] Live maintainer runs (AMA; this can take several minutes)"

  INSTALLATION_ID="$(discover_installation_id 2>/dev/null || true)"
  if [ -z "$INSTALLATION_ID" ]; then
    echo "FATAL: could not discover GitHub App installation id for repo $REPO_ID"
    exit 1
  fi
  echo "  GitHub installation: $INSTALLATION_ID"

  HTTP_MARKER_TITLE="maintainer-smoke-http-$TIMESTAMP"
  SCHEDULED_MARKER_TITLE="maintainer-smoke-scheduled-$TIMESTAMP"

  HTTP_PROMPT="This is a maintainer smoke test. First run: ak get repo --board $BOARD_ID -o json. Confirm repository $REPO_ID ($REPO_FULL_NAME) is present. Then run: ak github auth $REPO_ID --print-token. Do not print or store the token. After both commands succeed, create exactly one unassigned marker task with: ak create task --board $BOARD_ID --repo $REPO_ID --title \"$HTTP_MARKER_TITLE\" --description \"HTTP maintainer smoke marker\". Do not modify any repository."
  HTTP_MAINTAINER_ID=$(ak create maintainer \
    --board "$BOARD_ID" \
    --agent "$AGENT_ID" \
    --name "HTTP smoke maintainer $TIMESTAMP" \
    --prompt "$HTTP_PROMPT" \
    --interval-seconds 3600 \
    -o json | json_query "data.id")
  echo "  HTTP maintainer: $HTTP_MAINTAINER_ID"

  HTTP_BASELINE="$(maintainer_runs_count "$HTTP_MAINTAINER_ID")"
  post_github_issue_event "issue"
  sleep 5
  HTTP_AFTER="$(maintainer_runs_count "$HTTP_MAINTAINER_ID")"
  if [ "${HTTP_AFTER:-0}" -gt "${HTTP_BASELINE:-0}" ]; then
    pass "GitHub issues webhook dispatched an HTTP maintainer run"
  else
    fail "GitHub issues webhook did not dispatch an HTTP maintainer run"
  fi

  if HTTP_MARKER_TASK_ID="$(wait_for_marker_task "$HTTP_MARKER_TITLE" 600)"; then
    pass "HTTP maintainer run created marker task ($HTTP_MARKER_TASK_ID)"
  else
    fail "HTTP maintainer run did not create marker task"
    echo "    latest HTTP run: $(latest_run_summary "$HTTP_MAINTAINER_ID")"
  fi

  SCHEDULED_PROMPT="This is a scheduled maintainer smoke test. First run: ak get repo --board $BOARD_ID -o json. Confirm repository $REPO_ID ($REPO_FULL_NAME) is present. Then run: ak github auth $REPO_ID --print-token. Do not print or store the token. After both commands succeed, create exactly one unassigned marker task with: ak create task --board $BOARD_ID --repo $REPO_ID --title \"$SCHEDULED_MARKER_TITLE\" --description \"Scheduled maintainer smoke marker\". Do not modify any repository."
  SCHEDULED_MAINTAINER_ID=$(ak create maintainer \
    --board "$BOARD_ID" \
    --agent "$AGENT_ID" \
    --name "Scheduled smoke maintainer $TIMESTAMP" \
    --prompt "$SCHEDULED_PROMPT" \
    --interval-seconds 60 \
    -o json | json_query "data.id")
  echo "  Scheduled maintainer: $SCHEDULED_MAINTAINER_ID (interval 60s)"

  if SCHEDULED_MARKER_TASK_ID="$(wait_for_marker_task "$SCHEDULED_MARKER_TITLE" 720)"; then
    pass "scheduled maintainer run created marker task ($SCHEDULED_MARKER_TASK_ID)"
  else
    fail "scheduled maintainer run did not create marker task"
    echo "    latest scheduled run: $(latest_run_summary "$SCHEDULED_MAINTAINER_ID")"
  fi
  echo ""
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo "==============================="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if [ "$KEEP_ARTIFACTS" = 1 ]; then
  if [ -n "$HTTP_MARKER_TASK_ID" ]; then echo "  HTTP marker task:      $HTTP_MARKER_TASK_ID"; fi
  if [ -n "$SCHEDULED_MARKER_TASK_ID" ]; then echo "  Scheduled marker task: $SCHEDULED_MARKER_TASK_ID"; fi
fi
echo "==============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
