---
name: ak-task
description: |
  Full task lifecycle: create → assign → monitor → review → reject/complete.
  Use when asked to add a feature, fix a bug, create a task, 加个功能, or 修个 bug.
argument-hint: "<feature or bug description>"
---

# ak-task — Task Lifecycle

Create a task, assign it, then monitor → review → reject/complete.

## Identity

This is a leader workflow.

If `ak` says no leader identity exists for the current runtime, create one first:

```bash
ak identity create --username <username> [--name <name>]
```

The leader chooses its own username and optional full name.

## Unattended Execution Contract

Assume this workflow runs in two explicit modes:

- **Before task creation: human-in-the-loop.** Ask the user only during the initial clarification and task preview phase, before task creation is confirmed.
- **After task creation: human-not-in-the-loop.** Once the user confirms the task and it is created, do not stop to ask for permission, confirmation, or next steps unless the user interrupts you. Continue through the full work cycle: create, assign, monitor, review, reject or complete, and report the outcome.

If execution hits a blocker after confirmation, use the available tools and repository context to resolve it. If the blocker cannot be resolved without external authorization or production mutation, fail fast with the exact blocker and the next required action instead of waiting in the middle of the workflow.

## Workflow Checklist

Immediately after this skill is invoked, create and maintain an explicit task
plan/checklist in the agent UI. This checklist is a guardrail against attention
drift during clarification, preview, and execution handoff.

The checklist must include the full lifecycle:

1. Resolve task scope and target context.
2. Investigate code, repo, board, labels, workers, and related tasks.
3. Preview the exact task and get human confirmation.
4. Create labels/workers if needed, then create and assign the task.
5. Switch to human-not-in-the-loop execution.
6. Monitor the task until it reaches review.
7. Review the PR: CI, code, functional acceptance, notes.
8. Reject or merge according to gates.
9. Repeat monitor/review after rejection until the task is done.
10. Report final outcome.

Keep this checklist current:

- Mark exactly one active step as in progress.
- Update statuses at every phase transition.
- After `ak create task`, explicitly mark planning/creation complete and mark
  monitoring/review as in progress before any final user-facing summary.
- Do not send a final answer while any post-creation execution step remains
  pending, unless the user explicitly says to stop, cancel, abort, or only
  create the task.
- If context becomes long or the user interrupts, re-read the checklist before
  deciding the next action.

## Input

Parse the user's input:
- **What** — feature description or bug report (required)
- **Board** — which board (if not specified, use the first board)
- **Labels** — use board-level taxonomy for stable filtering; create only reusable missing labels before task creation

## Phase 1: Create & Assign

### Step 1: Context

Before choosing or creating workers, read `references/runtime-delegation.md`. Before creating any worker, also read `references/agent-creation.md` and follow its Worker Profile Preview.

```bash
ak get board                   # pick the right board
ak get label --board <board>   # existing board label taxonomy
ak get agent -o json           # available agents, load, runtime_available
ak get model --runtime <name>  # provider-reported models for a runtime
ak get repo                    # registered repos
```

If there's only one board, use it. Otherwise ask which board.

### Step 2: Investigate

Before creating the task, understand what's involved:
- Read CONTRIBUTING.md in the target repo to understand contribution requirements
- Read relevant source files to understand current implementation
- Identify which files need to change
- Check for existing related tasks: `ak get task --board <board-id>`

### Step 3: Confirm with User

Use `AskUserQuestion` to interactively resolve any uncertainties before creating the task. For each ambiguous point, present options for the user to choose from:

- **Scope unclear** — present 2-3 scope interpretations as options, each with a preview showing what files/changes are involved
- **Multiple approaches** — present implementation strategies as options with trade-off descriptions
- **Labels/agent/runtime/repo ambiguous** — present choices when there are multiple candidates
- **Dependencies uncertain** — present options about whether to depend on or parallelize with related tasks

#### Label Selection

Labels are board-level taxonomy, not free-form task notes. Use them only for stable filtering dimensions that will remain useful across tasks.

Before previewing the task:

1. Run `ak get label --board <board-id>` and reuse existing labels whenever possible.
2. Choose at most a small set of labels, usually one version label plus one or two stable area/type labels.
3. Create a missing label only if it will be reused beyond this task; otherwise put that detail in `## Spec`.
4. If label choice is ambiguous, ask during the initial clarification phase.

Recommended categories:

- **Version** — `vX.Y`, for example `v1.4`; avoid patch versions or suffixes unless the board already uses that granularity.
- **Area** — stable implementation area such as `frontend`, `backend`, `api`, `database`, `cli`, `infra`, `docs`, `ui`, `security`, or `test`.
- **Type** — optional when useful for filtering, such as `feature`, `bug`, or `refactor`.

Avoid labels for temporary process state, runtime/provider choice, tools, libraries, branches, files, or one-off implementation details. Examples that usually belong in the task description instead of labels: `blocked`, `testing`, `needs-review`, `codex`, `copilot`, `gemini`, `github`, `cloudflare`, `tailwind`, `sqlite`, `prompt-fix`, and file names.

When labels overlap, prefer the canonical stable form: `infra` over `infrastructure`, `bug` over `bugfix`, `database` over `db`, and `frontend` for UI implementation unless the task is specifically visual polish.

Create missing reusable labels before task creation:

```bash
ak create label --board <board-id> --name v1.4 --color "#22C55E" --description "Version 1.4"
ak create label --board <board-id> --name backend --color "#38BDF8" --description "Backend/API work"
ak create label --board <board-id> --name bug --color "#F87171" --description "Bug fix"
```

Useful color defaults:

- Version: `#22C55E`
- Frontend/UI: `#A78BFA`
- Backend/API/database: `#38BDF8`
- CLI/runtime: `#22D3EE`
- Bug/security: `#F87171`
- Infra/deploy: `#F59E0B`
- Docs/refactor/general: `#71717A`

#### Hard Stop: Agent Runtime Selection

Before creating workers or tasks, determine the worker runtime.

- If the user specified a runtime, assign only to a worker whose `runtime` matches it and whose `runtime_available` is `true`.
- If the user specified a runtime but that runtime is not schedulable, stop before worker or task creation and ask the user to choose an available runtime.
- If no matching available worker exists for the specified schedulable runtime, create a worker on that runtime before task creation using `references/agent-creation.md`.
- If the user did not specify runtime and multiple available runtimes are reasonable for the task, ask the user to choose the runtime before creating workers or tasks.
- Never silently default to the leader's own runtime.
- Before choosing a non-default model for a new worker, run `ak get model --runtime <runtime> -o json` and use a provider-reported model ID.

Keep iterating — each answer may reveal new questions. Only proceed to create when all points are resolved and the user has confirmed the final task spec.

If nothing is ambiguous (simple, clear-cut request), skip straight to the task preview below.

#### Structured Questions in Codex

Use the runtime's structured question tool during the pre-task-creation phase:

- In Claude-style runtimes, use `AskUserQuestion`.
- In Codex, use `request_user_input`.

For Codex Default mode, verify the feature flag before relying on interactive prompts:

```bash
codex features list | rg default_mode_request_user_input
```

Expected:

```text
default_mode_request_user_input     under development  true
```

If it is not enabled, tell the user to enable the feature flag themselves and
restart Codex before continuing:

```bash
codex features enable default_mode_request_user_input
```

Do not run this command for the user. The current Codex session will not gain the
tool after an automatic config change; the user must enable it and reopen Codex.
Do not switch Codex into Plan mode as a workaround. Plan mode injects Codex-native planning behavior and conflicts with this leader workflow.

### Step 4: Preview & Create Task

Before creating, show the user the **exact task that will be created** using `AskUserQuestion`. Format the preview as:

```
📋 Task Preview

Title: <concise action phrase>
Board: <board-name>
Repo: <repo-name>
Agent: <agent-name>
Runtime: <agent-runtime>
Labels: <labels>
Depends on: <task-ids or "none">

## Goal
<one sentence>

## Files
- <file path> — <what changes>

## Spec
<concrete behavior: inputs, outputs, edge cases, error handling>

## Checks
- [ ] <verifiable condition — reviewer will check each one in Gate 2>

Examples by task type:
- API: "POST /api/items returns 201 with { id, name }"
- API: "empty name returns 400 with validation error"
- UI: "clicking Submit creates the item and navigates to detail page"
- UI: "empty form shows inline validation, submit button stays disabled"
- CLI: "ak get task --board xxx prints task table with status column"

---
Create this task? (y/n)
```

Everything from `## Goal` through `## Checks` is the exact text that will be passed to `--description`. The header fields above it (Title, Board, Agent, Runtime, etc.) are metadata for display only — do not include them in `--description`. The user must see the full description before it's sent to the agent.

Before running `ak create task`, verify:

- Selected agent is a worker.
- Selected agent has `runtime_available: true`.
- If the user specified runtime, selected agent runtime matches it.
- If the user specified runtime, that runtime is schedulable.
- If runtime was ambiguous, the user chose the runtime.
- Task Preview includes Runtime and Agent.
- Labels exist on the board, are stable taxonomy labels, and exclude one-off implementation details.
- `--assign-to` uses the selected agent ID.

**On confirmation**, create the task:

```bash
ak create task \
  --board <board-id> \
  --repo <repo-id> \
  --assign-to <agent-id> \
  --title "<concise action phrase>" \
  --description "<detailed spec>" \
  --labels "<comma-separated>"
```

**`--assign-to` is mandatory.** Always include it on create. Only assign to an agent whose `runtime_available` is `true`. If the right role only exists on an unavailable runtime, create a new worker with the required capability profile on an available runtime and assign to that worker. Use `references/agent-creation.md`; do not create workers from role/runtime alone.

**Dependencies**: If this task touches files that overlap with other in-flight tasks, add `--depends-on <task-id>`. Create all related tasks upfront with DAG dependencies — don't wait for one to finish before creating the next.

### Task Creation Best Practices

- Create one task for one reviewable outcome.
- Split by feature/module boundary and context overlap, not by human job title.
- Keep highly overlapping work in one task, even if it touches frontend, backend, CLI, schema, and tests.
- Split only when work is independently understandable, independently reviewable, and has low file/data/API context overlap.
- Make the title an action phrase, not a vague topic.
- Put implementation constraints and acceptance checks in `--description`; do not rely on chat context.
- Include concrete files, commands, endpoints, UI states, and error cases when known.
- Assign only to worker agents with `runtime_available: true`.
- Use `--depends-on` for real blockers or overlapping context. Parallel tasks must not fight over the same files, data model, or API contract.
- Create missing reusable labels first with `ak create label --board <board-id> --name <name> --color <hex> --description "<desc>"`.

Report to user: task ID, title, assigned agent.

## Phase 2: Monitor & Review

### Step 5: Monitor

**Block on `ak wait` instead of writing polling loops.** Exit codes: 0 condition met, 2 task cancelled, 124 timeout.

```bash
ak wait task <task-id> --until in_review --timeout 1h
case $? in
  0)   ;;  # ready for review → Step 6
  2)   echo "task cancelled — abort" ; exit 1 ;;
  124) echo "timed out — investigate" ;;  # fall through to investigation
esac
```

Run `ak wait task --help` for the full flag list.

**On timeout (124) or if you suspect the agent is stuck, investigate immediately — don't just re-wait:**
1. Check daemon logs: `ak logs --lines 20`
2. Check if agent process is alive: `ps aux | grep "claude.*session"`
3. Check agent session log for what it's doing or where it's stuck
4. Check child processes: the agent may be stuck on a hook, install, or network call

### Step 6: Review PR

**Pre-check: CI status.** Before reviewing, verify CI has passed on the PR:
```bash
gh pr checks <pr-number> --repo <owner>/<repo>
```
If CI is pending or failed, reject immediately — worker must wait for CI to pass before submitting for review:
```bash
ak task reject <task-id> --reason "CI not green — wait for CI to pass before submitting for review"
```

Three gates — code review, functional acceptance, and agent notes review — must
pass before merging. Follow the shared verification policy in
`references/leader-verification.md`, including waiver evidence and verification
infrastructure learning.

#### Gate 1: Code Review

Read the full PR diff and review against the task spec:
```bash
gh pr view <pr-number> --repo <owner>/<repo> --json title,body,additions,deletions,changedFiles
gh pr diff <pr-number> --repo <owner>/<repo>
```

Check:
- Does the implementation match the task spec?
- Code quality — logic errors, bad abstractions, security issues
- Boundary awareness — CLI user-facing output vs internal logging, public API vs private
- Missing or broken test updates
- Dropped functionality (lost stack traces, removed useful info, etc.)

**Fails → reject immediately**, don't proceed to Gate 2.

#### Gate 2: Functional Acceptance

Apply `references/leader-verification.md`. Passing tests, CI, and code review
is not completion. Validate every task check from the product/user perspective.
If verification cannot be completed, follow the shared attempt budget, waiver,
and verification infrastructure learning rules.

#### Gate 3: Agent Notes Review

Read task notes before merging:

```bash
ak get note --task <task-id>
```

Check:
- The worker summarized what was done.
- Whether the worker proposed any durable process or principle change for its agent profile.
- Any proposal includes the reason, exact fields to change, and complete candidate `Agent` YAML using the same `metadata.name` username as the current agent.

If the completion summary is missing or unclear, reject and ask the worker to add it.

If no proposal is present, continue. If a proposal is present, review it using `references/runtime-delegation.md`. Apply it only when the proposal is durable, role-appropriate, and not task-specific.

### Step 7: Decide — act immediately, do not ask the user

**Any gate fails or is blocked → Reject.** List all issues in the reason.
```bash
ak task reject <task-id> --reason "<all issues, specific and actionable>"
```
After reject, go back to Step 5 and keep monitoring.

**All gates pass, or Gate 2 is explicitly waived after the required attempt
budget → Post verification comment, then merge.**

Post evidence on the PR before merging using the verification comment template in
`references/leader-verification.md`. Before running `gh pr merge`, re-read the
comment and confirm it satisfies the shared policy.

If the PR has merge conflicts, reject instead of merging — the worker agent will rebase, fix, and resubmit:
```bash
ak task reject <task-id> --reason "merge conflicts with main — rebase and resubmit"
```

Then merge:
```bash
gh pr merge <pr-number> --repo <owner>/<repo> --squash --delete-branch
```
The daemon's PR Monitor will mark the task done — do NOT manually `ak task complete`.

#### Cleanup after merge
Remove local review artifacts from the repo root after verifying each path belongs to this workflow:

- temporary review worktrees under `/tmp/ak-review-*`
- `playwright-report/`
- `test-results/`

## Phase 3: Exception Handling

### Removing a task in todo
Tasks in `todo` status cannot be cancelled — delete them directly:
```bash
ak delete task <task-id>
```

### Canceling an active task
For tasks in `in_progress` or `in_review`: **always close the PR first**, then cancel. Closing the PR without canceling is fine — PR Monitor will auto-cancel. But canceling without closing the PR leaves orphaned PRs.
```bash
gh pr close <pr-number> --repo <owner>/<repo> --delete-branch
ak task cancel <task-id>
```

### Stuck rejected task
If a rejected task stays `in_progress` without being picked up:
1. Check daemon logs — is it detecting the rejection?
2. If daemon is down or not tracking, close the PR, cancel, recreate with original spec + review feedback + reference the existing PR branch
3. Always use `--assign-to` on recreate

### CI failure
Investigate the failure. If it's a source bug, reject with details. If it's flaky CI, re-trigger.

### AK command, product, or skill issue
If the blocker appears to be an `ak` bug, missing capability, confusing UX, documentation gap, or skill workflow problem, file an issue in the official repo after collecting a minimal reproduction.

If the leader agent makes a process error, violates this skill, merges/rejects incorrectly, skips a required gate, misinterprets conflicting skill instructions, or has to be corrected by the user about expected skill behavior, do not stop at a chat apology or "next time" promise. Summarize the failure as a durable skill-improvement issue so future agents and external projects can benefit from the lesson. Include:

- What the agent did wrong.
- Which skill text was unclear, incomplete, contradictory, or too weak to prevent the error.
- The exact rule or wording that should be added or changed.
- Any local skill edits already made during the incident.

```bash
gh issue create \
  --repo saltbo/agent-kanban \
  --title "ak-task: <short process or skill problem summary>" \
  --body "$(cat <<'EOF'
## Summary
<what failed or what capability is missing>

## Command
ak <command and flags>

## Expected
<what should have happened>

## Actual
<exact error text or observed behavior>

## Context
- ak version:
- OS:
- Runtime:
- Auth type: user | machine | agent
- Board/task/repo IDs, if relevant:

## Reproduction
1. <step>
2. <step>

## Proposed Skill Change
<specific wording or rule that would prevent recurrence>
EOF
)"
```

Never include API keys, session tokens, private keys, `.env` contents, or private repository data. If `gh` is unavailable, open `https://github.com/saltbo/agent-kanban/issues/new` and paste the same content.

## Rules

- **Workflow completion is mandatory** — once this skill is invoked, the full lifecycle (create → assign → monitor → review → merge/reject) MUST run to completion.
  - **Before task creation: human-in-the-loop.** Discuss scope, resolve ambiguity, preview the exact task, and get explicit user confirmation before creating it.
  - **After task creation: human-not-in-the-loop.** The user is no longer part of execution control unless they explicitly interrupt with a new instruction. The leader owns execution and must continue monitoring, reviewing, rejecting, merging, and iterating until the work cycle completes.
  - After `ak create task`, continue immediately into monitoring/review work (`ak wait task ...`) in the same turn whenever possible. Do not send a final answer merely reporting that the task was created unless the user explicitly says to stop, cancel, abort, or only create the task.
  - If execution hits a blocker after task creation, solve it autonomously: inspect state, fix environment issues, reject blocked PRs with actionable reasons, create follow-up issues when the platform/skill is at fault, or wait for the task/PR. Do not stop and hand the blocker back to the user unless the user is the only possible source of required information or explicitly pauses the workflow.
  - If you are interrupted mid-workflow (user asks a side question, chat drifts to another topic, tool fails, etc.), handle the interruption and then **immediately resume the workflow from where you left off**. Never ask "should I continue monitoring?" or "do you want me to keep going?" — the answer is always yes. The only way to exit the workflow early is if the user explicitly says to stop, cancel, or abort.
- **Follow CONTRIBUTING.md** — read the target repo's CONTRIBUTING.md before creating tasks; check PR compliance during review
- **Investigate before creating** — read the code first, don't create vague tasks
- **One coherent outcome per invocation** — if the user describes multiple unrelated or low-overlap outcomes, create one and suggest splitting the rest
- **Detailed descriptions** — agents are autonomous, the description is their only input
- **Check for duplicates** — look at existing tasks before creating
- **Review = act** — reject or merge based on your review, don't ask the user for permission
- **Think about dependencies** — tasks with overlapping files, data model, API contract, or context must use `--depends-on` or be merged
- **Always `--assign-to` on create** — never create a task without assigning an agent
- **Close PR before cancel** — never cancel a task without closing its PR first
- **Don't sleep-poll blindly** — if monitoring takes too long, investigate daemon logs and agent processes immediately
- **File skill-improvement issues for agent process failures** — if you violate this skill or the user has to correct your workflow, create a GitHub issue in `saltbo/agent-kanban` documenting the failure and proposed skill change. Do this in addition to any immediate local skill edit; do not replace it with an apology or private note.
