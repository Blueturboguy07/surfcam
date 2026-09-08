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

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
      if (p === '/') p = '/renderer/index.html';
      const f = path.normalize(path.join(ROOT, p));
      if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
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
