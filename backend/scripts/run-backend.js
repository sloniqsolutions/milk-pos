/**
 * Run the backend on the same runtime the desktop app uses.
 *
 * better-sqlite3 is a native module, so its compiled binary only loads on the
 * Node ABI it was built against. Plain Node 24 is NODE_MODULE_VERSION 137;
 * Electron 42 is 146. There is one `better_sqlite3.node` on disk, so it can
 * satisfy exactly one of them:
 *
 *   npm rebuild better-sqlite3   -> 137, `node server.js` works, the app breaks
 *   electron-rebuild             -> 146, the app works, `node server.js` breaks
 *
 * The app is what ships, so the binary is built for Electron (see the
 * `postinstall` script) and the backend is launched through Electron's bundled
 * Node here. That is also exactly how electron/main.js spawns it in production
 * — `process.execPath` with ELECTRON_RUN_AS_NODE=1 — so development and
 * production run identical code on an identical runtime.
 *
 * Usage:
 *   node scripts/run-backend.js            # run once
 *   node scripts/run-backend.js --watch    # restart on change (nodemon)
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BACKEND_DIR = path.join(__dirname, '..');
const SERVER = path.join(BACKEND_DIR, 'server.js');
const CLOUD_DIR = path.join(BACKEND_DIR, '..', 'cloud');
const CLOUD_SERVER = path.join(CLOUD_DIR, 'server.js');

/**
 * Bring the cloud API up alongside the till.
 *
 * The till talks to it on every sync, heartbeat and backup push, so a
 * developer starting the backend on its own used to get a silent stream of
 * "offline"/connection-refused noise until they remembered to start `cloud/`
 * in a second terminal. It has no native module (see cloud/package.json — pg
 * is pure JS), so plain Node runs it; no need for Electron's Node here.
 *
 * If it's already running (someone started it separately, or a previous
 * `npm run dev` is still up), this instance just fails to bind port 4000 and
 * exits — logged, not fatal, and the one already serving keeps going.
 */
function startCloud() {
  if (!fs.existsSync(CLOUD_SERVER)) {
    console.warn('[cloud] ../cloud/server.js not found — skipping auto-start.');
    return null;
  }

  const child = spawn(process.execPath, [CLOUD_SERVER], {
    cwd: CLOUD_DIR,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });

  child.on('error', (err) => console.error('[cloud] Failed to start:', err.message));
  child.on('exit', (code, signal) => {
    if (signal) return; // killed on our way out — not worth logging
    console.log(`[cloud] exited (code ${code})`);
  });

  return child;
}

/** The electron package's main export is the path to its executable. */
function findElectronBinary() {
  const searchPaths = [
    path.join(BACKEND_DIR, '..', 'frontend', 'node_modules'),
    path.join(BACKEND_DIR, 'node_modules'),
  ];

  for (const base of searchPaths) {
    try {
      const entry = require.resolve('electron', { paths: [base] });
      const binary = require(entry);
      if (typeof binary === 'string' && fs.existsSync(binary)) return binary;
    } catch (e) {
      // Not installed under this path; try the next.
    }
  }
  return null;
}

const electron = findElectronBinary();

if (!electron) {
  console.error(
    '\nCould not find the Electron binary.\n\n' +
    'The backend runs on Electron\'s Node so that better-sqlite3 matches the\n' +
    'ABI the packaged app uses. Install the frontend dependencies first:\n\n' +
    '  cd ../frontend && npm install\n'
  );
  process.exit(1);
}

const watch = process.argv.includes('--watch');

const env = {
  ...process.env,
  // Run Electron as a plain Node process: no window, no Chromium.
  ELECTRON_RUN_AS_NODE: '1',
};

let command;
let args;

if (watch) {
  // nodemon restarts the server on change; --exec points it at Electron.
  //
  // nodemon is invoked through its JS entry point rather than the `npx.cmd`
  // shim: since the fix for CVE-2024-27980, Node refuses to spawn a .cmd file
  // without shell:true and fails with EINVAL. Running the script directly
  // avoids needing a shell at all.
  const nodemon = path.join(BACKEND_DIR, 'node_modules', 'nodemon', 'bin', 'nodemon.js');
  if (!fs.existsSync(nodemon)) {
    console.error('nodemon is not installed. Run "npm install" in the backend folder.');
    process.exit(1);
  }
  const relElectron = path.relative(BACKEND_DIR, electron);
  const relServer = path.relative(BACKEND_DIR, SERVER);
  command = process.execPath;
  args = [nodemon, '--watch', '.', '--ext', 'js,json', '--exec', `${relElectron} ${relServer}`];
} else {
  command = electron;
  args = [SERVER];
}

const cloudChild = startCloud();

const child = spawn(command, args, {
  cwd: BACKEND_DIR,
  env,
  stdio: 'inherit',
  shell: false,
});

child.on('error', (err) => {
  console.error('Failed to start the backend:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (cloudChild && !cloudChild.killed) cloudChild.kill();
  process.exit(signal ? 1 : code === null ? 0 : code);
});

// Forward termination so Ctrl+C stops both children too.
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
    if (cloudChild && !cloudChild.killed) cloudChild.kill(sig);
  });
});
