import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoseController, laneFromX } from '../renderer/pose-logic.mjs';

// Synthetic body in normalized image coords (y down). torso = hip - shoulder.
function body({ x = 0.5, shoulderY = 0.35, torso = 0.25, ankleLift = [0, 0], hipLift = 0, noseLift = 0, anklesVisible = true } = {}) {
  const hipY = shoulderY + torso - hipLift * torso;
  const sY = shoulderY - hipLift * torso;
  const noseY = shoulderY - 0.4 * torso - noseLift * torso - hipLift * torso;
  const ankleY = shoulderY + torso * 2.2;
  const lm = Array.from({ length: 33 }, () => ({ x, y: hipY, z: 0, visibility: 1 }));
  lm[0] = { x, y: noseY, z: 0, visibility: 1 };
  lm[11] = { x: x + 0.08, y: sY, z: 0, visibility: 1 };
  lm[12] = { x: x - 0.08, y: sY, z: 0, visibility: 1 };
  lm[23] = { x: x + 0.06, y: hipY, z: 0, visibility: 1 };
  lm[24] = { x: x - 0.06, y: hipY, z: 0, visibility: 1 };
  lm[27] = { x: x + 0.06, y: ankleY - ankleLift[0] * torso, z: 0, visibility: anklesVisible ? 1 : 0.1 };
  lm[28] = { x: x - 0.06, y: ankleY - ankleLift[1] * torso, z: 0, visibility: anklesVisible ? 1 : 0.1 };
  return lm;
}

const FPS = 30, DT = 1000 / FPS;

function run(ctrl, frames) {
  const out = [];
  let t = 0;
  for (const f of frames) { out.push(ctrl.update(f, t)); t += DT; }
  return out;
}
function events(results) { return results.flatMap((r) => r.events); }
function standing(ms, extra = {}) { return Array.from({ length: Math.round(ms / DT) }, () => body(extra)); }

// jogging in place: feet alternate, sinusoidal, clipped at ground; hips bounce a little; nose bounces a little
function jogging(ms, { footLift = 0.6, hipBounce = 0.08, noseBounce = 0.12, overlap = 0, torso = 0.25 } = {}) {
  const n = Math.round(ms / DT);
  const period = 600; // ms per full stride cycle
  return Array.from({ length: n }, (_, i) => {
    const ph = (i * DT / period) * 2 * Math.PI;
    const l = Math.max(0, Math.sin(ph)) * footLift + overlap;
    const r = Math.max(0, Math.sin(ph + Math.PI)) * footLift + overlap;
    const bounce = Math.abs(Math.sin(ph)); // two bounces per stride
    return body({ torso, ankleLift: [l, r], hipLift: bounce * hipBounce, noseLift: bounce * noseBounce });
  });
}
function jump(ms, { height = 0.45, torso = 0.25 } = {}) {
  const n = Math.round(ms / DT);
  return Array.from({ length: n }, (_, i) => {
    const a = Math.sin((i / (n - 1)) * Math.PI) * height;
    return body({ torso, ankleLift: [a, a], hipLift: a, noseLift: 0 });
  });
}
function duck(ms, { depth = 0.7, torso = 0.25 } = {}) {
  const n = Math.round(ms / DT);
  return Array.from({ length: n }, (_, i) => {
    const a = Math.sin((i / (n - 1)) * Math.PI) * depth;
    return body({ torso, noseLift: -a, hipLift: -a * 0.3 });
  });
}

test('no events during warmup', () => {
  const c = new PoseController();
  const res = run(c, [...standing(500), ...jump(400)]);
  assert.deepEqual(events(res), []);
});

test('jogging in place for 10s fires nothing', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...jogging(10000)]);
  assert.deepEqual(events(res), []);
});

test('sloppy jogging with brief both-feet-low overlap still fires nothing', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...jogging(8000, { overlap: 0.1, hipBounce: 0.1, noseBounce: 0.2 })]);
  assert.deepEqual(events(res), []);
});

test('a jump while standing fires exactly one jump', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...jump(450), ...standing(800)]);
  assert.deepEqual(events(res), ['jump']);
});

test('a jump in the middle of jogging fires exactly one jump', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...jogging(3000), ...jump(450), ...jogging(3000)]);
  assert.deepEqual(events(res), ['jump']);
});

test('two jumps 1s apart fire twice', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...jump(450), ...standing(1000), ...jump(450), ...standing(500)]);
  assert.deepEqual(events(res), ['jump', 'jump']);
});

test('a duck fires exactly one duck, jogging nose bounce does not', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...jogging(3000), ...duck(700), ...jogging(3000)]);
  assert.deepEqual(events(res), ['duck']);
});

test('jump does not register as duck and duck does not register as jump', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...jump(450), ...standing(1000), ...duck(700), ...standing(1000)]);
  assert.deepEqual(events(res), ['jump', 'duck']);
});

test('thresholds are distance-invariant (half-size torso, same behaviour)', () => {
  for (const torso of [0.12, 0.25, 0.4]) {
    const c = new PoseController();
    const res = run(c, [...standing(1500, { torso }), ...jogging(4000, { torso }), ...jump(450, { torso }), ...jogging(2000, { torso }), ...duck(700, { torso }), ...standing(500, { torso })]);
    assert.deepEqual(events(res), ['jump', 'duck'], `torso=${torso}`);
  }
});

test('ankles out of frame: jump still detected from hips+nose, jogging still ignored', () => {
  const hide = (f) => { f[27].visibility = 0.1; f[28].visibility = 0.1; return f; };
  const c = new PoseController();
  const res = run(c, [...standing(1500, { anklesVisible: false }), ...jogging(6000).map(hide), ...jump(450).map(hide), ...jogging(2000).map(hide)]);
  assert.deepEqual(events(res), ['jump']);
});

// hold a crouch (nose and hips down) for `ms`, entered over 400 ms and left over `riseMs`
function crouchHold(ms, { depth = 0.9, hipDepth = 0.6, riseMs = 600, torso = 0.25 } = {}) {
  const enter = Math.round(400 / DT), hold = Math.round(ms / DT), rise = Math.round(riseMs / DT);
  const frames = [];
  for (let i = 0; i < enter; i++) { const a = Math.sin((i / (enter - 1)) * Math.PI / 2); frames.push(body({ torso, noseLift: -a * depth, hipLift: -a * hipDepth })); }
  for (let i = 0; i < hold; i++) frames.push(body({ torso, noseLift: -depth, hipLift: -hipDepth }));
  for (let i = 0; i < rise; i++) { const a = Math.cos((i / (rise - 1)) * Math.PI / 2); frames.push(body({ torso, noseLift: -a * depth, hipLift: -a * hipDepth })); }
  return frames;
}

test('standing up from a held crouch is NOT a jump, and the crouch is exactly one duck', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...crouchHold(2000), ...standing(1500)]);
  assert.deepEqual(events(res), ['duck']);
});

test('standing up quickly from a short crouch is still not a jump', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...crouchHold(300, { riseMs: 350 }), ...standing(1500)]);
  assert.deepEqual(events(res), ['duck']);
});

test('duck re-arms: two crouches fire two ducks, and a jump after them still fires', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...crouchHold(800), ...standing(1200), ...crouchHold(800), ...standing(1200), ...jump(450), ...standing(600)]);
  assert.deepEqual(events(res), ['duck', 'duck', 'jump']);
});

test('nothing stays stuck: a very long crouch re-arms and a later jump fires', () => {
  const c = new PoseController();
  const res = run(c, [...standing(1500), ...crouchHold(6000), ...standing(2500), ...jump(450), ...standing(600)]);
  const ev = events(res);
  assert.equal(ev[0], 'duck');
  assert.equal(ev[ev.length - 1], 'jump');
  assert.ok(!ev.includes('jump') || ev.indexOf('jump') === ev.length - 1, 'a jump fired while standing up: ' + ev);
});

test('lanes: mirrored, stepping to the player left goes to lane 0, with hysteresis', () => {
  const c = new PoseController();
  // player steps to THEIR left = image x increases (mirror)
  const res = run(c, [...standing(1500, { x: 0.5 }), ...standing(300, { x: 0.75 }), ...standing(300, { x: 0.5 }), ...standing(300, { x: 0.2 })]);
  const lanes = res.map((r) => r.lane);
  assert.equal(lanes[0], 1);
  assert.equal(lanes[Math.round(1650 / DT)], 0);
  assert.equal(lanes[Math.round(1950 / DT)], 1);
  assert.equal(lanes[lanes.length - 1], 2);
});

test('lanes: jitter on a boundary never flaps', () => {
  const c = new PoseController();
  const frames = [...standing(1500, { x: 0.5 })];
  for (let i = 0; i < 300; i++) frames.push(body({ x: 1 / 3 + (i % 2 ? 0.02 : -0.02) }));
  const res = run(c, frames);
  const changes = res.filter((r) => r.laneChanged).length;
  assert.ok(changes <= 1, `lane flapped ${changes} times`);
});

test('laneFromX hysteresis table', () => {
  assert.equal(laneFromX(0.30, 1, 0.05), 1);
  assert.equal(laneFromX(0.27, 1, 0.05), 0);
  assert.equal(laneFromX(0.36, 0, 0.05), 0);
  assert.equal(laneFromX(0.40, 0, 0.05), 1);
  assert.equal(laneFromX(0.95, 0, 0.05), 2);
});
