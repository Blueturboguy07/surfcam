// Obstacle cues. Watches the game frame (webContents.capturePage), finds obstacles per lane with
// colour classes + a per-lane row profile, tracks the one in the player's lane, and turns its
// time-to-impact into a cue: LEFT / RIGHT for a train, JUMP for a low barrier, DUCK for a tall one.
//
// Screen model (fractions of the frame, y down), measured on recorded frames of the Bali world:
//   vanishing point VP = (0.47, 0.26); the player's lane always projects to the centre column.
//   half width of a lane at row y      = HALF_K * (y - VP.y)
//   centre of the adjacent lane at y   = VP.x ± OFF_K * (y - VP.y)
//   1 / (y - VP.y) is linear in time for an approaching obstacle, impact at y ≈ 0.9.

const VP = { x: 0.47, y: 0.26 };
const HALF_K = 0.19, OFF_K = 0.755;
const Y_IMPACT = { train: 0.9, jump: 0.9, duck: 1.0 };
const uOf = (y) => 1 / (y - VP.y);

function laneGeom(y, lane) { const d = Math.max(0, y - VP.y); return { cx: VP.x + (lane - 1) * OFF_K * d, hw: HALF_K * d }; }

// bitmap: BGRA bytes, w × h. Returns { 0: det, 1: det, 2: det, running } with det = {bottom, top, height, red, width}
function isRunning(buf, w, h) {
  // mean colour of a small block on the pause button (x≈0.035, y≈0.055): blue while a run is active
  let r = 0, g = 0, b = 0, n = 0;
  for (let py = Math.floor(0.04 * h); py < Math.floor(0.07 * h); py++) for (let px = Math.floor(0.02 * w); px < Math.floor(0.05 * w); px++) { const i = (py * w + px) * 4; b += buf[i]; g += buf[i + 1]; r += buf[i + 2]; n++; }
  r /= n; g /= n; b /= n;
  return b > 140 && b > r + 40 && g > 90;
}
function analyze(buf, w, h) {
  const out = { running: isRunning(buf, w, h) };
  const yRange = (lane) => [0.33, lane === 1 ? 0.58 : 0.68];
  for (let lane = 0; lane < 3; lane++) {
    const [y0, y1] = yRange(lane);
    const rows = [];
    for (let py = Math.floor(y0 * h); py < Math.floor(y1 * h); py++) {
      const { cx, hw } = laneGeom(py / h, lane);
      const x0 = Math.max(0, Math.floor((cx - hw) * w)), x1 = Math.min(w, Math.floor((cx + hw) * w));
      if (x1 - x0 < 2) continue;
      let obs = 0, red = 0, yellow = 0;
      for (let x = x0; x < x1; x++) {
        const i = (py * w + x) * 4; const b = buf[i], g = buf[i + 1], r = buf[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const sat = (mx - mn) / Math.max(mx, 1);
        if (r > 200 && g > 150 && b < 110) { yellow++; continue; }               // coins: neutral
        const gray = (sat < 0.2 && mx > 110) || (mx > 195 && sat < 0.3 && g >= r - 5);
        const dark = mx < 115 && sat < 0.35;
        const isRed = r > 140 && g < 100 && b < 100 && r - g > 60;
        if (gray || dark || isRed) obs++;
        if (isRed) red++;
      }
      const n = Math.max(1, x1 - x0 - yellow);
      rows.push({ py, f: obs / n, red: red / n, width: (x1 - x0) / w });
    }
    if (rows.length < 5) continue;
    const k = 5, sm = rows.map((_, i) => { let s = 0, c = 0; for (let j = i - 2; j <= i + 2; j++) if (rows[j]) { s += rows[j].f; c++; } return s / c; });
    let best = null, i = rows.length - 1;
    while (i >= 0) {
      if (sm[i] <= 0.45) { i--; continue; }
      const b = i; let t = b; while (t > 0 && sm[t - 1] > 0.3) t--;
      const height = (rows[b].py - rows[t].py) / h;
      if (b - t >= 3 && height >= 0.03 && (!best || height > best.height * 1.3)) {
        const seg = rows.slice(t, b + 1);
        const upper = seg.slice(0, Math.max(1, Math.floor(seg.length / 2)));
        const cand = { bottom: rows[b].py / h, top: rows[t].py / h, height, red: seg.reduce((s, r) => s + r.red, 0) / seg.length,
          redTop: upper.reduce((s, r) => s + r.red, 0) / upper.length, width: rows[b].width };
        // a sliver glued to the bottom of the centre band is the player's own head/cap, not an obstacle
        if (lane === 1 && cand.bottom >= y1 - 0.012 && height < 0.1) { i = t - 1; continue; }
        best = cand;
      }
      i = t - 1;
    }
    if (best) out[lane] = best;
  }
  return out;
}

class CueEngine {
  constructor(opts = {}) {
    this.leadMs = opts.leadMs ?? 700;
    this.track = null;        // player's lane: { u, t, firedFor }
    this.laneTracks = [null, null, null];
    this.rate = null;         // global game speed in 1/(y - vp) units per second, learned from any lane
    this.lastCue = null;
    this.history = [];
  }
  learnRate(lanes, t) {
    for (let lane = 0; lane < 3; lane++) {
      const det = lanes[lane];
      const prev = this.laneTracks[lane];
      if (!det || det.bottom > 0.66) { this.laneTracks[lane] = null; continue; }
      const u = 1 / (det.bottom - VP.y);
      if (prev && t - prev.t < 250 && u < prev.u && prev.u - u < 2.5) {
        const inst = (prev.u - u) / ((t - prev.t) / 1000);
        if (inst > 1 && inst < 20) this.rate = this.rate == null ? inst : 0.8 * this.rate + 0.2 * inst;
      }
      this.laneTracks[lane] = { u, t };
    }
  }
  classify(det) {
    // a barrier is red/white over its whole height (chevron); a train only has red at its bumper/base.
    // tall barrier (panel with a gap below) -> DUCK, low barrier -> JUMP
    const barrier = det.redTop > 0.2 && det.red > 0.15 && det.height < 0.35;
    if (barrier) return det.height / Math.max(det.width, 0.01) >= 0.8 ? 'duck' : 'jump';
    return 'train';
  }
  update(lanes, t) {
    if (lanes.running === false) { this.track = null; this.laneTracks = [null, null, null]; return null; }
    this.learnRate(lanes, t);
    const mine = lanes[1];
    let cue = null;
    if (!mine) { if (this.track && t - this.track.t > 400) this.track = null; return null; }
    const u = 1 / (mine.bottom - VP.y);
    if (this.track && t - this.track.t < 600 && u < this.track.u + 0.6) {
      const inst = (this.track.u - u) / ((t - this.track.t) / 1000);
      if (inst > 1 && inst < 20) this.track.rate = this.track.rate == null ? inst : 0.6 * this.track.rate + 0.4 * inst;
      this.track.u = u; this.track.t = t; this.track.n++;
    } else this.track = { u, t, firedFor: null, n: 1, rate: null, votes: { train: 0, jump: 0, duck: 0 } };
    this.track.votes[this.classify(mine)]++;
    const rate = (this.track.n >= 3 && this.track.rate) || this.rate || 6;   // own rate, else global, else a mid-run default
    const v = this.track.votes; const kind = Object.keys(v).sort((a, b) => v[b] - v[a])[0];   // majority over the track
    const etaMs = Math.max(0, (u - uOf(Y_IMPACT[kind])) / rate * 1000);
    let action = kind;
    if (kind === 'train') {
      const L = lanes[0]?.bottom ?? 0, R = lanes[2]?.bottom ?? 0;   // prefer the side with nothing (or something further away)
      action = L <= R ? 'left' : 'right';
    }
    const recent = this.lastCue && t - this.lastCue.t < 600 && this.lastCue.kind === kind;
    if (etaMs <= this.leadMs && etaMs > 60 && this.track.n >= 2 && this.track.firedFor !== kind && !recent) {
      this.track.firedFor = kind;
      cue = { action, kind, etaMs: Math.round(etaMs), rate: +rate.toFixed(2), bottom: mine.bottom, height: mine.height, red: mine.red, redTop: mine.redTop, t };
      this.lastCue = cue;
    }
    this.history.push({ t, bottom: +mine.bottom.toFixed(3), height: +mine.height.toFixed(3), red: +mine.red.toFixed(2), etaMs: Math.round(etaMs), rate: +rate.toFixed(2), kind, cue: !!cue });
    if (this.history.length > 300) this.history.shift();
    return cue;
  }
}

module.exports = { analyze, CueEngine, laneGeom, VP };
