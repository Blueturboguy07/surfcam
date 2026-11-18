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

1. Set the new version in `package.json`. Commit.
2. On the maintainer's Mac, run `npm run dist:mac`. It makes the signed, notarized universal **dmg and zip**
   in `dist/`. (The zip is new: Squirrel.Mac installs from it.)
   - If the app comes from `publik-build.yml` instead: sign, notarize and staple the app, then make the zip
     from the stapled app: `ditto -c -k --sequesterRsrc --keepParent SurfCam.app SurfCam-<version>-mac-universal.zip`.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. `release.yml` builds and tests the Windows
   installer, puts it on the release, then runs `update-feed.yml`, which adds `latest.yml` and its `.sig`.
4. Upload the mac files: `gh release upload vX.Y.Z dist/*.dmg dist/*.zip`.
5. Make the mac feed: run **Actions › Update feed** with the tag (or
   `gh workflow run update-feed.yml -f tag=vX.Y.Z`). It adds `latest-mac.yml` and its `.sig`. It adds only
   missing feed files. Use **force** after you replace an installer file.
6. Check that the release holds the four feed files.

For a publik release (a draft that publik scans): put all the installer files on the draft, then run
**Update feed** for the draft's tag BEFORE the scan. The scan then sees the feed files too.

The update key is needed only in step 5 (and 3): `update-feed.yml` reads the repo secrets
`PUBLIK_UPDATE_KEY` and `PUBLIK_UPDATE_KEY_PASSWORD`. `publik-build.yml` builds the installers and does
not need the key. Without CI, run the same script on a Mac that has the key in its keychain:

```sh
PUBLIK_UPDATE_KEY="$(security find-generic-password -s publik-update-key -a mann-private -w)" \
PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s publik-update-key -a mann-password -w)" \
node scripts/publik-update-feed.cjs release --tag vX.Y.Z --app surfcam --repo Blueturboguy07/surfcam
```

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
