---
description: Refine the current Gainable app via the harness (planner + BuildAgent) — cheap default, one HTTP turn
argument-hint: <refinement request, e.g. "add KPIs to the sponsors view">
allowed-tools: Bash(gaia chat:*), Bash(gaia:*), AskUserQuestion
---

The user is asking to refine the Gainable app for the project they're working in via the harness (cheap path — planner + BuildAgent do the work server-side).

Refinement request: $ARGUMENTS

Use the `gaia` skill to drive this — it documents the asks-protocol, exit codes, and conventions. Run:

`gaia chat "$ARGUMENTS"`

If the response contains pending `interactiveOptions` / `planner_clarification` (exit code 2), forward each question + options to the user via `AskUserQuestion`. When the user answers, run `gaia chat "<their answer>"` — the server detects the pending clarification and merges the answer in.

If `completion_ready`, surface the prose summary. If `agent_error` (exit 3), show the error verbatim. No commentary about which path you're using — just run it and report.
