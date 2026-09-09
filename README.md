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
| macOS (Apple silicon + Intel) | `SurfCam-<version>-mac-universal.dmg` | Signed with a Developer ID and notarized by Apple, so it opens like any other app. Drag SurfCam to Applications. macOS asks for camera access once. |
| Windows 10/11 (64-bit) | `SurfCam-Setup-<version>-win-x64.exe` | One-click installer (per user, no admin). It is not code-signed, so SmartScreen shows "Windows protected your PC" the first time: click **More info → Run anyway**. Windows must allow desktop apps to use the camera (Settings › Privacy & security › Camera). |

Same code, same detection, same HUD on both. Every Windows build is produced and launch-tested on a
real Windows machine in CI (`.github/workflows/release.yml`) before it is attached to a release.

## Run from source

    git clone https://github.com/Blueturboguy07/surfcam && cd surfcam
    npm install
    npm start

Zero engine installs. Node + npm only. Camera permission is asked once.

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

- `npm test` — the detector's unit tests (jogging = no events, jumps, ducks, lanes, crouch regressions).
- `npm run smoke` — launches the app with Chromium's synthetic camera and passes only once the pose
  model is loaded and frames are flowing. `node test/smoke.mjs <path-to-binary>` runs the same check
  against a packaged build; CI runs it against the Windows installer's installed copy.

- `SURFCAM_STATUS=/path/status.json npm start` writes live tracking state twice a second.
- `SURFCAM_PROBE=1 npm start` injects a keydown counter into the game iframe, fires a test key,
  and logs what the game frame received.

## Releasing

    npm run dist:mac      # signed + notarized universal dmg in dist/ (needs the Developer ID in the keychain
                          # and APPLE_KEYCHAIN_PROFILE=<notarytool profile>)
    git tag vX.Y.Z && git push origin vX.Y.Z   # CI builds + launch-tests the Windows installer and attaches it
    gh release upload vX.Y.Z dist/*.dmg        # after opening the dmg here and running the smoke test on it
