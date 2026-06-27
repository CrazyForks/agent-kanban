# Project Quality Loop

This reference defines how an AK maintainer judges whether a repository is ready for high-quality autonomous iteration.

The goal is not to replace code with prose specs. The goal is to give agents an objective standard for decisions and a feedback loop that proves whether implementation matches that standard.

## Contents

- [Principle](#principle)
- [First Audit For A Repository](#first-audit-for-a-repository)
- [Feature Spec Expectations](#feature-spec-expectations)
- [Other Project Knowledge](#other-project-knowledge)
- [Feedback Loop Expectations](#feedback-loop-expectations)
- [Readiness Levels](#readiness-levels)
- [Maintainer Actions](#maintainer-actions)
- [When Work Can Proceed](#when-work-can-proceed)
- [Memory Update](#memory-update)

## Principle

Agents have limited context and can drift. A repository maintained by agents needs two anchors:

- **Feature specs**: Gherkin `.feature` files that define user-visible behavior and acceptance scenarios.
- **Feedback loop**: automated checks and repeatable verification that tell an agent whether the work actually meets the target.

Keep `spec/` narrow. It should contain feature behavior specs, not all project knowledge. Technical decisions, architecture, stack choices, setup instructions, and agent-specific operating rules belong in the repository's normal documentation surfaces.

Without this loop, autonomous iteration is low-confidence. The maintainer should establish the loop before assigning broad feature, refactor, or technical-debt work.

## First Audit For A Repository

On the first scheduled heartbeat that touches a repository, audit whether the repository has an autonomous delivery loop.

Check for:

- `spec/` directory containing Gherkin `.feature` files, or the repository's established feature-spec path.
- Feature files that describe important user-visible behavior and acceptance scenarios.
- `AGENTS.md` or equivalent agent-facing repo instructions.
- Architecture and technical decision records in `docs/`, `docs/adr/`, or the repository's existing decision-doc location.
- Stack and dependency decisions outside `spec/`.
- Local setup and run instructions.
- Local test command.
- Typecheck/lint/build command where applicable.
- CI workflow that runs the meaningful checks.
- Integration, E2E, contract, or behavior tests for user-visible features.
- Test data or fixtures needed for repeatable verification.
- Clear task acceptance criteria conventions.

Record the result in repository memory under `repos/<owner>__<repo>.md`.

## Feature Spec Expectations

Feature specs should describe product behavior and acceptance scenarios in Gherkin. They should not be a general documentation bucket.

Good `.feature` content:

- `Feature:` sections for durable product capabilities.
- `Scenario:` or `Scenario Outline:` examples for user-visible behavior.
- `Given` / `When` / `Then` acceptance rules.
- `Background:` only for genuinely shared setup.
- Tags for useful grouping such as `@auth`, `@billing`, `@critical`, or `@regression`.
- Data tables or doc strings when they clarify inputs and expected outputs.

Bad `.feature` content:

- Pseudocode that mirrors implementation line-by-line.
- Architecture decisions.
- Stack choices.
- Agent workflow instructions.
- Setup or deployment instructions.
- Temporary task notes.
- Raw issue discussions copied wholesale.
- Large generated dumps.
- Aspirational text with no testable behavior.

See `example-feature-spec.feature` for a generic, testable feature spec example.

## Other Project Knowledge

Use existing repository conventions when they exist. If the repository has no convention, prefer:

- `AGENTS.md` for agent-facing operating instructions, required commands, coding rules, quality gates, and repo-specific workflow.
- `docs/adr/` for architecture decisions and tradeoffs.
- `docs/architecture.md` for current architecture overview.
- `docs/development.md` for local setup, run commands, verification commands, and troubleshooting.
- `README.md` for human-facing quickstart and project overview.

The maintainer may create tasks to establish these files when their absence prevents reliable autonomous work, but must not place this content in `spec/`.

The spec-first worker rule belongs in the target repository's `AGENTS.md` or equivalent agent instruction file. The maintainer should review whether workers followed it; the maintainer skill should not duplicate every repository's worker workflow.

See `example-agents.md` for a repository `AGENTS.md` starting point when a repository has no agent-facing quality rules.

## Feedback Loop Expectations

The feedback loop should let an implementation agent answer:

- What behavior am I trying to preserve or create?
- How do I run the project locally?
- Which tests/checks prove this change?
- What failure means I should keep working?
- What passing signal means the task is ready for review?

Look for:

- Unit tests for core logic.
- Integration tests for API/data boundaries.
- E2E or workflow tests for user-visible flows.
- Contract tests for public API or protocol behavior.
- Regression tests for known bugs.
- Typecheck/lint/build where useful.
- CI that runs the same meaningful checks.
- Minimal fixtures, seed data, or test harnesses.

Do not require every project to have every test type. Require the smallest meaningful loop that can catch the risks of that repository.

## Readiness Levels

Use these levels in repository memory:

- `missing`: no usable feature specs and no meaningful automated verification.
- `partial`: some feature specs, docs, or checks exist, but agents cannot reliably know whether changes meet the target.
- `usable`: feature specs and verification are good enough for normal assigned implementation tasks.
- `strong`: feature specs, supporting docs, tests, CI, and acceptance conventions support confident autonomous iteration.

## Maintainer Actions

If readiness is `missing` or `partial`, prioritize assigned tasks that build the loop:

- Add or reorganize `spec/` with Gherkin `.feature` files for core workflows.
- Move non-feature knowledge out of `spec/` into `AGENTS.md`, `docs/`, or ADR files.
- Document local setup and verification commands.
- Add regression tests around known bugs or high-risk behavior.
- Add integration/E2E/contract tests for critical paths.
- Add CI for the meaningful checks.
- Add fixtures or test harnesses that make verification repeatable.

Do not create vague "improve tests" tasks. Create concrete, assigned tasks with a target surface, acceptance criteria, and the checks that should exist afterward.

## When Work Can Proceed

Feature, refactor, and broad maintenance work can proceed when:

- The relevant behavior has a `.feature` spec or accepted issue proposal.
- The task has concrete acceptance criteria.
- There is a verification path that can fail before the fix and pass after it, or the task includes creating that verification path first.
- The assigned worker can run the checks locally or in CI.

If these conditions are not true, create a feedback-loop task first.

## Memory Update

For each repository, keep a short quality-loop section in `repos/<owner>__<repo>.md`:

```markdown
## Quality Loop
- Readiness: missing | partial | usable | strong
- Feature spec path: <path or none>
- Agent/docs paths: <AGENTS.md/docs paths or none>
- Main verification command: <command or none>
- CI: <workflow/status or none>
- Critical gaps: <bullets>
- Last audited: <iso-time>
```

Do not store full feature specs or docs in memory. Store paths, readiness, gaps, decisions, and links to tasks or issue proposals.
