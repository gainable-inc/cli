const fs = require('fs');
const path = require('path');

// Canonical skill source lives under the Claude Code plugin at
// `gainable/skills/`. The legacy `gaia init --legacy-skills` path reads
// these same files, so file-copy users and plugin-install users see identical
// skill content. The published npm package bundles `gainable/skills/` (see the
// "files" allowlist in package.json) so the globally-installed CLI resolves
// them too.
//
// Resolution is LAZY (called only when --legacy-skills actually reads a skill).
// Resolving at import time would crash every command on a global install where
// the skills aren't on disk — normal commands must never touch this.
//
// One candidate covers both layouts: from `src/assets/` (dev) and from
// `<pkg>/src/assets/` (npm global), two levels up lands on the package root,
// where `gainable/skills/` lives.
function resolveSkillPath(skillName) {
  const tail = path.join(skillName, 'SKILL.md');
  const candidate = path.join(__dirname, '..', '..', 'gainable', 'skills', tail);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `SKILL.md not found for "${skillName}" (looked in ${candidate}). ` +
    `--legacy-skills needs the bundled skill files; install the gainable ` +
    `plugin via your marketplace instead.`
  );
}

function read() {
  return fs.readFileSync(resolveSkillPath('gaia'), 'utf8');
}

function readCodeSkill() {
  return fs.readFileSync(resolveSkillPath('gaia-code'), 'utf8');
}

module.exports = { read, readCodeSkill };
