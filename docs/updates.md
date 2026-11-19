# Updates

SurfCam updates itself on macOS and Windows. The code is `publik-updater.cjs` (the Electron part) and
`publik-update-verify.cjs` (the signature check). Both files are the same in every publik Electron app.

## How it works

1. The app asks `https://publikhq.com/api/updates/surfcam/` for two files: `latest.yml` (Windows) or
   `latest-mac.yml` (macOS), and the signature of that file (`latest.yml.sig` or `latest-mac.yml.sig`).
   It asks at launch, every 24 hours, and when you click **Check for Updates…** (macOS: the SurfCam menu;
   Windows: the Help menu).
2. The app verifies the signature with the publik update public key, which is in `publik-update-verify.cjs`.
   If the signature is missing or wrong, the app stops there. It downloads nothing.
3. The feed must name this app (`publikApp: surfcam`) and give a sha512 for each file.
4. electron-updater downloads the file that the feed names. It refuses the file if its sha512 is not the
   one in the signed feed. Windows downloads the NSIS installer. macOS downloads the zip, and Squirrel.Mac
   also refuses an app that does not satisfy the code signature of the running app (same bundle ID, same
   Developer ID). This keeps the camera permission.
5. The app asks: "SurfCam X is ready to install. Restart now?" **Later** installs the update when you quit.
   The app never restarts by itself.

A failure in the background is silent (the log has it). A manual check always shows its result.
`PUBLIK_UPDATES=0` in the environment stops the automatic checks. The CI launch tests set it.

## The feed contract (what publik serves)

| Request | Response |
|---|---|
| `GET /api/updates/surfcam/latest.yml` | the release asset `latest.yml`, byte for byte |
| `GET /api/updates/surfcam/latest.yml.sig` | the release asset `latest.yml.sig`, byte for byte |
| `GET /api/updates/surfcam/latest-mac.yml` | the release asset `latest-mac.yml`, byte for byte |
| `GET /api/updates/surfcam/latest-mac.yml.sig` | the release asset `latest-mac.yml.sig`, byte for byte |

- Serve the files from the scan-approved release without changes. One changed byte breaks the signature.
- The app adds `?noCache=<random>` to each request. Ignore the query string.
- A redirect is fine. A 404 means "no update" for the app.
- The base URL must not carry a query string: electron-updater copies the base query onto every file URL.
- The feed lists ABSOLUTE GitHub asset URLs. electron-updater's generic provider resolves each URL with
  `new URL(url, base)`, so an absolute URL stays as it is (checked in `node_modules/electron-updater`,
  and by the unit tests and the proof). The app downloads the installer from GitHub, not from publik.
- The app does not send electron-updater's `x-user-staging-id` header.

A feed file looks like this (`scripts/publik-update-feed.cjs write` makes it):

```yaml
version: '0.1.3'
publikApp: 'surfcam'
files:
  - url: 'https://github.com/Blueturboguy07/surfcam/releases/download/v0.1.3/SurfCam-0.1.3-mac-universal.zip'
    sha512: '<base64>'
    size: 123456789
  - url: 'https://github.com/Blueturboguy07/surfcam/releases/download/v0.1.3/SurfCam-0.1.3-mac-universal.dmg'
    sha512: '<base64>'
    size: 123456789
path: '<the url of the first file>'
sha512: '<the sha512 of the first file>'
releaseDate: '2026-11-18T00:00:00.000Z'
```

The `.sig` file is a minisign signature of the feed file. The app accepts these forms:

| Made with | Algorithm | File form |
|---|---|---|
| `tauri signer sign` (what `scripts/publik-update-feed.cjs` uses) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text, wrapped in base64 |
| `minisign -S` (minisign 0.8 and later) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text |
| `minisign -S -l` (legacy) | `Ed`: Ed25519 over the file | minisign text |

Electron's crypto has no BLAKE2b-512, so the app computes it with the `blakejs` package. Both algorithms
therefore work in the app; `-l` is not needed. The trusted comment must name the file (`file:latest.yml` or
`file:latest-mac.yml`). tauri and minisign write that by default; do not replace it with `-t`.

## Cut a release

One command on the maintainer's Mac (it holds the Developer ID certificate, the notarytool profile
`publik` and the update key in its keychain):

```sh
npm version 0.1.4 --no-git-tag-version   # package.json + package-lock.json
git commit -am "Release 0.1.4" && git push origin main
scripts/publik-release.sh 0.1.4
```

`scripts/publik-release.sh <version>` does the rest and stops at the first failed check, before it publishes:

| Step | What it does |
|---|---|
| 1. Checks | on `main`, clean, pushed; `package.json` and `package-lock.json` = `<version>`; newer than the latest release; tag `v<version>` free (a draft `v<version>` is resumed) |
| 2. Build | runs `publik-build.yml` on the commit: the unsigned universal app and the Windows installer, both with the publik app token and launch- and self-tested |
| 3. macOS app | signs it with `scripts/publik-mac-sign.cjs` (`@electron/osx-sign`: inner binaries first, hardened runtime, `build/entitlements.mac.plist`), notarizes, staples, makes the update zip from the stapled app |
| 4. macOS dmg | `publik-dmg.yml` packs the stapled app into the dmg (electron-builder, `--prepackaged`); the Mac signs, notarizes and staples the dmg |
| 5. Windows | the installer from step 2 (not code-signed) |
| 6. Feed | `SHA256SUMS.txt`; `latest.yml` and `latest-mac.yml` with absolute GitHub URLs, signed with the update key from the keychain (`scripts/publik-update-feed.cjs`) |
| 7. Verify | uploads all files to a DRAFT release, deletes the local copies, downloads each file back: feed signatures with the app's public key, sha512 and sha256, versions (Info.plist, exe = feed), `codesign`, `spctl`, `stapler`, the designated requirement, the app token (`scripts/publik-release-check.cjs`) |
| 8. Publish | publishes the draft as the latest release; checks that each file answers 200 |

- `--no-publish` stops after step 7 and leaves a complete, verified draft.
- Run it again after a failure: it resumes. State: `$TMPDIR/publik-release-surfcam-<version>/state`
  (`PUBLIK_RELEASE_WORK` moves it). A step that is done is not done again.
- It starts no app, prints no secret, writes no secret to disk, and keeps one copy of each file on disk.
- It cannot: publish a release whose files fail a check, replace a published release, or sign the Windows
  installer (SurfCam has no Windows code-signing certificate).
- `release.yml` runs when the tag appears; its guard sees the installer on the release and builds nothing.
- publik scans the release at intake and serves it after a clean scan. Then the apps update (the live
  update proof below shows it).

Without the script, the feed alone: `gh workflow run update-feed.yml -f tag=vX.Y.Z` (repo secrets
`PUBLIK_UPDATE_KEY`, `PUBLIK_UPDATE_KEY_PASSWORD`; it adds only missing feed files, **force** replaces them).

## Roll back

electron-updater never installs an older version. To roll back:

1. Stop the bad update: delete its feed files, and publik stops serving it.
   `gh release delete-asset vX.Y.Z latest.yml -y` (and `latest.yml.sig`, `latest-mac.yml`, `latest-mac.yml.sig`).
   Apps that have not downloaded it yet get a 404 and stay where they are.
2. Release the good code again with a HIGHER version (for example 0.1.4 with the code of 0.1.2), with its
   feed. Apps that installed the bad version update to it.

## Rotate the key

Every installed app trusts only the keys in `PUBLIK_UPDATE_PUBLIC_KEYS` (`publik-update-verify.cjs`).

1. Make a new key: `npx @tauri-apps/cli@2.12.4 signer generate -w new.key`. Put the private key and its
   password in the keychain and in the repo secrets. Do not delete the old key yet.
2. Add the new public key (the `RW…` line of `new.key.pub`, base64-decoded) to `PUBLIK_UPDATE_PUBLIC_KEYS`,
   next to the old key. Release that version, signed with the OLD key.
3. Wait until most users run that version. Then sign the feeds with the new key (change the secrets).
4. In a later release, remove the old key from the list.

Users who skip the transition release cannot verify feeds that the new key signs. They must install
again by hand. If the old private key leaks, do the same steps at once. Until users have the new list,
a leaked key lets an attacker sign a feed. On Windows the installer is not code-signed, so the key is
the only protection there. On macOS, Squirrel.Mac still requires the Developer ID signature.

## Test builds and the proof

`.github/workflows/updater-proof.yml` proves the updater on GitHub's macOS and Windows runners. It
builds two test versions, N and N+1, with `"publikUpdaterTest": true` in `package.json`. Only a test
build reads these environment variables:

| Variable | Effect (test builds only) |
|---|---|
| `PUBLIK_UPDATE_URL` | replaces `https://publikhq.com/api/updates/<slug>/` |
| `PUBLIK_UPDATER_TEST=report` | writes the running version to `PUBLIK_UPDATER_RESULT` and exits |
| `PUBLIK_UPDATER_TEST=update` | runs the same check, download and install, writes the result, quits to install |

Test versions are `0.0.0-updtest.*`. A test feed that the real key signs is therefore never newer than a
real release. The proof puts N+1 on a prerelease with a `v0.0.0-updtest.*` tag and deletes it at the end.

## Live update proof

`.github/workflows/live-update-proof.yml` (**Actions › Live update proof**, inputs `from_tag` and
`expect_version`) proves the update of the REAL release with the LIVE publik feed, as a user sees it:

```sh
gh workflow run live-update-proof.yml -f from_tag=v0.1.3 -f expect_version=0.1.4
```

Jobs: macOS Apple silicon (answers "Restart Now"), macOS Apple silicon (answers "Later", then quits and
opens the app), macOS Intel (Restart Now), Windows x64 (Restart Now, Later). Each job
(`.github/scripts/live-update-proof.cjs`):

1. downloads `from_tag` from GitHub and checks it against that release's signed feed;
2. macOS: sets the quarantine flag, checks Gatekeeper (`spctl`: Notarized Developer ID), copies the app
   with Finder and marks it as moved by the user (quarantine flag 0x0100, which a user's Finder drag sets
   and a scripted copy does not; without it macOS runs the app from a read-only translocated copy). On the
   first start it answers Gatekeeper's question with **Open**. Windows: runs the installer silently;
3. macOS: writes real TCC grants (camera, microphone, screen capture, accessibility) for
   `com.publik.surfcam` into the user and the system TCC database, bound to the app's designated
   requirement (`.github/scripts/live-proof-root.sh`, the only file that uses `sudo`);
4. starts the app normally. No test hook, no feed override, nobody signs in: SurfCam stays on its publik
   sign-in window and never opens the camera;
5. waits for the app's own update check. `expect_version` = the from version: the app must find no update
   and stay. A newer `expect_version`: the app must download it, ask "Restart now?", and run
   `expect_version` after the answer;
6. checks the version on disk and in the running app, the designated requirement, Gatekeeper, and that
   each stored TCC requirement is still satisfied (a runner cannot show a consent prompt: this is the check
   tccd makes before it uses a grant);
7. clicks **Check for Updates…** and reads "You’re up to date." (on Windows, when the hidden menu bar
   can be driven).

Logs, UI dumps, screenshots and `summary.json` are the run's artifacts. A failed check fails the job.
`test/publik-updater-ui.test.mjs` tests the 24-hour check, `PUBLIK_UPDATES=0`, the menu item and the
restart question with fake timers.

## Copy to another Electron app

1. Copy `publik-updater.cjs`, `publik-update-verify.cjs`, `scripts/publik-update-feed.cjs`,
   `.github/workflows/update-feed.yml`, `.github/workflows/updater-proof.yml`,
   `.github/scripts/updater-proof.cjs`, `.github/scripts/updater-electron-crypto.cjs` and this file.
2. `npm install electron-updater blakejs`.
3. In `package.json` › `build`: add the two `.cjs` files to `files`; set `publish` to
   `{ "provider": "generic", "url": "https://publikhq.com/api/updates/<slug>/" }`; add a `zip` target next
   to the mac `dmg` target.
4. In the main process, first thing in `app.whenReady()`:
   `if (startUpdates({ slug: '<slug>', appName: '<Name>' }).testHook) return;`
   If the app has its own menu, call `startUpdates({ ..., menu: false })` and add `updates.menuItem()`.
5. Replace `surfcam`, `SurfCam` and the file names in `update-feed.yml`, `updater-proof.yml` and
   `updater-proof.cjs` (bundle ID check, installer names, the Windows uninstall entry name).
6. Add the repo secrets `PUBLIK_UPDATE_KEY` and `PUBLIK_UPDATE_KEY_PASSWORD`.
7. Add `PUBLIK_UPDATES: '0'` to the workflows that launch the app, and exclude `v*-updtest*` tags from
   any workflow that a `v*` tag starts.
8. Push, and check that the proof passes on both runners.
