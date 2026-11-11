// Sign-in gate and usage-count test for a packaged SurfCam build. It never talks to publik: the app is
// pointed at a fake publik on 127.0.0.1 (test/fake-publik.mjs, through PUBLIK_ORIGIN), with Chromium's
// synthetic camera. The build must carry its own publik app token (the test does not give one).
//
//   node .github/scripts/publik-telemetry-smoke.mjs <path to SurfCam binary> [extra app arguments...]
//
// Run 1 (signed in, usage counts on): the gate asks POST /installs and GET /wallet, then exactly one
//                           app_opened arrives within 20 s with this computer's key, and its JSON
//                           matches the publik telemetry v1 contract (slug, version of package.json, os).
// Run 2 (signed in, DO_NOT_TRACK=1): the gate still runs, and no telemetry request arrives in 15 s.
// Run 3 (not signed in):    for 15 s the app waits at Sign in with publik: GET /wallet is asked again
//                           every 3 s, no app_opened arrives, and the game window never opens (no camera
//                           request, no HUD). Then the fake publik says "signed in": the app continues by
//                           itself, opens the game window and sends one app_opened.
// In every run the app must still be running at the end. PUBLIK_SMOKE_REPORT=<file> saves what arrived.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_KEY, runDir, startFakePublik } from '../../test/fake-publik.mjs';

const bin = process.argv[2];
const appArgs = process.argv.slice(3);
if (!bin) { console.error('usage: publik-telemetry-smoke.mjs <binary> [app args]'); process.exit(2); }
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const OS_NAME = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTelemetry = (r) => r.method === 'POST' && r.url === '/api/v1/telemetry';
const isWallet = (r) => r.method === 'GET' && r.url === '/api/v1/wallet';
const isInstalls = (r) => r.method === 'POST' && r.url === '/api/v1/installs';

function stopApp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

/**
 * One app run against a fresh fake publik and a fresh publik folder. `script(ctx)` decides how long
 * the run lasts; ctx has the fake publik, the app's output so far, the status file and `exited`.
 */
async function run(label, { claimed, extraEnv }, script) {
  const publik = await startFakePublik({ claimed });
  const dir = runDir(`surfcam-${label}-`);
  const statusFile = path.join(dir, 'status.json');
  const env = { ...process.env, ...publik.env(dir), SURFCAM_FAKE_CAMERA: '1', SURFCAM_STATUS: statusFile, PUBLIK_TELEMETRY_DEBUG: '1', ...extraEnv };
  for (const k of ['PUBLIK_SELF_TEST', 'PUBLIK_API_KEY', 'PUBLIK_APP_TOKEN', 'PUBLIK_TELEMETRY_URL']) delete env[k];
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const started = Date.now();
  const child = spawn(bin, appArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ctx = { publik, statusFile, started, stdout: '', stderr: '', exited: null };
  child.stdout.on('data', (d) => { ctx.stdout += d; });
  child.stderr.on('data', (d) => { ctx.stderr += d; });
  child.on('exit', (code, signal) => { ctx.exited = { code, signal, afterMs: Date.now() - started }; });
  child.on('error', (e) => { ctx.exited = { error: String(e), afterMs: Date.now() - started }; });
  const marks = await script(ctx);
  const aliveAtEnd = !ctx.exited;
  stopApp(child);
  await sleep(2500);
  await publik.close();
  const requests = publik.requests.map((r) => ({ afterMs: r.t - started, method: r.method, url: r.url, headers: r.headers, body: r.body }));
  const debugLines = ctx.stderr.split(/\r?\n/).filter((l) => l.includes('publik-telemetry:'));
  const appLines = ctx.stdout.split(/\r?\n/).filter((l) => l.startsWith('[surfcam]') || l.startsWith('[hud] camera'));
  console.log(`[${label}] alive at end: ${aliveAtEnd}${ctx.exited ? ' ' + JSON.stringify(ctx.exited) : ''}; requests: ${JSON.stringify(requests.map((r) => `${r.method} ${r.url} +${r.afterMs}ms`))}; debug: ${JSON.stringify(debugLines)}; app: ${JSON.stringify(appLines)}`);
  return { label, aliveAtEnd, exitedEarly: ctx.exited, requests, debugLines, appLines, marks };
}

/** The app's own first screen is up: its HUD window loaded, or the renderer wrote a status. */
const appWindowOpened = (ctx) => ctx.stdout.includes('[surfcam] HUD at') || ctx.stdout.includes('[hud] camera') || fs.existsSync(ctx.statusFile);

async function waitFor(ctx, ms, until) {
  const end = Date.now() + ms;
  while (Date.now() < end && !ctx.exited && !until()) await sleep(200);
}

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails.push(what); };

function checkAppOpened(label, r) {
  let body = {};
  try { body = JSON.parse(r.body); } catch {}
  check(String(r.headers['content-type']).startsWith('application/json'), `${label}: Content-Type is application/json`);
  check(!('origin' in r.headers), `${label}: no Origin header (native request)`);
  check(r.headers.authorization === `Bearer ${FAKE_KEY}`, `${label}: Authorization is this computer's publik key (signed in)`);
  check(body.v === 1, `${label}: v is 1`);
  check(body.app === 'surfcam', `${label}: app is "surfcam" (got ${JSON.stringify(body.app)})`);
  check(body.event === 'app_opened', `${label}: event is app_opened (got ${JSON.stringify(body.event)})`);
  check(body.app_version === pkg.version, `${label}: app_version is ${pkg.version} (got ${JSON.stringify(body.app_version)})`);
  check(body.os === OS_NAME, `${label}: os is ${OS_NAME} (got ${JSON.stringify(body.os)})`);
  check(['arm64', 'x64'].includes(body.arch), `${label}: arch is arm64 or x64 (got ${JSON.stringify(body.arch)})`);
  check(typeof body.install_id === 'string' && UUID4.test(body.install_id), `${label}: install_id is a lowercase UUID v4`);
  const extra = Object.keys(body).filter((k) => !['v', 'app', 'install_id', 'event', 'app_version', 'os', 'arch'].includes(k));
  check(extra.length === 0, `${label}: no other field (extra: ${JSON.stringify(extra)})`);
  check(Buffer.byteLength(r.body) <= 2048, `${label}: body is at most 2 KB`);
}

// Run 1: signed in, usage counts on.
const on = await run('on', { claimed: true, extraEnv: { DO_NOT_TRACK: undefined, PUBLIK_TELEMETRY: undefined } }, async (ctx) => {
  await waitFor(ctx, 20000, () => ctx.publik.requests.some(isTelemetry));
  if (!ctx.exited) await sleep(1500); // a second request, or an early crash, would show up here
});
check(on.aliveAtEnd, 'on: the app is still running');
check(on.requests.filter(isInstalls).length === 1, 'on: the gate asked POST /api/v1/installs once (a new computer)');
const installs = on.requests.find(isInstalls);
if (installs) {
  let b = {};
  try { b = JSON.parse(installs.body); } catch {}
  check(b.app_slug === 'surfcam' && b.app_version === pkg.version, `on: installs names surfcam ${pkg.version}`);
  check(typeof b.app_token === 'string' && b.app_token.startsWith('pat_'), 'on: installs carries the app token of this build');
}
check(on.requests.some(isWallet), 'on: the gate asked GET /api/v1/wallet');
const onEvents = on.requests.filter(isTelemetry);
check(onEvents.length === 1, `on: exactly one telemetry request arrived (got ${onEvents.length})`);
if (onEvents[0]) {
  const firstWallet = on.requests.find(isWallet);
  check(firstWallet && firstWallet.afterMs <= onEvents[0].afterMs, 'on: app_opened came after the wallet said "signed in"');
  checkAppOpened('on', onEvents[0]);
}

// Run 2: signed in, opted out.
const off = await run('off', { claimed: true, extraEnv: { DO_NOT_TRACK: '1', PUBLIK_TELEMETRY: undefined } }, async (ctx) => {
  await waitFor(ctx, 15000, () => false);
});
check(off.aliveAtEnd, 'off: the app is still running');
check(off.requests.some(isWallet), 'off: the gate still ran (GET /api/v1/wallet)');
check(off.requests.filter(isTelemetry).length === 0, `off: no telemetry request arrived with DO_NOT_TRACK=1 (got ${off.requests.filter(isTelemetry).length})`);

// Run 3: not signed in, then signed in.
const gate = await run('gate', { claimed: false, extraEnv: { DO_NOT_TRACK: undefined, PUBLIK_TELEMETRY: undefined } }, async (ctx) => {
  await waitFor(ctx, 15000, () => false);
  const before = {
    wallets: ctx.publik.requests.filter(isWallet).length,
    telemetry: ctx.publik.requests.filter(isTelemetry).length,
    appWindow: appWindowOpened(ctx),
    alive: !ctx.exited,
  };
  ctx.publik.state.claimed = true; // the person signs in in the browser
  const signedInAt = Date.now() - ctx.started;
  await waitFor(ctx, 30000, () => ctx.publik.requests.some(isTelemetry) && appWindowOpened(ctx));
  if (!ctx.exited) await sleep(1500);
  return { before, signedInAt, after: { telemetry: ctx.publik.requests.filter(isTelemetry).length, appWindow: appWindowOpened(ctx) } };
});
const g = gate.marks;
check(g.before.alive, 'gate: the app waits at Sign in with publik (still running after 15 s)');
check(g.before.wallets >= 3, `gate: GET /api/v1/wallet is asked again every 3 s while it waits (got ${g.before.wallets} in 15 s)`);
check(g.before.telemetry === 0, `gate: no telemetry before the sign-in (got ${g.before.telemetry})`);
check(!g.before.appWindow, 'gate: the game window did not open and the camera was not asked before the sign-in');
check(g.after.appWindow, 'gate: after the sign-in the app continued by itself and opened the game window');
check(g.after.telemetry === 1, `gate: one app_opened after the sign-in (got ${g.after.telemetry})`);
const gateEvent = gate.requests.find(isTelemetry);
if (gateEvent) {
  check(gateEvent.afterMs >= g.signedInAt, 'gate: app_opened came after the sign-in');
  checkAppOpened('gate', gateEvent);
}
check(gate.aliveAtEnd, 'gate: the app is still running');

const result = fails.length === 0 ? 'PASS' : 'FAIL';
if (process.env.PUBLIK_SMOKE_REPORT) {
  // The report is an artifact: the app token of the installs body and the key are replaced by "present".
  const body = (q) => {
    if (!isInstalls(q)) return q.body;
    try { const b = JSON.parse(q.body); return JSON.stringify({ ...b, app_token: b.app_token ? 'present' : null }); } catch { return '(not JSON)'; }
  };
  const strip = (r) => ({ ...r, requests: r.requests.map((q) => ({ ...q, body: body(q), headers: { ...q.headers, authorization: q.headers.authorization ? 'present' : undefined } })) });
  const report = { result, fails, binary: bin, platform: process.platform, arch: process.arch, expected_version: pkg.version, on: strip(on), off: strip(off), gate: strip(gate) };
  fs.writeFileSync(process.env.PUBLIK_SMOKE_REPORT, JSON.stringify(report, null, 1) + '\n');
}
console.log(`RESULT: ${result}`);
setTimeout(() => process.exit(fails.length === 0 ? 0 : 1), 300);
