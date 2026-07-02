const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('../http');
const credentials = require('../credentials');
const skillAsset = require('../assets/skill');
const { fail } = require('../util');

async function pickProject(apps) {
  if (!process.stdin.isTTY) {
    throw fail('non-interactive — pass --project <projectId>. List with `gaia apps list`.');
  }
  process.stderr.write('Select a project:\n');
  apps.forEach((a, i) => {
    process.stderr.write(`  ${String(i + 1).padStart(2)}. ${a.projectName} (${a.appName})\n`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) =>
    rl.question('Number: ', (a) => { rl.close(); resolve(a.trim()); })
  );
  const idx = parseInt(answer, 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= apps.length) {
    throw fail('invalid selection');
  }
  return apps[idx];
}

function writeFileIfMissing(filePath, content, { force, label }) {
  const exists = fs.existsSync(filePath);
  if (exists && !force) {
    process.stderr.write(`  · ${label}: kept existing ${filePath}\n`);
    return { written: false, path: filePath };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  process.stderr.write(`  ${exists ? '↻' : '+'} ${label}: ${filePath}\n`);
  return { written: true, path: filePath };
}

/**
 * Bootstrap .gaia/project.json (project picker + write) and the gitignore.
 * Exposed for reuse by `gaia code init` / `gaia code pull` so the user
 * never has to run two commands to get started — `gaia code init` in an
 * empty dir does both project-picker AND code-mirror pull in one shot.
 *
 * Returns the projectJson. Skips the picker entirely if .gaia/project.json
 * already exists (unless --force).
 */
async function bootstrapProjectJson({ project: projectIdOverride, force } = {}) {
  const cwd = process.cwd();
  const gaiaDir = path.join(cwd, '.gaia');
  const projectFile = path.join(gaiaDir, 'project.json');

  // Before the early return so pre-existing workspaces pick the rules up
  // on their next `gaia init` / `gaia code pull` (silent when present).
  require('../project').seedCodexRules(cwd);

  if (fs.existsSync(projectFile) && !force) {
    return JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  }

  const apps = await http.get('/api/projects');
  if (!Array.isArray(apps) || apps.length === 0) {
    throw fail('account has no apps yet — create one in the Gainable UI first');
  }

  let chosen;
  if (projectIdOverride) {
    chosen = apps.find((a) => a.projectId === projectIdOverride);
    if (!chosen) throw fail(`project "${projectIdOverride}" not found in your account`);
  } else {
    chosen = await pickProject(apps);
  }

  const creds = credentials.load();
  const projectJson = {
    projectId: chosen.projectId,
    appName: chosen.appName,
    projectName: chosen.projectName,
    apiBase: creds.apiBase,
  };

  writeFileIfMissing(projectFile, JSON.stringify(projectJson, null, 2) + '\n',
    { force: true, label: 'project.json' });
  writeFileIfMissing(
    path.join(gaiaDir, '.gitignore'),
    'last-asks.json\nlast-turn.json\nfiles-state.json\npreflight/\nimport-session.json\n',
    { force, label: '.gaia/.gitignore' }
  );

  return projectJson;
}

module.exports = (program) => {
  program
    .command('init')
    .description('Scaffold .gaia/ in the current directory. The Gainable plugin (Claude Code or Codex) owns the skills; pass --legacy-skills to also write project-local SKILL.md copies.')
    .option('--project <id>', 'use this projectId (skip the interactive picker)')
    .option('--force', 'overwrite existing files')
    .option('--legacy-skills', 'also write .claude/skills/{gaia,gaia-code}/SKILL.md project-locally (pre-plugin grace path; the plugin owns skills otherwise)')
    .action(async (opts) => {
      const cwd = process.cwd();
      const projectJson = await bootstrapProjectJson(opts);
      process.stderr.write(`Scaffolding for ${projectJson.projectName} (${projectJson.projectId})\n`);

      const written = [];
      if (opts.legacySkills) {
        // Grace-period file-copy path for users who haven't installed
        // the @gainable plugin yet. The plugin install (the recommended
        // setup) gives every Claude Code session both skills globally,
        // so this branch is opt-in. After plugin install becomes
        // ubiquitous, this flag (and the writeFileIfMissing import)
        // can go away.
        const gaiaSkillFile = path.join(cwd, '.claude', 'skills', 'gaia', 'SKILL.md');
        writeFileIfMissing(gaiaSkillFile, skillAsset.read(),
          { force: opts.force, label: 'gaia skill (legacy)' });
        const codeSkillFile = path.join(cwd, '.claude', 'skills', 'gaia-code', 'SKILL.md');
        writeFileIfMissing(codeSkillFile, skillAsset.readCodeSkill(),
          { force: opts.force, label: 'gaia-code skill (legacy)' });
        written.push(gaiaSkillFile, codeSkillFile);
      } else {
        process.stderr.write('  · skills owned by the gainable plugin; pass --legacy-skills to write project-local copies\n');
      }

      process.stderr.write(`\nNext: open Claude Code or Codex in this directory.\n`);
      process.stdout.write(JSON.stringify({
        ok: true,
        project: projectJson,
        skills: written,
        skillsManagedBy: opts.legacySkills ? 'project-local (legacy)' : 'gainable plugin',
      }, null, 2) + '\n');
    });
};

module.exports.bootstrapProjectJson = bootstrapProjectJson;
module.exports.writeFileIfMissing = writeFileIfMissing;
