// SurfCam main process: serves the HUD page locally (so MediaPipe wasm + model load over http),
// opens one window whose page hosts a <webview> with Poki's Subway Surfers, and exposes a few
// IPC helpers used for verification (frame listing, eval inside the game iframe, status file).
const { app, BrowserWindow, session, systemPreferences, ipcMain, webContents } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json',
  '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const STATUS_FILE = process.env.SURFCAM_STATUS ? path.resolve(process.env.SURFCAM_STATUS) : null;
const TRACE_FILE = process.env.SURFCAM_TRACE ? path.resolve(process.env.SURFCAM_TRACE) : null;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p, u;
      try { u = new URL(req.url, 'http://x'); p = decodeURIComponent(u.pathname); } catch { res.writeHead(400); return res.end(); }
      if (p === '/__cmd') return handleCmd(u, res);
      if (p === '/') p = '/renderer/index.html';
      const f = path.normalize(path.join(ROOT, p));
      if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

// Dev/verification endpoint, loopback only: /__cmd?key=Up  |  /__cmd?probe=1  |  /__cmd?eval=<js>&frame=games.poki
async function handleCmd(u, res) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('poki.com'));
    if (!wc) return reply(500, { error: 'no poki webContents' });
    if (u.searchParams.get('focus')) { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); app.focus({ steal: true }); } return reply(200, { focused: true }); }
    const click = u.searchParams.get('click'); // fractions of the webview viewport, e.g. click=0.5,0.6
    if (click) {
      const [fx, fy] = click.split(',').map(Number);
      const size = await wc.executeJavaScript('({w: innerWidth, h: innerHeight})', true);
      const x = Math.round(fx * size.w), y = Math.round(fy * size.h);
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 60));
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return reply(200, { clicked: [x, y], viewport: size });
    }
    const hostkey = u.searchParams.get('hostkey'); // press a key in the HUD page itself (dev)
    if (hostkey) { const w = BrowserWindow.getAllWindows()[0]; w.webContents.sendInputEvent({ type: 'keyDown', keyCode: hostkey }); await new Promise((r) => setTimeout(r, 40)); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: hostkey }); return reply(200, { hostkey }); }
    const key = u.searchParams.get('key');
    if (key) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: key });
      await new Promise((r) => setTimeout(r, 40));
      wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      return reply(200, { sent: key, t: Date.now() });
    }
    const frameMatch = u.searchParams.get('frame') || 'games.poki';
    const frame = wc.mainFrame.framesInSubtree.find((f) => f.url.includes(frameMatch));
    if (u.searchParams.get('probe')) {
      if (!frame) return reply(500, { error: 'no game frame' });
      const r = await frame.executeJavaScript(`(() => { if (!window.__surfKeys) { window.__surfKeys = []; window.addEventListener('keydown', (e) => window.__surfKeys.push({key:e.key, code:e.code, keyCode:e.keyCode, trusted:e.isTrusted, t:Date.now(), target:e.target && e.target.tagName, active: document.activeElement && document.activeElement.tagName}), true); } return JSON.stringify({ installed: true, seen: window.__surfKeys, active: document.activeElement && document.activeElement.tagName, canvases: document.querySelectorAll('canvas').length, hasUnity: !!(window.unityInstance || window.gameInstance || window.Module) }); })()`, true);
      return reply(200, JSON.parse(r));
    }
    const code = u.searchParams.get('eval');
    if (code) { const r = await (frame || wc.mainFrame).executeJavaScript(code, true); return reply(200, { result: r }); }
    return reply(400, { error: 'unknown cmd' });
  } catch (e) { return reply(500, { error: String(e) }); }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    const ok = await systemPreferences.askForMediaAccess('camera');
    console.log('[surfcam] camera access granted:', ok);
  }
  const allow = (perms) => (_wc, permission, cb) => cb(perms.includes(permission));
  session.defaultSession.setPermissionRequestHandler(allow(['media', 'fullscreen', 'pointerLock']));
  session.fromPartition('persist:poki').setPermissionRequestHandler(allow(['fullscreen', 'pointerLock']));

  const port = await serve();
  const win = new BrowserWindow({
    width: 1280, height: 900, title: 'SurfCam', backgroundColor: '#000',
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js') },
  });
  win.loadURL(`http://127.0.0.1:${port}/renderer/index.html`);
  win.on('closed', () => app.quit());
  console.log('[surfcam] HUD at http://127.0.0.1:' + port);
  if (process.env.SURFCAM_PROBE) require('./probe').probe().catch((e) => console.log('[probe] failed', String(e)));
});

ipcMain.on('log', (_e, ...a) => console.log('[hud]', ...a));
ipcMain.on('trace', (_e, rows) => { if (TRACE_FILE && rows.length) fs.appendFile(TRACE_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', () => {}); });
ipcMain.on('status', (_e, s) => { if (STATUS_FILE) fs.writeFile(STATUS_FILE, JSON.stringify(s, null, 1), () => {}); });

// List every frame inside the game webview (url only), so we can find the Unity iframe.
ipcMain.handle('game-frames', (_e, wcId) => {
  const wc = webContents.fromId(wcId);
  if (!wc) return [];
  return wc.mainFrame.framesInSubtree.map((f) => ({ url: f.url, top: f === wc.mainFrame }));
});
// Run JS inside the first frame whose url contains `match` (defaults to the top frame).
ipcMain.handle('game-eval', async (_e, { wcId, match, code }) => {
  const wc = webContents.fromId(wcId);
  if (!wc) throw new Error('no webContents ' + wcId);
  const frame = match ? wc.mainFrame.framesInSubtree.find((f) => f.url.includes(match)) : wc.mainFrame;
  if (!frame) throw new Error('no frame matching ' + match);
  return frame.executeJavaScript(code, true);
});

app.on('window-all-closed', () => app.quit());
