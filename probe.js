// Verification-only. Enabled with SURFCAM_PROBE=1. After the Poki webview has loaded, it lists the
// frames, injects a keydown counter into the game iframe (cross-origin is fine from the main
// process), sends one synthetic ArrowLeft through the same path the HUD uses, and logs the count.
const { webContents } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  await sleep(15000);
  const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('poki.com'));
  if (!wc) return console.log('[probe] no poki webContents');
  const frames = wc.mainFrame.framesInSubtree;
  console.log('[probe] frames:', frames.map((f) => f.url).filter(Boolean).map((u) => u.slice(0, 90)));
  const gameFrame = frames.find((f) => f !== wc.mainFrame && /poki|game/.test(f.url) && !/ads|doubleclick|google/.test(f.url)) || wc.mainFrame;
  console.log('[probe] game frame:', gameFrame.url.slice(0, 120));
  await gameFrame.executeJavaScript(`window.__surfKeys = []; window.addEventListener('keydown', (e) => window.__surfKeys.push(e.key + ':' + e.keyCode + ':' + e.isTrusted), true); 'listener installed'`, true).then((r) => console.log('[probe]', r));
  // make sure focus is inside the game frame, like the HUD's "Focus game" button does
  await wc.mainFrame.executeJavaScript(`(() => { const f = document.querySelector('iframe'); if (f) f.focus(); return document.activeElement && document.activeElement.tagName; })()`, true).then((r) => console.log('[probe] activeElement after focus:', r));
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Left' }); await sleep(40); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Up' }); await sleep(40); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
  await sleep(300);
  const got = await gameFrame.executeJavaScript('JSON.stringify(window.__surfKeys)', true);
  console.log('[probe] keydowns seen inside game frame:', got);
}
module.exports = { probe };
