const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('../http');
const credentials = require('../credentials');
const project = require('../project');
const { fail } = require('../util');

/**
 * gaia code — Claude Code as creative author, harness as rails.
 *
 * Subcommands:
 *   gaia code init       — pulls conventions + full preflight; materializes writable subset to ./app/
 *   gaia code pull       — refreshes conventions + preflight (warns on local edits)
 *   gaia code status     — shows modified / new files in ./app/
 *   gaia code validate [<file>]  — runs validators against changed file(s)
 *   gaia code push       — validates + uploads atomically; runs view-route registrar; commits
 *
 * Local layout (under cwd):
 *   .gaia/conventions/   — CLAUDE.md, build-agent.md, skill guides
 *   .gaia/preflight/     — read-only context (server.js, package.json, chrome partials, protected routes)
 *   .gaia/files-state.json — hash + mode for every pulled file (writable + read-only)
 *   app/                 — writable mirror: views/, routes/, db/models/, public/css/, public/js/, partials/
 */

const CONV_DIR = '.gaia/conventions';
const PREFLIGHT_DIR = '.gaia/preflight';
const STATE_FILE = '.gaia/files-state.json';
const APP_DIR = 'app';

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function writeFileAt(absPath, content) {
  ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, content, 'utf8');
}

// ──────────────────────────────────────────────────────────────────────
// Conventions sync — download CLAUDE.md, build-agent.md, all skill guides.
// ──────────────────────────────────────────────────────────────────────
async function pullConventions() {
  const creds = credentials.requireAuth();
  const base = creds.apiBase.replace(/\/$/, '');
  const manifest = await http.get('/api/conventions/manifest');
  const items = Array.isArray(manifest?.files) ? manifest.files : [];
  for (const item of items) {
    const url = `${base}/api/conventions/file?id=${encodeURIComponent(item.id)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${creds.apiKey}` } });
    if (!resp.ok) throw fail(`conventions fetch failed for ${item.id} (HTTP ${resp.status})`, 1);
    const content = await resp.text();
    await writeFileAt(path.join(CONV_DIR, item.id), content);
  }
  return items.length;
}

// ──────────────────────────────────────────────────────────────────────
// Preflight sync — stream JSONL, write each file under .gaia/preflight/
// (read-only context) or app/views/ (writable canvas).
// ──────────────────────────────────────────────────────────────────────
async function pullPreflight(projectId) {
  const creds = credentials.requireAuth();
  const url = `${creds.apiBase.replace(/\/$/, '')}/api/builds/${encodeURIComponent(projectId)}/preflight`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${creds.apiKey}` } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw fail(`preflight failed: HTTP ${resp.status}${body ? ' — ' + body.slice(0, 200) : ''}`,
      resp.status >= 500 ? 1 : 3);
  }

  let header = null;
  const filesState = {};      // path → { hash, mode }
  let rwCount = 0;
  let roCount = 0;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.kind === 'header') header = obj;
      else if (obj.kind === 'file') {
        // Writable files → ./app/ (full BuildAgent scope mirror).
        // Read-only context → ./.gaia/preflight/ so Claude can grep but
        // can't accidentally edit.
        const destBase = obj.mode === 'rw' ? APP_DIR : PREFLIGHT_DIR;
        await writeFileAt(path.join(destBase, obj.path), obj.content);
        filesState[obj.path] = { hash: obj.hash, mode: obj.mode };
        if (obj.mode === 'rw') rwCount++; else roCount++;
      } else if (obj.kind === 'error') {
        throw fail(`preflight stream error: ${obj.error}`, 1);
      }
    }
  }

  if (header) {
    await writeFileAt(path.join(PREFLIGHT_DIR, 'manifest.json'),
      JSON.stringify(header, null, 2));
  }
  await writeFileAt(STATE_FILE, JSON.stringify({
    pulledAt: new Date().toISOString(),
    files: filesState,
  }, null, 2));

  return { rwCount, roCount, header };
}

// ──────────────────────────────────────────────────────────────────────
// Generate .gaia/preflight/index.md — a markdown summary of the app for
// Claude to read first. Built from the manifest + the pulled files.
// ──────────────────────────────────────────────────────────────────────
async function writePreflightIndex(projectId) {
  let manifestRaw;
  try {
    manifestRaw = JSON.parse(fs.readFileSync(path.join(PREFLIGHT_DIR, 'manifest.json'), 'utf8'));
  } catch { manifestRaw = {}; }
  const appManifest = await http.get(`/api/builds/${encodeURIComponent(projectId)}/manifest`);

  // List route files (apiSlugs) by reading the preflight routes dir.
  const routesDir = path.join(PREFLIGHT_DIR, 'routes');
  let routeFiles = [];
  try {
    routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));
  } catch { /* no routes dir */ }

  // List model files.
  const modelsDir = path.join(PREFLIGHT_DIR, 'db/models');
  let modelFiles = [];
  try {
    modelFiles = fs.readdirSync(modelsDir).filter((f) => f.endsWith('.js'));
  } catch { /* no models */ }

  // List writable views (app/views/).
  const viewsDir = path.join(APP_DIR, 'views');
  let viewFiles = [];
  try {
    viewFiles = fs.readdirSync(viewsDir).filter((f) => f.endsWith('.ejs'));
  } catch { /* no views yet */ }

  // Walk app/ to enumerate the writable subtree.
  const writable = { views: [], routes: [], models: [], css: [], js: [] };
  const collect = (absDir, relPrefix, bucket) => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        collect(path.join(absDir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name, bucket);
      } else {
        bucket.push(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      }
    }
  };
  collect(path.join(APP_DIR, 'views'),      '', writable.views);
  collect(path.join(APP_DIR, 'routes'),     '', writable.routes);
  collect(path.join(APP_DIR, 'db/models'),  '', writable.models);
  collect(path.join(APP_DIR, 'public/css'), '', writable.css);
  collect(path.join(APP_DIR, 'public/js'),  '', writable.js);

  const lines = [
    `# Preflight — ${appManifest.appName || projectId}`,
    '',
    `Project: \`${projectId}\``,
    `App: \`${appManifest.appName}\``,
    `Chrome: \`${appManifest.chrome || 'classic'}\` · Theme: \`${appManifest.theme || 'light'}\` · Root view: \`${appManifest.rootViewSlug || '(none)'}\``,
    `Scanned: ${manifestRaw.scannedAt || appManifest.scannedAt || 'unknown'}`,
    '',
    '## Writable scope — your canvas (under `app/`)',
    '',
    `Edit any of these. Push runs the same validators BuildAgent runs at \`complete_build\`.`,
    '',
    '### Views',
    writable.views.length ? writable.views.map((f) => `- \`app/views/${f}\``).join('\n') : '_(none)_',
    '',
    '### Routes',
    writable.routes.length ? writable.routes.map((f) => `- \`app/routes/${f}\``).join('\n') : '_(none)_',
    '',
    '### Models',
    writable.models.length ? writable.models.map((f) => `- \`app/db/models/${f}\``).join('\n') : '_(none)_',
    '',
    writable.css.length ? `### CSS\n${writable.css.map((f) => `- \`app/public/css/${f}\``).join('\n')}\n` : '',
    writable.js.length  ? `### JS\n${writable.js.map((f) => `- \`app/public/js/${f}\``).join('\n')}\n`   : '',
    '## Read-only context (under `.gaia/preflight/`)',
    '',
    'Grep these freely — they tell you what already exists. **Cannot be pushed.**',
    '',
    `- \`.gaia/preflight/server.js\` — the wiring; useful for seeing endpoint registration patterns. Owned by the registrar.`,
    `- \`.gaia/preflight/package.json\` — dep versions.`,
    `- \`.gaia/preflight/views/layout.ejs\` and \`views/chrome/*\` — framework view shell.`,
    `- \`.gaia/preflight/routes/{users,agents,weavy,mail,userFields}.js\` — protected framework routes.`,
    '',
    '## Components in use',
    '',
    Array.isArray(appManifest.components) && appManifest.components.length > 0
      ? appManifest.components.map((c) => `- \`<${c.tag}>\` — used in ${c.count} view(s): ${c.views.join(', ')}`).join('\n')
      : '_(none detected)_',
    '',
    '## Rules — read these before editing',
    '',
    '1. **Always** run `gaia code pull` at the start of a session — get the latest from the server.',
    '2. **Always** read `.gaia/conventions/CLAUDE.md` and `.gaia/conventions/build-agent.md` before editing.',
    '3. Read the relevant skill guide for what you\'re editing (`.gaia/conventions/skills/gainable-{alpine,design,mongodb,express-views,...}.md`).',
    '4. Edit under `app/`. Reach across views + routes + models when a feature needs all three — push validates the batch atomically.',
    '5. After every meaningful edit, run `gaia code validate <file>`. Treat validator output as binding.',
    '6. When done, run `gaia code push`. Push runs the full validator suite + view-route-registrar + git commit.',
    '7. For NEW views that need new data: write the view AND its route AND any new model AND any updated existing route — all at once. Push sees them together; validators check the batch holistically.',
    '',
  ];
  await writeFileAt(path.join(PREFLIGHT_DIR, 'index.md'), lines.join('\n'));
}

// ──────────────────────────────────────────────────────────────────────
// gaia-code skill installation used to happen here as a project-local
// file copy. With the @gainable plugin, the skill ships once globally
// when the user runs `/plugin install`. Project workspaces only need
// the lazy bootstrap (conventions, preflight, app/ mirror); the skill
// itself is plugin-owned. Use `gaia init --legacy-skills` if you're on
// the pre-plugin file-copy setup.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// Walk ./app/ recursively and diff against .gaia/files-state.json.
// Returns { modified: [{ path, baseHash }], created: [...] }.
// Only rw files are pushable — created files in non-rw paths are still
// listed so the user can see them (push will reject them).
// ──────────────────────────────────────────────────────────────────────
function diffLocal() {
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { modified: [], created: [], stateMissing: true }; }
  const knownByPath = state.files || {};
  const modified = [];
  const created = [];

  if (!fs.existsSync(APP_DIR)) return { modified, created };

  const walk = (absDir, relPrefix) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(abs, rel); continue; }
      let content;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const known = knownByPath[rel];
      if (!known) {
        created.push(rel);
      } else if (known.mode === 'rw' && sha256(content) !== known.hash) {
        modified.push({ path: rel, baseHash: known.hash });
      }
    }
  };
  walk(APP_DIR, '');
  return { modified, created };
}

module.exports = (program) => {
  const code = program
    .command('code')
    .description('Author mode (Claude Code or Codex writes the code): pull conventions + app preflight, edit views locally, validate, push');

  // Shared between `code init` and `code pull` — does the full sync
  // (bootstrap project.json if missing, pull conventions, pull
  // preflight, write the preflight index, install the gaia-code skill).
  // Idempotent. The skill tells Claude to run `gaia code pull` at every
  // session start; pull → init when the workspace is brand new.
  async function fullSync(opts, { firstRun }) {
    const { bootstrapProjectJson } = require('./init');
    const projectJson = await bootstrapProjectJson({ project: opts.project, force: false });
    if (firstRun) {
      process.stderr.write(`  · project: ${projectJson.projectName} (${projectJson.projectId})\n`);
    }
    process.stderr.write('  · pulling conventions…\n');
    const convCount = await pullConventions();
    process.stderr.write(`  · ${convCount} convention file(s) → ${CONV_DIR}/\n`);
    process.stderr.write('  · pulling preflight…\n');
    const { rwCount, roCount } = await pullPreflight(projectJson.projectId);
    process.stderr.write(`  · ${rwCount} writable file(s) → ${APP_DIR}/, ${roCount} read-only → ${PREFLIGHT_DIR}/\n`);
    await writePreflightIndex(projectJson.projectId);
    process.stderr.write(`  · wrote ${PREFLIGHT_DIR}/index.md\n`);
    // The gaia-code skill is installed by the @gainable plugin, not by
    // gaia code pull/init. If users want a project-local copy (pre-
    // plugin grace path), they run `gaia init --legacy-skills` instead.
    process.stdout.write(JSON.stringify({
      ok: true,
      projectId: projectJson.projectId,
      convCount, rwCount, roCount,
    }, null, 2) + '\n');
  }

  code
    .command('init')
    .description('Bootstrap a workspace: pick project, pull conventions + preflight, install the gaia-code skill')
    .option('--project <id>', 'use this projectId (skip the picker)')
    .action(async (opts) => {
      const firstRun = !fs.existsSync(path.join('.gaia', 'project.json'));
      process.stderr.write(`→ gaia code init${firstRun ? ' (new workspace)' : ''}\n`);
      await fullSync(opts, { firstRun });
    });

  code
    .command('pull')
    .description('Refresh conventions + preflight + writable mirror; auto-initializes a fresh workspace')
    .option('--project <id>', 'override project context')
    .option('--force', 'overwrite local modifications without warning')
    .action(async (opts) => {
      const firstRun = !fs.existsSync(path.join('.gaia', 'project.json'))
        || !fs.existsSync(STATE_FILE);
      if (!firstRun) {
        // Existing workspace — refuse to clobber uncommitted edits.
        const { modified, created } = diffLocal();
        if (!opts.force && (modified.length > 0 || created.length > 0)) {
          const blockers = [
            ...modified.map((m) => `M ${m.path}`),
            ...created.map((p) => `+ ${p}`),
          ];
          throw fail(
            `you have local edits — refusing to overwrite:\n  ${blockers.join('\n  ')}\nPush them first with \`gaia code push\`, or re-run with --force to discard.`
          );
        }
      }
      process.stderr.write(`→ gaia code pull${firstRun ? ' (bootstrapping workspace)' : ''}\n`);
      await fullSync(opts, { firstRun });
    });

  code
    .command('status')
    .description('Show modified / new files in app/views/')
    .action(async () => {
      const diff = diffLocal();
      if (diff.stateMissing) {
        throw fail('no preflight state — run `gaia code init` first');
      }
      const clean = diff.modified.length === 0 && diff.created.length === 0;
      process.stdout.write(JSON.stringify({
        clean,
        modified: diff.modified.map((m) => m.path),
        created: diff.created,
      }, null, 2) + '\n');
    });

  code
    .command('validate [file]')
    .description('Run validators against changed file(s) or a specific file')
    .option('--project <id>', 'override project context')
    .action(async (file, opts) => {
      const ctx = project.resolveProject({ projectIdOverride: opts.project });
      let files = [];
      if (file) {
        const abs = path.resolve(file);
        if (!fs.existsSync(abs)) throw fail(`not found: ${file}`);
        const content = fs.readFileSync(abs, 'utf8');
        // Map to repo-relative path (strip leading app/)
        const rel = path.relative(APP_DIR, abs).replace(/\\/g, '/');
        files = [{ path: rel, content }];
      } else {
        const diff = diffLocal();
        const all = [...diff.modified.map((m) => m.path), ...diff.created];
        if (all.length === 0) {
          process.stdout.write(JSON.stringify({ ok: true, files: [], note: 'no local changes' }) + '\n');
          return;
        }
        files = all.map((relPath) => {
          const abs = path.join(APP_DIR, relPath);
          return { path: relPath, content: fs.readFileSync(abs, 'utf8') };
        });
      }
      const url = `/api/builds/${encodeURIComponent(ctx.projectId)}/validate`;
      const result = await http.post(url, { files });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.ok) process.exit(3);
    });

  code
    .command('push')
    .description('Validate + atomically push changed files; auto-register new views; trace to the project chat')
    .option('--project <id>', 'override project context')
    .requiredOption('--summary <text>', 'short recap (1-3 sentences) of what changed and why; persisted to the project\'s chat UI so the human user sees a trace of the code session')
    .action(async (opts) => {
      const ctx = project.resolveProject({ projectIdOverride: opts.project });
      const diff = diffLocal();
      if (diff.stateMissing) throw fail('no preflight state — run `gaia code init` first');
      const all = [...diff.modified, ...diff.created.map((p) => ({ path: p, baseHash: null }))];
      if (all.length === 0) {
        process.stdout.write(JSON.stringify({ ok: true, written: [], note: 'no local changes' }) + '\n');
        return;
      }
      const filesPayload = all.map((entry) => {
        const abs = path.join(APP_DIR, entry.path);
        return {
          path: entry.path,
          content: fs.readFileSync(abs, 'utf8'),
          ...(entry.baseHash ? { baseHash: entry.baseHash } : {}),
        };
      });
      process.stderr.write(`→ gaia code push: ${filesPayload.length} file(s) → ${ctx.projectId}\n`);
      const result = await http.post(`/api/builds/${encodeURIComponent(ctx.projectId)}/push`, {
        files: filesPayload,
        summary: opts.summary,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.ok) process.exit(3);
      // Pull fresh state so future status/diff calls are accurate.
      await pullPreflight(ctx.projectId);
      process.stderr.write(`  ✓ pushed${result.commit ? ` (commit ${result.commit.slice(0, 7)})` : ''}; chat trace left for the project\n`);
    });
};
