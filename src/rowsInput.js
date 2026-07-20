const fs = require('fs');
const path = require('path');
const { fail } = require('./util');

const SPREADSHEET_EXTS = new Set(['.xlsx', '.xls', '.csv']);
const MAX_BYTES = 50 * 1024 * 1024; // matches the server's multipart + JSON ceiling

/**
 * Read stdin to completion. Used for `-`, which is the shape that makes a
 * collector script a one-liner:  node collect.js | gaia dataset sync <id> -
 */
function readStdin() {
  try {
    return fs.readFileSync(0);
  } catch (err) {
    throw fail(`could not read stdin: ${err.message}`, 1);
  }
}

/**
 * Classify an <input> argument without reading it.
 *   '-'                  → stdin, JSON
 *   *.json               → file, JSON
 *   *.csv|*.xlsx|*.xls   → file, spreadsheet (multipart)
 *
 * The transport follows from the extension because the two server paths differ:
 * JSON goes to /ingest, spreadsheets to /reupload-file. Both are equivalent as
 * far as the dataset is concerned — see `gaia dataset schema`.
 */
function classifyInput(input) {
  if (input === '-') return { kind: 'json', source: 'stdin', fileName: 'rows.json' };
  const abs = path.resolve(input);
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') return { kind: 'json', source: 'file', path: abs, fileName: path.basename(abs) };
  if (SPREADSHEET_EXTS.has(ext)) {
    return { kind: 'spreadsheet', source: 'file', path: abs, fileName: path.basename(abs) };
  }
  throw fail(
    `unsupported input "${input}" — expected '-' (JSON on stdin), a .json file, `
    + 'or a .csv/.xlsx/.xls file',
  );
}

/** Read the bytes for a classified input, enforcing the size ceiling. */
function readInput(spec) {
  let buffer;
  if (spec.source === 'stdin') {
    buffer = readStdin();
    if (buffer.length === 0) {
      throw fail('no data on stdin — pipe JSON in, or pass a file path instead of \'-\'');
    }
  } else {
    if (!fs.existsSync(spec.path)) throw fail(`file not found: ${spec.path}`);
    buffer = fs.readFileSync(spec.path);
  }
  if (buffer.length > MAX_BYTES) {
    throw fail(
      `input is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — the ceiling is 50 MB. `
      + 'Split the dataset across multiple sources, or reduce what you collect.',
    );
  }
  return buffer;
}

/**
 * Parse a JSON payload into the canonical `{ sheetName: rows[] }` shape.
 *
 * Accepts a bare array (the common single-entity case) or an explicit
 * `{ sheets: { name: [...] } }`. A bare array is left unkeyed here — the caller
 * resolves the sheet name from the dataset's saved fingerprint, which is what
 * lets a collector stay ignorant of the storage format's sheet naming.
 */
function parseJsonRows(buffer, input) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw fail(`${input} is not valid JSON: ${err.message}`);
  }

  if (Array.isArray(parsed)) return { rows: parsed, sheets: null };
  if (parsed && typeof parsed === 'object' && parsed.sheets && typeof parsed.sheets === 'object') {
    return { rows: null, sheets: parsed.sheets };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows)) {
    return { rows: parsed.rows, sheets: null };
  }
  throw fail(
    `${input} must be a JSON array of row objects, or { "sheets": { "<name>": [...] } } — `
    + `got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
  );
}

/**
 * Collect the values of one key across a payload, for the primary-key overlap
 * guard. Returns a Set of STRINGS, because `_id` derives from String(pkValue) —
 * comparing anything else would miss exactly the coercion mismatches the guard
 * exists to catch.
 */
function primaryKeyValues(payload, keyName) {
  const out = new Set();
  const collect = (rows) => {
    for (const row of rows || []) {
      if (!row || typeof row !== 'object') continue;
      const v = row[keyName];
      if (v === undefined || v === null || v === '') continue;
      out.add(String(v));
    }
  };
  if (payload.rows) collect(payload.rows);
  if (payload.sheets) for (const rows of Object.values(payload.sheets)) collect(rows);
  return out;
}

/** Total row count across a payload, for reporting. */
function countRows(payload) {
  if (payload.rows) return payload.rows.length;
  if (payload.sheets) {
    return Object.values(payload.sheets)
      .reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
  }
  return 0;
}

module.exports = {
  classifyInput,
  readInput,
  parseJsonRows,
  primaryKeyValues,
  countRows,
  MAX_BYTES,
};
