#!/usr/bin/env node
/**
 * Patches @vitejs/plugin-react-swc to always use optimizeDeps.rolldownOptions
 * instead of the deprecated optimizeDeps.esbuildOptions.
 *
 * The plugin checks `"rolldownVersion" in vite` using its statically-imported
 * vite module. In this monorepo, the plugin resolves vite@6 from the root
 * node_modules (pinned for security), so the check returns false even though
 * the actual running Vite process is v8. This causes a deprecation warning.
 *
 * Since we are on Vite 8, we simply unconditionally use rolldownOptions.
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let pluginPath;
try {
  pluginPath = require.resolve('@vitejs/plugin-react-swc');
} catch {
  console.log('[patch-react-swc] @vitejs/plugin-react-swc not found, skipping.');
  process.exit(0);
}

const src = readFileSync(pluginPath, 'utf8');

// Already applied
const applied = `...{ rolldownOptions: { transform: { jsx: { runtime: "automatic" } } } }`;
if (src.includes(applied)) {
  console.log('[patch-react-swc] Already patched, skipping.');
  process.exit(0);
}

// Original form (un-patched)
const original = `..."rolldownVersion" in vite ? { rolldownOptions: { transform: { jsx: { runtime: "automatic" } } } } : { esbuildOptions: { jsx: "automatic" } }`;

if (!src.includes(original)) {
  console.log('[patch-react-swc] Pattern not found — plugin may have been updated. Skipping.');
  process.exit(0);
}

writeFileSync(pluginPath, src.replace(original, applied), 'utf8');
console.log('[patch-react-swc] Patched @vitejs/plugin-react-swc for Vite 8 rolldown compat.');
