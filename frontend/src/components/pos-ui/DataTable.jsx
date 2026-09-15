export default function DataTable({ columns, data, emptyIcon: EmptyIcon, emptyTitle, emptySubtitle }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px' }}>
        {EmptyIcon && <EmptyIcon size={48} style={{ color: '#1B4C82', margin: '0 auto 16px' }} />}
        <div style={{ fontSize: 16, fontWeight: 700, color: '#0F1720' }}>{emptyTitle}</div>
        {emptySubtitle && <div style={{ fontSize: 13, color: '#6B7280', marginTop: 6 }}>{emptySubtitle}</div>}
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
      <thead>
        <tr style={{ background: '#F7F9FC', height: 44 }}>
          {columns.map((col) => (
            <th
              key={col.key}
              style={{
                textTransform: 'uppercase',
                fontSize: 11,
                color: '#6B7280',
                fontWeight: 600,
                padding: '0 16px',
                borderBottom: '1px solid #E5E9F0',
                textAlign: col.align || 'left',
                width: col.width || 'auto',
              }}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, idx) => (
          <tr
            key={row.id || idx}
            style={{
              height: 52,
              background: idx % 2 === 0 ? '#FFFFFF' : '#F7F9FC',
              borderBottom: '1px solid #E5E9F0',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#EAF2FB'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = idx % 2 === 0 ? '#FFFFFF' : '#F7F9FC'; }}
          >
            {columns.map((col) => (
              <td
                key={col.key}
                style={{
                  padding: '0 16px',
                  fontSize: 14,
                  color: '#0F1720',
                  textAlign: col.align || 'left',
                }}
              >
                {col.render ? col.render(row) : row[col.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
