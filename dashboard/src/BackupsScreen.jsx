import React, { useCallback, useEffect, useState } from 'react';

/**
 * Backups, and getting the shop trading again on a different machine.
 *
 * Written for the worst moment rather than the calm one. Somebody is standing
 * in the shop at eight in the evening with a dead PC and a queue at the
 * counter; they are not going to open a terminal. So the one thing recovery
 * actually needs — the most recent database — is one press from this screen.
 *
 * There is no pairing step any more: the replacement machine reconnects with
 * the same fixed API key every till uses (see cloud/middleware/branch-auth.js)
 * — the owner already has it, nothing is generated here.
 *
 * The health banner is the other half. A backup nobody looks at is a guess,
 * and the failure mode is silent: everything keeps working right up until the
 * day it is needed. So a branch that has not sent one in a day says so here,
 * loudly, on the screen the owner already opens.
 */

const card = {
  background: '#FFFFFF', border: '1px solid #E5E9F0', borderRadius: 14, padding: 20,
};

const bytes = (n) => {
  if (n == null) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
};

function ago(ms) {
  if (ms == null) return 'never';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const HEALTH = {
  current: { label: 'Up to date', bg: '#F0FDF4', border: '#BBF7D0', fg: '#166534' },
  lagging: { label: 'Falling behind', bg: '#FFFBEB', border: '#FDE68A', fg: '#92400E' },
  stale: { label: 'Out of date', bg: '#FEF2F2', border: '#FECACA', fg: '#991B1B' },
  none: { label: 'No backup', bg: '#FEF2F2', border: '#FECACA', fg: '#991B1B' },
};

const btn = (kind) => ({
  padding: '7px 13px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
  background: kind === 'primary' ? '#1B4C82' : kind === 'danger' ? '#FFFFFF' : '#FFFFFF',
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
  if (!res.ok) throw new Error(data.error || 'That did not work');
  return data;
}

export default function BackupsScreen() {
  const [data, setData] = useState({ branches: [], backups: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setData(await call('GET', '/api/backup'));
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  const worst = data.branches.filter(b => b.health === 'stale' || b.health === 'none');
  const byBranch = (id) => data.backups.filter(b => b.branch_id === id);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
          borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {worst.length > 0 && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
          borderRadius: 10, padding: '14px 16px', marginBottom: 20, fontSize: 14,
        }}>
          <strong>
            {worst.map(b => b.name).join(' and ')}{' '}
            {worst.length === 1 ? 'has' : 'have'} not sent a backup.
          </strong>{' '}
          That till is either switched off or cannot reach this server. Until it
          does, losing that machine would mean losing whatever it has recorded
          since its last copy.
        </div>
      )}

      {loading ? (
        <p style={{ color: '#9CA3AF', fontSize: 14 }}>Loading…</p>
      ) : (
        data.branches.map((branch) => {
          const h = HEALTH[branch.health] || HEALTH.none;
          const list = byBranch(branch.id);
          return (
            <section key={branch.id} style={{ ...card, marginBottom: 20 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                gap: 12, flexWrap: 'wrap', marginBottom: 14,
              }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#123A66' }}>
                    {branch.name}{' '}
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: h.bg, border: `1px solid ${h.border}`, color: h.fg,
                      verticalAlign: 'middle', marginLeft: 6,
                    }}>
                      {h.label}
                    </span>
                  </h3>
                  <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 4 }}>
                    Last backup {ago(branch.last_backup_age_ms)}
                    {branch.backups_held > 0 && ` · ${branch.backups_held} kept · ${bytes(branch.stored_bytes)} stored`}
                  </div>
                </div>
              </div>

              {!list.length ? (
                <p style={{ color: '#9CA3AF', fontSize: 13.5, margin: 0 }}>
                  Nothing stored for this branch yet. A paired till sends one
                  every half hour and whenever a shift is closed.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #E5E9F0' }}>
                        {['Day', 'Taken', 'Orders', 'Last order', 'Size', '']
                          .map((t, i) => (
                            <th key={t || i} style={{
                              textAlign: i === 2 || i === 4 ? 'right' : 'left', padding: '8px',
                              fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3,
                              color: '#6B7280', whiteSpace: 'nowrap',
                            }}>{t}</th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((b, i) => (
                        <tr key={b.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                          <td style={{ padding: '8px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                            {String(b.backup_day).slice(0, 10)}
                            {i === 0 && (
                              <span style={{ color: '#059669', fontWeight: 700, fontSize: 11 }}> · newest</span>
                            )}
                          </td>
                          <td style={{ padding: '8px', color: '#6B7280', whiteSpace: 'nowrap' }}>
                            {String(b.taken_at).slice(11, 16)}
                            {b.reason === 'shift-close' && (
                              <span style={{ color: '#9CA3AF' }}> · shift close</span>
                            )}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>{b.orders_count ?? '—'}</td>
                          <td style={{ padding: '8px', color: '#6B7280', whiteSpace: 'nowrap' }}>
                            {b.last_order_at ? String(b.last_order_at).slice(0, 16) : '—'}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right', color: '#6B7280', whiteSpace: 'nowrap' }}>
                            {bytes(b.gz_bytes)}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>
                            <a
                              href={`/api/backup/${b.id}/download`}
                              style={{ ...btn(), textDecoration: 'none', display: 'inline-block' }}
                            >
                              Download
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}

      <section style={{ ...card, background: '#F9FAFB' }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15, fontWeight: 700 }}>
          If a branch's machine dies
        </h3>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: '#374151', lineHeight: 1.75 }}>
          <li>Install Pure Milk POS on the replacement machine and start it once, then close it.</li>
          <li><strong>Download</strong> that branch's newest backup above.</li>
          <li>Sign in on that machine, go to Settings &rarr; Data &amp; Backup &rarr;
              Restore, and choose the file you downloaded. Restart when it asks.</li>
          <li>On that machine, go to Settings &rarr; Branch &amp; Cloud and enter
              the same cloud address and API key every till uses. Nothing new
              to generate — it is the one key you already have.</li>
          <li>That is it. The menu, staff and settings catch up from here within a
              minute, and the till starts backing itself up again on its own.</li>
        </ol>
        <p style={{ margin: '12px 0 0', fontSize: 12.5, color: '#6B7280' }}>
          No takings are lost either way: sales reach this server within thirty
          seconds of being rung up, so everything on the Orders and Reports
          screens here is already safe. What a backup restores is the till's own
          copy — up to half an hour of it may need to be re-checked against the
          Orders screen here.
        </p>
      </section>
    </div>
  );
}
