---
description: Drive the new-app build journey (contract turns + deterministic pipeline) — for building a NEW app, not refining
argument-hint: <build instruction, e.g. "I want a CRM for tracking SaaS deals" — or omit to kick the pipeline when contract is locked>
allowed-tools: Bash(gaia build:*), Bash(gaia:*), Read, Grep, Glob, TaskCreate, TaskUpdate, BashOutput, AskUserQuestion
---

The user is building a new Gainable app. **First load the full protocol — invoke the `gaia` skill** (it documents the asks/reply loop, exit codes, spec handling, and the build-progress TaskList). The rules below are the non-negotiables; follow them even if the skill text isn't loaded.

Request: $ARGUMENTS

Contract flow (data → derives → seed → ui → autonomy):
- `$ARGUMENTS` is a message → contract turn: `gaia build "<message>"`.
- `$ARGUMENTS` is empty → kick the deterministic pipeline (requires `phaseLock=autonomy`): `gaia build`.
- Widget answer to a pending ask → `gaia build --reply "<label>"` (paired in order if multiple asks).
- Forward any `interactiveOptions` to the user via `AskUserQuestion`. Never pick options autonomously — those are subjective design choices.

**MANDATORY — spec files.** The harness runs server-side and CANNOT read your local disk; only the string you pass reaches it. If the user points at a spec/doc file (or there's one in the folder), `Read` it IN FULL and pass its ENTIRE contents as the build message: `gaia build "<full spec text>"`. Never pass a file path, a filename, or a one-line paraphrase when a spec exists — that makes the harness design from generic domain knowledge instead of the spec.

**MANDATORY — spreadsheets.** If `$ARGUMENTS` points at an xlsx/xls/csv file, do NOT inline it as a spec. Run the import flow instead so the rows are ingested as the app's data: `gaia import upload <file>` → forward each survey question via `AskUserQuestion` + `gaia import answer '<json>'` → on proposal, `gaia import finalize` then `gaia import attach` → kick off the contract with `gaia build --silent "Let's get started. Analyze the attached data and propose an initial contract."` — then continue the normal contract flow below. (Full protocol in the `gaia` skill.)

**MANDATORY — pipeline progress.** When you kick the pipeline (`gaia build`, no args), run it with `run_in_background: true` and render a LIVE checklist: on each `workflow_stage_started` call `TaskCreate` + `TaskUpdate` (in_progress); on `workflow_stage_complete` mark it completed; poll background output until `build_complete`, then paste the literal launcher URL from the `app_launcher` event. Never run the pipeline in the foreground and never text-relay stage results in place of the checklist. (Full event shapes are in the `gaia` skill.)
