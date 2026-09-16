import React, { useState, useEffect, useMemo } from 'react';
import { History, ArrowUpDown, Droplet, Trash2, PackagePlus } from 'lucide-react';
import { inventoryAPI, InventoryEntry } from '@/api/index';

const BLUE = '#1B4C82';
const BLUE_TINT = '#EAF2FB';

type Tab = 'stock' | 'yogurt_conversion' | 'waste';

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'stock', label: 'Restocks', icon: PackagePlus },
  { key: 'yogurt_conversion', label: 'Yogurt Conversions', icon: Droplet },
  { key: 'waste', label: 'Waste', icon: Trash2 },
];

const inputStyle = {
  padding: '9px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8,
  fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' as const,
};

export default function StockHistoryScreen() {
  const [tab, setTab] = useState<Tab>('stock');
  const [entries, setEntries] = useState<InventoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    inventoryAPI.history({ type: tab, from: from || undefined, to: to || undefined })
      .then(data => { if (!cancelled) setEntries(data); })
      .catch(err => console.error('Failed to fetch stock history:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, from, to]);

  const sortedEntries = useMemo(() => {
    const copy = [...entries];
    copy.sort((a, b) => {
      const cmp = a.entry_date.localeCompare(b.entry_date) || a.id - b.id;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [entries, sortDir]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', background: '#F7F9FC', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '20px 32px',
        background: '#FFFFFF',
        borderBottom: '1px solid #E5E9F0',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: BLUE_TINT,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <History size={20} color={BLUE} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: '#0F1720', margin: 0 }}>Stock History</h1>
            <p style={{ fontSize: 13, color: '#6B7280', margin: '2px 0 0' }}>Every restock, yogurt conversion, and reported waste, by date</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, padding: 32, overflowY: 'auto' }}>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '9px 16px', borderRadius: 8,
                  border: `1.5px solid ${active ? BLUE : '#E5E9F0'}`,
                  background: active ? BLUE : '#FFFFFF',
                  color: active ? '#FFFFFF' : '#374151',
                  fontWeight: 600, fontSize: 13.5, cursor: 'pointer',
                  transition: 'background 140ms',
                }}
              >
                <Icon size={15} /> {label}
              </button>
            );
          })}
        </div>

        {/* Date filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <label style={{ fontSize: 13, color: '#6B7280', fontWeight: 600 }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} />
          <label style={{ fontSize: 13, color: '#6B7280', fontWeight: 600 }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle} />
          {(from || to) && (
            <button
              onClick={() => { setFrom(''); setTo(''); }}
              style={{ padding: '9px 14px', background: '#FFFFFF', color: '#6B7280', borderRadius: 8, border: '1.5px solid #E5E9F0', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Clear
            </button>
          )}
        </div>

        <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #E5E9F0', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: '#F7F9FC', borderBottom: '1px solid #E5E9F0' }}>
                <th style={{ padding: '16px 24px', fontSize: 12, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ingredient</th>
                <th style={{ padding: '16px 24px', fontSize: 12, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</th>
                <th
                  style={{ padding: '16px 24px', fontSize: 12, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    Date <ArrowUpDown size={13} />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={3} style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Loading history...</td>
                </tr>
              ) : sortedEntries.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>
                    No entries in this range.
                  </td>
                </tr>
              ) : (
                sortedEntries.map((entry) => {
                  const positive = entry.amount >= 0;
                  return (
                    <tr key={entry.id} style={{ borderBottom: '1px solid #E5E9F0' }}>
                      <td style={{ padding: '16px 24px', fontWeight: 600, color: '#0F1720' }}>
                        {entry.ingredient_name}
                      </td>
                      <td style={{ padding: '16px 24px' }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: positive ? '#16A34A' : '#EF4444' }}>
                          {positive ? '+' : ''}{entry.amount} {entry.ingredient_unit}
                        </span>
                      </td>
                      <td style={{ padding: '16px 24px', color: '#374151', fontSize: 14, fontWeight: 500 }}>
                        {entry.entry_date}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
