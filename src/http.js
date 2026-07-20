const credentials = require('./credentials');

class HttpError extends Error {
  constructor(status, body) {
    super(HttpError.messageFor(status, body));
    this.status = status;
    this.body = body;
    this.exitCode = status >= 500 ? 1 : 3;
  }

  /**
   * A bare "billing required" tells an agent nothing it can act on, and 402 is
   * the one status a scripted sync will hit through no fault of its payload.
   * Spell out the account state so the next step is obvious.
   */
  static messageFor(status, body) {
    if (status === 402) {
      const reason = body?.reason ? String(body.reason).replace(/_/g, ' ') : 'inactive';
      return `subscription required — this account's billing is ${reason}. `
        + 'Resolve it at /billing, then re-run.';
    }
    return body?.error || `HTTP ${status}`;
  }
}

/** Shared response handling: parse, then map non-2xx onto HttpError. */
async function readResponse(response, url) {
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = { raw: text }; }
  }
  if (!response.ok) throw new HttpError(response.status, parsed);
  return parsed;
}

function unreachable(url, err) {
  const wrapped = new Error(`could not reach ${url}: ${err.message}`);
  wrapped.exitCode = 1;
  return wrapped;
}

async function request(method, urlPath, { body } = {}) {
  const { apiKey, apiBase } = credentials.requireAuth();
  const url = apiBase.replace(/\/$/, '') + urlPath;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw unreachable(url, err);
  }
  return readResponse(response, url);
}

/**
 * POST a file as multipart/form-data.
 *
 * The JSON helper above can't express this, so every caller used to hand-roll
 * the FormData + Blob + bearer + error-mapping dance. Centralized here so the
 * 402 handling and error shapes stay identical to the JSON path.
 *
 * `fields` are extra string form fields sent alongside the file.
 */
async function postMultipart(urlPath, { buffer, fileName, fields = {} } = {}) {
  const { apiKey, apiBase } = credentials.requireAuth();
  const url = apiBase.replace(/\/$/, '') + urlPath;

  const form = new FormData();
  form.append('file', new Blob([buffer]), fileName);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }

  let response;
  try {
    // No Content-Type header — fetch sets it with the multipart boundary.
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
  } catch (err) {
    throw unreachable(url, err);
  }
  return readResponse(response, url);
}

module.exports = {
  request,
  get: (p) => request('GET', p),
  post: (p, body) => request('POST', p, { body }),
  delete: (p) => request('DELETE', p),
  postMultipart,
  HttpError
};
