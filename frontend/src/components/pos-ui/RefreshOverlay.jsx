import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * A soft veil with a spinner, shown over a screen while it re-reads data it has
 * just changed — so the person sees "updating…" instead of stale figures that
 * only fix themselves after a manual refresh.
 *
 * Wrap the screen's content in a `position: relative` container and render this
 * inside it. It blocks clicks while visible (a second edit mid-refresh would
 * race the first), and fades in/out so a fast refresh does not flash.
 */
export default function RefreshOverlay({ visible, label = 'Updating…' }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      style={{
        position: 'absolute', inset: 0, zIndex: 40,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10,
        background: 'rgba(247, 249, 252, 0.72)', backdropFilter: 'blur(1.5px)',
        opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 160ms ease',
      }}
    >
      <div className="animate-spin" style={{ color: '#1B4C82' }}>
        <Loader2 size={30} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#1B4C82' }}>{label}</span>
    </div>
  );
}
