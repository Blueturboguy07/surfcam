// Pure pose-to-game-intent logic. No DOM, no MediaPipe imports, so it runs in node tests.
// Input: MediaPipe Pose 33 normalized landmarks ({x,y,z,visibility}, y grows DOWN), timestamp ms.
// Output per frame: { ready, lane, events:['jump'|'duck'], thresholds, metrics }.
//
// Design rules (the reason this survives jogging in place):
//  * every vertical measure is divided by a torso-length baseline, never pixels
//  * jump  = BOTH ankles above their rolling-median baseline at once AND hips lifted AND the hips
//            are moving up fast. jogging alternates feet, so min(liftL, liftR) stays ~0, and
//            standing up from a crouch is too slow to pass the velocity gate.
//  * duck  = nose drops well below its "standing level" baseline. jogging bounces the nose a
//            little, a crouch drops it a lot. does not depend on ankles being in frame.
//  * lanes = mirrored hip-center x in three bands with hysteresis, so standing on a boundary
//            never flaps.
//  * baselines NEVER freeze. standing level for hips/nose is a rolling 25th percentile of y
//            (i.e. the upper envelope of the body), so a held crouch does not drag it down for
//            several seconds and a brief jump cannot drag it up. actions re-arm by hysteresis
//            or by timeout, so nothing can stay stuck.

export const LM = {
  NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
};

export const DEFAULTS = {
  mirror: true,             // selfie camera: player's left == image right
  laneMargin: 0.05,         // hysteresis around lane boundaries, fraction of frame width
  jumpLift: 0.22,           // both ankles must rise this × torso above baseline
  jumpHipLift: 0.12,        // hips must rise this × torso too
  jumpNoAnkleHipLift: 0.24, // fallback when ankles are out of frame: hips + nose both rise
  jumpVelocity: 1.6,        // hips must be rising faster than this, in torso lengths per second
  velocityWindowMs: 120,
  rearmFrac: 0.4,           // signal must fall below this fraction of threshold to re-arm
  duckDrop: 0.45,           // nose must drop this × torso below standing level
  maxActionMs: { jump: 1500, duck: 4000 }, // safety net only: re-arm by timeout no matter what
  ankleWindowMs: 1500,      // rolling median window for ankle ground level
  standWindowMs: 5000,      // rolling window for hip / nose standing level
  standPercentile: 0.25,    // percentile of y (y is down) that counts as standing level
  torsoWindowMs: 2000,
  cooldownMs: { jump: 600, duck: 700 },
  warmupMs: 1000,           // no events until baselines have this much history
  minVisibility: 0.5,
};

class RollingPercentile {
  constructor(windowMs, q = 0.5) { this.windowMs = windowMs; this.q = q; this.samples = []; }
  push(t, v) {
    this.samples.push({ t, v });
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }
  get spanMs() { return this.samples.length ? this.samples[this.samples.length - 1].t - this.samples[0].t : 0; }
  value() {
    if (!this.samples.length) return NaN;
    const s = this.samples.map((x) => x.v).sort((a, b) => a - b);
    const pos = (s.length - 1) * this.q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
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
    this.o = {
      ...DEFAULTS, ...opts,
      cooldownMs: { ...DEFAULTS.cooldownMs, ...(opts.cooldownMs || {}) },
      maxActionMs: { ...DEFAULTS.maxActionMs, ...(opts.maxActionMs || {}) },
    };
    this.reset();
  }
  reset() {
    const o = this.o;
    this.lane = 1;
    this.firstT = null;
    this.torsoBase = new RollingPercentile(o.torsoWindowMs, 0.5);
    this.ankleLBase = new RollingPercentile(o.ankleWindowMs, 0.5);
    this.ankleRBase = new RollingPercentile(o.ankleWindowMs, 0.5);
    this.hipStand = new RollingPercentile(o.standWindowMs, o.standPercentile);
    this.noseStand = new RollingPercentile(o.standWindowMs, o.standPercentile);
    this.hipHistory = [];      // [{t, y}] for velocity
    this.armed = { jump: true, duck: true };
    this.lastFired = { jump: -Infinity, duck: -Infinity };
  }

  hipVelocity(t, hipY, torso) {
    const o = this.o;
    this.hipHistory.push({ t, y: hipY });
    while (this.hipHistory.length > 2 && this.hipHistory[1].t <= t - o.velocityWindowMs) this.hipHistory.shift();
    const old = this.hipHistory[0];
    const dt = (t - old.t) / 1000;
    if (dt <= 0) return 0;
    return (old.y - hipY) / torso / dt; // positive = moving up
  }

  update(landmarks, t) {
    const o = this.o;
    const events = [];
    if (!landmarks || landmarks.length < 33) {
      return { ready: false, lane: this.lane, laneChanged: false, events, metrics: { tracking: false } };
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

    this.torsoBase.push(t, torsoNow);
    const torso = this.torsoBase.value() || torsoNow;

    const anklesOk = visible(la, o.minVisibility) && visible(ra, o.minVisibility);
    if (anklesOk) { this.ankleLBase.push(t, la.y); this.ankleRBase.push(t, ra.y); }
    this.hipStand.push(t, hipY);
    this.noseStand.push(t, nose.y);
    const hipVel = this.hipVelocity(t, hipY, torso);

    // lanes
    const xm = o.mirror ? 1 - hipX : hipX;
    const newLane = laneFromX(xm, this.lane, o.laneMargin);
    const laneChanged = newLane !== this.lane;
    this.lane = newLane;

    // vertical signals in torso units (positive = moved UP on screen)
    const hipLift = (this.hipStand.value() - hipY) / torso;
    const noseLift = (this.noseStand.value() - nose.y) / torso;
    const liftL = anklesOk ? (this.ankleLBase.value() - la.y) / torso : NaN;
    const liftR = anklesOk ? (this.ankleRBase.value() - ra.y) / torso : NaN;
    const feetLift = anklesOk ? Math.min(liftL, liftR) : NaN;

    const ready = (t - this.firstT) >= o.warmupMs && this.hipStand.spanMs >= o.warmupMs * 0.8;

    // timeouts: nothing can stay stuck
    if (!this.armed.jump && t - this.lastFired.jump > o.maxActionMs.jump) this.armed.jump = true;
    if (!this.armed.duck && t - this.lastFired.duck > o.maxActionMs.duck) this.armed.duck = true;

    // jump
    let jumpSignal, jumpThresh, mode;
    if (anklesOk) { jumpSignal = Math.min(feetLift, hipLift * (o.jumpLift / o.jumpHipLift)); jumpThresh = o.jumpLift; mode = 'feet+hips'; }
    else { jumpSignal = Math.min(hipLift, noseLift); jumpThresh = o.jumpNoAnkleHipLift; mode = 'hips+nose (ankles hidden)'; }
    const fastEnough = hipVel > o.jumpVelocity;
    if (this.armed.jump) {
      if (ready && jumpSignal > jumpThresh && fastEnough && t - this.lastFired.jump > o.cooldownMs.jump) {
        events.push('jump'); this.lastFired.jump = t; this.armed.jump = false;
      }
    } else if (jumpSignal < jumpThresh * o.rearmFrac) {
      this.armed.jump = true;
    }

    // duck
    const noseDrop = -noseLift;
    if (this.armed.duck) {
      if (ready && noseDrop > o.duckDrop && t - this.lastFired.duck > o.cooldownMs.duck) {
        events.push('duck'); this.lastFired.duck = t; this.armed.duck = false;
      }
    } else if (noseDrop < o.duckDrop * o.rearmFrac) {
      this.armed.duck = true;
    }

    return {
      ready, lane: this.lane, laneChanged, events,
      thresholds: { jump: jumpThresh, duck: o.duckDrop, velocity: o.jumpVelocity, mode },
      metrics: { tracking: true, anklesOk, torso, xm, hipLift, noseLift, liftL, liftR, feetLift, jumpSignal, hipVel, noseDrop, noseY: nose.y, hipY, armedJump: this.armed.jump, armedDuck: this.armed.duck },
    };
  }
}
