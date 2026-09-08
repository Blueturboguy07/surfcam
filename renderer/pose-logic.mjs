// Pure pose-to-game-intent logic. No DOM, no MediaPipe imports, so it runs in node tests.
// Input: MediaPipe Pose 33 normalized landmarks ({x,y,z,visibility}, y grows DOWN), timestamp ms.
// Output per frame: { ready, lane, events:['jump'|'duck'], thresholds, metrics }.
//
// Design rules (the reason this survives jogging in place):
//  * every vertical measure is divided by a torso-length baseline, never pixels
//  * jump  = BOTH ankles above their rolling ground level (75th percentile of y) at once, hips not
//            descending, and hips rising fast. jogging alternates feet, so min(liftL, liftR) stays ~0;
//            standing up from a crouch keeps the feet on the ground. without ankles: hips AND nose
//            above their standing level plus the velocity gate.
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
  laneMargin: 0.03,         // hysteresis around lane boundaries, fraction of frame width
  laneCenterHalf: 1 / 6,    // centre band = [0.5 - half, 0.5 + half]; 1/6 = equal thirds
  laneSmoothing: 0.6,       // EMA weight of the newest frame (1 = none). 0.6 ≈ 50 ms, not visible lag
  jumpLift: 0.22,           // both ankles must rise this × torso above baseline
  jumpHipLift: 0.12,        // hips must rise this × torso too
  jumpNoAnkleHipLift: 0.24, // fallback when ankles are out of frame: hips + nose both rise
  jumpVelocity: 1.2,        // hips must be rising faster than this, in torso lengths per second
  jumpHipFloor: -0.05,      // feet mode: hips only have to be NOT descending (a leg tuck while sitting is not a jump)
  jumpScale: 0.25,          // multiplies the jump distance thresholds (0.25 = a quarter of the original movement)
  duckScale: 0.5,           // multiplies the duck distance threshold
  duckHoldMs: 150,          // a shallow duck (between scaled and full threshold) must be held this long; a deep one is instant
  velocityWindowMs: 66,     // two frames at 30 fps: long enough to beat landmark noise, short enough to see a 200 ms hop
  rearmFrac: 0.4,           // signal must fall below this fraction of threshold to re-arm
  duckDrop: 0.45,           // nose must drop this × torso below standing level
  maxActionMs: { jump: 1500, duck: 4000 }, // safety net only: re-arm by timeout no matter what
  ankleWindowMs: 1500,      // rolling window for ankle ground level
  anklePercentile: 0.75,    // percentile of ankle y (y is down) that counts as ground: the lowest 25% of positions
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

// Centre of the torso polygon (L/R shoulder, L/R hip), each corner weighted by its visibility so a
// hip that is out of frame (MediaPipe still guesses a position for it) cannot drag the point around.
export function torsoCenter(landmarks) {
  let sx = 0, sy = 0, sw = 0;
  for (const i of [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP]) {
    const p = landmarks[i];
    const w = Math.max(0.05, p.visibility === undefined ? 1 : p.visibility);
    sx += p.x * w; sy += p.y * w; sw += w;
  }
  return { x: sx / sw, y: sy / sw };
}

export function laneFromX(x, currentLane, margin, centerHalf = 1 / 6) {
  // bands: [0,b1) -> 0, [b1,b2) -> 1, [b2,1] -> 2, with hysteresis toward the current lane
  const b1 = 0.5 - centerHalf, b2 = 0.5 + centerHalf;
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
    this.ankleLBase = new RollingPercentile(o.ankleWindowMs, o.anklePercentile);
    this.ankleRBase = new RollingPercentile(o.ankleWindowMs, o.anklePercentile);
    this.hipStand = new RollingPercentile(o.standWindowMs, o.standPercentile);
    this.noseStand = new RollingPercentile(o.standWindowMs, o.standPercentile);
    this.hipHistory = [];      // [{t, y}] for velocity
    this.laneX = null;         // smoothed, mirrored torso-centre x
    this.duckAboveSince = null;
    this.armed = { jump: true, duck: true };
    this.lastFired = { jump: -Infinity, duck: -Infinity };
  }

  setJumpScale(v) { this.o.jumpScale = Math.min(1.5, Math.max(0.1, v)); return this.o.jumpScale; }
  setDuckScale(v) { this.o.duckScale = Math.min(1.5, Math.max(0.1, v)); return this.o.duckScale; }
  setLaneCenterHalf(v) { this.o.laneCenterHalf = Math.min(0.3, Math.max(0.05, v)); return this.o.laneCenterHalf; }

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

    // lanes: centre of the torso polygon, mirrored, lightly smoothed
    const tc = torsoCenter(landmarks);
    const rawX = o.mirror ? 1 - tc.x : tc.x;
    this.laneX = this.laneX === null ? rawX : o.laneSmoothing * rawX + (1 - o.laneSmoothing) * this.laneX;
    const xm = this.laneX;
    const newLane = laneFromX(xm, this.lane, o.laneMargin, o.laneCenterHalf);
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
    const k = o.jumpScale, kd = o.duckScale;
    let jumpSignal, jumpThresh, mode;
    if (anklesOk) { jumpSignal = hipLift > o.jumpHipFloor ? feetLift : Math.min(feetLift, 0); jumpThresh = o.jumpLift * k; mode = 'feet+hips'; }
    else { jumpSignal = Math.min(hipLift, noseLift); jumpThresh = o.jumpNoAnkleHipLift * k; mode = 'hips+nose (ankles hidden)'; }
    const duckThresh = o.duckDrop * kd;
    const fastEnough = hipVel > o.jumpVelocity;
    if (this.armed.jump) {
      if (ready && jumpSignal > jumpThresh && fastEnough && t - this.lastFired.jump > o.cooldownMs.jump) {
        events.push('jump'); this.lastFired.jump = t; this.armed.jump = false;
      }
    } else if (jumpSignal < jumpThresh * o.rearmFrac) {
      this.armed.jump = true;
    }

    // duck: deep drop fires instantly, a shallow drop (past the scaled threshold only) must be held
    const noseDrop = -noseLift;
    if (noseDrop > duckThresh) { if (this.duckAboveSince === null) this.duckAboveSince = t; } else this.duckAboveSince = null;
    const duckHeld = this.duckAboveSince !== null && t - this.duckAboveSince >= o.duckHoldMs;
    const duckNow = noseDrop > o.duckDrop || (noseDrop > duckThresh && (duckHeld || kd >= 1));
    if (this.armed.duck) {
      if (ready && duckNow && t - this.lastFired.duck > o.cooldownMs.duck) {
        events.push('duck'); this.lastFired.duck = t; this.armed.duck = false;
      }
    } else if (noseDrop < duckThresh * o.rearmFrac) {
      this.armed.duck = true;
    }

    return {
      ready, lane: this.lane, laneChanged, events,
      thresholds: { jump: jumpThresh, duck: duckThresh, velocity: o.jumpVelocity, jumpScale: k, duckScale: kd, mode },
      metrics: { tracking: true, anklesOk, torso, xm, torsoCenter: tc, laneBands: [0.5 - o.laneCenterHalf, 0.5 + o.laneCenterHalf], hipLift, noseLift, liftL, liftR, feetLift, jumpSignal, hipVel, noseDrop, noseY: nose.y, hipY, armedJump: this.armed.jump, armedDuck: this.armed.duck },
    };
  }
}
