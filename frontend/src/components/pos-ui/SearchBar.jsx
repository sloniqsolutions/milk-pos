import { Search, X } from 'lucide-react';

/**
 * Search input shared by the management screens.
 */
export default function SearchBar({
  value,
  onChange,
  placeholder = 'Search...',
  resultCount,
  totalCount,
  width = '100%',
  maxWidth = 360,
}) {
  const hasQuery = String(value || '').trim().length > 0;

  return (
    <div style={{ width, maxWidth }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <Search
          size={16}
          style={{ position: 'absolute', left: 12, color: '#9CA3AF', pointerEvents: 'none' }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          style={{
            width: '100%',
            height: 40,
            borderRadius: 8,
            border: '1.5px solid #E5E9F0',
            background: '#FFFFFF',
            padding: hasQuery ? '0 36px 0 36px' : '0 12px 0 36px',
            fontSize: 14,
            color: '#0F1720',
            outline: 'none',
            fontFamily: 'Inter, sans-serif',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#1B4C82'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E9F0'; }}
        />
        {hasQuery && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear search"
            style={{
              position: 'absolute', right: 8,
              width: 22, height: 22, borderRadius: 11,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', background: '#F1F4F9', color: '#6B7280',
              cursor: 'pointer', padding: 0,
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {hasQuery && resultCount !== undefined && (
        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 6 }}>
          {resultCount === 0
            ? 'No matches'
            : `${resultCount}${totalCount !== undefined ? ` of ${totalCount}` : ''} shown`}
        </div>
      )}
    </div>
  );
}
