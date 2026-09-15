import { useEffect } from 'react';
import { Clock } from 'lucide-react';

/**
 * Shown when an action (a sale, an expense) is refused because no shift is
 * open. Auto-redirects to the Shifts screen after a beat so the cashier isn't
 * left stuck reading an error with no obvious next step.
 */
export default function NoShiftOverlay({ show, message, onRedirect }) {
  useEffect(() => {
    if (!show) return undefined;
    const t = setTimeout(() => onRedirect(), 1000);
    return () => clearTimeout(t);
  }, [show, onRedirect]);

  if (!show) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,32,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        background: '#FFFFFF', borderRadius: 16, padding: '32px 40px',
        textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        maxWidth: 360,
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', background: '#FEF3C7',
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
        }}>
          <Clock size={28} color="#B45309" />
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#0F1720', marginBottom: 6 }}>
          No Shift Open
        </div>
        <div style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5 }}>
          {message || 'You need to open a shift before you can continue.'}
        </div>
        <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 12 }}>
          Redirecting to Shifts…
        </div>
      </div>
    </div>
  );
}
