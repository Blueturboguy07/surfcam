// Signs SurfCam.app with the Developer ID identity in this Mac's keychain, the way electron-builder signs it:
// @electron/osx-sign signs the inner binaries first (helpers, frameworks, dylibs), then the app, each with
// the hardened runtime, a secure timestamp and build/entitlements.mac.plist (package.json uses that file for
// both `entitlements` and `entitlementsInherit`). scripts/publik-release.sh calls it and installs the
// @electron/osx-sign version of package-lock.json outside the repo first.
//   node scripts/publik-mac-sign.cjs <SurfCam.app> <entitlements.plist> <identity> <path of @electron/osx-sign>
'use strict';
const path = require('node:path');

const [app, entitlements, identity, osxSign] = process.argv.slice(2);
if (!app || !entitlements || !identity || !osxSign) {
  console.error('usage: node scripts/publik-mac-sign.cjs <app> <entitlements> <identity> <@electron/osx-sign dir>');
  process.exit(2);
}
// signAsync returns a promise (sign is the callback form).
const { signAsync } = require(path.resolve(osxSign));

signAsync({
  app,
  platform: 'darwin',
  type: 'distribution',
  identity,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  strictVerify: true,
  optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
})
  .then(() => console.log(`publik-mac-sign: signed ${path.basename(app)} (${identity})`))
  .catch((e) => {
    console.error(`publik-mac-sign: signing failed: ${(e && e.message) || e}`);
    process.exit(1);
  });
