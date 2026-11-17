import React, { useEffect, useState } from 'react';
import moment from 'moment';
import { ArrowLeft, Phone, MapPin, Printer, Wallet, DollarSign, ArrowDownRight, ArrowUpRight, Clock, Calendar } from 'lucide-react';

/**
 * One customer's full credit record — the dashboard's read-only copy of the till's
 * customer screen (frontend/src/pages/CustomersScreen.jsx): balance, litres and Dahi
 * to date, totals, oldest unpaid bill, a monthly breakdown and every credit order and
 * payment. Recording payments and editing the customer stay on the till.
 */

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';
const CREAM = '#FFFDE0';

const money = (v) => 'Rs ' + Number(v || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
const when = (v) => moment(String(v || '').replace(' ', 'T')).format('DD MMM YYYY, h:mm A');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function Card({ label, value, sub, icon, tone, highlight }) {
  return (
    <div style={{
      background: highlight ? CREAM : '#FFFFFF', borderRadius: 12, padding: '18px 20px',
      border: highlight ? `2px solid ${BLUE}` : '1.5px solid #E5E9F0',
      boxShadow: highlight ? '0 2px 8px rgba(27,76,130,0.08)' : '0 1px 4px rgba(0,0,0,0.04)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: highlight ? BLUE : '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
        {icon}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: tone || BLUE_DARK, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function ledgerRows(data) {
  return [
    ...(data.orders || []).map((o) => ({ ...o, type: 'order' })),
    ...(data.payments || []).map((p) => ({ ...p, type: 'payment' })),
  ];
}

function printStatement(data) {
  const rows = ledgerRows(data).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const rowsHtml = rows.map((item) => `
    <tr>
      <td>${esc(when(item.created_at))}</td>
      <td>${item.type === 'order' ? `Credit Order #${esc(item.id)}${item.status === 'voided' ? ' (voided)' : ''}` : 'Payment Received'}</td>
      <td>${esc(item.type === 'payment' ? item.received_by || '' : item.cashier_name || '')}</td>
      <td>${esc(item.note || '')}</td>
      <td style="text-align:right; color:${item.type === 'order' ? '#B91C1C' : '#15803D'}; font-weight: 600;">
        ${item.type === 'order' ? '+ ' + esc(money(item.total)) : '- ' + esc(money(item.amount))}
      </td>
    </tr>`).join('');
  const monthlyHtml = (data.monthly_breakdown || []).map((m) => `
    <tr>
      <td>${esc(moment(m.month, 'YYYY-MM').format('MMMM YYYY'))}</td>
      <td style="text-align:right;">${Number(m.litres).toFixed(1)} L</td>
      <td style="text-align:right;">${esc(money(m.amount))}</td>
    </tr>`).join('');
  const win = window.open('', '_blank', 'width=800,height=900');
  if (!win) { window.alert('Please allow pop-ups to print the statement.'); return; }
  win.document.write(`
    <html><head><title>Statement - ${esc(data.name)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 32px; color: #111827; }
        h1 { font-size: 20px; margin-bottom: 4px; color: #1B4C82; }
        .muted { color: #6B7280; font-size: 13px; margin-bottom: 20px; }
        .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
        .stat { border: 1.5px solid #1B4C82; background: #FFFDE0; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
        .stat .label { font-size: 11px; color: #1B4C82; text-transform: uppercase; font-weight: 700; }
        .stat .value { font-size: 16px; font-weight: 700; margin-top: 2px; color: #123A66; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
        th, td { padding: 8px 10px; font-size: 13px; border-bottom: 1px solid #E5E7EB; text-align: left; }
        th { background: #EAF2FB; color: #1B4C82; font-weight: 700; }
        h2 { font-size: 15px; margin: 24px 0 8px; color: #1B4C82; }
      </style></head>
    <body>
      <h1>${esc(data.name)} — Credit Statement</h1>
      <div class="muted">${esc(data.phone || '')} ${data.address ? '· ' + esc(data.address) : ''} · Printed ${esc(moment().format('DD MMM YYYY, h:mm A'))}</div>
      <div class="stats">
        <div class="stat"><div class="label">Current Balance</div><div class="value">${esc(money(data.balance))}</div></div>
        <div class="stat"><div class="label">Total Litres</div><div class="value">${Number(data.total_litres || 0).toFixed(1)} L</div></div>
        <div class="stat"><div class="label">Total Dahi</div><div class="value">${Number(data.total_dahi_kg || 0).toFixed(2)} kg</div></div>
        <div class="stat"><div class="label">Total Billed</div><div class="value">${esc(money(data.total_credited))}</div></div>
        <div class="stat"><div class="label">Total Paid</div><div class="value">${esc(money(data.total_paid))}</div></div>
        <div class="stat"><div class="label">Oldest Unpaid</div><div class="value">${data.days_outstanding > 0 ? data.days_outstanding + ' days' : '—'}</div></div>
      </div>
      ${monthlyHtml ? `<h2>Monthly Breakdown</h2><table><thead><tr><th>Month</th><th style="text-align:right;">Litres</th><th style="text-align:right;">Amount</th></tr></thead><tbody>${monthlyHtml}</tbody></table>` : ''}
      <h2>Full Transaction History</h2>
      <table><thead><tr><th>Date</th><th>Description</th><th>By</th><th>Note</th><th style="text-align:right;">Amount</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    </body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

export default function CustomerDetail({ customer, branchId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null); setError(null);
    const q = new URLSearchParams({ key: customer.group_key });
    if (branchId) q.set('branch', branchId);
    fetch(`/api/customers/detail?${q}`, { credentials: 'include' })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Could not load this customer');
        return body;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [customer.group_key, branchId]);

  const rows = data ? ledgerRows(data).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) : [];
  const th = { padding: '12px 16px', fontSize: 12, fontWeight: 700, color: BLUE };
  const td = { padding: '12px 16px', fontSize: 13 };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{
        padding: '16px 20px', background: '#FFFFFF', border: '1px solid #E5E9F0', borderRadius: 14,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <button onClick={onBack} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8,
            border: '1.5px solid #E5E9F0', background: '#FFFFFF', color: BLUE, fontSize: 13, fontWeight: 700,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
            <ArrowLeft size={16} /> All Customers
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%', background: BLUE, color: CREAM, display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 800, flexShrink: 0,
            }}>
              {String(customer.name || '?').trim().charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 800, color: BLUE_DARK, margin: 0 }}>{customer.name || 'Unnamed'}</h1>
              <div style={{ fontSize: 13, color: '#6B7280', display: 'flex', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
                {customer.phone && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Phone size={12} color={BLUE} /> {customer.phone}</span>}
                {customer.address && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><MapPin size={12} color={BLUE} /> {customer.address}</span>}
                {customer.branches && <span>{customer.branches}</span>}
              </div>
            </div>
          </div>
        </div>
        <button onClick={() => data && printStatement(data)} disabled={!data} style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px', borderRadius: 8,
          border: `1.5px solid ${BLUE}`, background: '#FFFFFF', color: BLUE, fontSize: 13, fontWeight: 700,
          cursor: data ? 'pointer' : 'default', opacity: data ? 1 : 0.5, fontFamily: 'inherit',
        }}>
          <Printer size={15} /> Print Statement
        </button>
      </div>

      {error ? (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', borderRadius: 10, padding: '12px 16px', fontSize: 14 }}>{error}</div>
      ) : !data ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: '#6B7280', fontSize: 15 }}>Loading customer record...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
            <Card highlight label="Current Balance" value={money(data.balance)} tone={data.balance > 0 ? '#B45309' : BLUE_DARK}
              sub={data.balance > 0 ? 'Payment pending' : 'All accounts clear'} icon={<Wallet size={18} color={BLUE} />} />
            <Card label="Litres Consumed To Date" value={`${Number(data.total_litres || 0).toFixed(1)} L`} sub="Milk bought in all past sales" icon={<span style={{ fontSize: 18 }}>🥛</span>} />
            <Card label="Dahi Consumed To Date" value={`${Number(data.total_dahi_kg || 0).toFixed(2)} kg`} sub="Dahi / yogurt bought in all past sales" icon={<span style={{ fontSize: 18 }}>🥣</span>} />
            <Card label="Total Credited" value={money(data.total_credited)} sub="Total value of credit orders" icon={<DollarSign size={18} color={BLUE} />} />
            <Card label="Total Received" value={money(data.total_paid)} tone="#16A34A" sub="All payments collected" icon={<ArrowDownRight size={18} color="#16A34A" />} />
            <Card label="Oldest Unpaid" value={data.days_outstanding > 0 ? `${data.days_outstanding} days` : '—'} tone={data.days_outstanding > 20 ? '#DC2626' : BLUE_DARK}
              sub="Age of oldest pending bill" icon={<Clock size={18} color={data.days_outstanding > 20 ? '#DC2626' : '#6B7280'} />} />
          </div>

          <div style={{ background: '#FFFFFF', borderRadius: 12, padding: 20, border: '1.5px solid #E5E9F0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: BLUE_TINT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Calendar size={18} color={BLUE} />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0F1720', margin: 0 }}>Monthly Breakdown</h3>
                <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>Usage and spend by calendar month</p>
              </div>
            </div>
            {!data.monthly_breakdown.length ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>No monthly billing records found.</div>
            ) : (
              <div style={{ border: '1px solid #E5E9F0', borderRadius: 8, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: '#F7F9FC', borderBottom: '1px solid #E5E9F0' }}>
                      <th style={th}>Month</th>
                      <th style={{ ...th, textAlign: 'right' }}>Litres</th>
                      <th style={{ ...th, textAlign: 'right' }}>Dahi</th>
                      <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.monthly_breakdown.map((m) => (
                      <tr key={m.month} style={{ borderBottom: '1px solid #F1F5F9' }}>
                        <td style={{ ...td, fontWeight: 600, color: '#0F1720' }}>{moment(m.month, 'YYYY-MM').format('MMMM YYYY')}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{Number(m.litres).toFixed(1)} L</td>
                        <td style={{ ...td, textAlign: 'right' }}>{Number(m.dahi_kg).toFixed(2)} kg</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: BLUE_DARK }}>{money(m.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ background: '#FFFFFF', borderRadius: 12, padding: 20, border: '1.5px solid #E5E9F0' }}>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0F1720', margin: 0 }}>Full Transaction History</h3>
              <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>All credit orders and payment receipts</p>
            </div>
            {!rows.length ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14 }}>No transactions recorded for this customer yet.</div>
            ) : (
              <div style={{ border: '1px solid #E5E9F0', borderRadius: 8, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: '#F7F9FC', borderBottom: '1px solid #E5E9F0' }}>
                      <th style={th}>Date & Time</th>
                      <th style={th}>Transaction</th>
                      <th style={th}>Received By / Staff</th>
                      <th style={th}>Notes</th>
                      <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item, idx) => (
                      <tr key={`${item.type}-${item.id}-${idx}`} style={{ borderBottom: '1px solid #F1F5F9', background: item.type === 'order' ? '#FFFFFF' : '#F0FDF4' }}>
                        <td style={{ ...td, color: '#6B7280', whiteSpace: 'nowrap' }}>{when(item.created_at)}</td>
                        <td style={{ ...td, fontWeight: 600, color: '#0F1720' }}>
                          {item.type === 'order' ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 9999, background: '#FEE2E2', color: '#DC2626', fontSize: 11, fontWeight: 700 }}>
                              <ArrowUpRight size={12} /> Credit Order #{item.id}{item.status === 'voided' ? ' (voided)' : ''}
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 9999, background: '#DCFCE7', color: '#16A34A', fontSize: 11, fontWeight: 700 }}>
                              <ArrowDownRight size={12} /> Payment Received
                            </span>
                          )}
                        </td>
                        <td style={{ ...td, color: '#0F1720' }}>{item.received_by || item.cashier_name || '—'}</td>
                        <td style={{ ...td, color: '#6B7280', fontStyle: item.note ? 'normal' : 'italic' }}>{item.note || '—'}</td>
                        <td style={{
                          ...td, fontSize: 14, fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap',
                          color: item.type === 'order' ? (item.status === 'voided' ? '#9CA3AF' : '#DC2626') : '#16A34A',
                          textDecoration: item.status === 'voided' ? 'line-through' : 'none',
                        }}>
                          {item.type === 'order' ? `+ ${money(item.total)}` : `− ${money(item.amount)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
