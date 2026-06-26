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
#   - creates a real GitHub issue in the board repository
#   - sends a signed GitHub issues webhook with the real issue payload
#   - waits for the event-triggered maintainer to triage the issue into a repo task
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
CALLER_AGENT_ID=""
MAINTAINER_ID=""
HTTP_MAINTAINER_ID=""
SCHEDULED_MAINTAINER_ID=""
REPO_FULL_NAME=""
INSTALLATION_ID=""
BOARD_REPO_TASK_ID=""
HTTP_TRIAGE_TASK_ID=""
HTTP_ISSUE_NUMBER=""
HTTP_ISSUE_TITLE=""
HTTP_ISSUE_URL=""
HTTP_ISSUE_REST_JSON=""
HTTP_REPOSITORY_REST_JSON=""
SCHEDULED_MARKER_TASK_ID=""
TEMP_WORKER_HOME=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  if [ -n "$MAINTAINER_ID" ]; then ak delete maintainer "$MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$HTTP_MAINTAINER_ID" ]; then ak delete maintainer "$HTTP_MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ -n "$SCHEDULED_MAINTAINER_ID" ]; then ak delete maintainer "$SCHEDULED_MAINTAINER_ID" --board "$BOARD_ID" >/dev/null 2>&1 || true; fi
  if [ "$KEEP_ARTIFACTS" != 1 ] && [ -n "$HTTP_ISSUE_NUMBER" ]; then
    gh issue close "$HTTP_ISSUE_NUMBER" -R "$REPO_FULL_NAME" --reason "not planned" --comment "Closed by AK maintainer smoke test cleanup." >/dev/null 2>&1 || true
  fi
  if [ "$KEEP_ARTIFACTS" != 1 ]; then
    if [ -n "$HTTP_TRIAGE_TASK_ID" ]; then ak task cancel "$HTTP_TRIAGE_TASK_ID" >/dev/null 2>&1 || true; ak delete task "$HTTP_TRIAGE_TASK_ID" >/dev/null 2>&1 || true; fi
    if [ -n "$SCHEDULED_MARKER_TASK_ID" ]; then ak task cancel "$SCHEDULED_MARKER_TASK_ID" >/dev/null 2>&1 || true; ak delete task "$SCHEDULED_MARKER_TASK_ID" >/dev/null 2>&1 || true; fi
  fi
  if [ -n "$BOARD_REPO_TASK_ID" ]; then ak task cancel "$BOARD_REPO_TASK_ID" >/dev/null 2>&1 || true; ak delete task "$BOARD_REPO_TASK_ID" >/dev/null 2>&1 || true; fi
  if [ "$KEEP_ARTIFACTS" != 1 ] && [ -n "$AGENT_ID" ]; then ak delete agent "$AGENT_ID" >/dev/null 2>&1 || true; fi
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

create_real_github_issue() {
  local created_url issue_json
  created_url="$(gh issue create \
    -R "$REPO_FULL_NAME" \
    --title "$HTTP_ISSUE_TITLE" \
    --body "Temporary issue created by AK maintainer smoke test $TIMESTAMP. It will be closed by the smoke cleanup unless --keep-artifacts is set.")"
  issue_json="$(gh issue view "$created_url" -R "$REPO_FULL_NAME" --json number,title,url)"
  HTTP_ISSUE_NUMBER="$(printf '%s' "$issue_json" | json_query "data.number")"
  HTTP_ISSUE_TITLE="$(printf '%s' "$issue_json" | json_query "data.title")"
  HTTP_ISSUE_URL="$(printf '%s' "$issue_json" | json_query "data.url")"
  HTTP_ISSUE_REST_JSON="$(gh api "repos/$REPO_FULL_NAME/issues/$HTTP_ISSUE_NUMBER" --jq '{ id, node_id, number, title, html_url, state, user: { login: .user.login, id: .user.id, node_id: .user.node_id, type: .user.type } }')"
  HTTP_REPOSITORY_REST_JSON="$(gh api "repos/$REPO_FULL_NAME" --jq '{ id, node_id, full_name, html_url, private, owner: { login: .owner.login, id: .owner.id, node_id: .owner.node_id, type: .owner.type } }')"
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

max_task_seq() {
  ak get task --board "$BOARD_ID" -o json 2>/dev/null \
    | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(Math.max(0, ...data.map((item) => Number(item.seq) || 0)));
"
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

assert_no_caller_created_tasks_since() {
  local baseline_seq="$1"
  local label="$2"
  local offenders
  if [ -z "$CALLER_AGENT_ID" ]; then
    fail "$label could not verify caller-created task leakage because caller identity is unknown"
    return
  fi
  offenders="$(ak get task --board "$BOARD_ID" -o json 2>/dev/null \
    | BASELINE_SEQ="$baseline_seq" CALLER_AGENT_ID="$CALLER_AGENT_ID" node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const baseline = Number(process.env.BASELINE_SEQ) || 0;
const caller = process.env.CALLER_AGENT_ID;
const offenders = data
  .filter((item) => (Number(item.seq) || 0) > baseline && item.created_by === caller)
  .map((item) => '#' + item.seq + ' ' + item.id + ' ' + item.title);
if (offenders.length > 0) console.log(offenders.join('\\n'));
")"
  if [ -z "$offenders" ]; then
    pass "$label created no tasks as caller/leader identity"
  else
    fail "$label created tasks as caller/leader identity"
    printf '%s\n' "$offenders" | sed 's/^/    /'
  fi
}

task_value() {
  local task_id="$1"
  local field="$2"
  ak get task "$task_id" -o json | FIELD="$field" node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const task = data.data || data;
const value = task[process.env.FIELD];
if (value === undefined || value === null) process.exit(1);
if (typeof value === 'object') console.log(JSON.stringify(value));
else console.log(value);
"
}

task_optional_value() {
  local task_id="$1"
  local field="$2"
  ak get task "$task_id" -o json | FIELD="$field" node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const task = data.data || data;
const value = task[process.env.FIELD];
if (value === undefined || value === null) process.exit(0);
if (typeof value === 'object') console.log(JSON.stringify(value));
else console.log(value);
"
}

assert_marker_created_by_maintainer() {
  local task_id="$1"
  local label="$2"
  local created_by
  created_by="$(task_value "$task_id" "created_by")"
  if [ "$created_by" = "$AGENT_ID" ]; then
    pass "$label marker task was created by maintainer agent"
  else
    fail "$label marker task created_by=$created_by, expected maintainer agent $AGENT_ID"
  fi
}

assert_issue_triage_task() {
  local task_id="$1"
  local created_by repo_id status assigned_to description
  created_by="$(task_value "$task_id" "created_by")"
  repo_id="$(task_value "$task_id" "repository_id")"
  status="$(task_value "$task_id" "status")"
  assigned_to="$(task_optional_value "$task_id" "assigned_to")"
  description="$(task_optional_value "$task_id" "description")"

  if [ "$created_by" = "$AGENT_ID" ]; then
    pass "HTTP issue triage task was created by maintainer agent"
  else
    fail "HTTP issue triage task created_by=$created_by, expected maintainer agent $AGENT_ID"
  fi

  if [ "$repo_id" = "$REPO_ID" ]; then
    pass "HTTP issue triage task is linked to repository $REPO_ID"
  else
    fail "HTTP issue triage task repository_id=$repo_id, expected $REPO_ID"
  fi

  if [ "$status" = "todo" ]; then
    pass "HTTP issue triage task remains todo for downstream assignment"
  else
    fail "HTTP issue triage task status=$status, expected todo"
  fi

  if [ -z "$assigned_to" ]; then
    pass "HTTP issue triage task is unassigned"
  else
    fail "HTTP issue triage task assigned_to=$assigned_to, expected unassigned"
  fi

  if [[ "$description" == *"Issue Number: #$HTTP_ISSUE_NUMBER"* ]] && [[ "$description" == *"$HTTP_ISSUE_URL"* ]]; then
    pass "HTTP issue triage task description carries webhook issue number and URL"
  else
    fail "HTTP issue triage task description is missing issue number or URL"
    echo "    description: $description"
  fi
}

post_github_issue_event() {
  local suffix="$1"
  local base_url secret payload signature delivery
  base_url="$(api_url)"
  secret="$(dev_var GITHUB_APP_WEBHOOK_SECRET)"
  delivery="maintainer-smoke-${TIMESTAMP}-${suffix}"
  payload=$(ISSUE_JSON="$HTTP_ISSUE_REST_JSON" REPOSITORY_JSON="$HTTP_REPOSITORY_REST_JSON" node -e "
const issue = JSON.parse(process.env.ISSUE_JSON);
const repository = JSON.parse(process.env.REPOSITORY_JSON);
const payload = {
  action: 'opened',
  installation: { id: Number(process.argv[1]) },
  repository,
  issue,
  sender: issue.user,
};
process.stdout.write(JSON.stringify(payload));
" "$INSTALLATION_ID")
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
CALLER_AGENT_ID="$(ak whoami 2>/dev/null | awk '/Agent ID:/ {print $3; exit}' || true)"

echo "  Board:   $BOARD_ID"
echo "  Repo:    $REPO_ID ($REPO_FULL_NAME)"
echo "  Agent:   $AGENT_ID ($RUNTIME, role=board-maintainer)"
[ -n "$CALLER_AGENT_ID" ] && echo "  Caller:  $CALLER_AGENT_ID"
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

  HTTP_TRIAGE_TITLE="maintainer-smoke-triage-$TIMESTAMP"
  HTTP_ISSUE_TITLE="Maintainer smoke issue $TIMESTAMP"
  create_real_github_issue
  echo "  GitHub issue: $REPO_FULL_NAME#$HTTP_ISSUE_NUMBER ($HTTP_ISSUE_URL)"
  SCHEDULED_MARKER_TITLE="maintainer-smoke-scheduled-$TIMESTAMP"
  LIVE_BASELINE_SEQ="$(max_task_seq)"

  HTTP_PROMPT="This is a maintainer issue triage smoke test. Treat only an issues.opened event as actionable. First run: ak get repo --board $BOARD_ID -o json. Confirm repository $REPO_ID ($REPO_FULL_NAME) is present. Then run: ak github auth $REPO_ID --print-token. Do not print or store the token. After both commands succeed, use the issue number and issue URL from the trigger context. Create exactly one unassigned triage task with: ak create task --board $BOARD_ID --repo $REPO_ID --title \"$HTTP_TRIAGE_TITLE\" --description \"Source: GitHub issues.opened maintainer smoke. Issue Number: #<issue.number>. Issue URL: <issue.html_url>. Requested Action: triage the issue and decide the implementation path.\" Do not modify GitHub or the repository."
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

  if HTTP_TRIAGE_TASK_ID="$(wait_for_marker_task "$HTTP_TRIAGE_TITLE" 600)"; then
    pass "HTTP maintainer run created issue triage task ($HTTP_TRIAGE_TASK_ID)"
    assert_issue_triage_task "$HTTP_TRIAGE_TASK_ID"
  else
    fail "HTTP maintainer run did not create issue triage task"
    echo "    latest HTTP run: $(latest_run_summary "$HTTP_MAINTAINER_ID")"
  fi
  assert_no_caller_created_tasks_since "$LIVE_BASELINE_SEQ" "HTTP maintainer event window"

  DELETE_OK=$(ak delete maintainer "$HTTP_MAINTAINER_ID" --board "$BOARD_ID" -o json 2>/dev/null | json_query "data.ok" || echo "")
  if [ "$DELETE_OK" = "true" ]; then
    pass "HTTP maintainer deleted before scheduled maintainer phase"
    HTTP_MAINTAINER_ID=""
  else
    fail "HTTP maintainer delete before scheduled maintainer phase did not return ok"
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
    assert_marker_created_by_maintainer "$SCHEDULED_MARKER_TASK_ID" "scheduled"
  else
    fail "scheduled maintainer run did not create marker task"
    echo "    latest scheduled run: $(latest_run_summary "$SCHEDULED_MAINTAINER_ID")"
  fi
  assert_no_caller_created_tasks_since "$LIVE_BASELINE_SEQ" "live maintainer run window"
  echo ""
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo "==============================="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if [ "$KEEP_ARTIFACTS" = 1 ]; then
  if [ -n "$AGENT_ID" ]; then echo "  Maintainer agent:      $AGENT_ID"; fi
  if [ -n "$HTTP_TRIAGE_TASK_ID" ]; then echo "  HTTP triage task:      $HTTP_TRIAGE_TASK_ID"; fi
  if [ -n "$SCHEDULED_MARKER_TASK_ID" ]; then echo "  Scheduled marker task: $SCHEDULED_MARKER_TASK_ID"; fi
fi
echo "==============================="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
