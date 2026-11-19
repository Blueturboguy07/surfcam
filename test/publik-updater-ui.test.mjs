// The parts of publik-updater.cjs that run inside Electron: the check at launch, the check every 24 hours,
// the menu item "Check for Updates…" (macOS: the SurfCam menu; Windows: the Help menu) and the restart
// question. electron and electron-updater's autoUpdater are fakes here (Module._load), and node:test's mock
// timers stand in for setInterval and setTimeout. The live proof (.github/workflows/live-update-proof.yml)
// clicks the same menu item through the UI of the installed app.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const DAY = 24 * 60 * 60 * 1000;

let current = null; // the fakes of the running test
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (current && request === 'electron') return current.electron;
  if (request === 'electron-updater') {
    const real = realLoad.call(this, request, parent, isMain);
    return { CancellationToken: real.CancellationToken, get autoUpdater() { return current.updater; } };
  }
  return realLoad.call(this, request, parent, isMain);
};
const { startUpdates } = require('../publik-updater.cjs');

/** A fresh fake Electron app (packaged, version `version`) and autoUpdater. `answer` is the button index a dialog returns. */
function fakes({ version = '0.1.3', answer = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcam-updater-ui-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'surfcam', version }));
  fs.writeFileSync(path.join(dir, 'app-update.yml'), 'provider: generic\n');
  const f = { dir, dialogs: [], menu: null, installs: [] };
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.checkForUpdates = () => { updater.checks++; updater.emit('checking-for-update'); return Promise.resolve(null); };
  updater.setFeedURL = (o) => { updater.feed = o; };
  updater.quitAndInstall = (...a) => { f.installs.push(a); };
  f.updater = updater;
  f.electron = {
    app: { getName: () => 'SurfCam', getVersion: () => version, isPackaged: true, getAppPath: () => dir, getPath: () => dir },
    dialog: { showMessageBox: async (...a) => { const o = a[a.length - 1]; f.dialogs.push(o); return { response: o.buttons.length > 1 ? answer : 0 }; } },
    BrowserWindow: { getFocusedWindow: () => null },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: (m) => { f.menu = m; } },
    autoUpdater: new EventEmitter(), // Squirrel.Mac's own updater (macOS)
  };
  return f;
}

/** Runs `fn` as if on `platform`, with the fakes installed, PUBLIK_UPDATES as given, and mock timers on. */
async function on(platform, f, fn, { updates } = {}) {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const savedResources = process.resourcesPath;
  const savedEnv = { PUBLIK_UPDATES: process.env.PUBLIK_UPDATES, PUBLIK_UPDATER_TEST: process.env.PUBLIK_UPDATER_TEST };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  process.resourcesPath = f.dir;
  delete process.env.PUBLIK_UPDATER_TEST;
  if (updates === undefined) delete process.env.PUBLIK_UPDATES; else process.env.PUBLIK_UPDATES = updates;
  current = f;
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    await fn();
  } finally {
    mock.timers.reset();
    current = null;
    Object.defineProperty(process, 'platform', savedPlatform);
    process.resourcesPath = savedResources;
    for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
}
const settle = () => new Promise((r) => setImmediate(r));
const updateItem = (submenu) => submenu.find((i) => i.label === 'Check for Updates…');

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: the app checks at launch, then every 24 hours, silently`, async () => {
    const f = fakes();
    await on(platform, f, async () => {
      const u = startUpdates({ slug: 'surfcam', appName: 'SurfCam' });
      assert.equal(u.testHook, false);
      assert.equal(f.updater.feed.url, 'https://publikhq.com/api/updates/surfcam/');
      assert.equal(f.updater.checks, 1, 'one check at launch');
      f.updater.emit('update-not-available', { version: '0.1.3' });
      mock.timers.tick(DAY - 1);
      assert.equal(f.updater.checks, 1, 'nothing before 24 hours');
      mock.timers.tick(1);
      assert.equal(f.updater.checks, 2, 'the 24-hour check fired');
      f.updater.emit('update-not-available', { version: '0.1.3' });
      mock.timers.tick(DAY);
      assert.equal(f.updater.checks, 3, 'and again 24 hours later');
      f.updater.emit('error', Object.assign(new Error('offline'), { code: 'ERR_PUBLIK_FEED_FETCH' }));
      mock.timers.tick(DAY);
      assert.equal(f.updater.checks, 4, 'a failed check does not stop the next one');
      assert.equal(f.dialogs.length, 0, 'background checks show nothing');
    });
  });

  test(`${platform}: PUBLIK_UPDATES=0 stops the automatic checks; the menu item still works`, async () => {
    const f = fakes();
    await on(platform, f, async () => {
      startUpdates({ slug: 'surfcam', appName: 'SurfCam' });
      mock.timers.tick(3 * DAY);
      assert.equal(f.updater.checks, 0);
      const submenu = platform === 'darwin' ? f.menu[0].submenu : f.menu.find((m) => m.role === 'help').submenu;
      updateItem(submenu).click();
      assert.equal(f.updater.checks, 1);
    }, { updates: '0' });
  });

  test(`${platform}: "Check for Updates…" in the ${platform === 'darwin' ? 'SurfCam' : 'Help'} menu answers "You’re up to date." with the running version`, async () => {
    const f = fakes({ version: '0.1.4' });
    await on(platform, f, async () => {
      startUpdates({ slug: 'surfcam', appName: 'SurfCam' });
      f.updater.emit('update-not-available', { version: '0.1.4' }); // the launch check: silent
      assert.equal(f.dialogs.length, 0);
      const submenu = platform === 'darwin' ? f.menu[0].submenu : f.menu.find((m) => m.role === 'help').submenu;
      if (platform === 'darwin') assert.equal(f.menu[0].label, 'SurfCam');
      const item = updateItem(submenu);
      assert.ok(item, 'the menu has "Check for Updates…"');
      item.click();
      assert.equal(f.updater.checks, 2);
      f.updater.emit('update-not-available', { version: '0.1.4' });
      assert.equal(f.dialogs.length, 1);
      assert.equal(f.dialogs[0].message, 'You’re up to date.');
      assert.equal(f.dialogs[0].detail, 'SurfCam 0.1.4 is the newest version.');
    });
  });

  for (const [answer, label] of [[0, 'Restart Now'], [1, 'Later']]) {
    test(`${platform}: a downloaded update asks "Restart now?"; ${label} ${answer === 0 ? 'installs now' : 'leaves it for the quit'}`, async () => {
      const f = fakes({ answer });
      await on(platform, f, async () => {
        startUpdates({ slug: 'surfcam', appName: 'SurfCam' });
        f.updater.emit('update-available', { version: '0.1.4' });
        f.updater.emit('update-downloaded', { version: '0.1.4' });
        if (platform === 'darwin') {
          assert.equal(f.dialogs.length, 0, 'macOS asks only after Squirrel.Mac accepted the code signature');
          f.electron.autoUpdater.emit('update-downloaded');
        }
        assert.equal(f.dialogs.length, 1);
        assert.equal(f.dialogs[0].message, 'SurfCam 0.1.4 is ready to install.');
        assert.deepEqual(f.dialogs[0].buttons, ['Restart Now', 'Later']);
        await settle();
        await settle();
        assert.deepEqual(f.installs, answer === 0 ? [[true, true]] : []);
        assert.equal(f.updater.autoInstallOnAppQuit, true, 'Later: the update installs when the app quits');
        mock.timers.tick(DAY);
        assert.equal(f.updater.checks, 1, 'no new check while an update waits for the restart');
      });
    });
  }
}
