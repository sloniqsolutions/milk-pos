// @ts-nocheck
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, AlertCircle, Truck, Flame, Users, Package, MoreHorizontal, ArrowLeft, ChevronRight } from 'lucide-react';
import moment from 'moment';
import { expensesAPI, shiftsAPI } from '@/api/index';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/lib/SettingsContext';
import PageHeader from '@/components/pos-ui/PageHeader';
import Modal from '@/components/pos-ui/Modal';
import Toast from '@/components/pos-ui/Toast';
import SearchBar from '@/components/pos-ui/SearchBar';
import NoShiftOverlay from '@/components/pos-ui/NoShiftOverlay';
import useDialogs from '@/lib/useDialogs';

/** Icon + accent colour shown for each fixed expense category. */
const CATEGORY_STYLE = {
  Transport: { icon: Truck, color: '#2563EB' },
  Gas: { icon: Flame, color: '#EA580C' },
  'Staff Wages': { icon: Users, color: '#7C3AED' },
  Supplies: { icon: Package, color: '#0D9488' },
  Miscellaneous: { icon: MoreHorizontal, color: '#6B7280' },
};
const categoryStyle = (name) => CATEGORY_STYLE[name] || { icon: MoreHorizontal, color: '#6B7280' };

/**
 * Money paid out of the shop — rider fuel, staff lunch, a repair.
 *
 * The reason this screen matters is the drawer. Cash handed out is gone from
 * the till but is not a sale, so unless it is recorded the shift closes short
 * by exactly that amount and the person counting gets blamed for it. Marking an
 * expense as paid from the drawer takes it straight off the shift's expected
 * cash; anything paid from a pocket or by card is still recorded but leaves the
 * drawer alone.
 */

const INPUT = {
  width: '100%', height: 44, borderRadius: 8,
  border: '1.5px solid #E5E7EB', background: '#FFFFFF',
  padding: '0 12px', fontSize: 14, color: '#111827',
  outline: 'none', fontFamily: 'Inter, sans-serif',
};

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 Days' },
  { id: 'last30', label: 'Last 30 Days' },
];

function rangeDates(id) {
  const today = moment().format('YYYY-MM-DD');
  if (id === 'yesterday') {
    const y = moment().subtract(1, 'day').format('YYYY-MM-DD');
    return { from: y, to: y };
  }
  if (id === 'last7') return { from: moment().subtract(6, 'days').format('YYYY-MM-DD'), to: today };
  if (id === 'last30') return { from: moment().subtract(29, 'days').format('YYYY-MM-DD'), to: today };
  return { from: today, to: today };
}

export default function ExpensesScreen({ onNavigate }) {
  const { currentUser, isAdmin } = useAuth();
  const { formatMoney, currencySymbol } = useSettings();

  const [range, setRange] = useState('today');
  const [expenses, setExpenses] = useState([]);
  const [totals, setTotals] = useState({ total: 0, from_drawer_total: 0, count: 0 });
  const [categories, setCategories] = useState([]);
  const [shift, setShift] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState(null);
  const [noShiftPrompt, setNoShiftPrompt] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ category: '', description: '', amount: '', fromDrawer: true });
  const { confirm, dialog } = useDialogs();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = rangeDates(range);
      const [data, cats, cur] = await Promise.all([
        expensesAPI.list({ from, to }),
        expensesAPI.categories(),
        shiftsAPI.current(),
      ]);
      setExpenses(data.expenses || []);
      setTotals(data.totals || { total: 0, from_drawer_total: 0, count: 0 });
      setCategories(cats || []);
      setShift(cur);
    } catch (err) {
      setToast({ message: err.message || 'Could not load expenses', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    if (!shift) {
      setNoShiftPrompt(true);
      return;
    }
    setForm({ category: categories[0] || '', description: '', amount: '', fromDrawer: true });
    setModalOpen(true);
  };

  const save = async () => {
    const amount = Number(form.amount);
    if (!form.category.trim()) {
      setToast({ message: 'Choose what the money was spent on', type: 'error' });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setToast({ message: 'Enter an amount greater than zero', type: 'error' });
      return;
    }

    setBusy(true);
    try {
      const created = await expensesAPI.create({
        category: form.category.trim(),
        description: form.description.trim(),
        amount,
        from_drawer: form.fromDrawer,
      });
      await load();
      setModalOpen(false);
      setToast({
        message: created.affected_shift
          ? `${formatMoney(amount)} recorded and taken off the drawer`
          : form.fromDrawer
            ? `${formatMoney(amount)} recorded — no shift is open, so the drawer was not adjusted`
            : `${formatMoney(amount)} recorded`,
        type: 'success',
      });
    } catch (err) {
      if (err.message && err.message.includes('shift is currently open')) {
        setModalOpen(false);
        setNoShiftPrompt(true);
      } else {
        setToast({ message: err.message || 'Could not save the expense', type: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row) => {
    const ok = await confirm({
      title: 'Remove this expense?',
      message: `${formatMoney(row.amount)} for ${row.category || 'this entry'} will be removed${row.from_drawer ? ' and added back to the expected drawer cash' : ''}.`,
      tone: 'danger',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await expensesAPI.remove(row.id);
      await load();
      setToast({ message: 'Expense removed', type: 'success' });
    } catch (err) {
      setToast({ message: err.message || 'Could not remove it', type: 'error' });
    }
  };

  const q = search.trim().toLowerCase();
  const visible = q
    ? expenses.filter(e =>
        String(e.category || '').toLowerCase().includes(q) ||
        String(e.description || '').toLowerCase().includes(q) ||
        String(e.staff_name || '').toLowerCase().includes(q))
    : expenses;

  const Stat = ({ label, value, hint, accent }) => (
    <div style={{
      flex: 1, background: '#FFFFFF', border: '1px solid #EBEBEB',
      borderRadius: 12, padding: 16,
    }}>
      <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || '#111827' }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>{hint}</div>}
    </div>
  );

  // Per-category totals for the currently selected date range — drives the
  // "By Category" cards below. Clicking one opens the full day-by-day
  // breakdown for that category (CategoryDetailScreen).
  const categoryTotals = categories.reduce((acc, c) => {
    acc[c] = expenses
      .filter(e => e.category === c)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    return acc;
  }, {});

  if (selectedCategory) {
    return (
      <CategoryDetailScreen
        category={selectedCategory}
        onBack={() => setSelectedCategory(null)}
        formatMoney={formatMoney}
      />
    );
  }

  return (
    <div className="flex-1 h-full overflow-y-auto" style={{ padding: 32, background: '#F7F9FC' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <PageHeader
          title="Expenses"
          subtitle="Money paid out — fuel, staff meals, supplies"
          actionLabel="Add Expense"
          actionIcon={Plus}
          onAction={openAdd}
        />

        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <Stat label="Total paid out" value={formatMoney(totals.total || 0)}
                hint={`${totals.count || 0} entr${(totals.count || 0) === 1 ? 'y' : 'ies'}`} />
          <Stat label="Taken from the drawer" value={formatMoney(totals.from_drawer_total || 0)}
                accent="#DC2626" hint="Deducted from expected cash" />
          <Stat
            label="Drawer should hold"
            value={shift ? formatMoney(shift.expected_cash || 0) : '—'}
            hint={shift
              ? `Float ${formatMoney(shift.opening_cash || 0)} + cash sales − payouts`
              : 'No shift open'}
          />
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>By Category</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
          {categories.map(c => {
            const { icon: Icon, color } = categoryStyle(c);
            return (
              <button
                key={c}
                onClick={() => setSelectedCategory(c)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                  background: '#FFFFFF', border: '1px solid #EBEBEB', borderRadius: 12,
                  padding: 14, cursor: 'pointer', transition: 'all 140ms',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = color; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#EBEBEB'; e.currentTarget.style.boxShadow = 'none'; }}
              >
                <div style={{
                  width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                  background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon size={18} color={color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#6B7280' }}>{c}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{formatMoney(categoryTotals[c] || 0)}</div>
                </div>
                <ChevronRight size={16} color="#D1D5DB" />
              </button>
            );
          })}
        </div>

        {/* The drawer only moves while a shift is open, so say so plainly
            rather than letting someone record a payout that quietly does
            nothing to the count they will do later. */}
        {!shift && (
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-start',
            background: '#FEF3C7', color: '#92400E',
            padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
          }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              No shift is open. Expenses are still recorded, but nothing is deducted from a
              drawer until a shift is started on the Shifts screen.
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {RANGES.map(r => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              style={{
                padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                background: range === r.id ? '#1B4C82' : '#FFFFFF',
                color: range === r.id ? '#FFFFFF' : '#6B7280',
                border: range === r.id ? 'none' : '1px solid #E5E9F0',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div style={{ marginBottom: 16 }}>
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search by type, note or who recorded it..."
            resultCount={visible.length}
            totalCount={expenses.length}
          />
        </div>

        <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #EBEBEB', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: '#F9FAFB', borderBottom: '1px solid #EBEBEB' }}>
                {['Time', 'Type', 'Note', 'Recorded by', 'From drawer', 'Amount', ''].map((h, i) => (
                  <th key={h + i} style={{
                    padding: '14px 16px', fontSize: 11, fontWeight: 700, color: '#6B7280',
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    textAlign: h === 'Amount' ? 'right' : h === 'From drawer' ? 'center' : 'left',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#9CA3AF' }}>Loading…</td></tr>
              )}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#9CA3AF' }}>
                  {q ? `Nothing matches "${q}".` : 'No expenses recorded for this period.'}
                </td></tr>
              )}
              {!loading && visible.map(e => {
                const mine = e.staff_id === currentUser?.id;
                return (
                  <tr key={e.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280' }}>
                      {moment(e.created_at).format('MMM D, hh:mm A')}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#111827' }}>{e.category}</td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280' }}>{e.description || '—'}</td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280' }}>{e.staff_name || '—'}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      {e.from_drawer ? (
                        <span style={{
                          padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                          background: '#FEE2E2', color: '#B91C1C',
                        }}>DRAWER</span>
                      ) : <span style={{ color: '#D1D5DB' }}>—</span>}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#111827' }}>
                      {formatMoney(e.amount)}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                      {(isAdmin || mine) && (
                        <button
                          onClick={() => remove(e)}
                          title={isAdmin ? 'Remove' : 'Remove your entry'}
                          style={{
                            width: 30, height: 30, borderRadius: 8, border: '1px solid #E5E7EB',
                            background: '#FFFFFF', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          <Trash2 size={14} color="#9CA3AF" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Add Expense" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              What was it for
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {categories.map(c => (
                <button
                  key={c}
                  onClick={() => setForm(f => ({ ...f, category: c }))}
                  style={{
                    padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                    cursor: 'pointer',
                    background: form.category === c ? '#111111' : '#FFFFFF',
                    color: form.category === c ? '#FFFFFF' : '#6B7280',
                    border: form.category === c ? 'none' : '1px solid #E5E7EB',
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
            <input
              style={INPUT}
              value={form.category}
              onChange={(e) => setForm(f => ({ ...f, category: e.target.value }))}
              placeholder="or type your own"
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Note <span style={{ fontWeight: 400, color: '#9CA3AF' }}>(optional)</span>
            </label>
            <input
              style={INPUT}
              value={form.description}
              onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="e.g. petrol for Ali, evening deliveries"
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Amount ({currencySymbol})
            </label>
            <input
              style={INPUT}
              type="number"
              min="0"
              step="1"
              value={form.amount}
              onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))}
              placeholder="0"
            />
          </div>

          {/* The whole point of the screen: cash out of the till has to come
              off the drawer, or the count at close will be short by this. */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 14px', borderRadius: 8,
            background: form.fromDrawer ? '#FEF2F2' : '#F9FAFB',
            border: `1px solid ${form.fromDrawer ? '#FECACA' : '#E5E7EB'}`,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Paid from the drawer</div>
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                {form.fromDrawer
                  ? 'Comes off the shift’s expected cash'
                  : 'Recorded only — the drawer is not adjusted'}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.fromDrawer}
              aria-label="Paid from the drawer"
              onClick={() => setForm(f => ({ ...f, fromDrawer: !f.fromDrawer }))}
              style={{
                width: 44, height: 24, borderRadius: 12, position: 'relative',
                border: 'none', padding: 0, cursor: 'pointer',
                background: form.fromDrawer ? '#DC2626' : '#E5E5E0',
                transition: 'background 140ms', flexShrink: 0,
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: form.fromDrawer ? 23 : 3,
                width: 18, height: 18, borderRadius: 9, background: '#FFFFFF',
                transition: 'left 140ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </button>
          </div>

          {form.fromDrawer && shift && (
            <div style={{ fontSize: 12, color: '#6B7280' }}>
              Drawer will go from <strong>{formatMoney(shift.expected_cash || 0)}</strong> to{' '}
              <strong>{formatMoney(Math.max(0, (shift.expected_cash || 0) - (Number(form.amount) || 0)))}</strong>
            </div>
          )}

          <button
            onClick={save}
            disabled={busy}
            style={{
              height: 44, borderRadius: 8, border: 'none', background: '#111111',
              color: '#FFFFFF', fontSize: 14, fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer', marginTop: 4,
            }}
          >
            {busy ? 'Saving…' : 'Record Expense'}
          </button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      {dialog}

      <NoShiftOverlay
        show={noShiftPrompt}
        message="You need to open a shift before you can record an expense."
        onRedirect={() => {
          setNoShiftPrompt(false);
          onNavigate && onNavigate('shifts');
        }}
      />
    </div>
  );
}

/**
 * Full-screen day-by-day breakdown for one expense category — "on which day
 * how much was spent on Gas", and so on for every category.
 */
function CategoryDetailScreen({ category, onBack, formatMoney }) {
  const [range, setRange] = useState('last30');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const { icon: Icon, color } = categoryStyle(category);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = rangeDates(range);
      const data = await expensesAPI.list({ from, to, category });
      setRows(data.expenses || []);
    } catch (err) {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [range, category]);

  useEffect(() => { load(); }, [load]);

  const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  const byDay = {};
  rows.forEach(r => {
    const day = moment(r.created_at).format('YYYY-MM-DD');
    if (!byDay[day]) byDay[day] = { day, count: 0, total: 0 };
    byDay[day].count += 1;
    byDay[day].total += Number(r.amount) || 0;
  });
  const dayRows = Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day));

  return (
    <div className="flex-1 h-full overflow-y-auto" style={{ padding: 32, background: '#F7F9FC' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <button
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: '1.5px solid #E5E9F0', background: '#FFFFFF',
              color: '#1B4C82', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            <ArrowLeft size={16} /> Back to Expenses
          </button>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: `${color}18`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={20} color={color} />
          </div>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0F1720', margin: 0 }}>{category} Expenses</h1>
            <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>Day-by-day breakdown of what was spent</p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {RANGES.map(r => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              style={{
                padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'Inter, sans-serif',
                background: range === r.id ? '#1B4C82' : '#FFFFFF',
                color: range === r.id ? '#FFFFFF' : '#6B7280',
                border: range === r.id ? 'none' : '1px solid #E5E9F0',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div style={{
          background: '#FFFFFF', border: '1px solid #EBEBEB', borderRadius: 12,
          padding: 16, marginBottom: 20, maxWidth: 260,
        }}>
          <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 6 }}>Total spent on {category}</div>
          <div style={{ fontSize: 24, fontWeight: 800, color }}>{formatMoney(total)}</div>
          <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>Daily Totals</div>
        <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #EBEBEB', overflow: 'hidden', marginBottom: 24 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: '#F9FAFB', borderBottom: '1px solid #EBEBEB' }}>
                <th style={{ padding: '12px 16px', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase' }}>Date</th>
                <th style={{ padding: '12px 16px', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', textAlign: 'center' }}>Entries</th>
                <th style={{ padding: '12px 16px', fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={3} style={{ padding: 24, textAlign: 'center', color: '#9CA3AF' }}>Loading…</td></tr>
              )}
              {!loading && dayRows.length === 0 && (
                <tr><td colSpan={3} style={{ padding: 24, textAlign: 'center', color: '#9CA3AF' }}>No {category} expenses in this period.</td></tr>
              )}
              {!loading && dayRows.map(d => (
                <tr key={d.day} style={{ borderBottom: '1px solid #F3F4F6' }}>
                  <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#111827' }}>
                    {moment(d.day, 'YYYY-MM-DD').format('MMM D, YYYY')}
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280', textAlign: 'center' }}>{d.count}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: '#111827', textAlign: 'right' }}>
                    {formatMoney(d.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>All Entries</div>
        <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #EBEBEB', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: '#F9FAFB', borderBottom: '1px solid #EBEBEB' }}>
                {['Time', 'Note', 'Recorded by', 'Amount'].map((h, i) => (
                  <th key={h + i} style={{
                    padding: '12px 16px', fontSize: 11, fontWeight: 700, color: '#6B7280',
                    textTransform: 'uppercase', textAlign: h === 'Amount' ? 'right' : 'left',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr><td colSpan={4} style={{ padding: 24, textAlign: 'center', color: '#9CA3AF' }}>Nothing recorded yet.</td></tr>
              )}
              {rows.map(e => (
                <tr key={e.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280' }}>
                    {moment(e.created_at).format('MMM D, hh:mm A')}
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280' }}>{e.description || '—'}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280' }}>{e.staff_name || '—'}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: '#111827', textAlign: 'right' }}>
                    {formatMoney(e.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
