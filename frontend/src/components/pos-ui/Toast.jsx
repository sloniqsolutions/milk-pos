import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

const ICONS = {
  success: { icon: CheckCircle, border: '#22C55E', color: '#16A34A' },
  error: { icon: XCircle, border: '#EF4444', color: '#DC2626' },
  warning: { icon: AlertTriangle, border: '#DC2626', color: '#EA580C' },
};

export default function Toast({ message, type = 'success', onClose }) {
  const [visible, setVisible] = useState(false);
  const config = ICONS[type] || ICONS.success;
  const Icon = config.icon;

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300);
    }, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 20,
        right: 20,
        zIndex: 9999,
        width: 320,
        background: '#FFFFFF',
        borderRadius: 8,
        borderLeft: `4px solid ${config.border}`,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        transform: visible ? 'translateX(0)' : 'translateX(120%)',
        transition: 'transform 300ms ease',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <Icon size={20} style={{ color: config.color, flexShrink: 0 }} />
      <span style={{ fontSize: 14, color: '#111827', flex: 1 }}>{message}</span>
      <button
        onClick={() => { setVisible(false); setTimeout(onClose, 300); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 18, lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}
