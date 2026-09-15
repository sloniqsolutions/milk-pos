import React, { useEffect, useState } from 'react';

/**
 * Shop-wide settings.
 *
 * Purpose-built rather than a reuse of the till's Settings screen, and that is
 * the honest choice: most of what that screen contains is genuinely per-branch.
 * A receipt footer, a printed address, a delivery charge and a paper size are
 * different at the two shops, and showing them here — editable, apparently
 * shop-wide — would invite the owner to set one branch's address on both.
 *
 * So this shows only what actually travels down to every till, and names what
 * it does not control rather than leaving that to be discovered.
 */

const card = {
  background: '#FFFFFF', border: '1px solid #E5E9F0',
  borderRadius: 14, padding: 20, marginBottom: 20,
};

const input = {
  width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
  padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit', background: '#FFFFFF',
};

export default function SettingsScreen() {
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState({});
  const [branchOwned, setBranchOwned] = useState([]);
  const [version, setVersion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  // Clearing all data — see the section below and cloud/routes/admin.js.
  const [clearOpen, setClearOpen] = useState(false);
  const [clearPassword, setClearPassword] = useState('');
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load settings');
      setFields(data.fields || []);
      setValues(data.settings || {});
      setBranchOwned(data.branch_owned || []);
      setVersion(data.version);
      setMessage(null);
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      // Only the fields this screen offers — never the whole values object,
      // which would send back anything the server happened to include.
      const payload = {};
      fields.forEach(f => { if (values[f.key] != null) payload[f.key] = values[f.key]; });

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');

      setValues(data.settings || {});
      setVersion(data.version);
      setMessage({
        tone: 'ok',
        text: 'Saved. Every till picks this up on its next sync, within about thirty seconds.',
      });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  /**
   * Saves the backup the server sent back (see cloud/routes/admin.js — it is
   * read inside the same transaction that deletes, so this is a true photo
   * of the instant before). Downloaded to disk before the "cleared" message
   * even shows, so there is no window where the data is gone from both the
   * database and the screen at once.
   */
  const downloadBackup = (backup) => {
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = backup.taken_at.replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `milk-pos-backup-before-clear-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const clearAllData = async () => {
    if (!clearPassword) {
      setClearMessage({ tone: 'error', text: 'Enter the dashboard password to confirm.' });
      return;
    }
    setClearing(true);
    try {
      const res = await fetch('/api/admin/clear-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: clearPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not clear data');

      if (data.backup) downloadBackup(data.backup);

      setClearPassword('');
      setClearOpen(false);
      setClearMessage({
        tone: 'ok',
        text: 'A backup was downloaded, then all trading data was cleared. The menu was left exactly as it was.',
      });
    } catch (err) {
      setClearMessage({ tone: 'error', text: err.message });
    } finally {
      setClearing(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 24, color: '#6B7280' }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
      {message && (
        <div style={{
          borderRadius: 10, padding: '11px 14px', marginBottom: 20, fontSize: 14,
          background: message.tone === 'ok' ? '#F0FDF4' : '#FEF2F2',
          border: `1px solid ${message.tone === 'ok' ? '#BBF7D0' : '#FECACA'}`,
          color: message.tone === 'ok' ? '#166534' : '#991B1B',
        }}>
          {message.text}
        </div>
      )}

      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#123A66' }}>Shop-wide settings</h2>
          {version != null && (
            <span style={{ fontSize: 12, color: '#9CA3AF' }}>version {version}</span>
          )}
        </div>
        <p style={{ margin: '0 0 18px', fontSize: 13, color: '#6B7280' }}>
          These are the same at both branches. Changing one here changes it on
          every till.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {fields.map(f => (
            <label key={f.key} style={{ display: 'block' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{f.label}</span>
              {f.type === 'select' ? (
                <select
                  value={values[f.key] ?? ''}
                  onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                  style={{ ...input, marginTop: 6 }}
                >
                  {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={values[f.key] ?? ''}
                  onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                  style={{ ...input, marginTop: 6 }}
                />
              )}
              {f.help && (
                <span style={{ display: 'block', fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
                  {f.help}
                </span>
              )}
            </label>
          ))}
        </div>

        <button
          onClick={save}
          disabled={saving}
          style={{
            marginTop: 22, height: 44, padding: '0 22px', borderRadius: 8, border: 'none',
            background: saving ? '#9CA3AF' : '#1B4C82', color: '#FFFFFF',
            fontSize: 15, fontWeight: 700, cursor: saving ? 'default' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save and send to the tills'}
        </button>
      </section>

      {/*
        Named explicitly. These are the settings an owner will come looking for
        and not find, and "where did the printer settings go" is a much worse
        experience than being told plainly why they are not here.
      */}
      <section style={{ ...card, background: '#F9FAFB' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 700, color: '#374151' }}>
          Set on each till, not here
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6B7280' }}>
          These are genuinely different at each shop, so each branch keeps its
          own. Changing them here would give both branches the same printed
          address and the same delivery charge.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {branchOwned.map(k => (
            <span key={k} style={{
              fontSize: 12, color: '#6B7280', background: '#FFFFFF',
              border: '1px solid #E5E9F0', borderRadius: 999, padding: '4px 10px',
            }}>
              {k.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      </section>

      {/*
        Handing this install off to its next owner. Wipes everything one shop
        actually did — orders, customers, staff, stock, backups — and leaves
        everything that belongs to the software rather than to a shop, the
        menu above all, exactly as it is. See cloud/routes/admin.js.
      */}
      <section style={{ ...card, border: '1.5px solid #FECACA', background: '#FEF2F2' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{
            width: 26, height: 26, borderRadius: '50%', background: '#FEE2E2',
            color: '#B91C1C', fontWeight: 800, fontSize: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            !
          </span>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#991B1B' }}>
            Clear all data
          </h3>
        </div>
        <p style={{ margin: '0 0 4px', fontSize: 13, color: '#7F1D1D', lineHeight: 1.5 }}>
          Permanently deletes every order, customer, manager account, shift,
          expense, stock count and backup. <strong>This cannot be undone.</strong>{' '}
          Use this only when handing this install to a new owner who needs to
          start with a genuinely empty shop.
        </p>
        <p style={{ margin: '0 0 4px', fontSize: 13, color: '#7F1D1D', lineHeight: 1.5 }}>
          A full backup downloads to your computer automatically, the instant
          before anything is deleted — everything you are about to lose is
          saved as one JSON file first.
        </p>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#7F1D1D', lineHeight: 1.5 }}>
          The menu and the administrator account are not touched — a new
          owner still needs the same product catalog and a way to sign in and
          set up their own staff, just none of the previous owner's sales
          history or managers.
        </p>

        {clearMessage && (
          <div style={{
            borderRadius: 8, padding: '9px 12px', marginBottom: 14, fontSize: 13,
            background: clearMessage.tone === 'ok' ? '#F0FDF4' : '#FFFFFF',
            border: `1px solid ${clearMessage.tone === 'ok' ? '#BBF7D0' : '#FCA5A5'}`,
            color: clearMessage.tone === 'ok' ? '#166534' : '#991B1B',
          }}>
            {clearMessage.text}
          </div>
        )}

        {!clearOpen ? (
          <button
            onClick={() => { setClearOpen(true); setClearMessage(null); }}
            style={{
              height: 40, padding: '0 18px', borderRadius: 8, border: '1.5px solid #B91C1C',
              background: '#FFFFFF', color: '#B91C1C', fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Clear all data…
          </button>
        ) : (
          <div style={{ background: '#FFFFFF', border: '1px solid #FECACA', borderRadius: 10, padding: 16 }}>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                Enter your dashboard password to confirm
              </span>
              <input
                type="password"
                autoFocus
                value={clearPassword}
                onChange={e => setClearPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') clearAllData(); }}
                style={{ ...input, marginTop: 6 }}
                placeholder="Password"
              />
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { setClearOpen(false); setClearPassword(''); setClearMessage(null); }}
                disabled={clearing}
                style={{
                  height: 40, padding: '0 16px', borderRadius: 8, border: '1px solid #E5E9F0',
                  background: '#FFFFFF', color: '#374151', fontSize: 13.5, fontWeight: 600,
                  cursor: clearing ? 'default' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={clearAllData}
                disabled={clearing}
                style={{
                  height: 40, padding: '0 16px', borderRadius: 8, border: 'none',
                  background: clearing ? '#FCA5A5' : '#B91C1C', color: '#FFFFFF',
                  fontSize: 13.5, fontWeight: 700, cursor: clearing ? 'default' : 'pointer',
                }}
              >
                {clearing ? 'Clearing…' : 'Yes, permanently clear all data'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
