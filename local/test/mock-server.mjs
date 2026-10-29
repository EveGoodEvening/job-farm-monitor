// Minimal stand-in for `POST /api/ingest` used by the jfm-emit / install tests.
import http from 'node:http';

/**
 * @param {{ status?: number, delayMs?: number }} [opts]
 */
export async function startMockServer(opts = {}) {
  const state = {
    status: opts.status ?? 200,
    delayMs: opts.delayMs ?? 0,
    /** Optional per-request status: return a number to override `status`. */
    /** @type {((json: unknown, body: string) => number | undefined) | null} */
    decide: null,
    /** @type {{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string, json: unknown, status: number }[]} */
    requests: [],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const status = state.decide?.(json, body) ?? state.status;
      state.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, json, status });
      const reply = () => {
        const ok = status >= 200 && status < 300;
        const out = ok
          ? { accepted: Array.isArray(json) ? json.length : 1, ignored: 0, revision: state.requests.length }
          : { error: status === 401 ? 'unauthorized' : 'server_error' };
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      };
      if (state.delayMs > 0) setTimeout(reply, state.delayMs);
      else reply();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock server has no port');

  return {
    url: `http://127.0.0.1:${addr.port}`,
    state,
    /** Envelopes from requests the server accepted (2xx). */
    accepted() {
      return state.requests
        .filter((r) => r.status >= 200 && r.status < 300 && Array.isArray(r.json))
        .flatMap((r) => /** @type {unknown[]} */ (r.json));
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
