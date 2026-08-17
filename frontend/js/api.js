// Thin wrapper around the backend REST API.
// The session token lives in memory only; a reload means logging in again,
// which is the right default for a tool holding switch credentials.

export const state = {
  token: null,
  host: null,
  system: null,
  caps: {},
  hostKey: null,
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = {};
  if (state.token) headers['X-Session'] = state.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(`Backend unreachable: ${err.message}`, 0);
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: text };
    }
  }
  if (!res.ok) {
    throw new ApiError(payload?.detail || `HTTP ${res.status}`, res.status);
  }
  return payload;
}

export const api = {
  connect: (payload) => request('POST', '/api/connect', payload),
  disconnect: () => request('POST', '/api/disconnect'),
  status: () => request('GET', '/api/status'),
  data: (section) => request('GET', `/api/data/${section}`),
  probe: () => request('POST', '/api/probe'),
  plan: (intent, payload) => request('POST', '/api/plan', { intent, payload }),
  apply: (commands, save = false, execLevel = false) =>
    request('POST', '/api/apply', { commands, save, exec_level: execLevel }),
  exec: (command, timeout = 60) => request('POST', '/api/exec', { command, timeout }),
  showCmd: (command, timeout = 60) => request('POST', '/api/show', { command, timeout }),
  save: () => request('POST', '/api/save'),
  uploadConfig: (lines, save = false) =>
    request('POST', '/api/config/upload', { lines, save }),
  downloadConfigUrl: () => '/api/config/download',
};

export { ApiError };
