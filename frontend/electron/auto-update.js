/**
 * Checks github.com/sloniqsolutions/milk-pos's Releases on launch and lets
 * the cashier install whatever is newer with one click — see package.json's
 * `build.publish` for the repo this points at, and RELEASING.md for how to
 * actually cut a release.
 *
 * Deliberately manual-download rather than the library's default
 * auto-download: a till has no idle moment to lose bandwidth to a background
 * download it didn't ask for, so this only ever downloads once someone
 * clicks the banner main.js's `update-available` message triggers in the
 * renderer (see src/components/UpdateBanner.jsx).
 *
 * The repo is private, so every request needs a token — electron-updater
 * reads one from the GH_TOKEN or GITHUB_TOKEN environment variable on this
 * machine automatically (see node_modules/electron-updater/out/providerFactory.js).
 * Nothing here ever holds or ships that token: it lives only in this
 * machine's own environment, set once with
 * `setx GH_TOKEN "<a read-only, repo-scoped fine-grained PAT>"` and picked up
 * by every launch after. Without it, checks fail with a 401/404 — logged
 * below, not surfaced to the cashier, since a missing update is never worth
 * interrupting a sale over.
 */

const { autoUpdater } = require('electron-updater');

function initAutoUpdater(mainWindow, log) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  autoUpdater.on('update-available', (info) => {
    log('[Update] Version ' + info.version + ' is available.');
    send('update-available', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    log('[Update] Already on the latest version.');
  });

  autoUpdater.on('error', (err) => {
    const msg = err && err.message ? err.message : String(err);
    log('[Update] Check/download failed: ' + msg);
    if (/401|403|404/.test(msg)) {
      log('[Update] This usually means GH_TOKEN is missing, expired, or lacks access to the private repo on this machine.');
    }
  });

  autoUpdater.on('download-progress', (p) => {
    send('update-download-progress', { percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('[Update] Version ' + info.version + ' downloaded, ready to install.');
    send('update-downloaded', { version: info.version });
  });

  const { ipcMain } = require('electron');

  ipcMain.handle('update-download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('update-install', () => {
    autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch((err) => {
    log('[Update] Initial check failed: ' + err.message);
  });
}

module.exports = { initAutoUpdater };
