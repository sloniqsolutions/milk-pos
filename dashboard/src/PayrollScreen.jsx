import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BranchFilter from './BranchFilter';

/**
 * Wages, one month at a time.
 *
 * The screen is built around what actually happens at the end of a month: the
 * owner works down a list, adjusts the two or three people whose month was not
 * ordinary, and pays everybody. So the ordinary person needs no interaction at
 * all — their row already shows their agreed salary and a Pay button — and the
 * exceptions are one field away.
 *
 * A paid month is locked. Changing the figures after the money has gone is how
 * a record stops matching what happened, so the payment has to be undone first,
 * which is one press and leaves a trail on screen.
 *
 * Nothing here ever reaches a till. See cloud/routes/payroll.js.
 */

const money = (v) =>
  v == null ? '—' : 'Rs ' + Number(v).toLocaleString('en-PK', { maximumFractionDigits: 0 });

const card = {
  background: '#FFFFFF', border: '1px solid #E5E9F0', borderRadius: 14, padding: 20,
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const periodLabel = (p) => {
  const [y, m] = String(p || '').split('-');
  return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : p;
};

/** The last 18 months, newest first. Payroll is never entered years ahead. */
function recentPeriods() {
  const out = [];
  const d = new Date();
  for (let i = 0; i < 18; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

const STATUS = {
  paid: { label: 'Paid', bg: '#F0FDF4', border: '#BBF7D0', fg: '#166534' },
  short: { label: 'Part paid', bg: '#FFFBEB', border: '#FDE68A', fg: '#92400E' },
  unpaid: { label: 'Unpaid', bg: '#F9FAFB', border: '#E5E9F0', fg: '#6B7280' },
};

function Pill({ status }) {
  const s = STATUS[status] || STATUS.unpaid;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
      background: s.bg, border: `1px solid ${s.border}`, color: s.fg, whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  );
}

function Stat({ label, value, tone, hint }) {
  return (
    <div style={{ flex: '1 1 150px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6B7280' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: tone || '#111827', marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

const input = {
  width: '100%', height: 32, borderRadius: 7, border: '1px solid #D1D5DB',
  padding: '0 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
  textAlign: 'right',
};

const btn = (kind) => ({
  padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
  background: kind === 'primary' ? '#1B4C82' : '#FFFFFF',
  color: kind === 'primary' ? '#FFFFFF' : kind === 'danger' ? '#B91C1C' : '#374151',
  border: `1px solid ${kind === 'primary' ? '#1B4C82' : kind === 'danger' ? '#FECACA' : '#D1D5DB'}`,
});

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'That did not save');
  return data;
}

/* ----------------------------------------------------------------- a row -- */

function Row({ person, period, onChanged, onError }) {
  const locked = person.status !== 'unpaid';
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  // Re-reads from the server's copy whenever it changes, so an edit abandoned
  // half-typed does not linger over a figure that has since moved.
  useEffect(() => { setDraft(null); }, [person.base_salary, person.bonus, person.overtime,
    person.advance, person.deduction, person.status, period]);

  const shown = draft || {
    base_salary: person.base_salary, bonus: person.bonus, overtime: person.overtime,
    advance: person.advance, deduction: person.deduction,
  };
  const num = (v) => (Number(v) > 0 ? Number(v) : 0);
  const net = Math.max(0,
    num(shown.base_salary) + num(shown.bonus) + num(shown.overtime)
    - num(shown.advance) - num(shown.deduction));
  const dirty = draft != null;

  const field = (key) => ({
    value: shown[key] ?? 0,
    disabled: locked || busy,
    onChange: (e) => setDraft({ ...shown, [key]: e.target.value }),
    style: { ...input, background: locked ? '#F9FAFB' : '#FFFFFF', color: locked ? '#9CA3AF' : '#111827' },
    type: 'number',
    min: 0,
  });

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); await onChanged(); }
    catch (e) { onError(e.message); }
    finally { setBusy(false); }
  };

  const save = () => run(async () => {
    await call('PUT', `/api/payroll/${person.id}/${period}`, {
      base_salary: num(shown.base_salary), bonus: num(shown.bonus),
      overtime: num(shown.overtime), advance: num(shown.advance),
      deduction: num(shown.deduction),
    });
    setDraft(null);
  });

  const pay = () => run(async () => {
    if (dirty) {
      await call('PUT', `/api/payroll/${person.id}/${period}`, {
        base_salary: num(shown.base_salary), bonus: num(shown.bonus),
        overtime: num(shown.overtime), advance: num(shown.advance),
        deduction: num(shown.deduction),
      });
    }
    await call('POST', `/api/payroll/${person.id}/${period}/pay`, {});
    setDraft(null);
  });

  const undo = () => run(() => call('DELETE', `/api/payroll/${person.id}/${period}/pay`));

  const cell = { padding: '8px 8px', verticalAlign: 'middle' };

  return (
    <tr style={{ borderBottom: '1px solid #F3F4F6', opacity: person.active ? 1 : 0.5 }}>
      <td style={{ ...cell, minWidth: 170 }}>
        <div style={{ fontWeight: 700, color: '#111827' }}>{person.name}</div>
        <div style={{ fontSize: 11.5, color: '#9CA3AF' }}>
          {person.job_title || 'No job title'}
          {person.branch_name ? ` · ${person.branch_name}` : ''}
          {!person.has_till_account && (
            // Worth saying: these are the riders and kitchen staff, who are on
            // the payroll but have no way to sign in to anything.
            <span style={{ color: '#C4B5FD' }}> · no till login</span>
          )}
          {!person.active && <span style={{ color: '#B91C1C' }}> · left</span>}
        </div>
      </td>
      <td style={{ ...cell, width: 110 }}><input {...field('base_salary')} /></td>
      <td style={{ ...cell, width: 100 }}><input {...field('bonus')} /></td>
      <td style={{ ...cell, width: 100 }}><input {...field('overtime')} /></td>
      <td style={{ ...cell, width: 100 }}><input {...field('advance')} /></td>
      <td style={{ ...cell, width: 100 }}><input {...field('deduction')} /></td>
      <td style={{ ...cell, textAlign: 'right', fontWeight: 800, fontSize: 14, whiteSpace: 'nowrap' }}>
        {money(net)}
      </td>
      <td style={{ ...cell, whiteSpace: 'nowrap' }}>
        <Pill status={person.status} />
        {person.status === 'short' && (
          <div style={{ fontSize: 11, color: '#92400E', marginTop: 3 }}>
            {money(person.paid_amount)} paid · {money(person.outstanding)} left
          </div>
        )}
        {person.status === 'paid' && person.paid_on && (
          <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 3 }}>
            {String(person.paid_on).slice(0, 10)}
          </div>
        )}
      </td>
      <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {locked ? (
          <button style={btn('danger')} onClick={undo} disabled={busy}>Undo payment</button>
        ) : (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {dirty && <button style={btn()} onClick={save} disabled={busy}>Save</button>}
            <button style={btn('primary')} onClick={pay} disabled={busy || net <= 0}>
              {dirty ? 'Save & pay' : 'Pay'}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------- the screen -- */

export default function PayrollScreen() {
  const [branchId, setBranchId] = useState('');
  const [period, setPeriod] = useState(recentPeriods()[0]);
  const [data, setData] = useState({ employees: [], totals: {} });
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', job_title: '', phone: '', monthly_salary: '', branch_id: '' });

  const load = useCallback(async () => {
    const qs = new URLSearchParams(branchId ? { period, branch: branchId } : { period });
    const d = await call('GET', `/api/payroll?${qs}`);
    setData(d);
    setError(null);
  }, [branchId, period]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => {
    call('GET', '/api/branches').then(setBranches).catch(() => setBranches([]));
  }, []);

  const people = data.employees || [];
  const totals = data.totals || {};
  const anyLeft = useMemo(() => people.some(p => !p.active), [people]);

  const addPerson = async () => {
    try {
      await call('POST', '/api/payroll/employees', {
        name: form.name,
        job_title: form.job_title,
        phone: form.phone,
        monthly_salary: Number(form.monthly_salary) || 0,
        branch_id: Number(form.branch_id) || Number(branchId) || null,
      });
      setForm({ name: '', job_title: '', phone: '', monthly_salary: '', branch_id: '' });
      setAdding(false);
      await load();
    } catch (e) { setError(e.message); }
  };

  const th = (align) => ({
    textAlign: align || 'left', padding: '8px', fontSize: 10.5,
    textTransform: 'uppercase', letterSpacing: 0.3, color: '#6B7280', whiteSpace: 'nowrap',
  });

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <BranchFilter value={branchId} onChange={setBranchId} />
        <select
          value={period}
          onChange={e => setPeriod(e.target.value)}
          style={{
            height: 34, borderRadius: 8, border: '1px solid #D1D5DB', padding: '0 10px',
            fontSize: 14, fontFamily: 'inherit', background: '#FFFFFF', cursor: 'pointer',
          }}
        >
          {recentPeriods().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button style={btn(adding ? undefined : 'primary')} onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Add someone without a till login'}
        </button>
      </div>

      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
          borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {adding && (
        <div style={{ ...card, marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#123A66' }}>Add to the payroll</h3>
          <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#6B7280' }}>
            For riders, kitchen and cleaning staff. They are paid through this
            screen and get no till account, no PIN and no way to sign in.
            Managers appear here automatically from the Staff tab.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {[
              ['name', 'Name', 'text', '1 1 180px'],
              ['job_title', 'Job', 'text', '1 1 140px'],
              ['phone', 'Phone', 'text', '1 1 140px'],
              ['monthly_salary', 'Monthly salary', 'number', '0 1 140px'],
            ].map(([key, label, type, flex]) => (
              <div key={key} style={{ flex }}>
                <label style={{ fontSize: 11.5, fontWeight: 600, color: '#374151' }}>{label}</label>
                <input
                  type={type}
                  value={form[key]}
                  onChange={e => setForm({ ...form, [key]: e.target.value })}
                  style={{ ...input, textAlign: type === 'number' ? 'right' : 'left', marginTop: 4, height: 34 }}
                />
              </div>
            ))}
            <div style={{ flex: '0 1 170px' }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: '#374151' }}>Branch</label>
              <select
                value={form.branch_id || branchId}
                onChange={e => setForm({ ...form, branch_id: e.target.value })}
                style={{
                  width: '100%', height: 34, marginTop: 4, borderRadius: 7,
                  border: '1px solid #D1D5DB', padding: '0 8px', fontSize: 13,
                  fontFamily: 'inherit', background: '#FFFFFF',
                }}
              >
                <option value="">Choose…</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <button style={{ ...btn('primary'), height: 34 }} onClick={addPerson} disabled={!form.name}>
              Add
            </button>
          </div>
        </div>
      )}

      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Stat label="On the payroll" value={totals.people ?? 0}
                hint={anyLeft ? 'plus former staff, shown faded' : null} />
          <Stat label={`Owed for ${periodLabel(period)}`} value={money(totals.net || 0)} />
          <Stat label="Paid so far" value={money(totals.paid || 0)} tone="#059669" />
          <Stat label="Still to pay" value={money(totals.outstanding || 0)}
                tone={totals.outstanding > 0 ? '#B45309' : '#059669'}
                hint={totals.unpaid_people ? `${totals.unpaid_people} ${totals.unpaid_people === 1 ? 'person' : 'people'}` : 'everybody is paid'} />
          <Stat label="Bonuses" value={money(totals.bonus || 0)} />
          <Stat label="Advances & deductions"
                value={money((totals.advance || 0) + (totals.deduction || 0))} />
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#9CA3AF' }}>
          Net is the salary plus bonus and overtime, less any advance already
          taken and any deduction. Marking a month paid records it against the
          day the money changed hands, which is the date the Reports screen
          counts it under.
        </p>
      </div>

      <section style={card}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#123A66' }}>
          {periodLabel(period)}{' '}
          <span style={{ color: '#9CA3AF', fontWeight: 500 }}>({people.length})</span>
        </h3>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#6B7280' }}>
          Every row starts at the agreed salary, so an ordinary month needs only
          the Pay button. A month that has been paid is locked — undo the payment
          to change its figures.
        </p>

        {loading ? (
          <p style={{ color: '#9CA3AF', fontSize: 14, margin: 0 }}>Loading…</p>
        ) : !people.length ? (
          <p style={{ color: '#9CA3AF', fontSize: 14, margin: 0 }}>
            Nobody on the payroll yet. Managers appear here from the Staff tab;
            add riders and kitchen staff with the button above.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E9F0' }}>
                  <th style={th()}>Person</th>
                  <th style={th('right')}>Salary</th>
                  <th style={th('right')}>Bonus</th>
                  <th style={th('right')}>Overtime</th>
                  <th style={th('right')}>Advance</th>
                  <th style={th('right')}>Deduction</th>
                  <th style={th('right')}>Net</th>
                  <th style={th()}>Status</th>
                  <th style={th('right')} />
                </tr>
              </thead>
              <tbody>
                {people.map(p => (
                  <Row
                    key={p.id}
                    person={p}
                    period={period}
                    onChanged={load}
                    onError={setError}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
