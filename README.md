# SurfCam

Webcam pose controller + HUD wrapped around the official Subway Surfers web build on Poki.
The game is not modified or copied. An Electron window hosts poki.com in a webview, runs
MediaPipe Pose on your webcam in the host page, draws a HUD over the game, and fires arrow keys
into the game through Electron's trusted input API.

## Install

Direct installs, no toolchain needed — grab the file for your computer from the
[latest release](https://github.com/Blueturboguy07/surfcam/releases/latest):

| | File | Notes |
|---|---|---|
| macOS (Apple silicon + Intel) | `SurfCam-<version>-mac-universal.dmg` | Signed with a Developer ID and notarized by Apple, so it opens like any other app. Drag SurfCam to Applications. After you sign in with publik, macOS asks for camera access once. |
| Windows 10/11 (64-bit) | `SurfCam-Setup-<version>-win-x64.exe` | One-click installer (per user, no admin). It is not code-signed, so SmartScreen shows "Windows protected your PC" the first time: click **More info → Run anyway**. Windows must allow desktop apps to use the camera (Settings › Privacy & security › Camera). |

Same code, same detection, same HUD on both. Every Windows build is produced and launch-tested on a
real Windows machine in CI (`.github/workflows/publik-build.yml` or `release.yml`) before it is attached
to a release.

## Sign in with publik

SurfCam opens with **Sign in with publik**. Click the button, then sign in in your browser. The window
continues by itself when you are signed in. Only then does SurfCam ask for the camera and open the game.
If publik is not reachable, the window says "publik is not reachable. Check your connection." and shows
**Retry**. SurfCam uses no AI, so there is no plan to choose and no key to enter.

The sign-in gives this computer a publik key. The key is in
`~/Library/Application Support/publik/apps/surfcam.json` (macOS) or
`%LOCALAPPDATA%\publik\apps\surfcam.json` (Windows), and only you can read that file. The publik module
`publik.cjs` does the sign-in and the usage counts. `publik-gate.cjs` draws the sign-in window.

## Run from source

    git clone https://github.com/Blueturboguy07/surfcam && cd surfcam
    npm install
    npm start

Zero engine installs. Node + npm only. Camera permission is asked once, after the sign-in.
The sign-in needs the publik app token of the build: put it in `PUBLIK_APP_TOKEN` in the environment,
or in `publik-app-token.txt` at the repo root (that file is in `.gitignore`).

## Play

1. Stand back so the camera sees at least your hips. Feet visible gives the strongest jump detection.
2. Click the game once (or press the **Focus game** button / `f`) so Unity has keyboard focus.
3. Step left / right to change lane. The HUD strip shows which of the three camera zones you are in.
4. Jump to jump. Crouch to roll under barriers. Jogging in place does nothing.

**Game only** (default ON) hides everything on the Poki page except the game iframe and pins it to the full
window. It is one injected stylesheet: every element `visibility: hidden`, `#game-element` visible and
`position: fixed; inset: 0`. Nothing is reparented, so the game never reloads. Toggle it off if you need
Poki's own UI. **Fullscreen** takes the whole app fullscreen (Esc exits).

HUD buttons: `Keys: ON/OFF` (or `k`) pauses key sending so you can use the mouse on Poki's UI.
`Recenter lane` (or `c`) tells the controller the character is back in the centre lane.

## Usage counts

After the sign-in, SurfCam sends two usage events to publik: `app_opened` at launch and `active_session`
every 30 minutes while it runs. Each event holds the app name, the app version, the operating system, the
CPU type and a random install ID. It also carries this computer's publik key, so publik counts you one
time. No video, no pose data, no key presses and no personal data are sent. To turn it off, set
`DO_NOT_TRACK=1` (or `PUBLIK_TELEMETRY=0`) in the environment. The sign-in still runs.
Details: https://publikhq.com/skills/telemetry.md

## How detection works (`renderer/pose-logic.mjs`, tested by `npm test`)

- Every vertical measure is divided by torso length, so distance from the camera does not matter.
- **Jump** = both ankles rise past a rolling-median baseline in the same frame AND hips rise.
  Jogging alternates feet, so it never satisfies this. With ankles out of frame it falls back to
  hips + nose rising together.
- **Duck** = nose drops well below its 4 s rolling baseline. Jogging bounces it a little, a crouch drops it a lot.
- **Lanes** = mirrored hip-centre x in three bands with hysteresis so a boundary never flaps.

## Swapping the output

`KeystrokeOutput` in `renderer/app.js` is the only thing that knows about Poki. Replace it with a
direct binding once the game is ours; the controller emits lane / jump / duck intents only.

## Verification hooks

- `npm test` — the detector's unit tests (jogging = no events, jumps, ducks, lanes, crouch regressions),
  and the publik module's tests (`test/publik-module.test.mjs`: the sign-in screens, the offline screen,
  the self-test line), against a fake publik on 127.0.0.1.
- `npm run smoke` — launches the app with Chromium's synthetic camera and passes only once the pose
  model is loaded and frames are flowing. A fake publik on 127.0.0.1 (`test/fake-publik.mjs`) tells the
  gate that this computer is signed in. `node test/smoke.mjs <path-to-binary>` runs the same check
  against a packaged build; CI runs it against the Windows installer's installed copy.
- `PUBLIK_SELF_TEST=1 <path-to-binary>` — prints `publik self-test: ok surfcam <version>` after a real
  `GET /api/v1/wallet`, then exits before any window opens. CI runs it on the macOS app and on the
  installed Windows copy against a fake publik (`.github/scripts/publik-self-test.cjs`), and
  `.github/scripts/publik-telemetry-smoke.mjs` checks that the app waits at the sign-in and sends its
  usage counts only after it.

- `SURFCAM_STATUS=/path/status.json npm start` writes live tracking state twice a second.
- `SURFCAM_PROBE=1 npm start` injects a keydown counter into the game iframe, fires a test key,
  and logs what the game frame received.

## Releasing

    npm run dist:mac      # signed + notarized universal dmg in dist/ (needs the Developer ID in the keychain,
                          # APPLE_KEYCHAIN_PROFILE=<notarytool profile> and PUBLIK_APP_TOKEN in the environment:
                          # scripts/publik-bake-token.cjs writes it to publik-app-token.txt for the build)
    git tag vX.Y.Z && git push origin vX.Y.Z   # CI builds + launch-tests the Windows installer and attaches it
    gh release upload vX.Y.Z dist/*.dmg        # after opening the dmg here and running the smoke test on it
