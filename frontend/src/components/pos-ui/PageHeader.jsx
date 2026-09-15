export default function PageHeader({ title, subtitle, actionLabel, actionIcon: ActionIcon, onAction, centered }) {
  const button = actionLabel && (
    <button
      onClick={onAction}
      className="flex items-center gap-2"
      style={{
        background: '#1B4C82',
        color: '#FFFFFF',
        height: 40,
        borderRadius: 8,
        fontWeight: 600,
        fontSize: 14,
        padding: '0 20px',
        border: 'none',
        cursor: 'pointer',
        boxShadow: '0 4px 10px rgba(27,76,130,0.28)',
        transition: 'background 140ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#123A66'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#1B4C82'; }}
    >
      {ActionIcon && <ActionIcon size={16} />}
      {actionLabel}
    </button>
  );

  if (centered) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24, gap: 16 }}>
        <div style={{ flex: 1 }} />
        <div style={{ flex: 2, textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F1720', margin: 0 }}>{title}</h1>
          {subtitle && <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{subtitle}</p>}
        </div>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
          {button}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F1720' }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{subtitle}</p>}
      </div>
      {button}
    </div>
  );
}
