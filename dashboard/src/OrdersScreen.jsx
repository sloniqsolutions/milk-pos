import React, { useEffect, useState } from 'react';
import BranchFilter from './BranchFilter';

/**
 * Every order, as the branches have delivered them.
 *
 * The till's own Orders screen is not reused here: it is built for finding a
 * sale that happened minutes ago in order to void or reprint it, neither of
 * which the owner can do from the dashboard. What is wanted here is the
 * opposite — a long list, across both branches, that can be searched and
 * narrowed by day.
 *
 * Only as current as the last sync. The completeness banner says so rather than
 * leaving a short list to be read as a quiet day.
 */

const money = (v) =>
  v == null ? '—' : 'Rs ' + Number(v).toLocaleString('en-PK', { maximumFractionDigits: 0 });

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const RANGES = [
  { key: 'today', label: 'Today', days: 0 },
  { key: 'yesterday', label: 'Yesterday', days: 1, single: true },
  { key: 'last7', label: 'Last 7 days', days: 6 },
  { key: 'last30', label: 'Last 30 days', days: 29 },
];

function rangeDates(key) {
  const now = new Date();
  const back = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  const r = RANGES.find(x => x.key === key) || RANGES[0];
  if (r.single) return { from: iso(back(r.days)), to: iso(back(r.days)) };
  return { from: iso(back(r.days)), to: iso(now) };
}

const card = {
  background: '#FFFFFF', border: '1px solid #E5E9F0', borderRadius: 14, padding: 20,
};

const chip = (active) => ({
  padding: '6px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap',
  background: active ? '#1B4C82' : '#FFFFFF',
  color: active ? '#FFFFFF' : '#374151',
  border: `1px solid ${active ? '#1B4C82' : '#D1D5DB'}`,
});

export default function OrdersScreen() {
  const [branchId, setBranchId] = useState('');
  const [rangeKey, setRangeKey] = useState('today');
  const [orders, setOrders] = useState([]);
  const [completeness, setCompleteness] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = (silent) => {
      if (!silent) setLoading(true);
      const { from, to } = rangeDates(rangeKey);
      const qs = new URLSearchParams(branchId ? { from, to, branch: branchId } : { from, to });

      // Voided orders included deliberately: an owner looking through orders
      // wants to see the one that was cancelled, not have it quietly omitted.
      qs.set('include_voided', '1');

      fetch(`/api/reports/detailed?${qs}`, { credentials: 'include' })
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Could not load orders');
          return data;
        })
        .then((rows) => {
          if (cancelled) return;
          setOrders(Array.isArray(rows) ? rows : []);
          setError(null);
        })
        .catch(e => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled && !silent) setLoading(false); });
    };

    load(false);
    // Silent background refresh — keeps the list current without owner having
    // to reload the page, without re-showing the loading spinner every time.
    const poll = setInterval(() => load(true), 15000);

    return () => { cancelled = true; clearInterval(poll); };
  }, [branchId, rangeKey]);

  useEffect(() => {
    const load = () =>
      fetch('/api/branches/completeness', { credentials: 'include' })
        .then(r => (r.ok ? r.json() : { branches: [] }))
        .catch(() => ({ branches: [] }))
        .then(d => setCompleteness(d.branches || []));

    load();
    const poll = setInterval(load, 10000);
    return () => clearInterval(poll);
  }, [branchId, rangeKey]);

  const behind = completeness.filter(
    b => b.last_sync_age_ms == null || b.last_sync_age_ms > 30 * 60 * 1000
  );

  const term = search.trim().toLowerCase();
  const visible = term
    ? orders.filter(o =>
        String(o.id).includes(term) ||
        String(o.order_no || '').toLowerCase().includes(term) ||
        String(o.cashier_name || '').toLowerCase().includes(term) ||
        String(o.customer_name || '').toLowerCase().includes(term) ||
        String(o.customer_phone || '').includes(term) ||
        String(o.items || '').toLowerCase().includes(term))
    : orders;

  const takings = visible
    .filter(o => o.status !== 'voided')
    .reduce((n, o) => n + (Number(o.total) || 0), 0);

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <BranchFilter value={branchId} onChange={setBranchId} />
        {RANGES.map(r => (
          <button key={r.key} onClick={() => setRangeKey(r.key)} style={chip(rangeKey === r.key)}>
            {r.label}
          </button>
        ))}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search order #, cashier, customer or item"
          style={{
            flex: '1 1 240px', height: 34, borderRadius: 8, border: '1px solid #D1D5DB',
            padding: '0 12px', fontSize: 14, outline: 'none', fontFamily: 'inherit',
          }}
        />
      </div>

      {behind.length > 0 && (
        <div style={{
          background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E',
          borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14,
        }}>
          <strong>Some orders may be missing.</strong>{' '}
          {behind.map(b => b.branch_name).join(' and ')} last delivered sales more
          than half an hour ago. Anything rung up since is still on that till.
        </div>
      )}

      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
          borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14,
        }}>
          {error}
        </div>
      )}

      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#123A66' }}>
            Orders <span style={{ color: '#9CA3AF', fontWeight: 500 }}>({visible.length})</span>
          </h3>
          <span style={{ fontSize: 13, color: '#6B7280' }}>
            {money(takings)} taken, voided orders excluded
          </span>
        </div>

        {loading ? (
          <p style={{ color: '#9CA3AF', fontSize: 14, margin: 0 }}>Loading…</p>
        ) : !visible.length ? (
          <p style={{ color: '#9CA3AF', fontSize: 14, margin: 0 }}>
            {orders.length ? 'Nothing matches that search.' : 'No orders in this period.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E9F0' }}>
                  {['#', 'Time', 'Branch', 'Cashier', 'Type', 'Customer', 'Items', 'Payment', 'Status', 'Total']
                    .map(h => (
                      <th key={h} style={{
                        textAlign: h === 'Total' ? 'right' : 'left', padding: '8px 10px',
                        fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3,
                        color: '#6B7280', whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 300).map((o, i) => {
                  const voided = o.status === 'voided';
                  return (
                    <tr key={`${o.branch_name}-${o.id}-${i}`} style={{
                      borderBottom: '1px solid #F3F4F6',
                      // Struck through rather than hidden: the owner is looking
                      // for the cancelled one as often as the others.
                      opacity: voided ? 0.55 : 1,
                    }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {o.order_no || o.id}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', whiteSpace: 'nowrap' }}>
                        {String(o.created_at || '').slice(5, 16)}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#374151' }}>{o.branch_name || '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#374151' }}>{o.cashier_name || '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#6B7280' }}>{o.order_type || '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', maxWidth: 180 }}>
                        {o.customer_name
                          ? <>{o.customer_name}{o.customer_phone ? <span style={{ color: '#9CA3AF' }}> · {o.customer_phone}</span> : null}</>
                          : '—'}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', maxWidth: 280 }}>{o.items || '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#6B7280' }}>{o.payment_method || '—'}</td>
                      <td style={{ padding: '8px 10px' }}>
                        {voided
                          ? <span style={{ color: '#DC2626', fontWeight: 700 }}>voided</span>
                          : <span style={{ color: '#059669' }}>{o.status}</span>}
                      </td>
                      <td style={{
                        padding: '8px 10px', textAlign: 'right', fontWeight: 700,
                        textDecoration: voided ? 'line-through' : 'none',
                      }}>
                        {money(o.total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length > 300 && (
              <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 12 }}>
                Showing the first 300. Narrow the dates or search to see the rest;
                the Reports tab exports the full list.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
