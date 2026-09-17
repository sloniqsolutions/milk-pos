import { useEffect, useState } from 'react';

/**
 * The till's half of electron/auto-update.js: a thin banner across the top
 * of the app once main.js's launch-time check finds a newer release.
 *
 * Nothing downloads until the cashier clicks — see auto-update.js's own note
 * on why this never auto-downloads on its own. `window.electronAPI` is
 * absent on the web (dashboard build), so this renders nothing there.
 */
export default function UpdateBanner() {
  const [state, setState] = useState('idle'); // idle | available | downloading | ready
  const [version, setVersion] = useState(null);
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onUpdateAvailable) return undefined;

    window.electronAPI.onUpdateAvailable(({ version }) => {
      setVersion(version);
      setState('available');
    });
    window.electronAPI.onUpdateDownloadProgress(({ percent }) => setPercent(percent));
    window.electronAPI.onUpdateDownloaded(() => setState('ready'));
  }, []);

  if (state === 'idle') return null;

  const install = async () => {
    setState('downloading');
    const result = await window.electronAPI.downloadUpdate();
    if (!result || !result.success) setState('available'); // let them try again
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: '#1B4C82', color: '#FFFFFF', fontSize: 13.5, fontWeight: 600,
      padding: '9px 20px', display: 'flex', alignItems: 'center',
      justifyContent: 'center', gap: 14,
    }}>
      {state === 'available' && (
        <>
          <span>Version {version} is available.</span>
          <button onClick={install} style={updateButtonStyle}>Download &amp; Install</button>
        </>
      )}
      {state === 'downloading' && <span>Downloading update{percent ? ` — ${percent}%` : '…'}</span>}
      {state === 'ready' && (
        <>
          <span>Version {version} is ready.</span>
          <button onClick={() => window.electronAPI.installUpdate()} style={updateButtonStyle}>
            Restart &amp; Install Now
          </button>
        </>
      )}
    </div>
  );
}

const updateButtonStyle = {
  background: '#FFFFFF', color: '#1B4C82', border: 'none', borderRadius: 6,
  padding: '5px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
};
