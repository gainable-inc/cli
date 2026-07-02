# Gainable — Codex plugin

Drive the Gainable harness from **OpenAI Codex**: build new apps, refine existing ones, or author app code yourself with the same validators the BuildAgent uses. Bundles:

- **Skills** — `gaia` (default, harness-driven refinement + new-app journey) and `gaia-code` (author-mode, explicit opt-in). Invoke with `@gaia` / `@gaia-code`, or type `$` to mention a skill.
- **`SessionStart` hook** — reads `.gaia/project.json` if present and orients Codex on the project; also nudges you to install the CLI if it's missing.

The plugin does **not** bundle a binary (Codex plugins aren't auto-added to PATH). The `gaia` CLI is delivered over npm — install it once:

```bash
npm i -g "@gainable.dev/cli"
```

> Same `gaia` CLI used by the Claude Code plugin — one package, both ecosystems.

## Install the plugin

From the Gainable marketplace (git-backed):

```bash
codex plugin marketplace add gainable-inc/cli
codex plugin add gainable@gainable
# or install "gainable" interactively from /plugins inside a session
```

For local development against this repo:

```bash
codex plugin marketplace add ./.agents/plugins   # repo-root marketplace
```

## Per-project workspace

```bash
mkdir my-app && cd my-app
gaia init                  # writes .gaia/project.json + seeds .codex/rules/gaia.rules
codex                      # the SessionStart hook orients Codex on the project
```

The seeded `.codex/rules/gaia.rules` lets Codex run every `gaia` command without per-subcommand approval prompts (loaded once you trust the project — Codex plugins can't ship approval rules, so the CLI seeds them per workspace).

## Authentication

Mint an API key in the Gainable UI at `/account/api-keys`, then:

```bash
gaia login --key gak_xxx_yyy --api-base https://build.gainable.dev
# or for local dev:
gaia login --key gak_xxx_yyy --api-base http://localhost:3010
```

Credentials are stored at `~/.gainable/credentials` (0600). `GAINABLE_API_KEY` and `GAINABLE_API_BASE` env vars override the file.

## Using it

Inside a Codex session, describe what you want and the right skill triggers:

| You say… | Skill | What happens |
|---|---|---|
| "add KPIs to the sponsors view" | **gaia** (default) | `gaia chat "..."` — one cheap HTTP turn, harness's planner + BuildAgent do the work |
| "I want to build a CRM app" | **gaia** + `gaia build` | Drives the multi-phase contract conversation, then the deterministic pipeline |
| "code the sponsors view yourself with a hero KPI section" | **gaia-code** (explicit opt-in) | `gaia code pull` → edit `./app/` → `gaia code validate` → `gaia code push --summary "..."` |

The skills relay every harness ask to you in plain chat (numbered list → reply); they never answer subjective design choices on your behalf.

## How this differs from the Claude Code plugin

Same harness, same CLI, same skills — two deltas, both because Codex's tool surface differs:

- **No auto-PATH'd binary.** Codex plugins can't ship a binary on PATH, so `gaia` comes from `npm i -g "@gainable.dev/cli"` (the Claude plugin used to vendor it; both now share the npm package).
- **Plain-chat asks + plain-text progress.** Codex has no `AskUserQuestion` or live task checklist, so the skills forward harness asks as numbered chat lists and relay build-pipeline progress as plain text lines (the Claude plugin uses `AskUserQuestion` + a `TaskList`).

## Updating

```bash
codex plugin marketplace upgrade
```

Restart the Codex session so the refreshed skill descriptions are re-discovered. CLI logic + server routes are always latest; bump the CLI with `npm update -g "@gainable.dev/cli"`.

## What lives where

```
codex/                                    ← this plugin
├── .codex-plugin/plugin.json            manifest + interface (install surface)
├── skills/gaia/SKILL.md                 default skill (harness path)
├── skills/gaia-code/SKILL.md            opt-in skill (author-mode)
└── hooks/{hooks.json,session-start.js}  SessionStart orientation + CLI check

.agents/plugins/marketplace.json          ← repo-root Codex marketplace entry → ./codex
```
