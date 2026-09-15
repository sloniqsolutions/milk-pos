
export default function Toggle({ value, onChange, label, hint }) {
  return (
    <div
      className="flex items-center justify-between cursor-pointer"
      onClick={() => onChange(!value)}
      style={{ padding: '4px 0' }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{hint}</div>}
      </div>
      <div
        style={{
          width: 44,
          height: 24,
          borderRadius: 9999,
          background: value ? '#DC2626' : '#E5E7EB',
          position: 'relative',
          transition: 'background 200ms',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 9999,
            background: '#FFFFFF',
            position: 'absolute',
            top: 3,
            left: value ? 23 : 3,
            transition: 'left 200ms',
          }}
        />
      </div>
    </div>
  );
}
