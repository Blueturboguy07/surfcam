// Writes publik-app-token.txt (in .gitignore) from the PUBLIK_APP_TOKEN environment variable, before a
// release build packs the app. publik.cjs reads that file next to itself: without it the packaged app
// cannot sign in. The token identifies the build, not a person. This script never prints it.
//
//   PUBLIK_APP_TOKEN=<the app token> node scripts/publik-bake-token.cjs   (CI: from the repo secret)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const token = String(process.env.PUBLIK_APP_TOKEN || '').trim();
if (!token.startsWith('pat_')) {
  console.error('publik-bake-token: PUBLIK_APP_TOKEN does not hold a publik app token. A build without it cannot sign in.');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'publik-app-token.txt');
fs.writeFileSync(file, token + '\n', { mode: 0o600 });
console.log('publik-bake-token: wrote publik-app-token.txt for the build');
