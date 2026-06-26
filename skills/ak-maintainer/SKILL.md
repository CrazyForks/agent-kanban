---
name: ak-maintainer
description: Maintain Agent Kanban boards from scheduled runs and GitHub webhook events. Use when acting as an AK board maintainer that reviews board state, follows up on GitHub issues or pull requests, creates AK tasks, records durable memory, and replies through the AK GitHub App bot identity.
---

# AK Maintainer

## Overview

You are maintaining an Agent Kanban board. Use AK as the source of truth for board workflow, task state, reviews, and follow-up work.

## Required Context

- Read the trigger prompt for the board id, repository scope, maintainer-specific instructions, and run type.
- Discover current repository scope with `ak get repo --board <board-id> -o json`.
- Search mounted memory before acting. Treat `HEARTBEAT.md` as the scheduled maintenance checklist, not as the only memory.

## GitHub Identity

- GitHub actions must use the AK GitHub App bot identity, not a human user's login.
- Before every `gh` command that reads from, writes to, or replies in a GitHub repository, run `ak auth git <repo-id>` for that repository.
- Do not use pre-existing `gh` login state or human GitHub credentials. If `ak auth git` fails, stop and report the failure.

## Scheduled Runs

Scheduled runs are proactive maintenance. Inspect the board and associated repositories for:

- New or stale issues needing maintainer action.
- Open pull requests needing review, merge readiness checks, or follow-up.
- Recent task outcomes that need linked issue updates.
- Functional problems, implementation problems, technical debt, unresolved proposals, and follow-up work worth turning into AK tasks.

## GitHub Event Runs

Event runs are reactive. Use the provided event context as a signal, then inspect AK and GitHub directly before acting.

- For issue and pull request comments or reviews, continue in the same GitHub thread when a maintainer response is useful.
- Do not answer only from webhook context. Fetch the current issue, PR, review, or comment state first.
- To read the current issue title or body, use the subject number from the trigger. Do not use GitHub database ids with `gh issue view`:
  `gh issue view <issue-number> -R <owner/repo> --json title,body --jq '{title,body}'`
- To read the current pull request title or description, use the subject number from the trigger. Do not use GitHub database ids with `gh pr view`:
  `gh pr view <pr-number> -R <owner/repo> --json title,body --jq '{title,body}'`
- To read an issue conversation comment body, match the event's comment URL:
  `gh issue view <issue-number> -R <owner/repo> --json comments --jq '.comments[] | select(.url=="<comment-url>") | .body'`
- To read a PR conversation comment body, match the event's comment URL:
  `gh pr view <pr-number> -R <owner/repo> --json comments --jq '.comments[] | select(.url=="<comment-url>") | .body'`
- To read a pull request review summary body, match the event's review node id:
  `gh pr view <pr-number> -R <owner/repo> --json reviews --jq '.reviews[] | select(.id=="<review-node-id>") | .body'`
- Native `gh pr` commands do not expose a direct single inline review comment lookup; only for inline review comments, use the numeric comment id from the trigger:
  `gh api repos/<owner>/<repo>/pulls/comments/<comment-id> --jq '.body'`
- Ignore events from the AK GitHub App bot when they appear in context.

## Memory

- Create or update focused memory files for durable board-level observations, decisions, open questions, and follow-up checkpoints.
- Keep memory concise and scoped to facts that should affect future maintainer runs.
- Never place credentials, private keys, environment files, or authentication material in notes, tasks, messages, or memory.
