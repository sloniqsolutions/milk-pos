const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const { buildReceiptBuffer } = require('./escpos-receipt');
const { printRawBuffer } = require('./print-raw-windows');
const { initAutoUpdater } = require('./auto-update');
const { resolveDataDir, migrateLegacyData } = require('./data-dir');

let mainWindow;
let backendProcess;
let cloudProcess;
let logPath;
// Set once the renderer has confirmed there is no open shift (or the check
// itself failed) — lets the close handler's own mainWindow.close() call fall
// through instead of looping back into itself.
let allowClose = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try {
    if (logPath) fs.appendFileSync(logPath, line);
  } catch(e) {}
}

/**
 * Bakes this shop's cloud pairing into every install, so a fresh machine is
 * already synced to the cloud the first time it opens — no manual step, no
 * file to hand-copy. Only writes once: if cloud-sync.json already exists (a
 * previous launch already wrote it, or someone rekeyed it by hand), it is
 * left alone rather than overwritten on every startup.
 *
 * Written into the data folder (see data-dir.js), which is where
 * backend/db/cloud-config.js looks — POS_USER_DATA_PATH when packaged, beside
 * server.js in development.
 */
function ensureCloudSyncConfig(dataDir) {
  const configPath = path.join(dataDir, 'cloud-sync.json');
  if (fs.existsSync(configPath)) return;

  // SECURITY: this key reads the whole branch (staff PIN hashes, orders) from the
  // cloud, and it is committed in this file. While the repository is public it is
  // public: rotate TILL_API_KEY (cloud/.env) and make the repo private, publishing
  // installers to a separate public releases repo — see RELEASING.md.
  const config = {
    enabled: true,
    cloud_url: 'https://milk-pos.virtiqosolutions.com',
    branch_id: 1,
    branch_name: 'Pure Milk',
    api_key: '0c8b6ffb654e510ecaff0e312e5a7b07b3b153d89fe5c6ea554d97bfa9823e3e',
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    log('[Main] Wrote cloud-sync.json (first run) at ' + configPath);
  } catch (e) {
    log('[Main] Could not write cloud-sync.json: ' + e.message);
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function waitForBackend(retries = 40, interval = 500) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        http.get('http://localhost:3001/api/health', (res) => {
          if (res.statusCode === 200) {
            log('[Main] Backend ready');
            resolve();
          } else {
            retry();
          }
        }).on('error', retry);
      };
      const retry = () => {
        attempts++;
        if (attempts >= retries) reject(new Error('Backend did not start'));
        else setTimeout(check, interval);
      };
      check();
    });
  }

  function startBackend() {
    const isDev = !app.isPackaged;

    log('=== startBackend called ===');
    log('isPackaged: ' + app.isPackaged);
    log('execPath: ' + process.execPath);
    log('resourcesPath: ' + process.resourcesPath);
    log('appPath: ' + app.getAppPath());
    log('userData: ' + app.getPath('userData'));

    let backendPath;

    if (isDev) {
      backendPath = path.join(__dirname, '../../backend/server.js');
    } else {
      const candidates = [
        path.join(process.resourcesPath, 'backend', 'server.js'),
        path.join(path.dirname(process.execPath), 'resources', 'backend', 'server.js'),
        path.join(app.getAppPath(), '..', 'backend', 'server.js'),
      ];
      candidates.forEach(p => log('candidate: ' + p + ' | exists: ' + fs.existsSync(p)));
      backendPath = candidates.find(p => fs.existsSync(p));
    }

    if (!backendPath) {
      log('ERROR: server.js not found in any path');
      return;
    }

    log('Using: ' + backendPath);

    const backendDir = path.dirname(backendPath);
    const sqlitePath = path.join(backendDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    log('sqlite3.node exists: ' + fs.existsSync(sqlitePath));
    log('node_modules exists: ' + fs.existsSync(path.join(backendDir, 'node_modules')));

    /*
     * Where the database lives.
     *
     * Packaged: Electron's per-user data folder (data-dir.js). NOT the install
     * folder — the NSIS updater deletes the install folder on every update,
     * database and all. Development: beside server.js, i.e. backend/ in the repo,
     * so `electron:dev` and `npm start` in backend/ still share one database.
     */
    const dataDir = resolveDataDir({ isPackaged: app.isPackaged, userDataPath: app.getPath('userData') });
    const dataDirForFiles = dataDir || backendDir;
    if (dataDir) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        migrateLegacyData(backendDir, dataDir, log);
      } catch (err) {
        log('[Data] Could not prepare the data folder: ' + err.message);
      }
    }
    log('Data folder: ' + dataDirForFiles);

    ensureCloudSyncConfig(dataDirForFiles);

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '3001',
      ...(dataDir ? { POS_USER_DATA_PATH: dataDir } : {}),
    };

    try {
      backendProcess = spawn(process.execPath, [backendPath], {
        cwd: backendDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env,
        windowsHide: true,
      });

      backendProcess.stdout.on('data', d => log('[Backend] ' + d.toString().trim()));
      backendProcess.stderr.on('data', d => log('[Backend ERR] ' + d.toString().trim()));
      backendProcess.on('exit', (code, signal) => log('[Backend] exited code=' + code + ' signal=' + signal));
      backendProcess.on('error', (err) => log('[Backend] spawn error: ' + err.message));

      log('Backend spawned successfully');
    } catch(err) {
      log('SPAWN THREW: ' + err.message);
    }
  }

  /**
   * Bring the cloud API up alongside the till, in development only.
   *
   * A packaged install ships to a real shop and talks to the cloud running on
   * the remote VPS (see cloud/server.js's own deployment note) — starting a
   * second, local cloud instance there would be actively wrong, not just
   * redundant. In development there's no remote server to reach, so this is
   * what used to require a separate `cd cloud && npm start` in another
   * terminal before the till would ever show as online.
   */
  function startCloud() {
    const cloudPath = path.join(__dirname, '../../cloud/server.js');
    if (!fs.existsSync(cloudPath)) {
      log('[Cloud] server.js not found at ' + cloudPath + ' — skipping auto-start.');
      return;
    }

    const cloudDir = path.dirname(cloudPath);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

    try {
      cloudProcess = spawn(process.execPath, [cloudPath], {
        cwd: cloudDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env,
        windowsHide: true,
      });

      cloudProcess.stdout.on('data', d => log('[Cloud] ' + d.toString().trim()));
      cloudProcess.stderr.on('data', d => log('[Cloud ERR] ' + d.toString().trim()));
      cloudProcess.on('exit', (code, signal) => log('[Cloud] exited code=' + code + ' signal=' + signal));
      cloudProcess.on('error', (err) => log('[Cloud] spawn error: ' + err.message));

      log('Cloud spawned successfully');
    } catch (err) {
      log('CLOUD SPAWN THREW: ' + err.message);
    }
  }

  function stopCloud() {
    if (cloudProcess) {
      cloudProcess.kill('SIGTERM');
      cloudProcess = null;
    }
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      // The taskbar and window-corner icon (electron/icons/icon.ico, made from
      // src/assets/cow-logo.png). The packaged .exe carries the same icon.
      icon: path.join(__dirname, 'icons', 'icon.ico'),
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 600,
      resizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        // SECURITY: this was `false`, which disables the same-origin policy for
        // the whole renderer. It was presumably switched off because the
        // packaged app is served from file:// and calls http://localhost:3001,
        // but that combination works with web security on: the backend answers
        // the opaque `null` origin explicitly (see backend/server.js), so
        // nothing here needs the browser's protections turned off.
        webSecurity: true,
      },
      title: 'Pure Milk POS',
      autoHideMenuBar: true,
      show: false,
    });

    if (!app.isPackaged) {
      mainWindow.loadURL('http://localhost:5173');
      mainWindow.webContents.openDevTools();
    } else {
      mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
      // Devtools used to open here too ("keep until fully working"), so the
      // shipped till launched with an inspector window in front of staff and
      // customers. It can still be opened deliberately with the shortcut below
      // when a problem needs diagnosing on site.
    }

    // F12 toggles devtools on demand, in packaged builds as well. The window
    // has no menu bar, so without this there is no way back in on a till.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });

    // A shift left open when the till is closed leaves the drawer uncounted
    // and the day's totals frozen mid-shift. Rather than let the window close
    // outright, ask the renderer (which holds the session) whether a shift is
    // open, and only let the close through once it says no.
    mainWindow.on('close', (event) => {
      if (allowClose) return;
      event.preventDefault();
      mainWindow.webContents.send('check-shift-before-close');
    });

    // Opens filling the screen rather than at the fixed 1280x800 size above —
    // that size is only a fallback for whatever the initial (un-maximized)
    // frame briefly measures before this fires. `maximize()` alone is a no-op
    // on a `resizable: false` window on Windows, so the work area is set
    // directly instead — that resizes the frame without needing the OS's
    // "maximized" gesture, which non-resizable windows can't perform.
    mainWindow.once('ready-to-show', () => {
      const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
      mainWindow.setBounds(workArea);
      mainWindow.show();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
  }

  /**
   * Real Windows printer names, for Settings → Printer's ESC/POS dropdown.
   * The same list the OS print dialog itself offers, so whatever name is
   * picked here is guaranteed to be one print-raw-windows.js can open.
   */
  ipcMain.handle('list-printers', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!win) return [];
    try {
      const printers = await win.webContents.getPrintersAsync();
      return printers.map((p) => ({ name: p.name, isDefault: !!p.isDefault }));
    } catch (err) {
      log('[Main] list-printers failed: ' + err.message);
      return [];
    }
  });

  /**
   * The ESC/POS print path — see escpos-receipt.js and print-raw-windows.js
   * for why this exists. `copies` and `paperWidthMm` are pre-formatted by
   * ReceiptModal.jsx from the same order data and settings the HTML receipt
   * uses, so this handler is pure plumbing: build the byte stream, hand it to
   * the printer's Windows spooler in RAW mode.
   */
  ipcMain.handle('print-escpos', async (event, { printerName, paperWidthMm, copies }) => {
    try {
      const buffer = buildReceiptBuffer(copies || [], paperWidthMm === 58 ? 58 : 80);
      await printRawBuffer(buffer, printerName);
      return { success: true };
    } catch (err) {
      log('[Main] print-escpos failed: ' + err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('shift-check-response', (event, hasOpenShift) => {
    if (!mainWindow) return;
    if (hasOpenShift) {
      // Used to be an OS-native dialog.showMessageBox here — the one thing in
      // the whole app that looked nothing like it, dropped in front of
      // whatever screen the cashier was on. The renderer shows its own card
      // instead, styled like everything else (see ElectronCloseGuard.jsx).
      mainWindow.webContents.send('close-blocked-shift-open');
    } else {
      allowClose = true;
      mainWindow.close();
    }
  });

  function stopBackend() {
    if (backendProcess) {
      backendProcess.kill('SIGTERM');
      backendProcess = null;
    }
  }

  app.whenReady().then(async () => {
    // Set up log path FIRST before anything else
    const userDataPath = app.getPath('userData');
    try {
      if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
      logPath = path.join(userDataPath, 'backend-debug.log');
      // Clear old log on each launch
      fs.writeFileSync(logPath, '');
    } catch(e) {
      console.error('Could not create log file:', e.message);
    }

    log('app.whenReady fired');

    if (!app.isPackaged) startCloud();
    startBackend();

    try {
      await waitForBackend();
      log('Backend confirmed ready');
    } catch (err) {
      log('Backend wait failed: ' + err.message);
    }

    createWindow();

    // Only in a packaged install: there is no GitHub release matching
    // whatever is on disk in development, so checking there would just log a
    // "version not found" error on every launch.
    if (app.isPackaged) {
      try {
        initAutoUpdater(mainWindow, log);
      } catch (err) {
        log('[Update] Failed to start updater: ' + err.message);
      }
    }
  });

  app.on('window-all-closed', () => {
    stopBackend();
    stopCloud();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { stopBackend(); stopCloud(); });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}