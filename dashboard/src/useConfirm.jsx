import React, { useCallback, useRef, useState } from 'react';

const TONE = {
  warning: { accent: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  danger: { accent: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  default: { accent: '#1B4C82', bg: '#EAF2FB', border: '#C8DCED' },
};

/**
 * Promise-based confirmation dialog, local to the dashboard.
 *
 * BackupsScreen.jsx was written against a `@/components/pos/useConfirm` hook
 * that never existed in this till's own frontend — only in whatever earlier
 * project this dashboard was adapted from. This is a from-scratch
 * replacement with the same `{ confirm, dialog }` shape: call
 * `await confirm({ title, message, note, confirmLabel, tone })`, resolving
 * true/false, and render `{dialog}` once, anywhere in the tree.
 */
export default function useConfirm() {
  const [state, setState] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      resolver.current = resolve;
      setState(options);
    });
  }, []);

  const settle = (result) => {
    setState(null);
    if (resolver.current) {
      resolver.current(result);
      resolver.current = null;
    }
  };

  if (!state) return { confirm, dialog: null };

  const tone = TONE[state.tone] || TONE.default;

  const dialog = (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,32,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
      }}
      onClick={() => settle(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF', borderRadius: 14, padding: 24,
          width: '100%', maxWidth: 420,
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        }}
      >
        <h3 style={{ margin: '0 0 10px', fontSize: 17, fontWeight: 800, color: '#111827' }}>
          {state.title}
        </h3>
        {state.message && (
          <p style={{ margin: '0 0 10px', fontSize: 14, color: '#374151', lineHeight: 1.5 }}>
            {state.message}
          </p>
        )}
        {state.note && (
          <div style={{
            background: tone.bg, border: `1px solid ${tone.border}`, color: tone.accent,
            borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 14,
          }}>
            {state.note}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
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
          <button
            onClick={() => settle(true)}
            style={{
              height: 38, padding: '0 16px', borderRadius: 8, border: 'none',
              background: tone.accent, color: '#FFFFFF',
              fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {state.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );

  return { confirm, dialog };
}
