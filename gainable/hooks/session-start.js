#!/usr/bin/env node
/**
 * Gainable plugin — SessionStart hook.
 *
 * Two jobs, both best-effort and silent on failure so a non-Gainable
 * directory never disrupts the session:
 *
 *   1. If the cwd contains a `.gaia/project.json`, print a one-line
 *      orientation block that Claude Code injects into the session as
 *      system context — so the very first turn already knows which
 *      Gainable project the session is operating in.
 *
 *   2. This plugin no longer bundles the `gaia` binary (the CLI is shared
 *      with the Codex plugin and delivered over npm). If `gaia` isn't
 *      resolvable on PATH, print the one-time install command.
 *
 * Silent (no output) when not in a Gainable workspace and gaia is present,
 * so non-Gainable directories don't get noise.
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
        `Use /gainable:chat for cheap refinements, /gainable:build for the new-app journey, ` +
        `/gainable:code to author code yourself, or the gaia / gaia-code skills directly.`
      );
    }
  }

  if (!gaiaOnPath()) {
    out.push(
      `The gaia CLI isn't on PATH — install it with: npm i -g "@gainable.dev/cli"  ` +
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
