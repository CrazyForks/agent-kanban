---
name: ak-plan
description: |
  Plan and execute a project — either a new version of an existing project, or a
  brand new product from scratch. Analyzes gaps, creates board with tasks and
  dependencies, assigns to agents. Use when asked to plan a version, build a
  product, create a project, or 规划版本.
argument-hint: "<version-or-name> [goals]"
---

# ak-plan — Project Planning

Plan and create a board with tasks — for a new version release or a new product from scratch.

## Unattended Execution Contract

Assume this workflow runs in two explicit modes:

- **Before task creation: human-in-the-loop.** Ask the user only during the initial planning, ambiguity resolution, and task-plan preview phase before task creation is confirmed.
- **After task creation: human-not-in-the-loop.** Once the user confirms the plan and tasks are created, do not stop to ask for permission, confirmation, or next steps unless the user interrupts you. Continue through the full work cycle: create, assign, monitor, review, reject or merge, and report the final outcome.

If execution hits a blocker after confirmation, use the available tools and repository context to resolve it. If the blocker cannot be resolved without external authorization or production mutation, fail fast with the exact blocker and the next required action instead of waiting in the middle of the workflow.

## Identity

This is a leader workflow.

If `ak` says no leader identity exists for the current runtime, create one first:

```bash
ak identity create --username <username> [--name <name>]
```

The leader chooses its own username and optional full name.

## Input

Parse the user's input:
- **Name** — version (e.g. "v1.4") or product name (e.g. "my-api"). If the user provides a patch version such as `v1.4.0`, normalize task labels to `v1.4`.
- **Goals** — what to achieve (if not provided, ask)

## Workflow Checklist

Immediately after this skill is invoked, create and maintain an explicit task
plan/checklist in the agent UI. This checklist is a guardrail against attention
drift during long human-in-the-loop planning discussions.

The checklist must include the full lifecycle, not just planning:

1. Detect project mode and repo/board context.
2. Understand current state and constraints.
3. Analyze gaps and draft task plan.
4. Preview task plan and get human confirmation.
5. Create or verify labels, workers, and tasks.
6. Switch to human-not-in-the-loop execution.
7. Monitor tasks until PRs reach review.
8. Review each PR: CI, code, functional acceptance, notes.
9. Reject or merge each PR according to gates.
10. Continue until all planned tasks are done.
11. Report final summary.

Keep this checklist current:

- Mark exactly one active step as in progress.
- Update statuses at every phase transition.
- After task creation, explicitly mark the planning/creation steps complete and
  mark monitoring/review as in progress before doing any final user-facing
  summary.
- Do not send a final answer while any post-creation execution step remains
  pending, unless the user explicitly says to stop, cancel, abort, or only
  create tasks.
- If context becomes long or the user interrupts, re-read the checklist before
  deciding the next action.

## Phase 0: Detect Mode

Check if this is an **existing project** or a **new product**:

```bash
git remote -v 2>/dev/null    # has a remote? → existing project
ak get repo                  # registered repos
```

Three possible states:

- **Existing project with remote** → skip to Phase 1
- **New product (no git init yet)** → go to Phase 0.5 (Scaffold)
- **Local-only project (git init done, no remote)** → STOP. A registered repo must have a real remote (`https://…` or `git@…`). Tell the user one of:
  1. Push the project to GitHub first: `gh repo create <owner>/<name> --source . --push`
  2. Or: ask them for the intended remote URL before proceeding.

  **Never invent a URL** (no `file://`, no local paths, no placeholders). The agent-kanban server will reject non-http(s)/ssh URLs with 400, and even if it didn't, the daemon cannot clone local paths.

## Phase 0.5: Scaffold (new products only)

```bash
# Create and clone repo (NEVER inside an existing git repo)
gh repo create <owner>/<name> --public --description "<one-liner>" --clone
cd <repo-dir>

# Initialize project — use framework CLIs, install ALL dependencies upfront
# Ask user for tech stack if not specified

# Create config files, entry point, DB schema, .gitignore
# Commit and push
git add -A && git commit -m "feat: project scaffold" && git push -u origin main
```

Register with agent-kanban (URL MUST come from `git remote get-url origin` — never hand-crafted):
```bash
ak create repo --name <name> --url "$(git remote get-url origin)"
```

The scaffold must contain enough structure for agents to start writing code immediately.

## Phase 1: Understand Current State

```bash
ak get board                   # existing boards
ak get agent -o json           # available agents, load, runtime_available
ak get repo                    # registered repos
git remote -v                  # repo URL (use this, never guess)
```

Read project instruction files, CONTRIBUTING.md, and recent git history to understand:
- What was shipped recently
- What patterns/conventions exist
- What the project architecture looks like
- Contribution requirements (branch strategy, commit format, code style, test expectations)

## Phase 2: Analyze Gaps

Use Explore agents to thoroughly scan the codebase for gaps related to the goals. Consider:
- Missing features vs stated goals
- Backend gaps (API, data model)
- CLI gaps (missing commands)
- Frontend gaps (if applicable, respect the project's UI principles)
- Test coverage gaps

Use `AskUserQuestion` to interactively confirm the plan with the user. For each ambiguous point, present options:

- **Scope** — which gaps to address in this version vs defer to later
- **Ordering** — which tasks are critical path vs nice-to-have
- **Approach** — when multiple implementation strategies exist, present them with trade-off descriptions
- **Task granularity** — whether to split a large piece into subtasks or keep it as one
- **Runtime choice** — when multiple schedulable runtimes are reasonable, ask which runtime to use for new workers

Keep iterating until all uncertainties are resolved.

### Structured Questions in Codex

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

Before creating any tasks, show the user a **task summary table** using `AskUserQuestion`:

```
📋 Task Plan Preview

| # | Title | Repo | Labels | Depends on | Agent |
|---|-------|------|--------|------------|-------|
| 1 | <title> | <repo> | backend | — | <agent> |
| 2 | <title> | <repo> | frontend | #1 | <agent> |
| ...

Per-task description summary:

### Task 1: <title>
Goal: <one sentence>
Files: <file list>
Spec: <key points — not the full description, but enough to judge scope>

### Task 2: <title>
...

---
Create all tasks? (y/n)
```

The user must confirm before any `ak create task` calls are made. If the user requests changes, adjust and re-preview.

### Label Best Practices

Labels are board-level taxonomy, not free-form notes. Before task creation, define the small label set this plan will use and show it in the preview. Prefer reusing existing board labels and adding only labels that will remain useful for future filtering.

Recommended label categories:

- **Version** — usually one version label per versioned task, formatted `vX.Y` (for example `v1.4`, `v2.0`). Prefer avoiding patch versions (`v1.4.0`) or suffixes (`v1.4-final`, `v1.4-test`) unless the board already has a specific reason to track that granularity.
- **Area** — one or two stable implementation areas: `backend`, `frontend`, `cli`, `api`, `database`, `infra`, `docs`, `ui`, `security`, `test`.
- **Type** — optional, only when it materially helps filtering: `feature`, `bug`, `refactor`.

Prefer keeping temporary process state, tools, providers, experiments, and implementation trivia in the task description instead of labels. Labels such as `done`, `setup:lefthook`, `prompt-fix-test`, `smoke-test`, `cost-test`, `codex`, `github`, `cloudflare`, `tanstack-query`, or file/library names usually become noisy unless the board already uses that exact label intentionally.

When labels overlap, choose the stable category:

- Use `infra`, not `infrastructure`.
- Use `bug`, not `bugfix`.
- Use `database`, not `db`.
- Use `frontend` for UI implementation unless the task is specifically design polish, then add `ui`.

Task labels must already exist on the board. Check existing labels first; if a needed label does not exist, create it with color and description, then use it on tasks:

```bash
ak get label --board $BOARD
ak create label --board $BOARD --name v1.4 --color "#22C55E" --description "Version 1.4"
ak create label --board $BOARD --name backend --color "#38BDF8" --description "Backend/API work"
ak create label --board $BOARD --name bug --color "#F87171" --description "Bug fix"
```

Useful color defaults:

- Version: `#22C55E`
- Frontend/UI: `#A78BFA`
- Backend/API/database: `#38BDF8`
- CLI/runtime: `#22D3EE`
- Bug/security: `#F87171`
- Infra/deploy: `#F59E0B`
- Docs/refactor/general: `#71717A`

## Phase 3: Create Board, Workers & Tasks

Use the existing board for the project. One project = one board.

```bash
ak get board                   # find the project board
# Only create a new board if this is a new product with no board yet
```

Before creating tasks, choose or create the workers that will own them. Read `references/runtime-delegation.md`.

Check existing agents. For a typical project you need:
- A primary implementation worker for each coherent feature/module.
- Focused specialist subagents only when the primary worker will repeatedly use that stable specialist context, such as test, review, or acceptance.

Only assign work to agents whose `runtime_available` is `true`. If the best role exists only on an unavailable runtime, create a new worker with the same role, soul, skills, and handoff settings on an available runtime.

Create missing agents before task creation:
```yaml
kind: Agent
metadata:
  name: <human-username>
  annotations:
    agent-kanban.dev/nickname: "<Human Name>"
spec:
  runtime: <available-runtime>
  model: <runtime-model>
  role: "<kebab-case-role>"
  bio: "<durable responsibility>"
  soul: |
    <durable behavior policy and decision rules>
    <if subagents are set, when to call them and how to review or integrate their output>
  skills:
    - <source>@<domain-skill>
  subagents:
    - <specialist-worker-agent-id>
```

The leader must generate and apply worker Agent YAML according to `references/runtime-delegation.md`. Then run `ak get agent -o json` and confirm the latest worker is visible and `runtime_available: true` before assigning tasks.

Create tasks with full specs. For each task:

1. **`--title`** — concise action phrase
2. **`--description`** — exhaustive spec including:
   - Files to create/modify
   - API endpoints, DB queries, UI components (concrete, not vague)
   - Patterns to follow from the existing codebase
3. **`--repo <id>`** — from `ak repo list`
4. **`--labels`** — include the planned `vX.Y` version label plus one or two stable area/type labels
5. **`--assign-to <agent-id>`** — worker chosen before task creation
6. **`--depends-on`** — task IDs this depends on

Create tasks in dependency order so earlier task IDs can be referenced:
```bash
T1=$(ak create task --board $BOARD --title "..." --repo $REPO --assign-to $AGENT -o json | jq -r .id)
T2=$(ak create task --board $BOARD --title "..." --repo $REPO --assign-to $AGENT --depends-on $T1 -o json | jq -r .id)
```

### Task Creation Best Practices

- Create one task for one reviewable outcome.
- Split by feature/module boundary and context overlap, not by human job title.
- Keep highly overlapping work in one task, even if it touches frontend, backend, CLI, infra, schema, and tests.
- Split only when work is independently understandable, independently reviewable, and has low file/data/API context overlap.
- Make each task independently claimable: no hidden chat context, no "continue from above" descriptions.
- Put the exact files, APIs, commands, UI states, and acceptance checks in `--description`.
- Assign every task at creation with `--assign-to`.
- Use `--depends-on` for real blockers or overlapping context. Tasks touching the same files, data model, or API contract should be sequential or merged.
- Keep parallel tasks independent by feature/module boundary and data model boundary.
- Use stable labels: version plus area, such as `v1.4,backend` or `v1.4,cli`.
- Keep the board label set small and reusable. If a label would be used by only one task and is not a version label, put that detail in the task description instead.

### Task Description Quality

Agents are autonomous — the description is their only input. A good description:

```
## Goal
One sentence: what this task produces.

## Files
- src/foo.ts — API route handlers
- src/bar.ts — data access layer

## Spec
POST /api/items — create item
  Request: { "name": string }
  Response: 201 { "id": 1, "name": "..." }
  Empty name → 400 validation error

## Checks
- [ ] POST /api/items returns 201 with { id, name }
- [ ] Empty name returns 400 with validation error
- [ ] New item appears on the list page without refresh
- [ ] Empty state shows "No items yet" placeholder
```

Vague descriptions produce vague code. Be specific.

## Phase 4: Monitor & Merge

**Block on `ak wait board` instead of writing polling loops.** It streams tasks one at a time as they reach the filter status. Exit codes: 0 condition met, 2 task cancelled, 124 timeout.

### React to PRs as workers push them
```bash
# Stream in_review tasks one at a time, handle each, then wait for the next
while ak wait board <board-id> --filter in_review --timeout 1h; do
  # Latest in_review task is printed — review its PR, merge or reject
  :
done

# Or wait until the entire board converges (0 = infinite)
ak wait board <board-id> --until all-done --timeout 0
```

Run `ak wait board --help` for the full flag list.

### When a task reaches `in_review` with a PR:

**Pre-check: CI status.** Before reviewing, verify CI has passed on the PR:
```bash
gh pr checks <pr-number> --repo <owner>/<repo>
```
If CI is pending or failed, reject immediately — worker must wait for CI to pass before submitting:
```bash
ak task reject <task-id> --reason "CI not green — wait for CI to pass before submitting for review"
```

Three gates — code review, functional acceptance, and agent notes review — must
pass before merging. Follow the shared verification policy in
`references/leader-verification.md`, including waiver evidence and
verification infrastructure learning.

**Gate 1: Code Review**

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

**Gate 2: Functional Acceptance**

Apply `references/leader-verification.md`. Passing tests, CI, and code review
is not completion. Validate every task check from the product/user perspective.
If verification cannot be completed, follow the shared attempt budget, waiver,
and verification infrastructure learning rules.

**Gate 3: Agent Notes Review**

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

**Any gate fails or is blocked → Reject.** List all issues in the reason.
```bash
ak task reject <task-id> --reason "<all issues, specific and actionable>"
```

**All gates pass, or Gate 2 is explicitly waived after the required attempt
budget → Post verification comment, then merge.**

Post evidence on the PR before merging using the verification comment template in
`references/leader-verification.md`. Before running `gh pr merge`, re-read
the comment and confirm it satisfies the shared policy.

If the PR has merge conflicts, reject instead of merging — the worker agent will rebase, fix, and resubmit:
```bash
ak task reject <task-id> --reason "merge conflicts with main — rebase and resubmit"
```

Then merge:
```bash
gh pr merge <pr-number> --repo <owner>/<repo> --squash --delete-branch
```
The daemon's PR Monitor will automatically complete the task — do NOT manually `ak task complete`.

#### Cleanup after merge
Remove local review artifacts from the repo root after verifying each path belongs to this workflow:

- temporary review worktrees under `/tmp/ak-review-*`
- `playwright-report/`
- `test-results/`

### Completion:
When all tasks are done, report the final summary to the user.

## AK Command, Product, or Skill Issues

If the blocker appears to be an `ak` bug, missing capability, confusing UX, documentation gap, or skill workflow problem, file an issue in the official repo after collecting a minimal reproduction.

If the leader agent makes a process error, violates this skill, merges/rejects incorrectly, skips a required gate, misinterprets conflicting skill instructions, or has to be corrected by the user about expected skill behavior, do not stop at a chat apology or "next time" promise. Summarize the failure as a durable skill-improvement issue so future agents and external projects can benefit from the lesson. Include:

- What the agent did wrong.
- Which skill text was unclear, incomplete, contradictory, or too weak to prevent the error.
- The exact rule or wording that should be added or changed.
- Any local skill edits already made during the incident.

```bash
gh issue create \
  --repo saltbo/agent-kanban \
  --title "ak-plan: <short process or skill problem summary>" \
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

- **Workflow completion is mandatory** — once this skill is invoked, the full lifecycle (plan → create → assign → monitor → review → merge all) MUST run to completion.
  - **Before task creation: human-in-the-loop.** Discuss scope, resolve ambiguity, preview the task plan, and get explicit user confirmation before creating tasks.
  - **After task creation: human-not-in-the-loop.** The user is no longer part of execution control unless they explicitly interrupt with a new instruction. The leader owns execution and must continue monitoring, reviewing, rejecting, merging, and iterating until the whole work cycle completes.
  - After `ak create task`, continue immediately into monitoring/review work (`ak wait board ...`) in the same turn whenever possible. Do not send a final answer merely reporting that tasks were created unless the user explicitly says to stop, cancel, abort, or only create tasks.
  - If execution hits a blocker after task creation, solve it autonomously: inspect state, fix environment issues, reject blocked PRs with actionable reasons, create follow-up issues when the platform/skill is at fault, or wait for the next task/PR. Do not stop and hand the blocker back to the user unless the user is the only possible source of required information or explicitly pauses the workflow.
  - If you are interrupted mid-workflow (user asks a side question, chat drifts to another topic, tool fails, etc.), handle the interruption and then **immediately resume the workflow from where you left off**. Never ask "should I continue monitoring?" or "do you want me to keep going?" — the answer is always yes. The only way to exit the workflow early is if the user explicitly says to stop, cancel, or abort.
- **Follow CONTRIBUTING.md** — read the target repo's CONTRIBUTING.md before creating tasks; check PR compliance during review
- **Prefer text output** — only use `-o json | jq` when extracting fields into variables (e.g. task IDs for `--depends-on`). For display, use default text output.
- **Always get repo URL from `git remote get-url origin`** — never guess, never improvise. If there is no remote, stop and ask the user to push the repo first (see Phase 0). `file://`, local paths, and placeholder URLs will be rejected by the server with 400.
- **Discuss the plan with the user before creating tasks** — don't just start creating
- **Set depends-on at creation time** — don't leave deps for later
- **Space API calls** — avoid triggering rate limits during batch creation
- **Respect project instructions** — follow all project conventions and UI principles
- **Pre-install shared dependencies in scaffold** — avoid parallel install conflicts
- **Tasks with high context overlap must be sequential or merged** (depends-on)
- **Tasks can be parallel only when their feature/module context, files, data model, and API contracts are independent**
- **File skill-improvement issues for agent process failures** — if you violate this skill or the user has to correct your workflow, create a GitHub issue in `saltbo/agent-kanban` documenting the failure and proposed skill change. Do this in addition to any immediate local skill edit; do not replace it with an apology or private note.
