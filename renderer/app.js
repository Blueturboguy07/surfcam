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
let keysOn = true, camVisible = true;
let gameLane = 1, desiredLane = 1, movingLane = false;
let fps = 0, frames = 0, fpsT = performance.now();
let lastEvent = '', lastEventT = 0, tracking = false, modelReady = false;

async function syncLane() {
  if (movingLane) return;
  movingLane = true;
  try {
    while (keysOn && gameLane !== desiredLane) {
      if (desiredLane > gameLane) { await out.right(); gameLane++; } else { await out.left(); gameLane--; }
      await sleep(140);
    }
  } finally { movingLane = false; }
}
function onEvent(ev) {
  lastEvent = ev; lastEventT = performance.now();
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
game.addEventListener('dom-ready', () => { log('game dom-ready', game.getURL()); });
game.addEventListener('did-navigate', (e) => log('game navigated', e.url));

// ---------- buttons ----------
$('btnKeys').onclick = () => { keysOn = !keysOn; $('btnKeys').textContent = 'Keys: ' + (keysOn ? 'ON' : 'OFF'); $('btnKeys').className = keysOn ? 'on' : 'off'; };
$('btnCenter').onclick = () => { gameLane = 1; desiredLane = ctrl.lane; syncLane(); };
$('btnFocus').onclick = focusGame;
$('btnCam').onclick = () => { camVisible = !camVisible; cam.classList.toggle('hidden', !camVisible); $('btnCam').textContent = camVisible ? 'Hide cam' : 'Show cam'; };
window.addEventListener('keydown', (e) => {
  if (e.key === 'k') $('btnKeys').click();
  if (e.key === 'c') $('btnCenter').click();
  if (e.key === 'f') focusGame();
});

// ---------- drawing ----------
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
function draw(landmarks, lane) {
  const w = cam.width, h = cam.height;
  ctx.save();
  ctx.translate(w, 0); ctx.scale(-1, 1);           // mirror so the player sees a mirror
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
  // lane bands (already in mirrored space: left band = player's left)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === lane ? 'rgba(52,211,153,.28)' : 'rgba(255,255,255,.06)';
    ctx.fillRect((i * w) / 3, 0, w / 3, h);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(w / 3, 0); ctx.lineTo(w / 3, h); ctx.moveTo((2 * w) / 3, 0); ctx.lineTo((2 * w) / 3, h); ctx.stroke();
  if (!landmarks) return;
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
    `${modelReady ? 'model ok' : 'loading model…'}  ${fps} fps  ${tracking ? 'TRACKING' : 'no person'}${res?.ready ? '' : tracking ? ' (calibrating)' : ''}`,
    `lane ${['L', 'C', 'R'][res?.lane ?? 1]}  game ${['L', 'C', 'R'][gameLane]}  keys ${keysOn ? 'ON' : 'OFF'}  sent ${out.sent}${out.last ? ' ' + out.last : ''}`,
    `feet ${f(m?.feetLift)}  hips ${f(m?.hipLift)}  nose ${f(m?.noseLift)}  torso ${f(m?.torso, 3)}${m && m.anklesOk === false ? '  ankles hidden' : ''}`,
    `last: ${lastEvent || '—'}   [k] keys  [c] recenter  [f] focus game`,
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
      res = ctrl.update(lm, now);
      m = res.metrics;
      if (res.ready) {
        if (res.lane !== desiredLane) { desiredLane = res.lane; syncLane(); }
        for (const ev of res.events) onEvent(ev);
      }
      if (camVisible) draw(lm, res.lane);
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
