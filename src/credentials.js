const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_API_BASE = 'https://build.gainable.dev';
const CREDENTIALS_DIR = path.join(os.homedir(), '.gainable');
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, 'credentials');

function load() {
  const envKey = process.env.GAINABLE_API_KEY;
  const envBase = process.env.GAINABLE_API_BASE;
  let fileCreds = {};
  try {
    fileCreds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch {
    // missing or unreadable — env-only path is still valid
  }
  return {
    apiKey: envKey || fileCreds.apiKey || null,
    apiBase: envBase || fileCreds.apiBase || DEFAULT_API_BASE,
    source: envKey ? 'env' : fileCreds.apiKey ? 'file' : null
  };
}

function save({ apiKey, apiBase }) {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({ apiKey, apiBase }, null, 2),
    { mode: 0o600 }
  );
  // mkdirSync mode is advisory if the dir existed; tighten explicitly.
  try { fs.chmodSync(CREDENTIALS_PATH, 0o600); } catch { /* Windows: chmod is a no-op */ }
}

function clear() {
  try {
    fs.unlinkSync(CREDENTIALS_PATH);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function requireAuth() {
  const creds = load();
  if (!creds.apiKey) {
    const err = new Error('not logged in — run `gaia login`');
    err.exitCode = 3;
    throw err;
  }
  return creds;
}

module.exports = {
  load,
  save,
  clear,
  requireAuth,
  CREDENTIALS_PATH,
  DEFAULT_API_BASE
};
