import { useEffect } from 'react';
import { shiftsAPI } from '@/api/index';
import useDialogs from '@/lib/useDialogs';

/**
 * Answers the Electron main process's "is it safe to close" check (see
 * electron/main.js + electron/preload.js) with whether a shift is currently
 * open. Mounted once at the app root so it works regardless of which screen
 * — or whether the PIN lock screen — is showing when the window is closed.
 *
 * Also owns the card shown when a close is refused. That used to be an
 * OS-native dialog.showMessageBox fired from the main process — the one box
 * in the whole app that looked like Windows rather than Milk POS. main.js now
 * just tells the renderer the close was blocked and this shows the same kind
 * of card as everything else.
 */
export default function ElectronCloseGuard() {
  const { alertCard, dialog } = useDialogs();

  useEffect(() => {
    if (!window.electronAPI) return undefined;

    const handler = async () => {
      let hasOpenShift = false;
      try {
        const shift = await shiftsAPI.current();
        hasOpenShift = !!shift;
      } catch (e) {
        // Can't reach the backend or no session — don't trap the user in an
        // app that refuses to close over a check that can't be answered.
        hasOpenShift = false;
      }
      window.electronAPI.respondShiftCheck(hasOpenShift);
    };

    window.electronAPI.onCheckShiftBeforeClose(handler);
  }, []);

  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onCloseBlockedShiftOpen) return undefined;

    window.electronAPI.onCloseBlockedShiftOpen(() => {
      alertCard({
        title: 'Shift Still Open',
        message: 'Close your shift on the Shifts screen before exiting the app — the drawer needs to be counted first.',
        tone: 'warning',
      });
    });
  }, [alertCard]);

  return dialog;
}
