#!/usr/bin/env bash
# publik-release.sh — cuts one SurfCam release for every OS SurfCam ships (docs/updates.md › Cut a release).
#
#   scripts/publik-release.sh <version> [--no-publish]        for example: scripts/publik-release.sh 0.1.4
#
# Run it on the maintainer's Mac: the Developer ID certificate, the notarytool profile "publik" and the
# publik update key live in its keychain. Before: set <version> in package.json and package-lock.json
# (npm version <version> --no-git-tag-version), commit and push to main. The script then does the rest:
#   1. checks: on main, clean tree, pushed; package.json and package-lock.json carry <version>; <version> is
#      newer than the latest release; the tag v<version> is free (a DRAFT v<version> is resumed)
#   2. CI: publik-build.yml on this commit (the unsigned universal SurfCam.app and the Windows installer,
#      both with the publik app token, launch- and self-tested on the runners); a green run is reused
#   3. macOS app: signs it with Developer ID (scripts/publik-mac-sign.cjs: @electron/osx-sign, inner binaries
#      first, hardened runtime, build/entitlements.mac.plist), notarizes it (notarytool), staples it, and makes
#      the update zip from the stapled app; the zip goes to the DRAFT release v<version>
#   4. macOS dmg: publik-dmg.yml packs the stapled app with electron-builder's dmg target (no signing); this
#      Mac signs, notarizes and staples the dmg
#   5. Windows: the installer from step 2 (not code-signed, as every SurfCam release so far)
#   6. SHA256SUMS.txt and the update feed (scripts/publik-update-feed.cjs): latest.yml + latest-mac.yml with
#      absolute GitHub URLs, signed with the publik update key from the keychain
#   7. uploads everything to the draft, deletes the local copies, downloads every file back and verifies it:
#      feed signatures (the app's public key), sha512/sha256, versions (Info.plist, exe = feed), codesign,
#      spctl, stapler, the designated requirement, the publik app token
#   8. publishes the draft as the latest release (not with --no-publish)
# It stops before publishing at the first failed check, can run again to resume (state: $PUBLIK_RELEASE_WORK,
# default ${TMPDIR}/publik-release-surfcam-<version>), starts no app and prints no secret.
set -euo pipefail

APP=SurfCam
SLUG=surfcam
REPO=Blueturboguy07/surfcam
BRANCH=main
BUNDLE_ID=com.publik.surfcam
IDENTITY='Developer ID Application: Mann Bellani (R5R3ZS54LV)'
NOTARY_PROFILE=publik
KEY_SERVICE=publik-update-key
DR_EXPECTED='identifier "com.publik.surfcam" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = R5R3ZS54LV'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/publik-release-check.cjs"
ENT="$ROOT/build/entitlements.mac.plist"

say() { printf '\n== %s\n' "$*"; api_room; }
api_room() { # waits while the GitHub API limit (shared with other tools) is nearly used up; this check is free
  local left reset
  left="$(gh api rate_limit --jq .resources.core.remaining 2>/dev/null || echo 0)"
  while [ "$left" -lt 100 ]; do
    reset="$(gh api rate_limit --jq '.resources.core.reset | todate' 2>/dev/null || echo '?')"
    echo "   the GitHub API limit is nearly used up ($left calls left, reset $reset): waiting"
    sleep 90
    left="$(gh api rate_limit --jq .resources.core.remaining 2>/dev/null || echo 0)"
  done
}
ok() { printf '   ok: %s\n' "$*"; }
die() { printf '\npublik-release: STOP: %s\n' "$*" >&2; exit 1; }
need_mb() { # <MB> <what>: stops (resumable) when the disk lacks the room
  local free; free="$(df -m "$WORK" | awk 'NR==2 {print $4}')"
  [ "$free" -ge "$1" ] || die "$2 needs about $1 MB of free disk, $free MB are free. Free some space, then run the script again (it resumes)."
}

VERSION="${1:-}"
PUBLISH=1
[ "${2:-}" = "--no-publish" ] && PUBLISH=0
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/publik-release.sh <version> [--no-publish], for example 0.1.4"
TAG="v$VERSION"
DMG="$APP-$VERSION-mac-universal.dmg"
ZIP="$APP-$VERSION-mac-universal.zip"
EXE="$APP-Setup-$VERSION-win-x64.exe"
BASE="https://github.com/$REPO/releases/download/$TAG/"
WORK="${PUBLIK_RELEASE_WORK:-${TMPDIR:-/tmp}/publik-release-$SLUG-$VERSION}"
STATE="$WORK/state"
OUT="$WORK/out"
MAC="$WORK/mac"
APP_PATH="$MAC/$APP.app"
mkdir -p "$STATE" "$OUT"
mark() { touch "$STATE/$1"; }
done_() { [ -f "$STATE/$1" ]; }
reset_state() { # the work of another commit is not reused: its files go, its state goes
  local f
  for f in "$STATE"/*; do [ ! -f "$f" ] || rm "$f"; done
  for f in "$OUT"/*; do [ ! -f "$f" ] || rm "$f"; done
  for f in "$OUT/feed" "$MAC" "$WORK/verify"; do [ ! -d "$f" ] || rm -r "$f"; done
}

# ------------------------------------------------------------------ 1. checks
say "1. checks ($TAG, work folder $WORK)"
[ "$(uname)" = Darwin ] || die "run this on the Mac that holds the Developer ID certificate"
for t in gh git node npm xcrun codesign spctl hdiutil ditto security shasum plutil lipo; do
  command -v "$t" > /dev/null || die "missing tool: $t"
done
cd "$ROOT"
git fetch --quiet origin "$BRANCH" --tags
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "check out $BRANCH first"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
SHA="$(git rev-parse HEAD)"
[ "$SHA" = "$(git rev-parse "origin/$BRANCH")" ] || die "HEAD is not origin/$BRANCH: push (or pull) first"
ok "on $BRANCH at $SHA, clean, pushed"
if [ "$(cat "$STATE/sha" 2>/dev/null)" != "$SHA" ]; then
  [ -z "$(ls -A "$STATE")" ] || ok "the work folder holds the work of another commit: starting again for $SHA"
  reset_state
  echo "$SHA" > "$STATE/sha"
fi
pkg_v="$(node -p "require('./package.json').version")"
lock_v="$(node -p "const l = require('./package-lock.json'); l.version + ' ' + l.packages[''].version")"
[ "$pkg_v" = "$VERSION" ] || die "package.json says $pkg_v. Bump first: npm version $VERSION --no-git-tag-version, then commit and push"
[ "$lock_v" = "$VERSION $VERSION" ] || die "package-lock.json says $lock_v, not $VERSION"
ok "package.json and package-lock.json: $VERSION"
latest="$(gh release list -R "$REPO" --exclude-drafts --exclude-pre-releases -L 1 --json tagName --jq '.[0].tagName // ""')"
newest="$(printf '%s\n%s\n' "${latest#v}" "$VERSION" | sort -V | tail -1)"
[ "$newest" = "$VERSION" ] && [ "${latest#v}" != "$VERSION" ] || die "$VERSION is not newer than the latest release $latest"
ok "newer than the latest release $latest"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" > /dev/null 2>&1; then
  die "the tag $TAG exists already (a published release or a stray tag): pick the next version"
fi
RELEASE_ID="$(gh api "repos/$REPO/releases" --paginate --jq ".[] | select(.tag_name == \"$TAG\") | .id")"
if [ -n "$RELEASE_ID" ]; then
  rel="$(gh api "repos/$REPO/releases/$RELEASE_ID" --jq '"\(.draft) \(.target_commitish)"')"
  [ "${rel%% *}" = true ] || die "a published release $TAG exists already"
  if [ "${rel#* }" != "$SHA" ]; then
    # A draft without files (a run that stopped before its first upload) moves to this commit.
    n="$(gh api "repos/$REPO/releases/$RELEASE_ID" --jq '.assets | length')"
    [ "$n" = 0 ] || die "the draft $TAG targets ${rel#* } and holds $n files, not $SHA: delete that draft or check out its commit"
    gh api -X PATCH "repos/$REPO/releases/$RELEASE_ID" -f target_commitish="$SHA" > /dev/null
    ok "the empty draft $TAG now targets $SHA"
  fi
  ok "the tag is free; resuming the draft $TAG (release $RELEASE_ID)"
else
  ok "the tag $TAG is free"
fi

# ------------------------------------------------------------------ helpers: CI, notarization, uploads
wait_run() { # <run id> <what>
  local s c
  echo "   waiting for $2: https://github.com/$REPO/actions/runs/$1"
  while :; do
    # A failed request (for example the API rate limit) is retried; it does not stop the release.
    s="$(gh run view "$1" -R "$REPO" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null || echo 'unknown unknown')"
    [ "${s%% *}" = completed ] && break
    sleep 90 # the API limit is shared: at most one call per 90 seconds while waiting
  done
  c="${s#* }"
  [ "$c" = success ] || die "$2 ended with $c: https://github.com/$REPO/actions/runs/$1 (run the script again to retry)"
  ok "$2: success"
}
dispatch() { # <workflow file> <state name> [inputs...]: a run of the workflow on this commit (reused when it is green or running)
  local wf="$1" name="$2" id="" s
  shift 2
  [ -f "$STATE/$name" ] && id="$(cat "$STATE/$name")"
  if [ -n "$id" ]; then
    s="$(gh run view "$id" -R "$REPO" --json status,conclusion,headSha --jq '"\(.headSha) \(.status) \(.conclusion)"')"
    case "$s" in
      "$SHA completed success" | "$SHA in_progress "* | "$SHA queued "* | "$SHA waiting "* | "$SHA pending "*) ;;
      *) echo "   the earlier run $id ($s) is not usable: starting a new one"; id="" ;;
    esac
  fi
  if [ -z "$id" ]; then
    local since; since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    gh workflow run "$wf" -R "$REPO" --ref "$BRANCH" "$@"
    for i in 1 2 3 4; do
      if [ "$i" = 1 ]; then sleep 20; else sleep 90; fi
      id="$(gh run list -R "$REPO" --workflow "$wf" --event workflow_dispatch --commit "$SHA" -L 5 --json databaseId,createdAt \
        --jq "[.[] | select(.createdAt >= \"$since\")] | .[-1].databaseId // \"\"" 2>/dev/null || true)"
      [ -n "$id" ] && break
    done
    [ -n "$id" ] || die "the run of $wf did not show up"
  fi
  echo "$id" > "$STATE/$name"
  RUN_ID="$id"
}
notarize() { # <file> <label>
  local file="$1" label="$2" id status
  id="$(cat "$STATE/notary-$label" 2>/dev/null || true)"
  if [ -z "$id" ]; then
    xcrun notarytool submit "$file" --keychain-profile "$NOTARY_PROFILE" --no-wait --output-format plist > "$WORK/notary-$label-submit.plist"
    id="$(plutil -extract id raw "$WORK/notary-$label-submit.plist")"
    echo "$id" > "$STATE/notary-$label"
  fi
  echo "   notarization of the $label: submission $id, waiting for Apple"
  xcrun notarytool wait "$id" --keychain-profile "$NOTARY_PROFILE" --timeout 2h > "$WORK/notary-$label-wait.txt" 2>&1 || true
  xcrun notarytool info "$id" --keychain-profile "$NOTARY_PROFILE" --output-format plist > "$WORK/notary-$label-info.plist"
  status="$(plutil -extract status raw "$WORK/notary-$label-info.plist")"
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" "$WORK/notary-$label-log.json" > /dev/null 2>&1 || true
    rm -f "$STATE/notary-$label"
    die "notarization of the $label: $status (Apple's log: $WORK/notary-$label-log.json)"
  fi
  ok "notarization of the $label: Accepted (submission $id)"
}
ensure_draft() {
  [ -n "$RELEASE_ID" ] && return
  local notes="$WORK/notes.md" changes
  if [ -n "${PUBLIK_RELEASE_NOTES:-}" ]; then changes="$(cat "$PUBLIK_RELEASE_NOTES")"
  else changes="$(git log --format='- %s' "$latest..HEAD")"; fi
  cat > "$notes" <<EOF
$APP $VERSION.

$changes

macOS: \`$DMG\` (Apple silicon + Intel), Developer ID signed, notarized and stapled. \`$ZIP\` is the update file.
Windows 10/11 (64-bit): \`$EXE\`, not code-signed: SmartScreen shows a warning the first time (More info, then Run anyway).
$APP 0.1.3 and later update themselves: $APP asks publik for a new version when it opens, every 24 hours, and when you click **Check for Updates…** (macOS: the $APP menu; Windows: the Help menu). It asks before it restarts.
Update feed: \`latest.yml\`, \`latest-mac.yml\` and their \`.sig\` files (docs/updates.md).
What is sent and how to turn it off: https://publikhq.com/skills/telemetry.md
EOF
  # The id comes from the answer itself: the list of releases can show a new draft only seconds later.
  RELEASE_ID="$(gh api -X POST "repos/$REPO/releases" -f tag_name="$TAG" -f target_commitish="$SHA" -f name="$APP $VERSION" \
    -F draft=true -F body=@"$notes" --jq .id)"
  [ -n "$RELEASE_ID" ] || die "the draft $TAG was not created"
  ok "draft release $TAG created (release $RELEASE_ID, target $SHA)"
}
asset_digest() { # <name>: "sha256:<hex>", "none" (no digest from the API) or "" (not on the draft)
  gh api "repos/$REPO/releases/$RELEASE_ID/assets" --paginate --jq ".[] | select(.name == \"$1\") | (.digest // \"none\")"
}
upload() { # <file>: puts the file on the draft unless the same bytes are there
  local f="$1" name remote want
  name="$(basename "$f")"
  want="sha256:$(shasum -a 256 "$f" | cut -d' ' -f1)"
  remote="$(asset_digest "$name")"
  if [ "$remote" = "$want" ]; then ok "$name is on the draft already"; return; fi
  if [ -n "$remote" ]; then gh release upload "$TAG" "$f" -R "$REPO" --clobber > /dev/null; else gh release upload "$TAG" "$f" -R "$REPO" > /dev/null; fi
  remote="$(asset_digest "$name")"
  [ "$remote" = "$want" ] || [ "$remote" = none ] || die "the upload of $name has $remote, the local file $want"
  ok "uploaded $name ($remote)"
}
on_draft() { [ -n "$RELEASE_ID" ] && [ -n "$(asset_digest "$1")" ]; }
app_checks() { # <SurfCam.app> <label>: the checks of a signed, notarized, stapled app
  local app="$1" label="$2" v dr a
  v="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")"
  [ "$v" = "$VERSION" ] || die "$label: Info.plist version $v, not $VERSION"
  [ "$(plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist")" = "$BUNDLE_ID" ] || die "$label: bundle ID"
  a="$(lipo -archs "$app/Contents/MacOS/$APP")"
  [[ "$a" == *x86_64* && "$a" == *arm64* ]] || die "$label: architectures $a"
  ok "$label: Info.plist $v, $BUNDLE_ID, universal ($a)"
  local info ent gk
  codesign --verify --deep --strict "$app" || die "$label: codesign --verify --deep --strict failed"
  info="$(codesign -dvv "$app" 2>&1)"
  grep -q "^Authority=$IDENTITY" <<< "$info" || die "$label: not signed by $IDENTITY"
  grep -q 'flags=0x10000(runtime)' <<< "$info" || die "$label: no hardened runtime"
  dr="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
  [ "$dr" = "$DR_EXPECTED" ] || die "$label: designated requirement changed: $dr"
  ent="$(codesign -d --entitlements - --xml "$app" 2>/dev/null)"
  grep -q 'com.apple.security.device.camera' <<< "$ent" || die "$label: no camera entitlement"
  ok "$label: codesign --verify --deep --strict: valid; $IDENTITY; hardened runtime; camera entitlement"
  ok "$label: designated => $dr"
  xcrun stapler validate "$app" > /dev/null || die "$label: no stapled ticket"
  gk="$(spctl -a -t exec -vv "$app" 2>&1 || true)"
  grep -q 'source=Notarized Developer ID' <<< "$gk" || die "$label: spctl: $gk"
  ok "$label: stapler validate: worked; spctl: $(tr '\n' ' ' <<< "$gk")"
  node "$CHECK" asar "$app/Contents/Resources/app.asar" --version "$VERSION" | sed 's/^/   /' || die "$label: app.asar check failed"
}
dmg_checks() { # <dmg> <label>
  local dmg="$1" label="$2" mnt="$WORK/mnt"
  local info gk
  codesign --verify --strict "$dmg" || die "$label: codesign --verify failed"
  info="$(codesign -dvv "$dmg" 2>&1)"
  grep -q "^Authority=$IDENTITY" <<< "$info" || die "$label: not signed by $IDENTITY"
  xcrun stapler validate "$dmg" > /dev/null || die "$label: no stapled ticket"
  gk="$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1 || true)"
  grep -q 'source=Notarized Developer ID' <<< "$gk" || die "$label: spctl: $gk"
  ok "$label: signed by $IDENTITY; stapler validate: worked; spctl: $(tr '\n' ' ' <<< "$gk")"
  mkdir -p "$mnt"
  hdiutil attach "$dmg" -nobrowse -noautoopen -readonly -mountpoint "$mnt" -quiet || die "$label: does not mount"
  [ -L "$mnt/Applications" ] || { hdiutil detach "$mnt" -quiet; die "$label: no Applications link"; }
  app_checks "$mnt/$APP.app" "$label › $APP.app"
  hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet
}

# ------------------------------------------------------------------ 2. CI build
say "2. CI build (publik-build.yml)"
if on_draft "$ZIP" && on_draft "$DMG" && on_draft "$EXE"; then
  ok "the draft holds the zip, the dmg and the installer: no build needed"
  CI_RUN="$(cat "$STATE/ci-build" 2>/dev/null || true)"
else
  dispatch publik-build.yml ci-build
  CI_RUN="$RUN_ID"
  wait_run "$CI_RUN" "publik build"
  steps="$(gh run view "$CI_RUN" -R "$REPO" --json jobs --jq '[.jobs[].steps[] | select(.name | test("^Check the|self-test")) | "\(.name)=\(.conclusion)"] | join("; ")')"
  [[ "$steps" == *"Check the app=success"* && "$steps" == *"Check the packed app=success"* && "$steps" != *"=failure"* ]] || die "the CI checks of the app token and the self-test did not all pass: $steps"
  ok "CI checked both builds (app token packed, publik self-test): $steps"
fi

# ------------------------------------------------------------------ 3. macOS app: sign, notarize, staple, update zip
say "3. macOS app"
if on_draft "$ZIP"; then
  ok "$ZIP is on the draft"
else
  if [ ! -f "$STATE/zip-made" ]; then
    if [ -d "$MAC" ] && [ "$(cat "$STATE/mac-from-run" 2>/dev/null)" != "$CI_RUN" ]; then
      rm -r "$MAC"
      ok "deleted a local app of an earlier CI run"
    fi
    if [ ! -d "$APP_PATH" ]; then
      rm -f "$STATE/mac-signed" "$STATE/notary-app" "$STATE/mac-stapled"
      need_mb 1000 "the unsigned app (download + unpack)"
      gh run download "$CI_RUN" -R "$REPO" -n surfcam-mac-universal-unsigned-app -D "$WORK/ci-mac"
      mkdir -p "$MAC"
      ditto -x -k "$WORK/ci-mac/SurfCam-mac-universal-unsigned-app.zip" "$MAC"
      echo "$CI_RUN" > "$STATE/mac-from-run"
      rm -f "$WORK/ci-mac/SurfCam-mac-universal-unsigned-app.zip"
      rmdir "$WORK/ci-mac"
      ok "unpacked the CI app: $(du -sm "$APP_PATH" | cut -f1) MB"
    fi
    if ! done_ mac-signed; then
      [ "$(plutil -extract CFBundleShortVersionString raw "$APP_PATH/Contents/Info.plist")" = "$VERSION" ] || die "the CI app is not $VERSION"
      osx_v="$(node -p "require('./package-lock.json').packages['node_modules/@electron/osx-sign'].version")"
      if [ ! -d "$WORK/tools/node_modules/@electron/osx-sign" ]; then
        npm install --prefix "$WORK/tools" --no-audit --no-fund --loglevel=error "@electron/osx-sign@$osx_v" > /dev/null
      fi
      node "$ROOT/scripts/publik-mac-sign.cjs" "$APP_PATH" "$ENT" "$IDENTITY" "$WORK/tools/node_modules/@electron/osx-sign" || die "signing the app failed"
      codesign --verify --deep --strict "$APP_PATH" || die "the signed app does not verify"
      mark mac-signed
    fi
    if ! done_ mac-stapled; then
      if [ ! -f "$STATE/notary-app" ]; then
        need_mb 400 "the notarization zip"
        ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$WORK/notarize-app.zip"
        notarize "$WORK/notarize-app.zip" app
        rm -f "$WORK/notarize-app.zip"
      else
        notarize "$APP_PATH" app
      fi
      xcrun stapler staple "$APP_PATH" > /dev/null || die "stapling the app failed"
      mark mac-stapled
    fi
    app_checks "$APP_PATH" "$APP.app (signed here)"
    need_mb 400 "the update zip"
    ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$OUT/$ZIP"
    mark zip-made
    ok "$ZIP made from the stapled app ($(du -m "$OUT/$ZIP" | cut -f1) MB)"
  fi
  [ -f "$OUT/$ZIP" ] || die "$OUT/$ZIP is missing: delete $STATE/zip-made and run again"
  ensure_draft
  upload "$OUT/$ZIP"
fi
if [ -d "$MAC" ]; then rm -r "$MAC"; ok "deleted the local app (the zip holds it)"; fi

# ------------------------------------------------------------------ 4. macOS dmg
say "4. macOS dmg (publik-dmg.yml packs the stapled app; this Mac signs, notarizes, staples)"
ensure_draft
if on_draft "$DMG"; then
  ok "$DMG is on the draft"
else
  if [ ! -f "$OUT/$DMG" ]; then
    rm -f "$STATE/dmg-signed" "$STATE/notary-dmg"
    dispatch publik-dmg.yml dmg-build -f "tag=$TAG"
    wait_run "$RUN_ID" "publik dmg"
    need_mb 400 "the dmg"
    gh run download "$RUN_ID" -R "$REPO" -n surfcam-dmg -D "$WORK/ci-dmg"
    mv "$WORK/ci-dmg/$DMG" "$OUT/$DMG"
    rmdir "$WORK/ci-dmg"
  fi
  if ! done_ dmg-signed; then
    codesign --force --sign "$IDENTITY" --timestamp "$OUT/$DMG"
    mark dmg-signed
  fi
  if ! done_ dmg-done; then
    notarize "$OUT/$DMG" dmg
    xcrun stapler staple "$OUT/$DMG" > /dev/null || die "stapling the dmg failed"
    dmg_checks "$OUT/$DMG" "$DMG"
    mark dmg-done
  fi
fi

# ------------------------------------------------------------------ 5. Windows installer
say "5. Windows installer"
if [ ! -f "$OUT/$EXE" ] && ! on_draft "$EXE"; then
  need_mb 300 "the Windows installer"
  gh run download "$CI_RUN" -R "$REPO" -n surfcam-windows-installer -D "$WORK/ci-win"
  mv "$WORK/ci-win/$EXE" "$OUT/$EXE"
  rm -f "$WORK"/ci-win/*
  rmdir "$WORK/ci-win"
fi
if [ -f "$OUT/$EXE" ]; then
  node "$CHECK" exe "$OUT/$EXE" --version "$VERSION" | sed 's/^/   /' || die "$EXE: version check failed"
fi

# ------------------------------------------------------------------ 6. SHA256SUMS.txt and the signed feed
say "6. SHA256SUMS.txt and the update feed"
if [ ! -f "$STATE/feed-done" ]; then
  for f in "$ZIP" "$DMG" "$EXE"; do
    if [ ! -f "$OUT/$f" ]; then need_mb 300 "$f"; gh release download "$TAG" -R "$REPO" --pattern "$f" --dir "$OUT"; fi
  done
  (cd "$OUT" && shasum -a 256 "$DMG" "$ZIP" "$EXE" > SHA256SUMS.txt)
  [ ! -d "$OUT/feed" ] || rm -r "$OUT/feed"
  node "$ROOT/scripts/publik-update-feed.cjs" write --app "$SLUG" --version "$VERSION" --download-base "$BASE" \
    --win "$OUT/$EXE" --mac-zip "$OUT/$ZIP" --mac-dmg "$OUT/$DMG" --out "$OUT/feed"
  # The update key goes from the keychain into the environment of the signing process only; it is never printed.
  PUBLIK_UPDATE_KEY="$(security find-generic-password -s "$KEY_SERVICE" -a mann-private -w)" \
  PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s "$KEY_SERVICE" -a mann-password -w)" \
    node "$ROOT/scripts/publik-update-feed.cjs" sign "$OUT/feed/latest.yml" "$OUT/feed/latest-mac.yml"
  mark feed-done
fi
ok "feed: $(sed -n 1p "$OUT/feed/latest.yml"), $(sed -n 1p "$OUT/feed/latest-mac.yml")"

# ------------------------------------------------------------------ 7. upload, download back, verify
say "7. upload to the draft $TAG, then download every file back and verify it"
for f in "$DMG" "$EXE" "$ZIP"; do [ -f "$OUT/$f" ] && upload "$OUT/$f"; done
upload "$OUT/SHA256SUMS.txt"
for f in latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig; do upload "$OUT/feed/$f"; done
for f in "$DMG" "$EXE" "$ZIP"; do rm -f "$OUT/$f"; done
ok "deleted the local copies of the installers"
if [ ! -f "$STATE/verified" ]; then
  V="$WORK/verify"
  [ ! -d "$V" ] || rm -r "$V"
  mkdir -p "$V/feed" "$V/files"
  names="$(gh api "repos/$REPO/releases/$RELEASE_ID/assets" --paginate --jq '.[].name' | sort | tr '\n' ' ')"
  want="$(printf '%s\n' "$DMG" "$EXE" "$ZIP" SHA256SUMS.txt latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig | sort | tr '\n' ' ')"
  [ "$names" = "$want" ] || die "the draft holds [$names], want [$want]"
  ok "the draft holds exactly: $names"
  gh release download "$TAG" -R "$REPO" --dir "$V/feed" --pattern 'latest*' --pattern SHA256SUMS.txt
  node "$CHECK" feed "$V/feed" "$V/files" --version "$VERSION" --app "$SLUG" --base "$BASE" | sed 's/^/   /' || die "the feed check failed"
  for f in "$EXE" "$DMG" "$ZIP"; do
    need_mb 900 "the check of $f"
    gh release download "$TAG" -R "$REPO" --dir "$V/files" --pattern "$f"
    node "$CHECK" feed "$V/feed" "$V/files" --version "$VERSION" --app "$SLUG" --base "$BASE" | grep -E "^(PASS|FAIL) $f" | sed 's/^/   /' || die "$f does not match the feed"
    node "$CHECK" sums "$V/feed/SHA256SUMS.txt" "$V/files" | grep -v '^skip' | sed 's/^/   /' || die "$f does not match SHA256SUMS.txt"
    case "$f" in
      *.exe) node "$CHECK" exe "$V/files/$f" --version "$VERSION" | sed 's/^/   /' || die "$f: version" ;;
      *.dmg) dmg_checks "$V/files/$f" "$f (downloaded back)" ;;
      *.zip)
        mkdir -p "$V/zip"
        ditto -x -k "$V/files/$f" "$V/zip"
        app_checks "$V/zip/$APP.app" "$f › $APP.app (downloaded back)"
        rm -r "$V/zip" ;;
    esac
    rm -f "$V/files/$f"
  done
  mark verified
  ok "every file on the draft verified"
fi

# ------------------------------------------------------------------ 8. publish
if [ "$PUBLISH" = 0 ]; then
  say "stopped before publishing (--no-publish): the draft $TAG is complete and verified"
  exit 0
fi
say "8. publish $TAG"
gh release edit "$TAG" -R "$REPO" --draft=false --latest > /dev/null
mark published
for f in "$DMG" "$ZIP" "$EXE" latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig SHA256SUMS.txt; do
  code="$(curl -s -o /dev/null -L -r 0-0 -w '%{http_code}' "$BASE$f")"
  [ "$code" = 200 ] || [ "$code" = 206 ] || die "published, but $BASE$f answers $code"
done
[ "$(gh api "repos/$REPO/releases/latest" --jq .tag_name)" = "$TAG" ] || die "published, but $TAG is not the latest release"
ok "published: https://github.com/$REPO/releases/tag/$TAG (the latest release; every file downloads)"
for d in "$WORK/verify" "$WORK/tools" "$OUT"; do [ ! -d "$d" ] || rm -r "$d"; done
ok "deleted the local work files (the state folder $STATE stays)"
