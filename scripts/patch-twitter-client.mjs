#!/usr/bin/env node
/**
 * Patches agent-twitter-client with current GraphQL query IDs for Twitter/X.
 *
 * Twitter rotates these IDs periodically. When they go stale, the feed returns
 * a 404. Update the values below when that happens by finding the current IDs
 * in x.com's main JS bundle:
 *
 *   curl -s "$(curl -s https://x.com/ | grep -o 'src="[^"]*main[^"]*\.js"' | head -1 | grep -o 'https://[^"]*')" \
 *     | grep -oP 'queryId:"[^"]+",operationName:"HomeTimeline"'
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

let pkgDir;
try {
  // Resolve the package root from the main entry point
  const mainPath = require.resolve('agent-twitter-client');
  pkgDir = mainPath.replace(/\/dist\/.*$/, '');
} catch {
  console.log('[patch-twitter-client] agent-twitter-client not found, skipping.');
  process.exit(0);
}

// All dist files that need patching (the server uses the node ESM variant)
const DIST_FILES = [
  `${pkgDir}/dist/node/esm/index.mjs`,
  `${pkgDir}/dist/default/esm/index.mjs`,
  `${pkgDir}/dist/default/cjs/index.js`,
].filter(existsSync);

const PATCHES = [
  // HomeTimeline query ID (rotates periodically — update when feed returns 404)
  { old: 'HJFjzBgCs16TqxewQOeLNg', new: 'Fb7fyZ9MMCzvf_bNtwNdXA', name: 'HomeTimeline' },
  // HomeLatestTimeline query ID
  { old: 'K0X1xbCZUjttdK8RazKAlw', new: '2ee46L1AFXmnTa0EvUog-Q', name: 'HomeLatestTimeline' },
  // Stub out @roamhq/wrtc (ESM) — Conduit doesn't use Twitter Spaces/WebRTC,
  // but the static import crashes at startup when the native binary isn't present.
  {
    old: `import wrtc from '@roamhq/wrtc';`,
    new: `const wrtc = { nonstandard: {}, RTCPeerConnection: class {}, MediaStream: class {} };`,
    name: 'wrtc-esm-stub',
    silent: true, // only present in ESM files; skip warning for CJS files
  },
  // Stub out @roamhq/wrtc (CJS)
  {
    old: `var wrtc = require('@roamhq/wrtc');`,
    new: `var wrtc = { nonstandard: {}, RTCPeerConnection: class {}, MediaStream: class {} };`,
    name: 'wrtc-cjs-stub',
    silent: true, // only present in CJS files; skip warning for ESM files
  },
];

for (const filePath of DIST_FILES) {
  let src = readFileSync(filePath, 'utf8');
  let changed = false;

  for (const patch of PATCHES) {
    if (src.includes(patch.old)) {
      src = src.replaceAll(patch.old, patch.new);
      console.log(`[patch-twitter-client] ${patch.name}: patched in ${filePath.replace(pkgDir, 'agent-twitter-client')}`);
      changed = true;
    } else if (!src.includes(patch.new) && !patch.silent) {
      console.warn(`[patch-twitter-client] WARNING: ${patch.name} ID not found in ${filePath.replace(pkgDir, 'agent-twitter-client')} — may need updating`);
    }
  }

  if (changed) writeFileSync(filePath, src, 'utf8');
}
