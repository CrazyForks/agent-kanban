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
2. AK resolves the owning AMA project and default AMA environment server-side.
3. AK ensures the AK agent has a mapped AMA AgentDefinition.
4. AK creates a short-lived AK agent session identity.
5. AK stores the private runtime credential in AMA vault as a session secret.
6. AK creates an AMA session with AK runtime env and vault-backed secret refs.
7. AK stores AMA ids and dispatch result in task metadata annotations.
8. The AMA runner starts the session; the agent uses AK CLI/API for claim,
   notes, review, reject handling, completion, and cancellation.

The public task API and CLI still speak AK concepts. `ak create task` and task
assignment do not require AMA agent, environment, or runner flags.

## Runner Onboarding

`ak start` keeps the existing AK credential flow:

- the CLI reads or saves AK API credentials
- it calls `/api/runtime/runners/onboarding`
- AK resolves AMA project, environment, capabilities, and runner federation
  server-side
- AK creates/refreshes the generic AMA external project binding
- AK performs OAuth2 token exchange for a runner token
- the CLI starts `ama-runner`

The runner token is passed via `AMA_TOKEN` in the child process environment, not
as a command-line argument. The runner command line contains AMA origin,
project, environment, and capabilities because those are runner process inputs,
but they are not exposed as AK CLI options.

## Metadata

AK task metadata annotations may contain:

```json
{
  "ama.projectId": "project_...",
  "ama.agentId": "agent_...",
  "ama.environmentId": "env_...",
  "ama.sessionId": "session_...",
  "ak.agentId": "agent_...",
  "ak.runtimeSessionId": "session_uuid",
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
- `board_maintainer_runs`

AMA stores the scheduled trigger, created sessions, events, runtime history, and
future agent memory/notebook capability. AK can list heartbeat runs and link to
their AMA sessions, but AK does not copy full session history into local tables.

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
- Added server-side AMA project mapping and AK-agent-to-AMA-agent mapping.
- Kept repositories as AK product records while translating GitHub repositories
  to AMA resource refs during dispatch.

## Current Verification Evidence

Local AK checks:

- `pnpm build`
- `pnpm -r --parallel run lint`
- `npx vitest run`
- `bash scripts/install-cli.sh`
- `./scripts/daemon-smoke-test.sh codex`

Real smoke evidence from the latest successful run:

- board: `0zktb42l`
- repository: `q04u4hch`
- positive lifecycle task: `abog3lqkspbn`
- generated PR: `https://github.com/saltbo/agent-kanban/pull/205`
- cancel lifecycle task: `j54jtk8vpsi4`
- smoke summary: `Passed 11 Failed 0`

The smoke created real AK tasks, dispatched them through the online AMA
environment with a local runner, verified claim, in-progress, review, reject,
resume, second review, completion, session cleanup, cancellation, and cancelled
session cleanup.

AMA support work was pushed separately in Any Managed Agents:

- `5e3c016 fix(runners): preserve queued session resumes`

That fix prevents an older completed runner lease from overwriting newer queued
work for the same session during AK reject/resume.

## Remaining Follow-Up

- Broaden maintainer negative-case validation after this PR lands.
- Improve AMA event rendering in AK task detail as AMA canonical event shapes
  evolve.
- Continue migrating old machine/session compatibility tables once rollout
  safety is agreed.
- Add AMA agent memory/notebook UX when the generic AMA memory capability is
  ready for product use.
