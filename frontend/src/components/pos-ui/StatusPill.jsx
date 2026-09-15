
const STATUS_STYLES = {
  Completed: { bg: '#DCFCE7', text: '#16A34A' },
  Held: { bg: '#FEE2E2', text: '#EA580C' },
  Voided: { bg: '#FEE2E2', text: '#DC2626' },
  Active: { bg: '#DCFCE7', text: '#16A34A' },
  Inactive: { bg: '#F3F4F6', text: '#6B7280' },
  Cash: { bg: '#F3F4F6', text: '#374151' },
  Card: { bg: '#EFF6FF', text: '#2563EB' },
  completed: { bg: '#DCFCE7', text: '#16A34A' },
  held: { bg: '#FEE2E2', text: '#EA580C' },
  voided: { bg: '#FEE2E2', text: '#DC2626' },
};

export default function StatusPill({ status }) {
  const normalized = status === 'completed' ? 'Completed' : status === 'held' ? 'Held' : status === 'voided' ? 'Voided' : status;
  const style = STATUS_STYLES[status] || STATUS_STYLES[normalized] || STATUS_STYLES.Inactive;
  const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);

  return (
    <span
      style={{
        padding: '3px 10px',
        borderRadius: 9999,
        fontSize: 12,
        fontWeight: 600,
        display: 'inline-flex',
        background: style.bg,
        color: style.text,
      }}
    >
      {label}
    </span>
  );
}
