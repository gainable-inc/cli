---
name: gaia-code
description: Use this skill ONLY when the user EXPLICITLY opts you into author-mode with phrases like "code it yourself", "write the code manually", "I want YOU to do the coding", "without using Gaia / the harness / the planner", "bypass the harness", or similar explicit opt-in. This mode is EXPENSIVE — it pulls conventions, the app preflight, and a local mirror, then reads many files and runs validators. For ordinary refinement requests like "add X to view Y", "add KPIs to Z", "change the layout", "fix bug N" — use the `gaia` skill instead (cheaper; the harness's planner + BuildAgent do the work via one `gaia chat` turn).
---

# gaia code — you as the creative author, Gainable as the rails

> **The `gaia` CLI is delivered via npm, not bundled in this plugin.** If a `gaia` command fails with "command not found", install it once: `npm i -g "@gainable.dev/cli"`, then `gaia login --key gak_... --api-base https://build.gainable.dev`.

## STOP — am I the right skill for this request?

Before doing anything else, check: did the user **explicitly** ask you to write the code itself? Look for phrases like "code it yourself", "write it manually", "I want YOU to do it", "without using the harness/Gaia/the planner", "bypass the agent".

**If NOT — STOP. Switch to the `gaia` skill instead.** Run `gaia chat "<the user's request>"` — that's one cheap HTTP turn that dispatches to the harness's planner + BuildAgent. Don't pull conventions, don't read the preflight, don't grep files. Plain refinement asks like "add KPIs to the sponsors view", "redesign the deals page", "fix the kanban bug" all belong to `gaia chat`, NOT `gaia code` — even though they're about editing app code.

`gaia code` exists only for the EXPLICIT opt-in path where the user wants finer creative control or wants to bypass the harness for some reason. It's the exception, not the default.

---

If you're still here (the user did explicitly opt in), the rest of this skill applies. You author Gainable-grade code in `./app/`; every push runs the same validator suite the BuildAgent runs at `complete_build`.

## Always do this first, every session

1. **`gaia code pull`** — get the latest app state from the server. Two cases:
   - **Fresh workspace** (no `.gaia/` yet): pull auto-initializes — it'll prompt you to pick a project (or read it from `--project <id>` if you have one in mind), bootstrap `.gaia/project.json`, download conventions, the preflight, and the writable mirror. One command, no setup steps.
   - **Established workspace**: pull refreshes everything against the server's current state. Refuses to clobber uncommitted edits — if you have local changes, push them first.

   Idempotent in both cases. Run it first every session, no exceptions.
2. **Read `.gaia/preflight/index.md`** — generated summary of the app: writable scope (views/routes/models/css/js), read-only context, components in use, chrome, theme, root view.
3. **Read `.gaia/conventions/CLAUDE.md` and `.gaia/conventions/build-agent.md`** — the same context the BuildAgent loads. Tech stack rules, drawer patterns, app-shell architecture, multi-step edit strategy.
4. **Read the relevant skill guide** for what you're touching: `.gaia/conventions/skills/gainable-alpine.md` for Alpine, `gainable-design.md` for DaisyUI/Tailwind, `gainable-mongodb.md` for schemas + CRUD, `gainable-express-views.md` for routing, etc.

## Workspace layout

```
.gaia/
├── conventions/                       ← static guidance (CLAUDE.md, build-agent.md, 13 skill guides)
├── preflight/                         ← READ-ONLY context
│   ├── index.md                       ← read FIRST
│   ├── manifest.json
│   ├── server.js                      ← the wiring; grep to learn registration patterns
│   ├── package.json
│   ├── views/layout.ejs, chrome/      ← framework view shell
│   └── routes/{users,agents,weavy,…}  ← protected framework routes
└── files-state.json                   ← CLI-managed; never edit

app/                                   ← WRITABLE — your canvas
├── views/                             ← views + partials (NOT chrome/, NOT layout.ejs)
├── routes/                            ← Express handlers (NOT users.js, agents.js, weavy.js, mail.js, userFields.js)
├── db/models/                         ← Mongoose schemas, sidecars
├── public/css/                        ← stylesheets
└── public/js/                         ← view-side JS
```

You can read / grep anywhere — `./app/` and `./.gaia/preflight/` both. You can only edit / write under `./app/`. The server rejects pushes for anything outside.

## Working loop

1. **Plan**: read the user's request, scan `.gaia/preflight/index.md`, decide which files to touch. A "new feature that needs new data" usually means: new view + new route + new model + maybe an updated existing route. Reach across the whole stack — push validates atomically and the cross-file validators (e.g. `view-route-complete`, `canonical-names`, `view-fetch-reachability`) only work right when they see the full batch.
2. **Edit / create**: write to `./app/`. New views: just write the `.ejs` — push auto-registers the server.js entry via the same registrar the deterministic pipeline uses (Stage R). New routes / models: write the files; push picks them up.
3. **Validate after every meaningful edit**: `gaia code validate <file>`. This runs the EXACT validator suite the BuildAgent runs at `complete_build` — Alpine `this.` in bindings, populated-ref-select normalization, `<style>` in EJS, currency Intl.NumberFormat, view-route-complete, attached-model-fields, canonical-names, view-fetch-reachability, ~100 rules. Treat output as binding. Fix every error.
4. **Push when satisfied**: `gaia code push --summary "<recap>"`. This:
   - Refuses if remote files have changed since you pulled (run `gaia code pull` and re-apply your edits).
   - Runs validators on the full batch.
   - Atomically writes files to the server-side build dir.
   - Auto-registers new view routes in `server.js`.
   - Commits to the inner git repo (returns commit hash).
   - **Leaves a trace in the project's chat UI** — a synthetic user bubble plus an assistant completion bubble with your `--summary` recap, the list of created/updated files, and the commit hash. The human user sees this next time they open the project in the Gainable UI so the code session is visible in the project history alongside `gaia chat` and UI-driven refinements.

The `--summary` flag is **required**. Compose 1–3 sentences that recap what changed and why, in the same voice the BuildAgent uses for its completion messages (concise, second-person to the human, e.g. "Added a KPI strip above the sponsors table showing Gold/Silver/Bronze counts — mirrored the `<g-kpi>` pattern from `overview.ejs`. Sponsor tiers come from the existing `/api/sponsor-tiers` endpoint."). Don't lecture about how validators ran or which files you touched — the workDone list shows that. Focus on the what + why.

## Hard rules

1. **Edit only under `./app/`**. Anything in `./.gaia/preflight/` is read-only; the push will reject any attempt to write a protected path.
2. **Always `gaia code pull` first.** Stale local edits over newer server state is a real failure mode.
3. **Run `gaia code validate` after every write/edit.** Don't accumulate errors — fix as you go. The validators encode roughly 100 lessons from production incidents; trust them.
4. **Never `--force` past a validator.** If push rejects, the rejection is correct. Fix and re-push.
5. **For NEW data-backed features: author the FULL stack in one push.** View + route + model + (if needed) updates to existing routes. The cross-file validators see the batch holistically; trying to push the view alone trips `view-route-complete` even if the route is "coming next."
6. **server.js is owned by the registrar.** Don't try to add `app.use(...)` lines yourself — write the view + route files, push will register them.
7. **Framework routes are off-limits**: `routes/users.js`, `routes/agents.js`, `routes/weavy.js`, `routes/mail.js`, `routes/userFields.js`. Grep them in `./.gaia/preflight/routes/` for reference but never write them.
8. **Chrome variants are project-managed**: `views/chrome/{classic,topnav,mini,workspace}.ejs` live in preflight (read-only). The active variant is set by `Project.chrome`, not by editing files. If the user wants to change layout, that's the harness's job, not yours.
9. **When the user has subjective creative ambiguity** (3 layouts that fit equally well, brand-palette decisions, "which icon"), present the choices to the user as a short numbered chat list and wait for their pick. Bounded creativity within the validators' rails — but on subjective design calls, defer to the user.
10. **If the preflight tells you an endpoint exists** (`.gaia/preflight/server.js` + `app/routes/<name>.js`), use it. **Don't invent endpoints.** The `view-fetch-reachability` app-level validator rejects any `fetch('/api/X')` for a non-existent X.

## Exit codes (when you shell out to gaia)

- `0` — success
- `1` — transport error (network, server down)
- `3` — validation failure / business error (push rejected, validators failed, project not found, stale local state, etc.)

stdout is JSON for every command; stderr is human-readable progress. Parse stdout to decide your next step.
