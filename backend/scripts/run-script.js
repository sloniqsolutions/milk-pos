/**
 * Run a maintenance script on Electron's Node.
 *
 * Anything that requires db/database.js needs the same runtime the app uses,
 * because better-sqlite3's binary is built for Electron's ABI — see
 * scripts/run-backend.js for the full explanation.
 *
 *   node scripts/run-script.js scripts/seed_blaze_menu.js [--replace]
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BACKEND_DIR = path.join(__dirname, '..');

function findElectronBinary() {
  const searchPaths = [
    path.join(BACKEND_DIR, '..', 'frontend', 'node_modules'),
    path.join(BACKEND_DIR, 'node_modules'),
  ];
  for (const base of searchPaths) {
    try {
      const binary = require(require.resolve('electron', { paths: [base] }));
      if (typeof binary === 'string' && fs.existsSync(binary)) return binary;
    } catch (e) {
      // Try the next location.
    }
  }
  return null;
}

const [, , scriptArg, ...rest] = process.argv;

if (!scriptArg) {
  console.error('Usage: node scripts/run-script.js <script.js> [args...]');
  process.exit(1);
}

const target = path.resolve(BACKEND_DIR, scriptArg);
if (!fs.existsSync(target)) {
  console.error(`Script not found: ${target}`);
  process.exit(1);
}

const electron = findElectronBinary();
if (!electron) {
  console.error(
    '\nCould not find the Electron binary.\n' +
    'Install the frontend dependencies first:  cd ../frontend && npm install\n'
  );
  process.exit(1);
}

const child = spawn(electron, [target, ...rest], {
  cwd: BACKEND_DIR,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  shell: false,
});

child.on('error', (err) => {
  console.error('Failed to run the script:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : code === null ? 0 : code));
