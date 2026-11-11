// A fake publik on 127.0.0.1 for the launch tests. It answers the three routes of the publik module
// (POST /api/v1/installs, GET /api/v1/wallet, POST /api/v1/telemetry) the way publikhq.com does and
// keeps every request. The app reaches it through PUBLIK_ORIGIN. Nothing here talks to publikhq.com.
//
//   const publik = await startFakePublik({ claimed: true });   // false: the wallet says "anonymous"
//   spawn(app, { env: { ...process.env, ...publik.env(dir) } });
//   publik.state.claimed = true;                               // the person signs in
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** The install key the fake publik gives out. Not a real key. */
export const FAKE_KEY = 'pk_live_ci0000000000_00000000000000000000000000000000';

export async function startFakePublik({ claimed = true } = {}) {
  const requests = [];
  const state = { claimed };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ t: Date.now(), method: req.method, url: req.url, headers: req.headers, body });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && req.url === '/api/v1/installs') {
        let installId = null;
        try { installId = JSON.parse(body).install_id; } catch {}
        return json(201, { key: FAKE_KEY, install_id: installId, base_url: `${origin}/api/v1`, claim_url: `${origin}/claim/ci`, claim_state: 'anonymous' });
      }
      if (req.method === 'GET' && req.url === '/api/v1/wallet') {
        return json(200, {
          claim_state: state.claimed ? 'claimed' : 'anonymous', claim_url: state.claimed ? null : `${origin}/claim/ci`,
          account: state.claimed ? { handle: 'ci' } : null, plan: { kind: 'none', label: null }, balance_micros: 0,
          top_up_url: `${origin}/wallet`, linked_at: null,
        });
      }
      if (req.method === 'POST' && req.url === '/api/v1/telemetry') { res.writeHead(204); return res.end(); }
      json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    state,
    server,
    /**
     * The environment for one app run: PUBLIK_ORIGIN, and a publik folder of its own under `dir`, so
     * the fake key never reaches this computer's real publik folder. On Windows only LOCALAPPDATA
     * moves (an Electron app whose profile has no AppData folders stops at once).
     */
    env(dir) {
      const local = path.join(dir, 'AppData', 'Local');
      const xdg = path.join(dir, '.config');
      for (const d of [local, xdg, path.join(dir, 'Library', 'Application Support')]) fs.mkdirSync(d, { recursive: true });
      return { PUBLIK_ORIGIN: origin, LOCALAPPDATA: local, XDG_CONFIG_HOME: xdg, ...(process.platform === 'win32' ? {} : { HOME: dir }) };
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A new empty folder for one run. */
export function runDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
