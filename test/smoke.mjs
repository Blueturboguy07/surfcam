// Launch smoke test: starts SurfCam with a synthetic camera and passes only when the app reports
// the pose model loaded and frames flowing. Runs the dev app by default, or a packaged binary:
//
//   node test/smoke.mjs                                   # electron . (dev)
//   node test/smoke.mjs dist/win-unpacked/SurfCam.exe     # a packaged Windows build
//   node test/smoke.mjs "/Applications/SurfCam.app/Contents/MacOS/SurfCam"
//
// What "ready" proves: the local http server came up, the renderer loaded, getUserMedia handed over
// a stream, MediaPipe's wasm + the pose model loaded (GPU or the CPU fallback), and the rAF loop is
// producing frames — i.e. everything except a human in front of the lens.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const binArg = process.argv[2] || process.env.SURFCAM_BIN || '';
const bin = binArg ? path.resolve(binArg) : createRequire(import.meta.url)('electron');
const args = binArg ? [] : [path.resolve(here, '..')];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcam-smoke-'));
const statusFile = path.join(dir, 'status.json');
const timeoutMs = Number(process.env.SURFCAM_SMOKE_TIMEOUT || 120000);

console.log(`smoke: launching ${bin} ${args.join(' ')}`);
const child = spawn(bin, args, {
  env: { ...process.env, SURFCAM_FAKE_CAMERA: '1', SURFCAM_STATUS: statusFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { logs += d; });

const started = Date.now();
let done = false;
function finish(code, msg) {
  done = true;
  console.log(msg);
  try { child.kill(); } catch {}
  setTimeout(() => process.exit(code), 500);
}
child.on('exit', (code, signal) => { if (!done) finish(1, `SMOKE FAIL: app exited early (code ${code}, signal ${signal})\n${logs.slice(-3000)}`); });
child.on('error', (e) => { if (!done) finish(1, `SMOKE FAIL: could not launch: ${e}`); });

const tick = setInterval(() => {
  if (done) return clearInterval(tick);
  try {
    const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (s.modelReady && s.fps > 0) {
      clearInterval(tick);
      return finish(0, `SMOKE OK: model ready, ${s.fps} fps, tracking=${s.tracking}, ${Date.now() - started} ms after launch (${process.platform} ${os.release()})`);
    }
  } catch {}
  if (Date.now() - started > timeoutMs) {
    clearInterval(tick);
    finish(1, `SMOKE FAIL: no ready status within ${timeoutMs} ms\n${logs.slice(-3000)}`);
  }
}, 500);
