import { Fragment, useRef, useState } from 'react';
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { activationAPI } from '@/api/index';
import cowLogo from '@/assets/cow-logo.png';

const GROUP_COUNT = 5;
const GROUP_LENGTH = 5;

/** Uppercase alphanumeric only — matches what the activation server accepts. */
const clean = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, GROUP_LENGTH);

interface ActivationScreenProps {
  onActivated: () => void;
}

/**
 * Shown instead of the PIN screen until this install has a valid product
 * key. Masked like a password by default — a product key visible over a
 * cashier's shoulder is exactly the credential this exists to protect — with
 * a show/hide toggle for the one moment that actually needs it: checking a
 * typo before submitting a 25-character string nobody can memorise.
 */
export default function ActivationScreen({ onActivated }: ActivationScreenProps) {
  const [groups, setGroups] = useState<string[]>(Array(GROUP_COUNT).fill(''));
  const [revealed, setRevealed] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const complete = groups.every((g) => g.length === GROUP_LENGTH);

  const setGroup = (index: number, raw: string) => {
    const value = clean(raw);
    setGroups((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setError('');
    if (value.length === GROUP_LENGTH && index < GROUP_COUNT - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !groups[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  /** A key pasted whole — "VK7JG-NPHTM-C97JM-9MPGT-3V66T" or without the
   * dashes — fills every box at once instead of landing entirely in the one
   * that was focused. */
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = clean2(e.clipboardData.getData('text'));
    if (text.length < GROUP_LENGTH) return;
    e.preventDefault();
    const next = Array(GROUP_COUNT).fill('');
    for (let i = 0; i < GROUP_COUNT; i++) {
      next[i] = text.slice(i * GROUP_LENGTH, i * GROUP_LENGTH + GROUP_LENGTH);
    }
    setGroups(next);
    setError('');
    const lastFilled = next.findIndex((g) => g.length < GROUP_LENGTH);
    inputRefs.current[lastFilled === -1 ? GROUP_COUNT - 1 : lastFilled]?.focus();
  };

  const activate = async () => {
    if (!complete || activating) return;
    setActivating(true);
    setError('');
    try {
      await activationAPI.activate(groups.join('-'));
      onActivated();
    } catch (err) {
      setShaking(true);
      setError(err instanceof Error && err.message ? err.message : 'Could not activate.');
      setTimeout(() => setShaking(false), 400);
    } finally {
      setActivating(false);
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', display: 'flex', overflow: 'hidden',
      fontFamily: 'Inter, -apple-system, sans-serif', background: '#FFFEF0',
    }}>
      {/* ── LEFT PANEL ── */}
      <div style={{
        width: '42%', height: '100%', display: 'flex', flexDirection: 'column',
        justifyContent: 'flex-start', padding: '36px 40px', overflow: 'hidden',
        background: '#FFFEF0', borderRight: '1px solid #E8E4DA',
      }}>
        <div style={{ marginBottom: 20 }}>
          <img
            src={cowLogo}
            alt="Pure Milk POS"
            style={{ width: '100%', maxWidth: 460, height: 370, borderRadius: 16, objectFit: 'cover', display: 'block' }}
          />
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#000000', letterSpacing: '-1px', lineHeight: 1.15, marginBottom: 10 }}>
            Activate Pure Milk POS
          </div>
          <div style={{ width: 40, height: 3, background: '#000000', borderRadius: 2, marginBottom: 20 }} />
          <div style={{ fontSize: 15, color: '#6B6B63', lineHeight: 1.5, fontWeight: 400 }}>
            This copy of the till software needs a one-time product key before
            it can be used. It came with your purchase — check the card or
            message it was sent in.
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px',
            background: '#FBFEFE', border: '1px solid #E8E4DA', borderRadius: 9999,
          }}>
            <ShieldCheck size={12} color="#A3A39A" />
            <span style={{ color: '#A3A39A', fontSize: 11, fontWeight: 500 }}>
              Licensed installs only
            </span>
          </div>
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div style={{
        flex: 1, height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', background: '#1F4E79',
        padding: '40px 48px', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ width: '100%', maxWidth: 460 }}>
          <div style={{ marginBottom: 28 }}>
            <h2 style={{ color: '#FFFFFF', fontSize: 24, fontWeight: 700, letterSpacing: '-0.5px', margin: '0 0 6px 0' }}>
              Enter product key
            </h2>
            <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14, margin: 0, fontWeight: 400 }}>
              Five groups of five characters, like VK7JG-NPHTM-C97JM-9MPGT-3V66T
            </p>
          </div>

          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              animation: shaking ? 'activationShake 0.4s ease' : 'none',
              marginBottom: 16,
            }}
          >
            {groups.map((value, i) => (
              <Fragment key={i}>
                {i > 0 && <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 18, fontWeight: 700 }}>—</span>}
                <input
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type={revealed ? 'text' : 'password'}
                  value={value}
                  maxLength={GROUP_LENGTH}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={activating}
                  onChange={(e) => setGroup(i, e.target.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  onPaste={onPaste}
                  style={{
                    width: 76, height: 54, borderRadius: 10, textAlign: 'center',
                    fontSize: 20, fontWeight: 700, letterSpacing: 3,
                    color: '#111110', background: '#FFFFFF', fontFamily: 'Inter, sans-serif',
                    border: error ? '1.5px solid #EF4444' : value.length === GROUP_LENGTH ? '1.5px solid #16A34A' : '1.5px solid #E5E5E0',
                    outline: 'none', transition: 'border-color 140ms',
                  }}
                />
              </Fragment>
            ))}

            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              title={revealed ? 'Hide key' : 'Show key'}
              style={{
                width: 40, height: 54, borderRadius: 10, border: '1.5px solid rgba(255,255,255,0.25)',
                background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.75)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                marginLeft: 4,
              }}
            >
              {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          <p style={{
            color: '#FCA5A5', fontSize: 13, margin: '0 0 18px 0', minHeight: 18,
            opacity: error ? 1 : 0, transition: 'opacity 180ms',
          }}>
            {error || ' '}
          </p>

          <button
            onClick={activate}
            disabled={!complete || activating}
            style={{
              width: '100%', height: 50, borderRadius: 10, border: 'none',
              background: !complete || activating ? 'rgba(255,255,255,0.25)' : '#FFFFFF',
              color: !complete || activating ? 'rgba(255,255,255,0.6)' : '#1F4E79',
              fontSize: 15, fontWeight: 700, cursor: !complete || activating ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 140ms',
            }}
          >
            {activating ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            {activating ? 'Activating…' : 'Activate'}
          </button>
        </div>

        <style>{`
          @keyframes activationShake {
            0%, 100% { transform: translateX(0); }
            15% { transform: translateX(-7px); }
            30% { transform: translateX(7px); }
            45% { transform: translateX(-5px); }
            60% { transform: translateX(5px); }
            75% { transform: translateX(-3px); }
            90% { transform: translateX(3px); }
          }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
}

/** Same cleanup as `clean`, without the 5-character cap — used once, on
 * paste, before the text is split into groups. */
function clean2(v: string) {
  return v.toUpperCase().replace(/[^0-9A-Z]/g, '');
}
