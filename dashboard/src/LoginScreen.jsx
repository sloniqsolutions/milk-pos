import React, { useState } from 'react';
import { auth } from './api';
import cowLogo from '@/assets/cow-logo.png';

/**
 * Owner sign-in.
 *
 * Email and password, not the till's four-digit PIN — this page is on the open
 * internet and shows the shop's entire takings. The server answers every kind of
 * failure identically, so this form deliberately does not try to be more helpful
 * than that: telling someone "no such account" tells an attacker the same thing.
 *
 * The logo is the same file the till's own PIN screen uses
 * (frontend/src/assets/cow-logo.png), reached through the `@` alias that
 * already falls back to the POS source tree — see dashboard/vite.config.js.
 */
export default function LoginScreen({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await auth.login(email, password));
    } catch (err) {
      setError(err.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const fieldStyle = (name) => ({
    width: '100%', height: 46, borderRadius: 10,
    border: `1.5px solid ${focused === name ? '#1B4C82' : '#E5E9F0'}`,
    padding: '0 14px', fontSize: 15, outline: 'none', boxSizing: 'border-box',
    fontFamily: 'inherit', color: '#111827',
    background: focused === name ? '#FFFFFF' : '#FAFBFC',
    transition: 'border-color 140ms, background 140ms',
  });

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #EAF2FB 0%, #F7F9FC 45%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {/* Logo — deliberately large and set above the card, so it reads as the
            shop's mark rather than a small icon bolted onto a generic form. */}
        <div style={{
          width: 128, height: 128, borderRadius: '50%',
          background: '#FFFFFF', border: '4px solid #FFFFFF',
          boxShadow: '0 10px 30px rgba(27,76,130,0.22)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', marginBottom: 22,
        }}>
          <img src={cowLogo} alt="Pure Milk POS" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        <form onSubmit={submit} style={{
          background: '#FFFFFF', border: '1px solid #E5E9F0', borderRadius: 20,
          padding: '36px 36px 32px', width: '100%',
          display: 'flex', flexDirection: 'column', gap: 18,
          boxShadow: '0 12px 40px rgba(27,76,130,0.10)',
        }}>
          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#123A66', letterSpacing: '-0.3px' }}>
              Pure Milk POS
            </h1>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: '#6B7280' }}>Owner Dashboard</p>
          </div>

          <div style={{ height: 1, background: '#EEF1F5', margin: '2px 0 4px' }} />

          <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
            Email
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onFocus={() => setFocused('email')}
              onBlur={() => setFocused(null)}
              autoComplete="username"
              required
              placeholder="you@example.com"
              style={{ ...fieldStyle('email'), marginTop: 7 }}
            />
          </label>

          <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
            Password
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
              autoComplete="current-password"
              required
              placeholder="••••••••"
              style={{ ...fieldStyle('password'), marginTop: 7 }}
            />
          </label>

          {error && (
            <div style={{
              background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
              borderRadius: 10, padding: '11px 13px', fontSize: 13, fontWeight: 500,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              height: 48, borderRadius: 10, border: 'none', marginTop: 6,
              background: busy ? '#9CA3AF' : '#1B4C82', color: '#FFFFFF',
              fontSize: 15.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer',
              boxShadow: busy ? 'none' : '0 6px 16px rgba(27,76,130,0.32)',
              transition: 'background 140ms',
            }}
            onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = '#123A66'; }}
            onMouseLeave={(e) => { if (!busy) e.currentTarget.style.background = '#1B4C82'; }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p style={{ marginTop: 22, fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>
          Sales, shifts, expenses, stock and staff — synced from every till.
        </p>
      </div>
    </div>
  );
}
