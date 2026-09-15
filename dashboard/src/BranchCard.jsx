import React from 'react';
import { money, count, ago, duration, clockTime, timeOfDay } from './format';

/**
 * One branch.
 *
 * The rule this component exists to enforce: **a figure is never shown as
 * current unless it is**. A stale revenue number is worse than a blank one,
 * because a blank prompts a question and a stale number prompts a decision.
 *
 * So freshness is not a badge bolted onto the corner — it decides how the whole
 * card renders. An offline branch does not show dimmed numbers with a warning;
 * its figures are re-labelled "last known" and pushed behind the timestamp they
 * belong to, so they cannot be read as now.
 */

const TONE = {
  live:    { dot: '#16A34A', label: 'Live',    tint: '#F0FDF4', border: '#BBF7D0' },
  delayed: { dot: '#D97706', label: 'Delayed', tint: '#FFFBEB', border: '#FDE68A' },
  offline: { dot: '#DC2626', label: 'Offline', tint: '#FEF2F2', border: '#FECACA' },
  never:   { dot: '#9CA3AF', label: 'Never connected', tint: '#F9FAFB', border: '#E5E9F0' },
};

function Figure({ label, value, strong, muted }) {
  return (
    <div style={{ flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6B7280' }}>
        {label}
      </div>
      <div style={{
        fontSize: strong ? 26 : 17,
        fontWeight: strong ? 700 : 600,
        color: muted ? '#9CA3AF' : '#111827',
        marginTop: 2,
      }}>
        {value}
      </div>
    </div>
  );
}

export default function BranchCard({ branch, serverTimeMs }) {
  const tone = TONE[branch.freshness] || TONE.never;
  const stale = branch.freshness === 'offline' || branch.freshness === 'never';
  const shift = branch.shift;

  // A skewed till clock does not just mislead this screen — every order it
  // writes is timestamped from it, so it corrupts the reports too. Worth
  // surfacing wherever it is noticed.
  const skewMin = branch.clock_skew_ms == null ? 0 : Math.round(Math.abs(branch.clock_skew_ms) / 60000);
  const showSkew = skewMin >= 5;

  return (
    <div style={{
      border: `1px solid ${tone.border}`,
      background: '#FFFFFF',
      borderRadius: 14,
      padding: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: tone.dot }} />
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#123A66' }}>
            {branch.branch_name}
          </h2>
        </div>
        <span style={{
          fontSize: 12, fontWeight: 600, color: tone.dot,
          background: tone.tint, border: `1px solid ${tone.border}`,
          padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap',
        }}>
          {tone.label}
          {branch.age_ms != null && ` · ${ago(branch.age_ms)}`}
        </span>
      </div>

      {/* Never connected — say exactly that, rather than showing zeroes. */}
      {branch.freshness === 'never' && (
        <p style={{ margin: 0, fontSize: 14, color: '#6B7280' }}>
          This till has not reported yet. Check that it is running and that its
          <code style={{ margin: '0 4px' }}>cloud-sync.json</code> is in place.
        </p>
      )}

      {/* Offline — the figures become history, explicitly labelled as such. */}
      {branch.freshness === 'offline' && (
        <div style={{ background: tone.tint, border: `1px solid ${tone.border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#991B1B' }}>
            No contact since {timeOfDay(branch.server_received_ms) || 'earlier'}
          </div>
          <div style={{ fontSize: 13, color: '#7F1D1D', marginTop: 4 }}>
            The till may be closed, or its internet may be down. The figures below
            are the <strong>last known</strong> values, not current ones.
          </div>
        </div>
      )}

      {/* Online but nobody on the drawer. A real, fresh state — not a fault. */}
      {!stale && branch.state === 'no_open_shift' && (
        <p style={{ margin: 0, fontSize: 14, color: '#6B7280' }}>
          Till is online. No shift is open.
        </p>
      )}

      {shift && (
        <>
          <div style={{ fontSize: 13, color: stale ? '#9CA3AF' : '#374151' }}>
            <strong style={{ color: stale ? '#9CA3AF' : '#111827' }}>{shift.staff_name || 'Unknown'}</strong>
            {clockTime(shift.opened_at) && ` · opened ${clockTime(shift.opened_at)}`}
            {!stale && duration(shift.opened_at) && ` · ${duration(shift.opened_at)} in`}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <Figure label={stale ? 'Last known revenue' : 'Revenue'} value={money(shift.total_revenue)} strong muted={stale} />
            <Figure label="Orders" value={count(shift.total_orders)} strong muted={stale} />
            <Figure label={stale ? 'Drawer at last contact' : 'Expected in drawer'} value={money(shift.expected_cash)} strong muted={stale} />
          </div>

          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 16,
            borderTop: '1px solid #F3F4F6', paddingTop: 14,
          }}>
            <Figure label="Cash" value={money(shift.cash_revenue)} muted={stale} />
            <Figure label="Card / online" value={money(shift.non_cash_revenue)} muted={stale} />
            <Figure label="Opening float" value={money(shift.opening_cash)} muted={stale} />
          </div>
        </>
      )}

      <div style={{
        borderTop: '1px solid #F3F4F6', paddingTop: 14,
        display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'baseline',
      }}>
        <Figure
          label="Expenses today"
          value={money(branch.expenses_today?.total ?? 0)}
          muted={stale}
        />
        <div style={{ fontSize: 12, color: '#6B7280', alignSelf: 'center' }}>
          {count(branch.expenses_today?.count ?? 0)} recorded
          {shift?.drawer_expenses != null && ` · ${money(shift.drawer_expenses)} out of the drawer`}
        </div>
      </div>

      {showSkew && (
        <div style={{
          fontSize: 12, color: '#92400E', background: '#FFFBEB',
          border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px',
        }}>
          This till&rsquo;s clock is about {skewMin} minutes out. That also affects the
          time stamped on every order it records, so it is worth correcting.
        </div>
      )}
    </div>
  );
}
