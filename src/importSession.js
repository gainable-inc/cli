const fs = require('fs');
const path = require('path');
const http = require('./http');
const credentials = require('./credentials');
const project = require('./project');
const { fail } = require('./util');

const STATE_FILE = 'import-session.json';

/**
 * Where to store the active import session id locally.
 *   - Inside a .gaia/ project workspace: keep it there.
 *   - Otherwise: ~/.gainable/import-session.json so subsequent commands in
 *     the same shell can find the session without --session.
 */
function stateLocation() {
  try {
    const found = project.findProjectDir();
    if (found?.gaiaDir) return { dir: found.gaiaDir, file: path.join(found.gaiaDir, STATE_FILE) };
  } catch { /* malformed project.json — fall through to global */ }
  const dir = path.dirname(credentials.CREDENTIALS_PATH);
  return { dir, file: path.join(dir, STATE_FILE) };
}

function saveState(state) {
  const { dir, file } = stateLocation();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function loadState() {
  const { file } = stateLocation();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function clearState() {
  const { file } = stateLocation();
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function resolveSessionId(flag) {
  if (flag) return flag;
  const s = loadState();
  if (s?.importSessionId) return s.importSessionId;
  throw fail('no active import session — pass --session <id> or start one first');
}

/**
 * After every turn, the server returns a state snapshot. Persist the bits
 * the next command needs (sessionId, toolUseId for replies) so the CLI
 * stays stateless from the user's perspective.
 *
 * `intent` carries WHY the session was started. `gaia dataset create` sets it
 * so that whichever command later observes `state === 'proposal'` knows to
 * finalize and create the dataset itself. Its absence means the `gaia import`
 * path, which hands off to `import attach` instead — so preserving it across
 * turns is what keeps the two surfaces from stepping on each other.
 */
function persistTurnResponse(response, extra = {}) {
  if (!response?.importSessionId) return;
  const prev = loadState();
  const next = {
    importSessionId: response.importSessionId,
    fileName: response.fileName || prev?.fileName || null,
    state: response.state || null,
    toolUseId: response.toolUseId || null,
    question: response.question || null,
    savedAt: new Date().toISOString(),
    ...(prev?.intent ? { intent: prev.intent } : {}),
    ...extra
  };
  saveState(next);
}

// ── Analyzer transport ────────────────────────────────────────────────────
// Thin wrappers over /api/excel-import/*. Kept here rather than in the command
// modules so `gaia import` and `gaia dataset` drive the identical protocol.

/** Upload a spreadsheet and run the first agent turn. */
async function startFileSession({ buffer, fileName, importSessionId }) {
  return http.postMultipart('/api/excel-import/start', {
    buffer,
    fileName,
    fields: importSessionId ? { importSessionId } : {}
  });
}

/** Start an analyzer session from JSON rows — no file involved. */
async function startRowsSession({ rows, sheets, sheetName, fileName, importSessionId }) {
  const body = { fileName };
  if (sheets) body.sheets = sheets;
  else body.rows = rows;
  if (sheetName) body.sheetName = sheetName;
  if (importSessionId) body.importSessionId = importSessionId;
  return http.post('/api/excel-import/start-rows', body);
}

/** Peek at session state WITHOUT advancing the agent. */
async function getSessionState(importSessionId) {
  return http.get(`/api/excel-import/state?importSessionId=${encodeURIComponent(importSessionId)}`);
}

async function answerTurn({ importSessionId, toolUseId, answers }) {
  return http.post('/api/excel-import/answer', { importSessionId, toolUseId, answers });
}

async function finalizeSession(importSessionId) {
  return http.post('/api/excel-import/finalize', { importSessionId });
}

async function cancelSession(importSessionId) {
  return http.post('/api/excel-import/cancel', { importSessionId });
}

/**
 * Create a dataset from a finalized analyzer session.
 *
 * The single "session → dataset" path, shared by `gaia import attach` and
 * `gaia dataset create` so the two cannot disagree about the request shape.
 * Creating CONSUMES the server-side session — callers should persist the
 * returned collectionId before doing anything else that can fail.
 *
 * Returns `{ collectionId, name, collection }`.
 */
async function createCollectionFromSession({ importSessionId, name, description }) {
  const payload = {
    name,
    sources: [{ provider: 'file-upload', importSessionId }]
  };
  if (description) payload.description = description;

  const created = await http.post('/api/data/collections', payload);
  const collectionId = created?.collection?.collectionId || created?.collection?.id;
  if (!collectionId) throw fail('dataset created but no collectionId in response', 1);
  return {
    collectionId,
    name: created.collection.name || name,
    collection: created.collection
  };
}

/**
 * Map an expired/missing analyzer session onto actionable guidance. The server
 * returns 404 or 410; either way the session is gone and the only way forward
 * is starting over, so say that rather than surfacing a bare status.
 */
function isSessionGone(err) {
  return err?.status === 404 || err?.status === 410;
}

module.exports = {
  STATE_FILE,
  stateLocation,
  saveState,
  loadState,
  clearState,
  resolveSessionId,
  persistTurnResponse,
  startFileSession,
  startRowsSession,
  getSessionState,
  answerTurn,
  finalizeSession,
  cancelSession,
  createCollectionFromSession,
  isSessionGone,
};
