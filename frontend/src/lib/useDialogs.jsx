import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, XCircle, Info } from 'lucide-react';

const TONE = {
  danger: { accent: '#B91C1C', bg: '#FEF2F2', border: '#FECACA', Icon: XCircle },
  warning: { accent: '#B45309', bg: '#FFFBEB', border: '#FDE68A', Icon: AlertTriangle },
  success: { accent: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0', Icon: CheckCircle },
  info: { accent: '#1B4C82', bg: '#EAF2FB', border: '#C8DCED', Icon: Info },
};

/**
 * Promise-based alert/confirm cards, replacing window.alert and
 * window.confirm — an OS chrome box that matches nothing else on a till a
 * cashier looks at all day.
 *
 * `await confirm({ title, message, note, tone, confirmLabel, cancelLabel })`
 * resolves true/false. `await alertCard({ title, message, tone })` (or just a
 * plain string) resolves once dismissed. Render `{dialog}` once per screen
 * that calls either — same shape as the dashboard's own useConfirm.jsx.
 */
export default function useDialogs() {
  const [state, setState] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((options) => new Promise((resolve) => {
    resolver.current = resolve;
    setState({ kind: 'confirm', tone: 'info', ...options });
  }), []);

  const alertCard = useCallback((options) => new Promise((resolve) => {
    const opts = typeof options === 'string' ? { message: options } : (options || {});
    resolver.current = resolve;
    setState({ kind: 'alert', tone: 'danger', title: 'Something went wrong', ...opts });
  }), []);

  const settle = (result) => {
    setState(null);
    if (resolver.current) {
      resolver.current(result);
      resolver.current = null;
    }
  };

  if (!state) return { confirm, alertCard, dialog: null };

  const tone = TONE[state.tone] || TONE.info;
  const Icon = tone.Icon;
  const isConfirm = state.kind === 'confirm';

  const dialog = (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,32,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 10000, padding: 20, fontFamily: "'Inter', sans-serif",
      }}
      onClick={() => settle(isConfirm ? false : true)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF', borderRadius: 16, padding: 26,
          width: '100%', maxWidth: 420,
          boxShadow: '0 20px 50px rgba(16,40,80,0.25)',
        }}
      >
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%', background: tone.bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Icon size={22} color={tone.accent} />
          </div>
          <div style={{ flex: 1, paddingTop: 2, minWidth: 0 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 800, color: '#0F1720' }}>
              {state.title}
            </h3>
            {state.message && (
              <p style={{ margin: 0, fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-line' }}>
                {state.message}
              </p>
            )}
            {state.note && (
              <div style={{
                marginTop: 10, background: tone.bg, border: `1px solid ${tone.border}`,
                color: tone.accent, borderRadius: 8, padding: '9px 12px', fontSize: 12.5,
              }}>
                {state.note}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
          {isConfirm && (
            <button
              onClick={() => settle(false)}
              style={{
                height: 38, padding: '0 16px', borderRadius: 8,
                border: '1px solid #E5E9F0', background: '#FFFFFF',
                fontSize: 13.5, fontWeight: 600, color: '#374151', cursor: 'pointer',
              }}
            >
              {state.cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            onClick={() => settle(true)}
            style={{
              height: 38, padding: '0 18px', borderRadius: 8, border: 'none',
              background: tone.accent, color: '#FFFFFF',
              fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {state.confirmLabel || (isConfirm ? 'Confirm' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );

  return { confirm, alertCard, dialog };
}
