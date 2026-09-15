import React from 'react';
import { useLive } from './useLive';
import BranchCard from './BranchCard';
import { money, count, ago, timeOfDay } from './format';

/**
 * The live view: both branches, side by side.
 *
 * Carries the second of the two staleness clocks (see useLive.js). If our own
 * polling stops, every card below would still claim to be live — each was, when
 * it was fetched — so the whole page is greyed out and banner-ed instead. That
 * failure is invisible to a per-card badge.
 */
export default function LiveScreen({ user, onSignOut, embedded = false }) {
  const { data, error, fetchedAt, pageAgeMs, pageStale, reload } = useLive(true);

  const branches = data?.branches || [];

  /*
   * A combined figure across branches is only meaningful if every branch is
   * actually reporting. Summing a live branch with one that went offline an
   * hour ago produces a number that looks authoritative and is simply wrong, so
   * the total says how many branches it covers and refuses to imply more.
   */
  const reporting = branches.filter(b => b.freshness === 'live' || b.freshness === 'delayed');
  const combined = reporting.reduce((acc, b) => ({
    revenue: acc.revenue + (b.shift?.total_revenue || 0),
    orders: acc.orders + (b.shift?.total_orders || 0),
    expenses: acc.expenses + (b.expenses_today?.total || 0),
  }), { revenue: 0, orders: 0, expenses: 0 });

  const allReporting = reporting.length === branches.length && branches.length > 0;

  return (
    <div style={embedded ? undefined : { minHeight: '100vh', background: '#F7F9FC' }}>
      {/* Standalone only: inside the shell the header already exists. */}
      {!embedded && (
        <header style={{
          background: '#FFFFFF', borderBottom: '1px solid #E5E9F0',
          padding: '14px 24px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#123A66' }}>Pure Milk POS — Live</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: '#6B7280' }}>{user.email}</span>
            <button onClick={onSignOut} style={{
              border: '1px solid #E5E9F0', background: '#FFFFFF', borderRadius: 8,
              padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151',
            }}>
              Sign out
            </button>
          </div>
        </header>
      )}

      {/*
        The page's own staleness. Rendered outside the dimmed region so it stays
        legible, and worded so there is no doubt the figures below are frozen.
      */}
      {(pageStale || error) && (
        <div style={{
          background: '#FEF2F2', borderBottom: '1px solid #FECACA',
          padding: '12px 24px', color: '#991B1B', fontSize: 14,
        }}>
          <strong>Not connected to the dashboard service.</strong>{' '}
          {fetchedAt
            ? `Everything below is frozen from ${timeOfDay(fetchedAt)} and is not current.`
            : 'No data has loaded yet.'}
          <button onClick={reload} style={{
            marginLeft: 12, border: '1px solid #FECACA', background: '#FFFFFF',
            color: '#991B1B', borderRadius: 6, padding: '4px 10px',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>
            Retry
          </button>
        </div>
      )}

      <main style={{
        padding: 24, maxWidth: 1200, margin: '0 auto',
        // The whole view dims when it cannot be trusted, so no individual
        // figure can be read as current.
        opacity: pageStale ? 0.45 : 1,
        filter: pageStale ? 'grayscale(0.6)' : 'none',
        transition: 'opacity 0.2s',
      }}>
        {!data && !error && (
          <p style={{ color: '#6B7280' }}>Loading…</p>
        )}

        {fetchedAt && (
          <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 12 }}>
            Refreshed {ago(pageAgeMs)}
          </div>
        )}

        {branches.length > 0 && (
          <section style={{
            background: '#FFFFFF', border: '1px solid #E5E9F0', borderRadius: 14,
            padding: 20, marginBottom: 20,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#123A66' }}>
                Across the open shifts
              </h2>
              <span style={{ fontSize: 12, color: allReporting ? '#6B7280' : '#B45309' }}>
                {allReporting
                  ? `both branches reporting`
                  : `${reporting.length} of ${branches.length} branches reporting — this total is incomplete`}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 28, marginTop: 14, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6B7280' }}>Revenue</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>{money(combined.revenue)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6B7280' }}>Orders</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>{count(combined.orders)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6B7280' }}>Expenses</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#B45309' }}>{money(combined.expenses)}</div>
              </div>
            </div>
            <p style={{ margin: '12px 0 0', fontSize: 12, color: '#9CA3AF' }}>
              These are the shifts open right now, not the whole day — a branch
              that has already cashed up is not counted. Not yet reconciled
              either: a later void can change them. Use Reports for the day&rsquo;s
              official total.
            </p>
          </section>
        )}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: 20,
        }}>
          {branches.map(b => (
            <BranchCard key={b.branch_id} branch={b} serverTimeMs={data?.server_time_ms} />
          ))}
        </div>
      </main>
    </div>
  );
}
