/**
 * Rebuild better-sqlite3 against the Electron ABI.
 *
 * `electron-rebuild` works out which ABI to target by reading the version of
 * the `electron` package it can resolve. Electron is a devDependency of the
 * frontend, not of this package, so running the bare command from here fails
 * with "Unable to find electron's version number" — which is what the old
 * `postinstall` script did on every fresh `npm install` in this folder.
 *
 * This resolves the version from wherever Electron actually lives and passes
 * it explicitly.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const BACKEND_DIR = path.join(__dirname, '..');

function findElectronVersion() {
  const searchPaths = [
    path.join(BACKEND_DIR, '..', 'frontend', 'node_modules'),
    path.join(BACKEND_DIR, 'node_modules'),
  ];

  for (const base of searchPaths) {
    const pkg = path.join(base, 'electron', 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
      } catch (e) {
        // Malformed; keep looking.
      }
    }
  }
  return null;
}

const version = findElectronVersion();

if (!version) {
  // Not an error: a CI install of the backend alone has nothing to target, and
  // failing here would break `npm install`.
  console.log('Electron not found; skipping the native rebuild.');
  console.log('Run "npm run rebuild:electron" once the frontend is installed.');
  process.exit(0);
}

console.log(`Rebuilding better-sqlite3 for Electron ${version}...`);

// Invoke the rebuild CLI through its JS entry point rather than the `npx.cmd`
// shim: since the fix for CVE-2024-27980, Node refuses to spawn a .cmd file
// without shell:true and fails with EINVAL.
const cli = path.join(BACKEND_DIR, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');

if (!fs.existsSync(cli)) {
  console.log('@electron/rebuild is not installed; skipping the native rebuild.');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [cli, '-f', '-w', 'better-sqlite3', '--version', version, '--module-dir', BACKEND_DIR],
  { cwd: BACKEND_DIR, stdio: 'inherit', shell: false }
);

process.exit(result.status === null ? 1 : result.status);
