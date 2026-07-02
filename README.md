# Gainable CLI &amp; plugins

The command-line control plane for the [Gainable](https://build.gainable.dev) harness — build, refine, and publish AI-built apps from your terminal, or let your coding agent drive it.

This repo ships three things from one source of truth:

| | What | Where |
|---|---|---|
| **`gaia` CLI** | A thin HTTP client for the Gainable harness (`@gainable.dev/cli`) | `bin/`, `src/` |
| **Claude Code plugin** | `gaia` / `gaia-code` skills + `/gainable:*` commands | [`gainable/`](./gainable) |
| **Codex plugin** | `gaia` / `gaia-code` skills, installed via marketplace | [`codex/`](./codex) |

Full docs: **https://docs.gainable.dev** (CLI &amp; plugins section).

## Install the CLI

Requires Node.js 18+.

```bash
npm i -g "@gainable.dev/cli"
gaia --version
```

Authenticate with an API key from **Account → API keys** at [build.gainable.dev](https://build.gainable.dev):

```bash
gaia login --key gak_xxx_yyy
gaia apps list
```

Credentials are stored at `~/.gainable/credentials` (`0600`). The `GAINABLE_API_KEY` and `GAINABLE_API_BASE` environment variables override the file.

## Install a plugin

The CLI works on its own, but it shines when your coding agent drives it. The agent learns when to run `gaia` and forwards any questions back to you.

**Claude Code**

```
/plugin marketplace add gainable-inc/cli
/plugin install gainable@gainable
```

**OpenAI Codex**

```bash
codex plugin marketplace add gainable-inc/cli
# then, inside a codex session:
codex /plugins        # install "gainable"
```

Both plugins rely on the globally installed `gaia` from npm — they don't bundle a binary. See [`gainable/README.md`](./gainable/README.md) and [`codex/README.md`](./codex/README.md) for the details and per-agent differences.

## Commands

| Command | What it does |
|---|---|
| `gaia login` / `gaia logout` | Manage credentials |
| `gaia init` | Link the current folder to a project |
| `gaia apps list` / `create` | List or create apps |
| `gaia build "<idea>"` | Drive the new-app build journey |
| `gaia chat "<change>"` | Refine an already-built app |
| `gaia code pull` / `validate` / `push` | Author app code locally with the same validators the harness uses |
| `gaia import upload <file>` | Turn a spreadsheet into an app's data |
| `gaia publish` | Publish a built app to `&lt;slug&gt;.gainable.app` |

Run `gaia --help` or `gaia <command> --help` for the full reference. Every command prints JSON to stdout (machine-readable) and human status to stderr.

## Repo layout

```
.
├── bin/gaia.js                  CLI entry point
├── src/                         CLI source (commander; zero deps but commander)
├── package.json                 npm package: @gainable.dev/cli
├── gainable/                    Claude Code plugin
│   └── .claude-plugin/, skills/, commands/, hooks/, settings.json
├── codex/                       Codex plugin
│   └── .codex-plugin/, skills/, hooks/
├── .claude-plugin/marketplace.json   Claude Code marketplace entry → ./gainable
└── .agents/plugins/marketplace.json  Codex marketplace entry → ./codex
```

## Development

```bash
git clone https://github.com/gainable-inc/cli.git && cd cli
bun install      # or: npm install
bun link         # puts `gaia` on your PATH from source
```

- **CLI changes** (`src/`) ship via npm: bump `package.json`, then `npm publish --access public`.
- **Plugin/skill changes** (`gainable/`, `codex/`) ship via git — push to `main`, then `/plugin update gainable` (Claude Code) or `codex plugin marketplace upgrade` (Codex).

## License

Proprietary © Gainable, Inc. — source-available, governed by the [Gainable Terms of Service](https://www.gainable.dev/terms). See [`LICENSE`](./LICENSE).
