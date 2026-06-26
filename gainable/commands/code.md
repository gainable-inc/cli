---
description: Switch to Claude-as-author mode for the current Gainable app — heavier than chat, use when you want creative control
argument-hint: <change request, e.g. "redesign the dashboard with a KPI hero section">
allowed-tools: Bash(gaia code:*), Bash(gaia:*), Read, Write, Edit, Grep, Glob, AskUserQuestion
---

The user is opting Claude into author-mode for the current Gainable app. Switch to the `gaia-code` skill for the full protocol (pull → read preflight → read conventions → edit → validate → push).

Request: $ARGUMENTS

Follow the gaia-code skill's working loop:

1. `gaia code pull` (auto-bootstraps the workspace on first run — conventions, preflight, app/)
2. Read `.gaia/preflight/index.md`, `.gaia/conventions/CLAUDE.md`, `.gaia/conventions/build-agent.md`, plus relevant skill guides
3. Edit under `app/` — full BuildAgent scope (views, routes, db/models, public/css, public/js — NOT just views)
4. Run `gaia code validate <file>` after every meaningful edit
5. `gaia code push --summary "<recap>"` when done

Don't author code if the request looks like a normal refinement ("add KPIs to Y", "fix Z") — prefer `gaia chat` (cheaper, harness handles it). The gaia-code skill has the "STOP — am I the right skill?" check at the top.
