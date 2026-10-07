import React, { useEffect, useState } from 'react';
import BranchFilter from './BranchFilter';
import { SORTS, PERIOD_SORTS, PERIODS, sortCustomers, daysLabel, localDay, periodRange, periodView, periodTotals } from './customerSort';

/**
 * Credit customers.
 *
 * Milk POS's regulars who take milk on account and settle up later — not
 * one-off delivery orders. What matters here is the balance: who owes what,
 * and how much is outstanding across the shop right now. Every figure comes
 * from the till's own computation (backend/db/customer-summary.js) and is
 * simply carried by the sync, so it always agrees with what the till's own
 * ledger screen would show for the same customer.
 *
 * Aggregated by phone across branches, so "what does this household owe"
 * answers for the whole business rather than one branch's half of it.
 */

const money = (v) =>
  v == null ? '—' : 'Rs ' + Number(v).toLocaleString('en-PK', { maximumFractionDigits: 0 });

const card = {
  background: '#FFFFFF', border: '1px solid #E5E9F0', borderRadius: 14, padding: 20,
};

function Stat({ label, value, tone }) {
  return (
    <div style={{ flex: '1 1 140px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6B7280' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: tone || '#111827', marginTop: 2 }}>{value}</div>
    </div>
  );
}

export default function CustomersScreen() {
  const [branchId, setBranchId] = useState('');
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({ customers: 0, outstanding: 0, owing: 0, litres: 0 });
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('balance');
  const [period, setPeriod] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // The period is asked of the cloud, which counts each customer's real credit orders in it.
  // "All", or a custom range not yet complete, asks for nothing extra.
  const range = periodRange(period, localDay(), { from: customFrom, to: customTo });
  const rangeFrom = range ? range.from : '';
  const rangeTo = range ? range.to : '';

  useEffect(() => {
    let cancelled = false;

    const load = (silent) => {
      if (!silent) setLoading(true);
      const q = new URLSearchParams();
      if (branchId) q.set('branch', branchId);
      if (rangeFrom && rangeTo) { q.set('from', rangeFrom); q.set('to', rangeTo); }
      const qs = q.toString() ? `?${q}` : '';
      fetch(`/api/customers${qs}`, { credentials: 'include' })
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Could not load customers');
          return data;
        })
        .then((data) => {
          if (cancelled) return;
          setRows(data.customers || []);
          setTotals(data.totals || {});
          setError(null);
        })
        .catch((e) => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled && !silent) setLoading(false); });
    };

    load(false);
    // Silent background refresh — balances change as the till takes payments,
    // without the owner having to reload the page.
    const poll = setInterval(() => load(true), 15000);

    return () => { cancelled = true; clearInterval(poll); };
  }, [branchId, rangeFrom, rangeTo]);

  // With a period chosen, the table shows only people who had a credit order or made a payment in
  // it, with that period's own figures. An older cloud that cannot supply them is said so on
  // screen rather than quietly showing lifetime numbers under a period's name.
  const periodActive = Boolean(rangeFrom && rangeTo);
  const periodSupported = !periodActive || rows.length === 0 || rows[0].period_credited !== undefined;
  const periodMode = periodActive && periodSupported;
  const inPeriod = periodMode ? periodView(rows) : rows;
  const pTotals = periodMode ? periodTotals(rows) : null;

  const sortOptions = periodMode ? [...SORTS, ...PERIOD_SORTS] : SORTS;
  const activeSort = sortOptions.some(s => s.key === sortKey) ? sortKey : 'balance';

  const term = search.trim().toLowerCase();
  const matching = term
    ? inPeriod.filter(r =>
        String(r.name || '').toLowerCase().includes(term) ||
        String(r.phone || '').replace(/\D/g, '').includes(term.replace(/\D/g, '')) ||
        String(r.address || '').toLowerCase().includes(term))
    : inPeriod;
  // Display order only — the figures are exactly what the cloud sent.
  const visible = sortCustomers(matching, activeSort, localDay());

  const when = (v) => (v ? String(v).slice(0, 16) : '—');
  const td = { padding: '8px 10px' };
  const columns = periodMode
    ? [
        { h: 'Name', cell: c => (<>{c.name || 'Unnamed'}{c.active === 0 && (
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#6B7280', background: '#F3F4F6', border: '1px solid #E5E9F0', borderRadius: 999, padding: '1px 6px' }}>inactive</span>)}</>),
          style: { ...td, fontWeight: 600, color: '#111827' } },
        { h: 'Phone', cell: c => c.phone || '—', style: { ...td, color: '#374151', whiteSpace: 'nowrap' } },
        { h: 'Orders', cell: c => c.period_orders, style: { ...td, color: '#374151' } },
        { h: 'Credited', right: true, cell: c => money(c.total_credited), style: { ...td, textAlign: 'right', color: '#374151' } },
        { h: 'Paid', right: true, cell: c => money(c.total_paid), style: { ...td, textAlign: 'right', color: '#16A34A' } },
        { h: 'Balance', right: true, cell: c => money(c.balance), style: { ...td, textAlign: 'right', fontWeight: 700, color: (c.balance || 0) > 0 ? '#B45309' : '#111827' } },
        { h: 'Last order', cell: c => when(c.last_order_at), style: { ...td, color: '#374151', whiteSpace: 'nowrap' } },
      ]
    : [
        { h: 'Name', cell: c => (<>{c.name || 'Unnamed'}{c.active === 0 && (
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#6B7280', background: '#F3F4F6', border: '1px solid #E5E9F0', borderRadius: 999, padding: '1px 6px' }}>inactive</span>)}</>),
          style: { ...td, fontWeight: 600, color: '#111827' } },
        { h: 'Phone', cell: c => c.phone || '—', style: { ...td, color: '#374151', whiteSpace: 'nowrap' } },
        { h: 'Address', cell: c => c.address || '—', style: { ...td, color: '#6B7280', maxWidth: 320 } },
        { h: 'Litres', right: true, cell: c => `${Number(c.total_litres || 0).toFixed(1)} L`, style: { ...td, textAlign: 'right', color: '#374151' } },
        { h: 'Credited', right: true, cell: c => money(c.total_credited), style: { ...td, textAlign: 'right', color: '#374151' } },
        { h: 'Paid', right: true, cell: c => money(c.total_paid), style: { ...td, textAlign: 'right', color: '#16A34A' } },
        { h: 'Balance', right: true, cell: c => money(c.balance), style: { ...td, textAlign: 'right', fontWeight: 700, color: (c.balance || 0) > 0 ? '#B45309' : '#111827' } },
        { h: 'Last order', cell: c => String(c.last_order_at || '').slice(0, 10) || '—', style: { ...td, color: '#9CA3AF', whiteSpace: 'nowrap' } },
        { h: 'Days ago', cell: c => daysLabel(c.days), style: { ...td, color: '#374151', whiteSpace: 'nowrap' } },
        { h: 'Branches', cell: c => c.branches || '—', style: { ...td, color: '#6B7280' } },
      ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <BranchFilter value={branchId} onChange={setBranchId} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, phone or address"
          style={{
            flex: '1 1 260px', height: 36, borderRadius: 8, border: '1px solid #D1D5DB',
            padding: '0 12px', fontSize: 14, outline: 'none', fontFamily: 'inherit',
          }}
        />
        <select
          value={activeSort}
          onChange={e => setSortKey(e.target.value)}
          aria-label="Sort customers"
          style={{
            height: 36, borderRadius: 8, border: '1px solid #D1D5DB', padding: '0 10px',
            fontSize: 14, background: '#FFFFFF', color: '#111827', fontFamily: 'inherit',
          }}
        >
          {sortOptions.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {PERIODS.map(p => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            style={{
              padding: '6px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'inherit',
              background: period === p.key ? '#1B4C82' : '#FFFFFF',
              color: period === p.key ? '#FFFFFF' : '#6B7280',
              border: period === p.key ? '1px solid #1B4C82' : '1px solid #D1D5DB',
            }}
          >
            {p.label}
          </button>
        ))}
        {period === 'custom' && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 4 }}>
            <input type="date" value={customFrom} max={customTo || undefined} onChange={e => setCustomFrom(e.target.value)}
              aria-label="From date"
              style={{ height: 32, borderRadius: 8, border: '1px solid #D1D5DB', padding: '0 8px', fontSize: 13, fontFamily: 'inherit' }} />
            <span style={{ color: '#9CA3AF', fontSize: 13 }}>to</span>
            <input type="date" value={customTo} min={customFrom || undefined} onChange={e => setCustomTo(e.target.value)}
              aria-label="To date"
              style={{ height: 32, borderRadius: 8, border: '1px solid #D1D5DB', padding: '0 8px', fontSize: 13, fontFamily: 'inherit' }} />
          </span>
        )}
      </div>
      <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6B7280' }}>
        {period === 'all' && 'Showing every credit customer.'}
        {period !== 'all' && !periodActive && 'Pick both dates to see what customers took and paid in that range.'}
        {periodActive && !periodSupported && 'This cloud version cannot show a period yet, so the lifetime figures are shown.'}
        {periodMode && `From ${rangeFrom} to ${rangeTo}: customers who took milk on credit or paid something in this period. Credited and Paid are that period's own; Balance is what they owed at the end of ${rangeTo}.`}
      </p>

      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
          borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14,
        }}>
          {error}
        </div>
      )}

      <div style={{ ...card, marginBottom: 20 }}>
        {periodMode ? (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <Stat label="Customers active" value={pTotals.active} />
            <Stat label="Credited in period" value={money(pTotals.credited)} />
            <Stat label="Paid in period" value={money(pTotals.paid)} tone="#16A34A" />
            <Stat label={`Total balance at end of ${rangeTo}`} value={money(pTotals.outstanding)} tone="#B45309" />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <Stat label="Credit customers" value={totals.customers ?? 0} />
            <Stat label="Outstanding balance" value={money(totals.outstanding)} tone="#B45309" />
            <Stat label="Customers owing" value={totals.owing ?? 0} />
            <Stat label="Lifetime litres" value={`${Number(totals.litres || 0).toFixed(1)} L`} />
          </div>
        )}
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#9CA3AF' }}>
          Balances are computed at the till and pushed on every credit sale and
          every payment received, so they stay current within a sync.
        </p>
      </div>

      <section style={card}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#123A66' }}>
          Customers <span style={{ color: '#9CA3AF', fontWeight: 500 }}>({visible.length})</span>
        </h3>

        {loading ? (
          <p style={{ color: '#9CA3AF', fontSize: 14, margin: 0 }}>Loading…</p>
        ) : !visible.length ? (
          <p style={{ color: '#9CA3AF', fontSize: 14, margin: 0 }}>
            {rows.length
              ? (periodMode && !term
                  ? 'No customer took milk on credit or paid anything in this period.'
                  : 'Nobody matches that search.')
              : 'No credit customers yet. They are added at the till, on the Customers screen.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E9F0' }}>
                  {columns.map(col => (
                    <th key={col.h} style={{
                      textAlign: col.right ? 'right' : 'left', padding: '8px 10px',
                      fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: '#6B7280',
                      whiteSpace: 'nowrap',
                    }}>{col.h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(c => (
                  <tr key={c.group_key} style={{ borderBottom: '1px solid #F3F4F6' }}>
                    {columns.map(col => <td key={col.h} style={col.style}>{col.cell(c)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
