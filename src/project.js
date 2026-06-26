const fs = require('fs');
const path = require('path');

const PROJECT_DIRNAME = '.gaia';
const PROJECT_FILE = 'project.json';

/**
 * Walk up from `startDir` looking for a `.gaia/project.json`.
 * Returns { dir, project } on hit, or null if not found before the root.
 */
function findProjectDir(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  // path.parse(dir).root is 'C:\\' on Windows, '/' on POSIX — loop until
  // we reach it (and check root itself once).
  while (true) {
    const candidate = path.join(dir, PROJECT_DIRNAME, PROJECT_FILE);
    if (fs.existsSync(candidate)) {
      try {
        const project = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        return { dir, gaiaDir: path.join(dir, PROJECT_DIRNAME), file: candidate, project };
      } catch (err) {
        const wrapped = new Error(`malformed ${candidate}: ${err.message}`);
        wrapped.exitCode = 3;
        throw wrapped;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;  // reached root
    dir = parent;
  }
}

/**
 * Resolve project context for a command:
 *   1. --project <id> flag overrides everything (no local state writes).
 *   2. Otherwise read .gaia/project.json by walk-up.
 *   3. Else throw with exitCode 3.
 *
 * Returns { projectId, gaiaDir? } — gaiaDir present iff resolved from disk.
 */
function resolveProject({ projectIdOverride } = {}) {
  if (projectIdOverride) {
    return { projectId: projectIdOverride, gaiaDir: null, project: null };
  }
  const found = findProjectDir();
  if (!found) {
    const err = new Error(
      'no project context — run `gaia init` in this directory, or pass --project <projectId>'
    );
    err.exitCode = 3;
    throw err;
  }
  if (!found.project?.projectId) {
    const err = new Error(`${found.file} missing required "projectId"`);
    err.exitCode = 3;
    throw err;
  }
  return { projectId: found.project.projectId, gaiaDir: found.gaiaDir, project: found.project };
}

/**
 * Save a JSON state file inside .gaia/. Silently skipped when gaiaDir is
 * null (--project flag used without a local project).
 */
function saveState(gaiaDir, name, data) {
  if (!gaiaDir) return false;
  try {
    fs.mkdirSync(gaiaDir, { recursive: true });
    fs.writeFileSync(path.join(gaiaDir, name), JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    process.stderr.write(`warning: could not write ${name}: ${err.message}\n`);
    return false;
  }
}

function loadState(gaiaDir, name) {
  if (!gaiaDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(gaiaDir, name), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write `.gaia/project.json` + `.gaia/.gitignore` in the cwd for a project
 * that was just created server-side. Shared by the auto-init paths
 * (`gaia build "<idea>"` in an empty dir, `gaia import attach` with no
 * project context) so the on-disk shape can't drift between commands.
 * Returns the resolved context, same shape as resolveProject().
 */
function writeProjectFiles({ projectId, projectName, apiBase }) {
  const gaiaDir = path.join(process.cwd(), PROJECT_DIRNAME);
  fs.mkdirSync(gaiaDir, { recursive: true });
  fs.writeFileSync(path.join(gaiaDir, PROJECT_FILE), JSON.stringify({
    projectId,
    projectName,
    apiBase,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(gaiaDir, '.gitignore'),
    'last-asks.json\nlast-turn.json\nfiles-state.json\npreflight/\nimport-session.json\n');
  return resolveProject({});
}

module.exports = {
  findProjectDir,
  resolveProject,
  saveState,
  loadState,
  writeProjectFiles,
  PROJECT_DIRNAME,
  PROJECT_FILE
};
