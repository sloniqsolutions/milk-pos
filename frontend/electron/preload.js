const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridges the main process's "are you sure it's safe to close" check to the
 * renderer, which is the only side that holds a signed-in session and can
 * actually ask the backend whether a shift is open.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  onCheckShiftBeforeClose: (callback) => ipcRenderer.on('check-shift-before-close', callback),
  respondShiftCheck: (hasOpenShift) => ipcRenderer.send('shift-check-response', hasOpenShift),
  // Fired instead of main.js showing its own OS-native dialog when a close
  // was refused — the renderer shows an in-app card matching the rest of the
  // till instead. See ElectronCloseGuard.jsx.
  onCloseBlockedShiftOpen: (callback) => ipcRenderer.on('close-blocked-shift-open', callback),

  // Raw ESC/POS receipt printing — see electron/escpos-receipt.js and
  // electron/print-raw-windows.js. Used by ReceiptModal.jsx when Settings →
  // Printer has "Direct ESC/POS" selected; falls back to window.print()
  // otherwise or if either of these calls fails.
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  printEscPos: (payload) => ipcRenderer.invoke('print-escpos', payload),
});
