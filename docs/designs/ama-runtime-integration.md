# AMA Runtime Integration

Status: implementation record for `codex/ama-runtime-integration`

## Goal

Agent Kanban remains the task orchestration and review product. Any Managed
Agents is the runtime substrate.

AK owns:

- boards, org scoping, tasks, dependencies, review, PR workflow, and task
  annotations
- AK CLI workflow commands used by humans, lead agents, and worker agents
- AK product features such as board maintainers

AMA owns:

- projects as the runtime workspace scope
- agent definitions, environments, runners, sessions, scheduled triggers,
  vault-backed runtime secrets, events, usage, and runtime history

The integration must keep AMA hidden as product plumbing. AK users should not
need to understand AMA project, environment, runner capability, or session
configuration in order to use AK.

## Boundary Decisions

- AK org maps to one AMA project.
- AK board does not map to an AMA project.
- AMA does not store AK task, board, review, or PR semantics as first-class
  product fields.
- AK stores runtime correlation in task metadata annotations.
- AK may keep product tables such as `agents`, `repositories`, `machines`, and
  `board_maintainers` while the public AK UX still depends on them.
- The old Machine UX is preserved as an AK concept. Its backend now starts an
  AMA runner through AK-managed onboarding instead of exposing AMA runner setup.

## Runtime Flow

Assigned AK tasks dispatch through AMA:

1. AK receives a task create or assignment with an AK agent id.
2. AK resolves the owning AMA project and an online AK machine runtime mapped
   to an AMA environment server-side.
3. AK ensures the AK agent has a mapped AMA AgentDefinition.
4. AK creates a short-lived AK agent session identity.
5. AK stores the private runtime credential in AMA vault as a session secret
   and records the credential id in `ama_agent_sessions` for later revocation.
6. AK creates an AMA session with AK runtime env and vault-backed secret refs.
7. AK stores AMA ids and dispatch result in task metadata annotations.
8. The AMA runner starts the session; the agent uses AK CLI/API for claim,
   notes, review, reject handling, completion, and cancellation.

The public task API and CLI still speak AK concepts. `ak create task` and task
assignment do not require AMA agent, environment, or runner flags.

### Dispatch policy

Dispatch is deferred — the task stays todo+assigned without a runtime
binding — when the task is dependency-blocked, `scheduled_at` is in the
future, or capable machines exist but every runner is busy or offline.
Dispatch fails (409) only when no machine supports the agent's runtime at all.

A per-minute cron closes the loop, replacing the old daemon poll loop:

- `reconcileAmaBoundTasks` — releases tasks whose AMA session died
  (error/stopped/archived/missing) and tears down bindings left behind by
  best-effort cleanup on complete/cancel.
- `dispatchPendingAmaTasks` — dispatches assigned, unblocked, due,
  undispatched todo tasks (requires `AK_API_URL`).
- The stale sweep stops the bound AMA session before releasing a stale task.

### Binding teardown

`releaseTaskRuntimeBinding` is the single teardown path: stop the AMA session
(404/409 tolerated as already-terminal), revoke the vault session secret,
close the AK agent session, clear the binding annotations. Complete and cancel
transition locally first and tear down best-effort (the reconcile sweep mops
up if AMA is unreachable); release tears down strictly before re-dispatch;
re-dispatch always tears down the previous session first. Reject falls back
from resume to restart (teardown + release) when the session is already dead.

## Runner Onboarding

`ak start` keeps the existing AK credential flow:

- the CLI reads or saves AK API credentials
- it registers an AK machine with the runtime the runner will actually serve
- AK creates or reuses the machine's AMA environment during machine
  registration
- AK returns runner onboarding data in the machine registration response
- AK resolves AMA project, environment, capabilities, and runner federation
  server-side
- AK creates/refreshes the generic AMA external project binding
- AK performs OAuth2 token exchange for runner access and refresh tokens
- the CLI starts `ama-runner`

The runner credentials are written to an AK-owned runner config file with
restricted permissions. `AMA_TOKEN` is removed from the child process
environment. The runner command line contains the config path, AMA API server,
project, environment, workdir, and concurrency because those are runner process
inputs, but they are not exposed as AK CLI options.

## Metadata

AK task metadata annotations may contain:

```json
{
  "ama.projectId": "project_...",
  "ama.agentId": "agent_...",
  "ama.environmentId": "env_...",
  "ama.sessionId": "session_...",
  "agentId": "agent_...",
  "agentSessionId": "session_uuid",
  "ama.dispatch.result": "accepted"
}
```

These annotations are AK-owned correlation data. They are not written back into
AMA as AK product semantics.

The generic AMA external project binding uses standard federation fields:
issuer, external tenant id, environment id, and capabilities. It does not need
AK task or board metadata.

## Board Maintainers

Board maintainers are an AK product feature backed by generic AMA scheduled
agent triggers.

AK stores maintainer configuration and lightweight run correlation in:

- `board_maintainers`

AMA stores the scheduled trigger, created sessions, events, runtime history, and
future agent memory/notebook capability. AK lists heartbeat runs through a
public AK-shaped API response, but AK does not copy full session history into
local tables.

Maintainers are configured with AK agent ids. AK maps those agents to AMA
AgentDefinitions internally.

## Compatibility Rules

- `ak start`, `ak stop`, `ak restart`, `ak status`, and `ak logs` remain the
  AK machine commands.
- `ak start` must not ask users for AMA environment or capability arguments.
- Task creation and assignment must not ask users for AMA environment or
  session arguments.
- Machines remain visible as the AK runner/environment concept where existing
  UX depends on them.
- Legacy daemon/session APIs remain compatibility surfaces only. They are not
  the accepted runtime dispatch path.

## Implemented In This Branch

- Added task metadata annotations and runtime session mappings.
- Added AMA SDK-backed task dispatch.
- Added vault-backed AK agent session credentials for AMA sessions.
- Routed task chat, reject resume, cancel stop, and runtime snapshots through
  AMA sessions when a task is AMA-bound.
- Reworked `ak start` to launch `ama-runner` through AK onboarding while
  preserving the original AK credential flow.
- Preserved machine command names and stopped exposing AMA runner config as AK
  CLI arguments.
- Added board maintainer APIs, CLI commands, settings UI, scheduled trigger
  integration, and heartbeat run listing.
- Added server-side owner runtime bindings, machine-to-AMA-environment mappings,
  and AK-agent-to-AMA-agent mappings.
- Kept repositories as AK product records while translating GitHub repositories
  to AMA resource refs during dispatch.

## Current Verification Evidence

Local AK checks:

- `pnpm build`
- `pnpm -r --parallel run lint`
- `npx vitest run`
- `bash scripts/install-cli.sh`
- `./scripts/daemon-smoke-test.sh --runtime codex`

Real smoke evidence from the latest successful run (claude runtime, local AK
dev server + deployed AMA + released runner v0.1.0):

- generated PR: `https://github.com/saltbo/slink/pull/65`
- smoke summary: `Passed 11 Failed 0`
- the codex run was correctly refused by the new quota-aware dispatch (codex
  5-hour window at 100% at the time), which is the intended behavior

The smoke created real AK tasks, dispatched them through the online AMA
environment with a local runner, verified claim, in-progress, review, reject,
resume, second review, completion, session cleanup, cancellation, and cancelled
session cleanup.

AMA support work was pushed separately in Any Managed Agents:

- `5e3c016 fix(runners): preserve queued session resumes`

That fix prevents an older completed runner lease from overwriting newer queued
work for the same session during AK reject/resume.

## Closed Daemon-Parity Gaps

All of these are implemented and tested:

- PR state sync via a platform GitHub App: users install the app on their
  repositories (one click, no secrets, no per-user setup); GitHub delivers
  all installations' pull_request events to `POST /api/webhooks/github-app`,
  signed with the app webhook secret (`GITHUB_APP_WEBHOOK_SECRET`, platform
  env — never distributed). Events map PR merged→done and closed→cancelled
  in real time, routed by `pr_url`, which only matches tasks inside the PR
  owner's own boards — replacing the old daemon's 30s `gh` poll.
  One-time platform setup: create a GitHub App with webhook URL
  `<origin>/api/webhooks/github-app`, a generated webhook secret,
  Pull requests (Read) permission, and the Pull request event subscription;
  put the secret in the deployment env. A GitLab handler can be added as a
  sibling endpoint. (AK)
- Git author/committer identity rides `runtimeEnv` per agent. GPG signing
  remains open — needs a runner-side session signing key capability. (AK)
- Provider-native subagent files (`.claude/agents/*.md`, `.codex/agents/*.toml`)
  are materialized in the session worktree by the runner. (AMA)
- Quota-aware dispatch: runners report per-runtime quota windows; dispatch
  skips runners whose target runtime is at 100% utilization until the window
  resets, and the dispatch sweep retries. Mid-run rate-limit pause remains
  delegated to the runtime CLIs. (AK + AMA)
- Session usage accounting: AMA usage summary totals are copied into
  `ama_agent_sessions` at binding teardown. (AK)
- Leader session reaping: the CLI closes dead-PID leader sessions (with usage
  report) on the first leader command of a process. (AK)
- Session max duration: runner-side timeout (default 2h, configurable) fails
  the lease explicitly instead of renewing forever. (AMA)
- Runner capabilities are detected from installed CLIs and refreshed on every
  heartbeat. (AMA)
- Mid-run chat: prompts to a running claude-code/copilot session are delivered
  live over the runner channel into the runtime; codex (and any channel
  failure) falls back to the queued resume turn. (AMA)
- Codex/copilot resume tokens ride lease renewals and survive interrupts, so
  all three runtimes resume after a runner restart. (AMA)
- Runner version is pinned by the server via the machine registration
  response (`AMA_RUNNER_VERSION` env), with the CLI constant as fallback. (AK)
- The legacy CLI daemon is deleted (`packages/cli/src/daemon/`, `__daemon`
  command, daemon-only modules and tests — net −17k lines). Server legacy
  API surfaces stay until the 2026-09-01 sunset. (AK)

## Remaining Follow-Up

- GPG commit signing per agent (runner-side session signing key). (AMA)
- Register the production GitHub App and add a "Connect GitHub" install link
  in the web UI (the receiver endpoint is live; the app itself is a one-time
  manual registration). (AK ops/UI)
- Broaden maintainer negative-case validation; improve AMA event rendering;
  add memory/notebook UX when the AMA capability is ready. (AK)
- AMA-side changes require an AMA deploy and an ama-runner release (and a
  bump of the server runner-version pin) before they are live end-to-end;
  the latest smoke ran against the released runner v0.1.0. (ops)
