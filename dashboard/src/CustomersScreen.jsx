import React, { useEffect, useState } from 'react';
import BranchFilter from './BranchFilter';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = (silent) => {
      if (!silent) setLoading(true);
      const qs = branchId ? `?branch=${branchId}` : '';
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
  }, [branchId]);

  const term = search.trim().toLowerCase();
  const visible = term
    ? rows.filter(r =>
        String(r.name || '').toLowerCase().includes(term) ||
        String(r.phone || '').replace(/\D/g, '').includes(term.replace(/\D/g, '')) ||
        String(r.address || '').toLowerCase().includes(term))
    : rows;

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
      </div>

      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
          borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14,
        }}>
          {error}
        </div>
      )}

      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Stat label="Credit customers" value={totals.customers ?? 0} />
          <Stat label="Outstanding balance" value={money(totals.outstanding)} tone="#B45309" />
          <Stat label="Customers owing" value={totals.owing ?? 0} />
          <Stat label="Lifetime litres" value={`${Number(totals.litres || 0).toFixed(1)} L`} />
        </div>
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
              ? 'Nobody matches that search.'
              : 'No credit customers yet. They are added at the till, on the Customers screen.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E9F0' }}>
                  {['Name', 'Phone', 'Address', 'Litres', 'Credited', 'Paid', 'Balance', 'Last order', 'Branches']
                    .map((h, i) => (
                      <th key={h} style={{
                        textAlign: i >= 3 && i <= 6 ? 'right' : 'left', padding: '8px 10px',
                        fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: '#6B7280',
                        whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(c => (
                  <tr key={c.group_key} style={{ borderBottom: '1px solid #F3F4F6' }}>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: '#111827' }}>
                      {c.name || 'Unnamed'}
                      {c.active === 0 && (
                        <span style={{
                          marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#6B7280',
                          background: '#F3F4F6', border: '1px solid #E5E9F0',
                          borderRadius: 999, padding: '1px 6px',
                        }}>
                          inactive
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '8px 10px', color: '#374151', whiteSpace: 'nowrap' }}>
                      {c.phone || '—'}
                    </td>
                    <td style={{ padding: '8px 10px', color: '#6B7280', maxWidth: 320 }}>
                      {c.address || '—'}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: '#374151' }}>
                      {Number(c.total_litres || 0).toFixed(1)} L
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: '#374151' }}>
                      {money(c.total_credited)}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: '#16A34A' }}>
                      {money(c.total_paid)}
                    </td>
                    <td style={{
                      padding: '8px 10px', textAlign: 'right', fontWeight: 700,
                      color: (c.balance || 0) > 0 ? '#B45309' : '#111827',
                    }}>
                      {money(c.balance)}
                    </td>
                    <td style={{ padding: '8px 10px', color: '#9CA3AF', whiteSpace: 'nowrap' }}>
                      {String(c.last_order_at || '').slice(0, 10) || '—'}
                    </td>
                    <td style={{ padding: '8px 10px', color: '#6B7280' }}>
                      {c.branches || '—'}
                    </td>
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
