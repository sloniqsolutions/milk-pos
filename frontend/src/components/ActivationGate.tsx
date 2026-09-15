import { useEffect, useState, type ReactNode } from 'react';
import ActivationScreen from '@/pages/ActivationScreen';
import { activationAPI } from '@/api/index';

/**
 * Blocks the whole app — even the PIN screen — until this install has a
 * valid product key. Checked once per launch; activation itself only ever
 * needs to succeed once (see backend/db/activation-config.js), so there is
 * no repeated network dependency for a till that otherwise works offline
 * once it is set up.
 */
export default function ActivationGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'activated' | 'unactivated'>('checking');

  useEffect(() => {
    activationAPI.status()
      .then((res) => setStatus(res.activated ? 'activated' : 'unactivated'))
      // The backend not answering yet (still starting up) must not read as
      // "unlicensed" — that would flash the activation screen at every launch
      // before the backend is ready. Treat it the same as activated and let
      // whatever screen actually needs the backend show its own connection
      // error instead.
      .catch(() => setStatus('activated'));
  }, []);

  if (status === 'checking') return null;
  if (status === 'unactivated') {
    return <ActivationScreen onActivated={() => setStatus('activated')} />;
  }
  return <>{children}</>;
}
