// Pure pose-to-game-intent logic. No DOM, no MediaPipe imports, so it runs in node tests.
// Input: MediaPipe Pose 33 normalized landmarks ({x,y,z,visibility}, y grows DOWN), timestamp ms.
// Output per frame: { ready, lane, events:['jump'|'duck'], metrics }.
//
// Design rules (the reason this survives jogging in place):
//  * every vertical measure is divided by a torso-length baseline, never pixels
//  * jump  = BOTH ankles above their rolling-median baseline at once AND hips lifted.
//            jogging alternates feet, so min(liftL, liftR) stays ~0.
//  * duck  = nose drops well below its rolling baseline. jogging bounces the nose a little,
//            a crouch drops it a lot. does not depend on ankles being in frame.
//  * lanes = mirrored hip-center x in three bands with hysteresis, so standing on a
//            boundary never flaps.

export const LM = {
  NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
};

export const DEFAULTS = {
  mirror: true,            // selfie camera: player's left == image right
  laneMargin: 0.05,        // hysteresis around lane boundaries, fraction of frame width
  jumpLift: 0.22,          // both ankles must rise this × torso above baseline
  jumpHipLift: 0.12,       // hips must rise this × torso too
  jumpNoAnkleHipLift: 0.24,// fallback when ankles are out of frame: hips + nose both rise
  rearmFrac: 0.4,          // signal must fall below this fraction of threshold to re-arm
  duckDrop: 0.45,          // nose must drop this × torso below its baseline
  baselineWindowMs: 1500,  // rolling window for ankle / hip baselines
  noseWindowMs: 4000,      // rolling window for the nose baseline
  torsoWindowMs: 2000,
  cooldownMs: { jump: 600, duck: 700 },
  warmupMs: 1000,          // no events until baselines have this much history
  minVisibility: 0.5,
};

class RollingMedian {
  constructor(windowMs) { this.windowMs = windowMs; this.samples = []; }
  push(t, v) {
    this.samples.push({ t, v });
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }
  get spanMs() { return this.samples.length ? this.samples[this.samples.length - 1].t - this.samples[0].t : 0; }
  value() {
    if (!this.samples.length) return NaN;
    const s = this.samples.map((x) => x.v).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
}

function avg(a, b) { return (a + b) / 2; }
function visible(lm, min) { return lm && (lm.visibility === undefined || lm.visibility >= min); }

export function laneFromX(x, currentLane, margin) {
  // bands: [0,1/3) -> 0, [1/3,2/3) -> 1, [2/3,1] -> 2, with hysteresis toward the current lane
  const b1 = 1 / 3, b2 = 2 / 3;
  if (currentLane === 0) return x > b1 + margin ? (x > b2 + margin ? 2 : 1) : 0;
  if (currentLane === 2) return x < b2 - margin ? (x < b1 - margin ? 0 : 1) : 2;
  if (x < b1 - margin) return 0;
  if (x > b2 + margin) return 2;
  return 1;
}

export class PoseController {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts, cooldownMs: { ...DEFAULTS.cooldownMs, ...(opts.cooldownMs || {}) } };
    this.reset();
  }
  reset() {
    const o = this.o;
    this.lane = 1;
    this.firstT = null;
    this.torsoBase = new RollingMedian(o.torsoWindowMs);
    this.ankleLBase = new RollingMedian(o.baselineWindowMs);
    this.ankleRBase = new RollingMedian(o.baselineWindowMs);
    this.hipBase = new RollingMedian(o.baselineWindowMs);
    this.noseBase = new RollingMedian(o.noseWindowMs);
    this.armed = { jump: true, duck: true };
    this.lastFired = { jump: -Infinity, duck: -Infinity };
    this.airborne = false;
    this.ducking = false;
  }

  update(landmarks, t) {
    const o = this.o;
    const events = [];
    if (!landmarks || landmarks.length < 33) {
      return { ready: false, lane: this.lane, events, metrics: { tracking: false } };
    }
    if (this.firstT === null) this.firstT = t;
    const ls = landmarks[LM.L_SHOULDER], rs = landmarks[LM.R_SHOULDER];
    const lh = landmarks[LM.L_HIP], rh = landmarks[LM.R_HIP];
    const la = landmarks[LM.L_ANKLE], ra = landmarks[LM.R_ANKLE];
    const nose = landmarks[LM.NOSE];

    const shoulderY = avg(ls.y, rs.y);
    const hipY = avg(lh.y, rh.y);
    const hipX = avg(lh.x, rh.x);
    const torsoNow = Math.max(1e-3, hipY - shoulderY);

    // baselines. frozen while an action is in progress so the action does not pollute them.
    const inAction = this.airborne || this.ducking;
    if (!inAction) this.torsoBase.push(t, torsoNow);
    const torso = this.torsoBase.value() || torsoNow;

    const anklesOk = visible(la, o.minVisibility) && visible(ra, o.minVisibility);
    if (!inAction) {
      if (anklesOk) { this.ankleLBase.push(t, la.y); this.ankleRBase.push(t, ra.y); }
      this.hipBase.push(t, hipY);
      this.noseBase.push(t, nose.y);
    }

    // lanes
    const xm = o.mirror ? 1 - hipX : hipX;
    const newLane = laneFromX(xm, this.lane, o.laneMargin);
    const laneChanged = newLane !== this.lane;
    this.lane = newLane;

    // vertical signals in torso units (positive = moved UP on screen)
    const hipLift = (this.hipBase.value() - hipY) / torso;
    const noseLift = (this.noseBase.value() - nose.y) / torso;
    const liftL = anklesOk ? (this.ankleLBase.value() - la.y) / torso : NaN;
    const liftR = anklesOk ? (this.ankleRBase.value() - ra.y) / torso : NaN;
    const feetLift = anklesOk ? Math.min(liftL, liftR) : NaN;

    const ready = (t - this.firstT) >= o.warmupMs && this.hipBase.spanMs >= o.warmupMs * 0.8;

    // jump
    let jumpSignal, jumpThresh;
    if (anklesOk) { jumpSignal = Math.min(feetLift, hipLift / (o.jumpHipLift / o.jumpLift)); jumpThresh = o.jumpLift; }
    else { jumpSignal = Math.min(hipLift, noseLift); jumpThresh = o.jumpNoAnkleHipLift; }
    if (this.armed.jump) {
      if (ready && jumpSignal > jumpThresh && t - this.lastFired.jump > o.cooldownMs.jump) {
        events.push('jump'); this.lastFired.jump = t; this.armed.jump = false; this.airborne = true;
      }
    } else if (jumpSignal < jumpThresh * o.rearmFrac) {
      this.armed.jump = true; this.airborne = false;
    }

    // duck
    const noseDrop = -noseLift;
    if (this.armed.duck) {
      if (ready && noseDrop > o.duckDrop && t - this.lastFired.duck > o.cooldownMs.duck) {
        events.push('duck'); this.lastFired.duck = t; this.armed.duck = false; this.ducking = true;
      }
    } else if (noseDrop < o.duckDrop * o.rearmFrac) {
      this.armed.duck = true; this.ducking = false;
    }

    return {
      ready, lane: this.lane, laneChanged, events,
      metrics: { tracking: true, anklesOk, torso, xm, hipLift, noseLift, liftL, liftR, feetLift, jumpSignal, noseDrop },
    };
  }
}
