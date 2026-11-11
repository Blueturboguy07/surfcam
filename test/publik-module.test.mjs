// The publik module (publik.cjs) in plain Node, against the fake publik of test/fake-publik.mjs with a
// scripted gate UI: the gate's words, the sign-in flow, the offline screen and the self-test line.
// No window, no camera and nothing that reaches publikhq.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FAKE_KEY, runDir, startFakePublik } from './fake-publik.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const FAKE_APP_TOKEN = 'pat_ci_fake_not_a_real_token';

// The module reads PUBLIK_ORIGIN when it loads: start the fake publik first.
const publik = await startFakePublik({ claimed: false });
const port = Number(new URL(publik.origin).port);
Object.assign(process.env, publik.env(runDir('surfcam-module-')), { PUBLIK_APP_TOKEN: FAKE_APP_TOKEN, PUBLIK_TELEMETRY_INTERVAL_SECONDS: '3600' });
for (const k of ['DO_NOT_TRACK', 'PUBLIK_TELEMETRY', 'PUBLIK_API_KEY', 'PUBLIK_SELF_TEST', 'PUBLIK_TELEMETRY_URL']) delete process.env[k];
const m = createRequire(import.meta.url)('../publik.cjs');

test.after(() => publik.close());

test('the module names SurfCam, its version and no AI', () => {
  assert.equal(m.APP_SLUG, 'surfcam');
  assert.equal(m.APP_VERSION, pkg.version);
  assert.equal(m.USES_AI, false);
  assert.equal(m.hasAppToken(), true);
});

test('the gate shows Sign in with publik until the wallet says signed in, then starts the usage counts', async () => {
  const shown = [], opened = [];
  const ui = {
    show(screen) {
      shown.push(screen);
      // The person presses the button once; the browser sign-in then finishes 1 s later.
      if (shown.length === 1) { setTimeout(() => { publik.state.claimed = true; }, 1000); return Promise.resolve('sign_in'); }
      return new Promise(() => {}); // the poll ends this screen
    },
    openUrl(url) { opened.push(url); },
  };
  const gate = await m.ensureSignedIn(ui);
  assert.equal(gate.key, FAKE_KEY);
  assert.equal(gate.choice, null);
  assert.equal(gate.wallet.claim_state, 'claimed');
  assert.deepEqual(shown.map((s) => s.id), ['sign_in', 'sign_in']);
  assert.equal(shown[0].title, 'Sign in with publik');
  assert.equal(shown[0].body, 'This app uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in.');
  assert.deepEqual(shown[0].buttons, [{ action: 'sign_in', label: 'Sign in with publik' }]);
  assert.equal(shown[1].note, 'Waiting for you to sign in in your browser.');
  assert.deepEqual(opened, [`${publik.origin}/claim/ci`]);
  assert.ok(!shown.some((s) => s.id === 'choose'), 'no plan screen: SurfCam uses no AI');

  const install = publik.requests.find((r) => r.url === '/api/v1/installs');
  const body = JSON.parse(install.body);
  assert.equal(body.app_slug, 'surfcam');
  assert.equal(body.app_version, pkg.version);
  assert.equal(body.app_token, FAKE_APP_TOKEN);
  const cred = JSON.parse(fs.readFileSync(m.credentialPath(), 'utf8'));
  assert.equal(cred.key, FAKE_KEY);
  if (process.platform !== 'win32') assert.equal(fs.statSync(m.credentialPath()).mode & 0o777, 0o600);

  for (let i = 0; i < 50 && !publik.requests.some((r) => r.url === '/api/v1/telemetry'); i++) await new Promise((r) => setTimeout(r, 100));
  const events = publik.requests.filter((r) => r.url === '/api/v1/telemetry');
  assert.equal(events.length, 1);
  assert.equal(events[0].headers.authorization, `Bearer ${FAKE_KEY}`);
  const event = JSON.parse(events[0].body);
  assert.equal(event.app, 'surfcam');
  assert.equal(event.event, 'app_opened');
  assert.equal(event.app_version, pkg.version);
});

test('offline: "publik is not reachable. Check your connection." with Retry, and Retry continues', async () => {
  await publik.close();
  const shown = [];
  const ui = {
    async show(screen) {
      shown.push(screen);
      await new Promise((resolve) => publik.server.listen(port, '127.0.0.1', resolve)); // the connection is back
      return 'retry';
    },
    openUrl() {},
  };
  const gate = await m.ensureSignedIn(ui);
  assert.equal(gate.wallet.claim_state, 'claimed');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].id, 'unreachable');
  assert.equal(shown[0].title, 'Sign in with publik');
  assert.equal(shown[0].body, 'publik is not reachable. Check your connection.');
  assert.deepEqual(shown[0].buttons, [{ action: 'retry', label: 'Retry' }]);
});

test('PUBLIK_SELF_TEST=1 prints the self-test line after a real GET /wallet and exits 0', async () => {
  // Not execFileSync: the fake publik runs in this process and must answer while the child waits.
  const env = { ...process.env, ...publik.env(runDir('surfcam-self-test-')), PUBLIK_SELF_TEST: '1' };
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'require(process.argv[1]).ensureSignedIn()', path.join(root, 'publik.cjs')], { env, encoding: 'utf8' });
  assert.equal(stdout.trim(), `publik self-test: ok surfcam ${pkg.version}`);
});
