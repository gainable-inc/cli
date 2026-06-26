const credentials = require('./credentials');

class HttpError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.exitCode = status >= 500 ? 1 : 3;
  }
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
    const wrapped = new Error(`could not reach ${url}: ${err.message}`);
    wrapped.exitCode = 1;
    throw wrapped;
  }
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = { raw: text }; }
  }
  if (!response.ok) throw new HttpError(response.status, parsed);
  return parsed;
}

module.exports = {
  request,
  get: (p) => request('GET', p),
  post: (p, body) => request('POST', p, { body }),
  delete: (p) => request('DELETE', p),
  HttpError
};
