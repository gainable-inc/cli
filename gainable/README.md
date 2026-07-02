# @gainable — Claude Code plugin

Drive the Gainable harness from Claude Code: build new apps, refine existing ones, or author code yourself with the same validators the BuildAgent uses. Bundles:

- **Skills** — `gaia` (default, harness-driven refinement) and `gaia-code` (Claude-as-author mode, explicit opt-in)
- **Slash commands** — `/gainable:chat`, `/gainable:build`, `/gainable:code`, `/gainable:apps`
- **`gaia` CLI** — shared with the Codex plugin, delivered over npm (`npm i -g "@gainable.dev/cli"`); talks to the Gainable server over HTTP
- **`SessionStart` hook** — reads `.gaia/project.json` if present and orients Claude on the project from turn 0
- **Default permissions** — `gaia *` Bash patterns pre-allowed; no permission prompts

## Install

Install the CLI (shared with the Codex plugin) and the plugin:

```
npm i -g "@gainable.dev/cli"
/plugin marketplace add gainable-inc/cli
/plugin install gainable@gainable
```

Once installed, both skills, slash commands, and the SessionStart hook are available in every Claude Code session — no per-project setup of the toolkit. The plugin no longer bundles the `gaia` binary; it comes from the npm package above (the SessionStart hook reminds you if it's missing).

## Per-project workspace

```powershell
mkdir my-app && cd my-app
gaia init                  # writes .gaia/project.json + .gaia/.gitignore
claude                     # SessionStart hook orients Claude on the project
```

That's it. The plugin owns the skills + commands + binary.

## Authentication

Mint an API key in the Gainable UI at `/account/api-keys`, then:

```powershell
gaia login --key gak_xxx_yyy --api-base https://build.gainable.dev
# or for local dev:
gaia login --key gak_xxx_yyy --api-base http://localhost:3010
```

Credentials are stored at `~/.gainable/credentials` (0600). `GAINABLE_API_KEY` and `GAINABLE_API_BASE` env vars override the file.

## Using it

Inside a Claude Code session, describe what you want and Claude picks the right path:

| You say… | Skill triggered | What happens |
|---|---|---|
| "add KPIs to the sponsors view" | **gaia** (default) | `gaia chat "..."` — one cheap HTTP turn, harness's planner + BuildAgent do the work |
| "code the sponsors view yourself with a hero KPI section" | **gaia-code** (explicit opt-in) | `gaia code pull` → read conventions + preflight → edit `./app/` → `gaia code validate` → `gaia code push --summary "..."` |
| "I want to build a CRM app" | **gaia** + `gaia build` | Drives the multi-phase contract conversation, then the deterministic pipeline |

Or use slash commands directly:
- `/gainable:chat "add probability column to the deals table"` — one-shot refinement
- `/gainable:build "I want a CRM"` — contract conversation
- `/gainable:code "redesign the dashboard"` — Claude-as-author mode
- `/gainable:apps` — list apps in your account

## What lives where

```
gainable/                                  ← this plugin
├── .claude-plugin/plugin.json           manifest
├── skills/gaia/SKILL.md                 default skill (harness path)
├── skills/gaia-code/SKILL.md            opt-in skill (Claude-as-author)
├── commands/{chat,build,code,apps}.md   slash commands
├── hooks/{hooks.json,session-start.js}  SessionStart orientation
└── settings.json                        pre-allowed Bash patterns
```

Each Gainable project workspace (the dir you'd open Claude Code in) holds:
```
.gaia/
├── project.json          projectId, accountId, appName, apiBase
└── .gitignore            transient CLI state
```

In gaia-code mode, additional dirs appear lazily on first `gaia code pull`:
```
.gaia/conventions/        CLAUDE.md, build-agent.md, skill guides
.gaia/preflight/          read-only mirror of server.js, package.json, framework partials/routes
app/                      writable mirror of views/, routes/, db/models/, public/css/, public/js/
```

## Updating

```
/plugin update gainable
```

After update, restart Claude Code so the new skill descriptions are re-discovered. CLI logic + server routes are always latest with no per-session step.

## Legacy fallback

Users not yet on the plugin can still use the toolkit via `npm i -g "@gainable.dev/cli"` + `gaia init --legacy-skills`, which writes `.claude/skills/{gaia,gaia-code}/SKILL.md` per project (the pre-plugin behavior; the SKILL.md files are bundled in the npm package for this). Plan is to deprecate `--legacy-skills` once everyone's on the plugin.

## Development

Working on the plugin source itself:

```bash
git clone https://github.com/gainable-inc/cli.git && cd cli
# Edit src/* (the CLI) or gainable/* (skills, commands, hooks) freely
git commit -am "..."
git push
```

CLI changes ship via npm (`npm publish --access public`); plugin/skill changes ship by pushing to `main`. Then in a Claude Code session: `/plugin update gainable`. The CLI is a normal npm dependency — no vendoring/sync step.
