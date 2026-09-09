import { FilesetResolver, PoseLandmarker } from '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
import { PoseController, LM } from './pose-logic.mjs';

const $ = (id) => document.getElementById(id);
const game = $('game'), video = $('video'), cam = $('cam'), ctx = cam.getContext('2d');
const statusEl = $('status'), flashEl = $('flash'), laneSpans = [...document.querySelectorAll('#lane-strip span')];
const log = (...a) => { console.log(...a); window.surf?.log(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- output layer. Temporary: synthesized keystrokes into the Poki webview. ----------
// Swap this object for a direct game binding once the game is ours.
class KeystrokeOutput {
  constructor(view) { this.view = view; this.sent = 0; }
  async tap(keyCode) {
    await this.view.sendInputEvent({ type: 'keyDown', keyCode });
    await sleep(40);
    await this.view.sendInputEvent({ type: 'keyUp', keyCode });
    this.sent++;
    this.last = keyCode;
  }
  left() { return this.tap('Left'); }
  right() { return this.tap('Right'); }
  jump() { return this.tap('Up'); }
  duck() { return this.tap('Down'); }
}
const out = new KeystrokeOutput(game);

// ---------- state ----------
const ctrl = new PoseController();
const CONFIGURED = { laneCenterHalf: 1 / 6, jumpScale: 0.25, duckScale: 0.5, keysOn: true, gameOnly: true, camVisible: true };
let keysOn = true, camVisible = true;
let gameLane = 1, desiredLane = 1, movingLane = false;
let fps = 0, frames = 0, fpsT = performance.now();
let lastEvent = '', lastEventT = 0, tracking = false, modelReady = false;
let lostCount = 0, wasTracking = false, traceRows = [], lastTraceT = 0, lastThresholds = null;

async function syncLane() {
  if (movingLane) return;
  movingLane = true;
  try {
    while (keysOn && gameLane !== desiredLane) {
      if (desiredLane > gameLane) { await out.right(); gameLane++; } else { await out.left(); gameLane--; }
      await sleep(100);
    }
  } finally { movingLane = false; }
}
function onEvent(ev, m) {
  lastEvent = ev; lastEventT = performance.now();
  log('EVENT', ev, JSON.stringify({ hipLift: m?.hipLift, noseLift: m?.noseLift, feetLift: m?.feetLift, jumpSignal: m?.jumpSignal, noseDrop: m?.noseDrop, torso: m?.torso, anklesOk: m?.anklesOk }));
  flashEl.textContent = ev.toUpperCase(); flashEl.className = ev;
  setTimeout(() => { if (performance.now() - lastEventT > 350) flashEl.className = ''; }, 400);
  if (!keysOn) return;
  if (ev === 'jump') out.jump(); else if (ev === 'duck') out.duck();
}

// ---------- game webview helpers ----------
async function focusGame() {
  try {
    const r = await game.executeJavaScript(`(() => {
      const f = document.querySelector('iframe[src*="poki"], iframe[src*="game"], iframe');
      if (f) { f.focus(); return f.src; }
      return null;
    })()`);
    log('focusGame ->', r);
  } catch (e) { log('focusGame failed', String(e)); }
}
// ---------- game-only mode: hide everything on the Poki page except the game iframe and pin it
// to the full viewport. Same thing as deleting every other node in the inspector, done with
// visibility so the iframe is never reparented (reparenting an iframe reloads it).
const GAME_ONLY_CSS = `
  html, body { overflow: hidden !important; background: #000 !important; }
  body * { visibility: hidden !important; }
  #game-element { visibility: visible !important; position: fixed !important; left: 0 !important; top: 0 !important;
    width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; border: 0 !important; margin: 0 !important; }
`;
let gameOnly = true, gameOnlyKey = null;
async function applyGameOnly() {
  try {
    if (gameOnlyKey) { await game.removeInsertedCSS(gameOnlyKey); gameOnlyKey = null; }
    if (gameOnly) gameOnlyKey = await game.insertCSS(GAME_ONLY_CSS);
  } catch (e) { log('game-only css failed', String(e)); }
}
game.addEventListener('dom-ready', () => { log('game dom-ready', game.getURL()); gameOnlyKey = null; applyGameOnly(); });
game.addEventListener('did-navigate-in-page', () => applyGameOnly());
game.addEventListener('did-navigate', (e) => log('game navigated', e.url));

// ---------- buttons ----------
$('btnKeys').onclick = () => { keysOn = !keysOn; $('btnKeys').textContent = 'Keys ' + (keysOn ? 'ON' : 'OFF'); $('btnKeys').className = keysOn ? 'on' : 'off'; };
$('btnCenter').onclick = () => { gameLane = 1; desiredLane = ctrl.lane; syncLane(); };
$('btnFocus').onclick = focusGame;
const setLaneWidth = (delta) => { const v = ctrl.setLaneCenterHalf(ctrl.o.laneCenterHalf + delta); $('btnLaneN').textContent = `Lanes ${Math.round(v * 200)}% ▸ narrower`; try { localStorage.setItem('laneCenterHalf', v); } catch {} };
$('btnLaneN').onclick = () => setLaneWidth(-0.02);
$('btnLaneW').onclick = () => setLaneWidth(+0.02);
try { const v = parseFloat(localStorage.getItem('laneCenterHalf')); if (Number.isFinite(v)) { ctrl.setLaneCenterHalf(v); setLaneWidth(0); } } catch {}
const setJump = (delta) => { const v = ctrl.setJumpScale(ctrl.o.jumpScale + delta); $('btnJumpLess').textContent = `Jump ${Math.round(v * 100)}% ▸ less`; try { localStorage.setItem('jumpScale', v); } catch {} };
const setDuck = (delta) => { const v = ctrl.setDuckScale(ctrl.o.duckScale + delta); $('btnDuckLess').textContent = `Duck ${Math.round(v * 100)}% ▸ less`; try { localStorage.setItem('duckScale', v); } catch {} };
$('btnJumpLess').onclick = () => setJump(-0.05); $('btnJumpMore').onclick = () => setJump(+0.05);
$('btnDuckLess').onclick = () => setDuck(-0.1); $('btnDuckMore').onclick = () => setDuck(+0.1);
try { const j = parseFloat(localStorage.getItem('jumpScale')); if (Number.isFinite(j)) ctrl.setJumpScale(j); const d = parseFloat(localStorage.getItem('duckScale')); if (Number.isFinite(d)) ctrl.setDuckScale(d); } catch {}
setJump(0); setDuck(0);
$('btnGameOnly').onclick = () => { gameOnly = !gameOnly; $('btnGameOnly').textContent = 'Game only: ' + (gameOnly ? 'ON' : 'OFF'); $('btnGameOnly').className = gameOnly ? 'on' : ''; applyGameOnly(); };
$('btnFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); };
$('btnCam').onclick = () => { camVisible = !camVisible; cam.classList.toggle('hidden', !camVisible); $('btnCam').textContent = camVisible ? 'Cam' : 'Cam off'; };
// ---------- manual test controls: same output layer the detector uses ----------
const manual = {
  left: () => { out.left(); gameLane = Math.max(0, gameLane - 1); flash('◀ LEFT'); },
  right: () => { out.right(); gameLane = Math.min(2, gameLane + 1); flash('RIGHT ▶'); },
  jump: () => { out.jump(); flash('▲ JUMP (manual)'); },
  duck: () => { out.duck(); flash('▼ DUCK (manual)'); },
  start: () => { out.tap('Space'); flash('SPACE (start / hoverboard)'); },
};
function flash(text, cls = 'manual') {
  flashEl.textContent = text; flashEl.className = cls;
  const at = performance.now(); lastEventT = at;
  setTimeout(() => { if (performance.now() - lastEventT > 350) flashEl.className = ''; }, 400);
}
$('btnStart').onclick = manual.start; $('btnLeft').onclick = manual.left; $('btnRight').onclick = manual.right; $('btnUp').onclick = manual.jump; $('btnDown').onclick = manual.duck;
$('btnSettings').onclick = () => { const p = $('settings'); p.hidden = !p.hidden; $('btnSettings').className = p.hidden ? '' : 'on'; };
$('btnReset').onclick = () => {
  try { for (const k of ['laneCenterHalf', 'jumpScale', 'duckScale']) localStorage.removeItem(k); } catch {}
  ctrl.setLaneCenterHalf(CONFIGURED.laneCenterHalf); setLaneWidth(0);
  ctrl.setJumpScale(CONFIGURED.jumpScale); setJump(0);
  ctrl.setDuckScale(CONFIGURED.duckScale); setDuck(0);
  if (keysOn !== CONFIGURED.keysOn) $('btnKeys').click();
  if (gameOnly !== CONFIGURED.gameOnly) $('btnGameOnly').click();
  if (camVisible !== CONFIGURED.camVisible) $('btnCam').click();
  gameLane = 1; desiredLane = ctrl.lane;
  flash('RESET TO DEFAULTS');
  log('settings reset to defaults');
};
window.addEventListener('keydown', (e) => {
  if (e.key === 'k') $('btnKeys').click();
  if (e.key === 'c') $('btnCenter').click();
  if (e.key === 'f') focusGame();
  if (e.key === 'h') document.getElementById('hud').classList.toggle('collapsed');
  if (e.key === 's' && !e.metaKey) { $('btnSettings').click(); return; }
  if (e.key === ' ') { e.preventDefault(); manual.start(); }
  const map = { ArrowLeft: manual.left, ArrowRight: manual.right, ArrowUp: manual.jump, ArrowDown: manual.duck, a: manual.left, d: manual.right, w: manual.jump };
  if (map[e.key]) { e.preventDefault(); map[e.key](); }
});

// ---------- drawing ----------
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
function draw(landmarks, lane, m) {
  const w = cam.width, h = cam.height;
  const [b1, b2] = m?.laneBands ?? [1 / 3, 2 / 3];
  const edges = [0, b1, b2, 1];
  ctx.save();
  ctx.translate(w, 0); ctx.scale(-1, 1);           // mirror so the player sees a mirror
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
  // lane bands (already in mirrored space: left band = player's left)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === lane ? 'rgba(52,211,153,.28)' : 'rgba(255,255,255,.06)';
    ctx.fillRect(edges[i] * w, 0, (edges[i + 1] - edges[i]) * w, h);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(b1 * w, 0); ctx.lineTo(b1 * w, h); ctx.moveTo(b2 * w, 0); ctx.lineTo(b2 * w, h); ctx.stroke();
  if (!landmarks) return;
  // torso polygon + its centre: this dot is what picks the lane
  const Q = (i) => [(1 - landmarks[i].x) * w, landmarks[i].y * h];
  ctx.fillStyle = 'rgba(96,165,250,.25)'; ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [k, i] of [LM.L_SHOULDER, LM.R_SHOULDER, LM.R_HIP, LM.L_HIP].entries()) { const [x, y] = Q(i); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  if (m?.torsoCenter) {
    const cx = (1 - m.torsoCenter.x) * w, cy = m.torsoCenter.y * h;
    ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, 7); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(251,191,36,.8)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  }
  const P = (i) => [(1 - landmarks[i].x) * w, landmarks[i].y * h];
  ctx.strokeStyle = '#34d399'; ctx.lineWidth = 2;
  for (const [a, b] of BONES) { const [ax, ay] = P(a), [bx, by] = P(b); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
  for (const i of [LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP, LM.L_ANKLE, LM.R_ANKLE]) {
    const [x, y] = P(i); ctx.fillStyle = (landmarks[i].visibility ?? 1) > 0.5 ? '#fff' : '#f87171'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
  }
}
function setStatus(m, res) {
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  laneSpans.forEach((s, i) => s.classList.toggle('active', i === (res?.lane ?? 1)));
  statusEl.textContent = [
    `${modelReady ? '' : 'loading… '}${fps}fps ${tracking ? 'TRACK' : 'no person'}${res?.ready ? '' : tracking ? ' (cal)' : ''} ${lastThresholds?.mode?.includes('hidden') ? 'feet hidden' : 'feet ok'} lost ${lostCount}`,
    `lane ${['L', 'C', 'R'][res?.lane ?? 1]}  dot ${f(m?.xm)}  keys ${keysOn ? 'ON' : 'OFF'}  sent ${out.sent}  ${lastEvent || ''}`,
    `jump ${f(m?.jumpSignal)}/${f(lastThresholds?.jump)} rise ${f(m?.hipVel, 1)}/${f(lastThresholds?.velocity, 1)}   duck ${f(m?.noseDrop)}/${f(lastThresholds?.duck)}`,
  ].join('\n');
}

// ---------- main loop ----------
async function main() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));
  await video.play();
  log('camera', video.videoWidth + 'x' + video.videoHeight);

  const vision = await FilesetResolver.forVisionTasks('/node_modules/@mediapipe/tasks-vision/wasm');
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'GPU' },
    runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  modelReady = true; log('pose model ready');

  let lastVideoT = -1, lastStatusT = 0;
  const loop = () => {
    const now = performance.now();
    let res = null, m = null;
    if (video.currentTime !== lastVideoT) {
      lastVideoT = video.currentTime;
      const r = landmarker.detectForVideo(video, now);
      const lm = r.landmarks?.[0];
      tracking = !!lm;
      if (wasTracking && !tracking) { lostCount++; log('POSE LOST at', Math.round(now)); }
      if (!wasTracking && tracking) log('pose found at', Math.round(now));
      wasTracking = tracking;
      res = ctrl.update(lm, now);
      m = res.metrics;
      if (res.thresholds) lastThresholds = res.thresholds;
      traceRows.push({ t: Math.round(now), tracking, ready: res.ready, lane: res.lane, ev: res.events.join(','), mode: res.thresholds?.mode,
        hip: m?.hipLift, nose: m?.noseLift, feet: m?.feetLift, jumpSig: m?.jumpSignal, jumpThr: res.thresholds?.jump, hipVel: m?.hipVel, noseDrop: m?.noseDrop, duckThr: res.thresholds?.duck,
        torso: m?.torso, noseY: m?.noseY, hipY: m?.hipY, armedJ: m?.armedJump, armedD: m?.armedDuck });
      if (now - lastTraceT > 1000) { lastTraceT = now; window.surf?.trace(traceRows); traceRows = []; }
      if (res.ready) {
        if (res.lane !== desiredLane) { desiredLane = res.lane; syncLane(); }
        for (const ev of res.events) onEvent(ev, m);
      }
      if (camVisible) draw(lm, res.lane, m);
      frames++;
      if (now - fpsT > 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
      setStatus(m, res);
      if (now - lastStatusT > 500) {
        lastStatusT = now;
        window.surf?.status({ t: Date.now(), modelReady, fps, tracking, ready: res.ready, lane: res.lane, gameLane, keysOn, sent: out.sent, lastKey: out.last || null, lastEvent, metrics: m });
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
main().catch((e) => { log('fatal', String(e)); statusEl.textContent = 'ERROR: ' + e.message; });
