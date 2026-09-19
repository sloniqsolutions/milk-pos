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
 * The releases are public, so a till needs no credentials to look for one —
 * package.json's `build.publish` deliberately does NOT say `private: true`.
 * (With it, electron-updater insists on a GH_TOKEN on every machine and finds
 * nothing without one, so a shop's second PC could never have updated.) If the
 * releases ever move to a private repo, this needs a different arrangement, not
 * a token baked into the app.
 *
 * A failed check (offline, GitHub down) is logged, never surfaced to the
 * cashier: a missing update is never worth interrupting a sale over.
 */

/** How often a till that stays open for days looks for a new release. */
const RECHECK_MS = 4 * 60 * 60 * 1000;

const { autoUpdater } = require('electron-updater');

function initAutoUpdater(mainWindow, log) {
  autoUpdater.autoDownload = false;
  // Only takes effect once an update has actually been downloaded (the banner's
  // button): if the cashier downloads it and carries on selling, it installs
  // when they next close the app, instead of waiting for a click that may never come.
  autoUpdater.autoInstallOnAppQuit = true;

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
    // Silent, and reopen the app afterwards: the cashier clicks once and the till
    // comes back on the new version, instead of stopping at an installer wizard.
    autoUpdater.quitAndInstall(true, true);
  });

  const check = () => autoUpdater.checkForUpdates().catch((err) => {
    log('[Update] Check failed: ' + err.message);
  });
  check();
  // Once at launch is not enough for a till that is left open for days.
  const timer = setInterval(check, RECHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { initAutoUpdater };
