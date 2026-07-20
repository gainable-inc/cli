---
name: gaia
description: Use this skill as the DEFAULT for ANY change to a Gainable app — adding features, editing views, adding KPIs, fixing bugs, refining behavior, changing layouts, modifying routes, anything app-related. Also handles building a new app from idea, attaching a spreadsheet, listing apps, credentials, and creating or syncing DATASETS — including recurring data pipelines ("sync my data every day", "collect from an API on a schedule", "keep this dataset up to date") via `gaia dataset`. The harness's planner + BuildAgent do the work server-side via `gaia chat` / `gaia build` — you just relay the user's request (one cheap HTTP turn, no preflight, no local mirror). ONLY skip this skill in favor of `gaia-code` when the user EXPLICITLY opts you into author-mode with phrases like "code it yourself", "write it manually", "without using Gaia/the harness/the planner", "I want YOU to do the coding". Plain refinements like "add X to view Y", "fix Z", "change the layout" stay with THIS skill.
---

# Gainable harness — CLI control plane (Codex)

This directory represents a Gainable app. The actual generated code (routes, models, views, agents) lives on the Gainable server. You drive everything through the `gaia` CLI — never edit files in this directory claiming they're the app.

> **The `gaia` CLI is delivered via npm, not bundled in this plugin.** If a `gaia` command fails with "command not found", install it once: `npm i -g "@gainable.dev/cli"`, then `gaia login --key gak_... --api-base https://build.gainable.dev`.

## Two distinct "chats" — don't confuse them

| Flow | When | Command |
|---|---|---|
| **Build journey** (contract conversation → deterministic pipeline) | Building a NEW app, from idea through the 5 phases (data → derives → seed → ui → autonomy) and then the actual build run. | `gaia build` |
| **Refinement chat** (edit views/routes on an already-built app) | Modifying an EXISTING built app — "add KPI cards to the Companies view", "fix this bug". | `gaia chat` |

## When to suggest gaia-code instead

`gaia chat` is the default for refinement — cheap, one HTTP turn, planner + BuildAgent handle it. But for some requests the harness pays off less, and authoring locally with `gaia-code` is the better trade. Use your judgement before running `gaia chat`. If TWO OR MORE of the signals below are present, surface the choice to the user (a short two-option question in chat) before dispatching:

- **Cross-cutting scope.** Request touches 3+ distinct surfaces (e.g. view + new route + new model + existing route updates). The planner has to thread many decisions together; you can read the relevant existing files first and write a coherent batch.
- **Subjective design refactor.** "Redesign", "rethink the layout", "make this more elegant", "play with a different approach" — the planner picks one direction without asking; you can present options first.
- **Iteration-heavy.** User explicitly asks for review-first ("show me the code before applying"), or signals they want to iterate ("let's try a few approaches", "I want to see what you'd do").
- **Harness has misfired here before.** User is correcting a previous `gaia chat` output or asking to undo and redo something the planner already attempted.
- **The user explicitly opts in.** "Code it yourself", "do this manually", "without the harness" — switch to `gaia-code` immediately, no question.

For everything else — single-file edits, KPI additions, bug fixes, color/label changes, "add X to view Y", "fix Z" — go straight to `gaia chat` without asking. The harness handles those reliably and cheaply.

When you do surface the choice, frame it as one question, two options:

> "This looks [cross-cutting / iteration-heavy / a creative refactor]. Two ways to do it:
> - **`gaia chat`** — one cheap turn, harness's planner decides the approach
> - **`gaia code`** — I author it locally with conventions + validators; more iterations possible, slower upfront"

Let the user pick. Don't lecture about cost trade-offs unless asked.

## Local files

- `.gaia/project.json` — project metadata (`projectId`, `appName`, ...). Managed by `gaia init`; do not edit by hand.
- `.gaia/last-asks.json`, `.gaia/last-turn.json` — CLI-managed state from the prior `gaia build` turn. Read-only for you; useful for inspecting what just happened.

## How to invoke gaia

Always run `gaia` in the shell. Conventions for every command:
- **stdout** = structured JSON. Parse it.
- **stderr** = human-readable status. Surface to the user when relevant; ignore otherwise.
- **Exit codes:** `0` success · `1` transport error · `2` pending input (an ask awaits a reply) · `3` auth / validation / business error.

## Building a new app — `gaia build`

One command drives the full new-app journey. Arg/flag presence picks the path:

```bash
gaia build "I want a CRM for tracking SaaS deals"   # contract turn (typed message)
gaia build --reply "Classic"                        # widget answer to a pending ask
gaia build --reply "A" --reply "B"                  # multi-ask reply (paired in order)
gaia build --reply "A,B"                            # multi-select pick
gaia build                                          # no args → kick the deterministic pipeline
```

### Contract turns (when called with a message or --reply)

Response JSON shape:
- `prose` — what the agent said. Show to the user.
- `interactiveOptions` — `[{ question, options: [{ id, label }] }]` pending choice asks.
- `interactiveTextInput` — text-input asks (less common).
- `contract` — current merged contract state.
- `validation: { ok, errors, missing }` — surface errors verbatim.
- `phase` — current contract phase (`data` / `derives` / `seed` / `ui` / `autonomy`).

**When asks come back (`interactiveOptions` is non-empty in the response JSON): always forward to the user. Never answer autonomously.** These are subjective design choices (layout, autopilot picks, scope) — the user owns them.

#### Forwarding an ask

Codex has no structured-question UI, so present each ask as a plain numbered list in chat and wait for the user's reply. Show the question text, then the options:

```
Which view should be the home page?

1. Today (recommended)
2. Pipeline
3. Companies
4. Contacts

Reply with the number or the view name.
```

When the user replies, map their input to the matching option label with a judgement call — `"3"` → `"Companies"`, `"companies"` → `"Companies"`, `"the companies one"` → `"Companies"` — then submit via `gaia build --reply "<matched label>"`. For a multi-select ask (e.g. autopilot picks), accept several numbers/names and submit them as `gaia build --reply "A,B"` or paired `--reply` flags. If the user's reply doesn't match any option, ask them to clarify rather than guessing.

When `phase === 'autonomy'` and there are no asks, the contract is ready — the next `gaia build` (no args) kicks the deterministic pipeline.

### Hard rules for the ask/reply loop — read these carefully

1. **Only forward asks that LITERALLY appear in `interactiveOptions` of the gaia response.** Do not invent your own clarifying questions. Do not "help" the user by pre-asking about things you think gaia might want to know. DataAnalyzer (Fable 5) decides what to ask and what to decide autonomously — your job is to relay, not to anticipate. If a turn returns zero asks, the agent decided everything itself; submit no replies, just await the next state. Fabricating asks gets you and the user out of sync with the server and burns turns.
2. **One `gaia build --reply` at a time. Never in parallel.** Each reply changes the server's contract state and may unlock new asks (or skip past them entirely). Fire one reply, await the JSON response, see what `interactiveOptions` come back NEXT, then decide. Never run multiple `gaia build` commands against the same project simultaneously — the server serializes turns and the parallel calls will conflict.
3. **A single contract turn may auto-advance multiple phases.** When you submit a reply, gaia may run through several phases in one server-side sweep (e.g. data → derives → seed → ui all in one turn if the agent has enough info). That's by design. You just see the resulting JSON state — surface it, don't be alarmed that "fewer asks" came back than you predicted.
4. **After every reply, re-read `phase` and `interactiveOptions` from the response before doing anything else.** Your prediction about "what comes next" is almost always wrong because the agent's silent reasoning between phases skips asks you might expect. Always work from the response, not from a plan.

### Deterministic pipeline (when called with no args)

`gaia build` (no args) streams stage events as JSON Lines (stdout) while it runs, then exits: `0` on success, `3` on build failure, `1` on transport error. If the project isn't at `phaseLock='autonomy'` yet, the server returns 409 and the CLI surfaces the reason. The pipeline runs 90-180 seconds across 6-9 stages (models, seed, settings UI, main UI, register, copilot, autonomy, audit — some are conditional).

**Run the pipeline as a plain FOREGROUND command with stdout redirected to a file:**

```
gaia build > .gaia/build-events.jsonl
```

**Never background it** — no `Start-Process`, `nohup`, `&`, or polling wrappers. The command exits by itself when the pipeline finishes, and backgrounding breaks on Windows: `gaia` is an npm `.cmd` shim, so `Start-Process -FilePath 'gaia'` fails with `%1 is not a valid Win32 application`.

Why the redirect: your shell call is atomic — you cannot react to events mid-command anyway. With the JSON stdout out of the way, the user watches the CLI's own stderr checklist stream live in the command cell: `▶ <stage>` on start, throttled `· <step>` heartbeat lines while a stage runs, `✓ <stage> (Ns)` on completion, and finally `✓ build succeeded — open: <url>`. That stderr stream IS the live checklist — never re-enumerate the stages in chat afterwards.

1. **Before** running it, write one short line setting expectations: e.g. "Starting the build pipeline (typically 90-180 seconds) — the stages stream in the command output below."
2. Run the redirected command above and wait for it to exit.
3. **After** it exits, write ONE short line:
   - Exit `0`: paste the launcher URL **literally from the final `✓ build succeeded — open: <url>` stderr line** (same value as the `app_launcher` event's `payload.url` in `.gaia/build-events.jsonl`): e.g. `Build succeeded — open: {url}`.
   - Exit `3`: report the `✗`-line failure plainly; the full event record is in `.gaia/build-events.jsonl` if you need details.

**Never construct the launcher URL yourself.** The CLI-emitted URL is the only safe one — it's the main-app `/apps/<appName>` route on whichever apiBase the user authenticated against. Do NOT hardcode a host, and do NOT substitute the public `<app>.localhost` Traefik URL (it 401s without the auth key the iframe-launcher injects). If neither the stderr URL line nor an `app_launcher` event exists (older CLI, dropped stream), tell the user the build finished — without surfacing a guessed URL.

Do not dump raw JSON to the chat — the streaming stderr checklist + your one summary line are enough.

### Contract-turn exit codes

`gaia build` exits `0` on every successful contract turn, regardless of whether `interactiveOptions` are pending — the pending-asks signal lives ONLY in the JSON: check `response.interactiveOptions.length` to decide whether to forward asks. The build pipeline (no args) still exits `3` on build failure and `1` on transport error — those ARE failures.

### Starting a brand-new app — no `.gaia/` yet, no projectId

When the user wants to build a new app from scratch (provides a spec file or describes an idea) and there's no `.gaia/project.json` in the current directory, run:

```bash
gaia build "<full spec contents, or the user's idea>"
```

**The harness runs server-side and cannot read your local disk — only the message string reaches it.** If the user points at a spec/doc file (or there's one in the folder), read it IN FULL first and pass its ENTIRE contents as the message. Do NOT pass a file path, a filename, or a paraphrased one-line summary when a spec exists: the server falls back to generic domain knowledge and designs the wrong data model. Only use a short idea string when the user described an idea with no spec to inline.

**Exception — spreadsheets.** If the user points at an xlsx/xls/csv file, do NOT inline it as a spec. Spreadsheets go through the import flow (`gaia import upload` → survey → `gaia import attach`) so the rows are actually ingested as the app's data — see "Building an app from a spreadsheet" below.

The CLI auto-creates a new project server-side, writes `.gaia/project.json` locally, and runs the first contract turn — one command, no prior `gaia init` / `gaia apps create` step needed. Use `--name "<project name>"` to label the new project explicitly; otherwise the first ~50 chars of the message become the name.

If you'd rather do it explicitly (e.g. in a script): `gaia apps create "<name>"` returns `{ projectId }`, then `gaia init --project <id>` writes `.gaia/project.json`, then `gaia build "<msg>"`. Most of the time the auto-init path is what you want.

### Starting a new build when the folder already has a built project

The user might run `gaia build "<idea>"` in a folder where `.gaia/project.json` points to a project that is ALREADY built. The CLI handles this automatically: the contract-turn response comes back with `phaseLock: "built"` and `terminal: true`, the CLI prints a one-line notice to stderr, creates a fresh project, overwrites `.gaia/project.json`, and re-runs the contract turn against the new project. No manual intervention needed.

**Do NOT** interpret a `terminal: true` / `phaseLock: "built"` response as "the user's build request is already done." It means the existing project the folder pointed to was DONE — but the user just asked you to build something new, so the CLI is mid-pivot to a fresh project. Wait for the second response (the new project's first contract turn) and proceed from there. The `--name` flag still works.

For refinements on an already-built project (adding fields, fixing a view, changing a label), use `gaia chat` instead — that's the dedicated refinement path and won't trigger the pivot.

## Other commands

| Command | What it does |
|---|---|
| `gaia apps list [-q text]` | List apps in this account. |
| `gaia apps create [name]` | Create a new empty Gainable project server-side (returns `{ projectId, projectName }`). Usually skipped in favor of `gaia build "<idea>"` which auto-creates. |
| `gaia init [--project <id>]` | Scaffold `.gaia/` in an empty directory. |
| `gaia chat "<msg>" [--page <slug>]` | Refine a built app: BuildAgent edits view/route files; streams progress. See below. |
| `gaia publish [--status]` | Publish the current built app to its `<slug>.gainable.app` URL. See "Publishing" below. |
| `gaia import upload <file>` | Upload an xlsx/xls/csv to start the ImportAgent question loop. |
| `gaia import state` / `answer <json>` / `finalize` / `cancel` | Walk the ImportAgent loop (see below). |
| `gaia import attach` | Bridge a finalized import into the build journey: create the dataset (rows ingested), auto-create the project if needed, attach. |
| `gaia dataset create <input>` | Create a STANDALONE dataset from JSON rows or a spreadsheet (`-` reads JSON from stdin). Walks the same Q&A loop as `gaia import`. |
| `gaia dataset answer <json>` | Answer the analyzer's pending question during `dataset create`; auto-completes the dataset when the agent proposes. |
| `gaia dataset schema <id>` | **Print the dataset's write contract** — required keys, primary key, per-field form. Read this BEFORE writing any collector script. |
| `gaia dataset sync <id> [input]` | Replace the dataset's contents with a full snapshot. |
| `gaia dataset list [-q text]` | List datasets with providers, row counts, last sync. |
| `gaia login` / `gaia logout` | Credential management. Usually the user has already done this. |

## Refining a built app — `gaia chat`

```bash
gaia chat "add a probability column to the deals table"
gaia chat --page deals "rename the Stage column to Pipeline Stage"
```

Streams JSON events to stdout (one per line) plus human-readable progress to stderr. Exit codes:
- `0` — `completion_ready` (success). Surface the prose summary to the user.
- `2` — `planner_clarification` (the planner is asking the user a clarifying question). Present the `question` + `options` to the user as a numbered chat list, then run `gaia chat "<the user's answer>"`. The server detects the pending clarification and merges the answer in — no special flag needed.
- `3` — `agent_error` or build failure. Show the error to the user.
- `1` — transport error.

Key events to watch in the JSON stream:
- `planner_analyzing` — agent is thinking
- `planner_plan_ready` — the plan is decided (auto-accepted in the CLI flow)
- `agent_started` — BuildAgent is editing files
- `completion_ready` — final summary + files changed

## Publishing a built app — `gaia publish`

```bash
gaia publish              # publish (or republish) and surface the public URL
gaia publish --status     # peek at current publish state without uploading
```

Mirrors the main app UI's "Publish" button: copies the built app to the publish staging area, modifies it for production (auth, theme, env), tarballs it, and uploads to the publish router. The deployed URL is `https://<slug>.gainable.app`.

Synchronous — the CLI blocks until publish finishes server-side. On success it prints the URL to stderr and emits a tagged `app_published` JSON event on stdout:

```json
{"event":"app_published","payload":{"url":"https://sales-crm-xxxxx.gainable.app","appName":"sales-crm-xxxxx"}}
```

Exit codes: `0` success, `3` publish failure, `1` transport error.

**Surface the literal URL to the user.** Paste `payload.url` from the `app_published` event verbatim into the chat — do NOT paraphrase to "your published app" or any wording that omits the URL string. Format example:

- `Published — live at: {url}`
- `Done. Public URL: {url}`

`gaia publish --status` returns JSON on stdout with `{ published, running, url, lastPublished }`. When the user asks "is this published?" without wanting a deploy, run `--status` first; otherwise default to `gaia publish` which republishes (idempotent).

## Building an app from a spreadsheet (Excel / CSV → app)

When the user points at an xlsx/xls/csv file as the starting point for an app, the journey is: **import survey → attach → build journey**. The spreadsheet is NOT a spec to inline — never paste file contents into `gaia build`. The ImportAgent analyzes the actual workbook server-side.

### Step 1 — upload and walk the survey

```bash
gaia import upload ./data.xlsx
```

Response JSON shape (same protocol for every turn):
- `state: "question"` → agent is paused; `toolUseId` + `question` describe what it's asking. **Always present `question` to the user as a numbered chat list** — the question shape is the agent's tool input (kind/label/options/etc.), not arbitrary prose. Then:
  ```bash
  gaia import answer '<answers-json>'
  ```
  `<answers-json>` is the answers object the agent expects (e.g. `{"choice":"keep"}` or `{"picks":["Sheet1","Sheet2"]}`). The CLI auto-uses the saved `toolUseId`; you only supply the JSON.
- `state: "proposal"` → agent emitted a `seedPlan`. Show `summary` to the user, then continue to Step 2.
- `state: "done"` → agent finished without proposing (rare; surface `message` to the user).

`gaia import state` peeks the current state WITHOUT advancing the agent. `gaia import cancel` drops the session server-side. Exit code `2` after `upload`, `answer`, or `state` means a pending question awaits.

### Step 2 — finalize, create the dataset, attach to a project

```bash
gaia import finalize        # validate the seedPlan; show `summary` to the user
gaia import attach          # dataset created + rows ingested + attached to the project
```

`gaia import attach` does the whole bridge in one command: creates the dataset (rows ingested server-side), auto-creates a project and writes `.gaia/project.json` when the directory has none, and attaches the dataset so the draft contract starts with the mains pre-materialized. Flags: `--name <datasetName>` (default: file stem), `--project <id>`, `--project-name <name>`.

The import session is consumed by `attach` — but the command is re-runnable: the created `collectionId` is saved locally, so a retry after a failure resumes at the attach step.

### Step 3 — kick off the contract conversation

```bash
gaia build --silent "Let's get started. Analyze the attached data and propose an initial contract."
```

This is the exact silent kickoff the web builder sends after an import. From here it's the normal **build journey** (see "Building a new app — `gaia build`" above): forward `interactiveOptions` to the user as numbered chat lists, reply with `gaia build --reply`, and when `phase === 'autonomy'` with no asks, kick the pipeline with `gaia build` (no args).

## Recurring data → Gainable (`gaia dataset`)

When the user wants a script that collects data on a schedule (every 24h, from APIs or anywhere else) and feeds it into Gainable, the shape is **create once, sync forever**. This is a different journey from `gaia import`, which exists to bootstrap an app from a spreadsheet — `gaia dataset` makes a standalone dataset that a script keeps fresh.

Rows go in as **JSON**. There is no need to write a CSV to disk first.

### The three rules

1. **Full snapshot, always.** Every sync REPLACES the entire dataset. Your script must emit every row that should exist, every time — never a delta, never just today's rows. Rows missing from the payload are DELETED. That is intentional: it's how corrections and deletions propagate, and it means a missed run costs nothing.
2. **The shape is frozen at creation.** The dataset remembers the exact keys from the seed data. A sync missing any of them is rejected wholesale (`drift`) and **nothing is written**. Extra keys are fine; renamed or removed keys are not. To change the shape, create a NEW dataset.
3. **Read the contract before writing the script.** `gaia dataset schema <id>` returns exactly what to emit. Never infer the shape from memory of the seed data.

### Step 1 — create (once)

Seed with **5-20 representative real rows**. The analyzer infers column types and picks the primary key from actual values, and that choice is frozen for the dataset's life — a one-row seed produces a bad schema you cannot fix later.

```bash
node ./collect.js | gaia dataset create - --name "Ops Metrics"
```

Exit `2` means the analyzer is asking a question — same protocol as `gaia import`. Present it as a numbered chat list and wait for the reply, then:

```bash
gaia dataset answer '{"choice":"..."}'
```

Loop until exit `0`. The final stdout carries `collectionId` **and the full write contract** — you do not need a second call.

A spreadsheet works too (`gaia dataset create ./seed.xlsx`), and transports are interchangeable afterwards: a dataset seeded from a workbook can still be synced from JSON. The CLI resolves the sheet name from the saved contract, so your collector never has to know it.

### Step 2 — write the collector

Read `shape.requiredKeys` and `entities[].fields[]`. Each field carries a `writeAs` telling you the exact form (`"JSON number, not a formatted string"`, `"ISO 8601 date string"`). Two patterns, depending on the source:

```bash
# Source returns full current state (list all deals, list all repos):
# pipe it straight through — no local state at all.
node ./collect.js | gaia dataset sync col_abc -

# Append-only source (daily metrics, event logs): the script owns accumulation.
node ./collect.js                      # merge new rows into store.json, ATOMICALLY
gaia dataset sync col_abc ./data/store.json
```

Prefer the stateless shape when the API supports it — it's self-healing. If you must keep a local store, write it atomically (temp file + rename) so a crash never leaves a truncated snapshot.

### Step 3 — sync (every run)

```bash
gaia dataset sync col_ab12cd34ef56 -
```

Exit `0` prints per-entity `{inserted, updated, deleted}`. Exit `3` with `reason: "drift"` means the payload no longer matches the contract — stderr names the exact keys, and **nothing was written**. Fix the shape; do not retry blindly.

The CLI refuses a sync whose primary keys barely overlap what is already stored (`--min-overlap`, default 0.5), because that is the signature of a truncated payload or a regenerated key. If the turnover is genuinely intentional, pass `--force`.

`gaia dataset sync <id>` with **no input** is for Google Sheets / Excel-Online / Airtable datasets, which re-fetch from upstream. `gaia dataset schema` tells you which kind you have.

## Hard rules

1. **Never edit local code** as if it's the app. The app is on the Gainable server. Local files are metadata + transcripts only.
2. **Never answer `interactiveOptions` autonomously.** Always present each ask to the user as a numbered chat list and wait for their reply.
3. **Never construct widget-answer messages by hand.** Always use `gaia build --reply` / `gaia import answer`. The server expects a specific format and the CLI builds it from saved state.
4. **Never run gaia commands in parallel against the same project.** Turns serialize on the server; concurrent calls conflict.
5. **If `.gaia/project.json` is missing**, prompt the user to run `gaia init` (or use `gaia build "<idea>"` which auto-inits). Don't guess a `projectId`.
6. **Inline the full spec — never a path or a summary.** When the user points at a spec/doc file, read it and pass its COMPLETE contents to `gaia build`. The harness can't see local files.
7. **The live build checklist is the CLI's stderr stream in the command cell** (run `gaia build > .gaia/build-events.jsonl`). After exit, summarize with ONE line + the literal launcher URL from the final stderr line. Never re-enumerate stages, never paraphrase or guess the URL.
8. **Run gaia commands in the foreground, never backgrounded.** No `Start-Process`, `nohup`, `&`, or redirect-and-poll — every gaia command exits on its own, and on Windows `gaia` is an npm `.cmd` shim that `Start-Process` can't launch.
9. **If `gaia` isn't installed**, tell the user to run `npm i -g "@gainable.dev/cli"` — this plugin doesn't bundle the binary.
10. **Choose a dataset primary key that can never change, and never regenerate it.** The app derives each row's comment/file thread id from its primary key value. Use a natural key that comes from the data source itself — an upstream record id, a canonical slug. Never an array index, a row number, a `collected_at` timestamp, or a hash of fields that can be edited. A rotating key silently destroys every attached comment and file on the next sync, and the row counts look perfectly normal while it happens.
11. **Never sync a partial payload.** `gaia dataset sync` deletes rows absent from it. If your collector failed partway, abort the sync — do not send what you managed to collect.
12. **Never write a collector script from memory of a dataset's shape.** Run `gaia dataset schema <id>` and follow its contract literally — keys are matched exactly and a mismatch rejects the whole sync.
