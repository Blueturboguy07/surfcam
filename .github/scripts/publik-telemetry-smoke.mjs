// Usage-count test for a packaged SurfCam build. It never talks to publik: the app is pointed at a
// listener on 127.0.0.1 (PUBLIK_TELEMETRY_URL), with Chromium's synthetic camera.
//
//   node .github/scripts/publik-telemetry-smoke.mjs <path to SurfCam binary> [extra app arguments...]
//
// Run 1 (usage counts on):  exactly one app_opened request must arrive within 20 s, and its JSON must
//                           match the publik telemetry v1 contract (slug, version of package.json, os).
// Run 2 (DO_NOT_TRACK=1):   no request may arrive in 15 s.
// In both runs the app must still be running at the end. PUBLIK_SMOKE_REPORT=<file> saves what arrived.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const bin = process.argv[2];
const appArgs = process.argv.slice(3);
if (!bin) { console.error('usage: publik-telemetry-smoke.mjs <binary> [app args]'); process.exit(2); }
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const OS_NAME = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    requests.push({ t: Date.now(), method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(204); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/api/v1/telemetry`;

function stopApp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

async function run(label, extraEnv, waitMs, until) {
  requests.length = 0;
  const env = { ...process.env, SURFCAM_FAKE_CAMERA: '1', PUBLIK_TELEMETRY_URL: url, PUBLIK_TELEMETRY_DEBUG: '1', ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const started = Date.now();
  const child = spawn(bin, appArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', exited = null;
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code, signal) => { exited = { code, signal, afterMs: Date.now() - started }; });
  child.on('error', (e) => { exited = { error: String(e), afterMs: Date.now() - started }; });
  while (Date.now() - started < waitMs && !exited && !until()) await sleep(200);
  if (!exited) await sleep(1500); // a second request, or an early crash, would show up here
  const aliveAtEnd = !exited;
  const exitedEarly = exited; // null when the app was still running
  const seen = requests.map((r) => ({ afterMs: r.t - started, method: r.method, url: r.url, headers: r.headers, body: r.body }));
  stopApp(child);
  await sleep(2500);
  const debugLines = stderr.split(/\r?\n/).filter((l) => l.includes('publik-telemetry:'));
  console.log(`[${label}] alive at end: ${aliveAtEnd}${exitedEarly ? ' ' + JSON.stringify(exitedEarly) : ''}; requests: ${seen.length}; debug: ${JSON.stringify(debugLines)}`);
  return { label, aliveAtEnd, exitedEarly, requests: seen, debugLines };
}

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails.push(what); };

// Run 1: usage counts on.
const on = await run('on', { DO_NOT_TRACK: undefined, PUBLIK_TELEMETRY: undefined, PUBLIK_API_KEY: undefined }, 20000, () => requests.length > 0);
check(on.aliveAtEnd, 'on: the app is still running');
check(on.requests.length === 1, `on: exactly one request arrived (got ${on.requests.length})`);
const r = on.requests[0];
if (r) {
  let body = {};
  try { body = JSON.parse(r.body); } catch {}
  check(r.method === 'POST' && r.url === '/api/v1/telemetry', `on: POST /api/v1/telemetry (got ${r.method} ${r.url})`);
  check(String(r.headers['content-type']).startsWith('application/json'), 'on: Content-Type is application/json');
  check(!('origin' in r.headers), 'on: no Origin header (native request)');
  check(!('authorization' in r.headers), 'on: no Authorization header (signed out)');
  check(body.v === 1, 'on: v is 1');
  check(body.app === 'surfcam', `on: app is "surfcam" (got ${JSON.stringify(body.app)})`);
  check(body.event === 'app_opened', `on: event is app_opened (got ${JSON.stringify(body.event)})`);
  check(body.app_version === pkg.version, `on: app_version is ${pkg.version} (got ${JSON.stringify(body.app_version)})`);
  check(body.os === OS_NAME, `on: os is ${OS_NAME} (got ${JSON.stringify(body.os)})`);
  check(['arm64', 'x64'].includes(body.arch), `on: arch is arm64 or x64 (got ${JSON.stringify(body.arch)})`);
  check(typeof body.install_id === 'string' && UUID4.test(body.install_id), 'on: install_id is a lowercase UUID v4');
  const extra = Object.keys(body).filter((k) => !['v', 'app', 'install_id', 'event', 'app_version', 'os', 'arch'].includes(k));
  check(extra.length === 0, `on: no other field (extra: ${JSON.stringify(extra)})`);
  check(Buffer.byteLength(r.body) <= 2048, 'on: body is at most 2 KB');
}

// Run 2: opted out.
const off = await run('off', { DO_NOT_TRACK: '1', PUBLIK_TELEMETRY: undefined, PUBLIK_API_KEY: undefined }, 15000, () => false);
check(off.aliveAtEnd, 'off: the app is still running');
check(off.requests.length === 0, `off: no request arrived with DO_NOT_TRACK=1 (got ${off.requests.length})`);

server.close();
const result = fails.length === 0 ? 'PASS' : 'FAIL';
if (process.env.PUBLIK_SMOKE_REPORT) {
  const report = { result, fails, binary: bin, platform: process.platform, arch: process.arch, expected_version: pkg.version, on, off };
  fs.writeFileSync(process.env.PUBLIK_SMOKE_REPORT, JSON.stringify(report, null, 1) + '\n');
}
console.log(`RESULT: ${result}`);
setTimeout(() => process.exit(fails.length === 0 ? 0 : 1), 300);
