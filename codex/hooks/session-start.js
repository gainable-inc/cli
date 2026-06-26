#!/usr/bin/env node
/**
 * Gainable Codex plugin — SessionStart hook.
 *
 * Two jobs, both best-effort and silent on failure so a non-Gainable
 * directory (or a broken environment) never disrupts the session:
 *
 *   1. If the cwd holds a `.gaia/project.json`, print a one-line
 *      orientation block so the very first turn already knows which
 *      Gainable project the session is in — no need for the user to
 *      say "we're working in project X".
 *
 *   2. Unlike the Claude Code plugin, the Codex plugin does NOT bundle
 *      the `gaia` binary (Codex plugins aren't auto-added to PATH). The
 *      CLI is delivered via npm. If `gaia` isn't resolvable, print the
 *      one-time install command.
 *
 * NOTE: Codex plugin hooks require user trust and may not auto-run. The
 * gaia / gaia-code skills therefore re-state project context themselves
 * and must not DEPEND on this hook having fired — it's a convenience.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function gaiaOnPath() {
  // `gaia --version` is a pure local command (commander handles --version
  // before any action runs — no auth, no network). shell:true so the npm
  // bin shim resolves cross-platform (gaia.cmd on Windows, gaia on POSIX).
  try {
    const r = spawnSync('gaia --version', { shell: true, stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

try {
  const out = [];

  const projectFile = path.join(process.cwd(), '.gaia', 'project.json');
  if (fs.existsSync(projectFile)) {
    const p = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    if (p && p.projectId) {
      const parts = [
        `You're in Gainable project "${p.projectName || p.projectId}"`,
        `id: ${p.projectId}`,
        p.appName ? `app: ${p.appName}` : null,
        p.apiBase ? `apiBase: ${p.apiBase}` : null,
      ].filter(Boolean);
      out.push(
        `${parts.join(', ')}. ` +
        `Use the gaia skill (type @ or $ to invoke it) for cheap refinements and the new-app journey, ` +
        `or gaia-code to author code yourself.`
      );
    }
  }

  if (!gaiaOnPath()) {
    out.push(
      `The gaia CLI isn't on PATH — install it with: npm i -g @gainable.dev/cli  ` +
      `(then 'gaia login --key gak_... --api-base https://build.gainable.dev').`
    );
  }

  if (out.length) process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
} catch (err) {
  // Silent failure — don't disrupt the session if anything in here breaks.
  process.stderr.write(`[gainable session-start] ${err.message}\n`);
  process.exit(0);
}
