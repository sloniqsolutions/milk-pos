import { useState, useEffect } from 'react';
import { Users, ChevronDown, Check, Delete, ChevronLeft, Loader2, Shield } from 'lucide-react';
import { staffAPI, settingsAPI } from '../api/index';
import { useAuth } from '../context/AuthContext';
import cowLogo from '@/assets/cow-logo.png';

interface Staff {
  id: number;
  name: string;
  role: string;
  color: string;
  active: number;
}

interface Settings {
  restaurant_name?: string;
}

export default function LoginScreen() {
  const { login } = useAuth();
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<Staff | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [shaking, setShaking] = useState(false);
  const [pinError, setPinError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [restaurantName, setRestaurantName] = useState('Pure Milk');
  const [loading, setLoading] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [staff, settings] = await Promise.all([
          staffAPI.directory(),
          settingsAPI.getAll()
        ]) as [Staff[], Settings];
        // The directory endpoint only ever returns active accounts, so this
        // no longer filters on a field the payload may not carry.
        setStaffList(staff);
        if (settings.restaurant_name) setRestaurantName(settings.restaurant_name);
      } catch (err) {
        console.error('Failed to load login data:', err);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  const getInitials = (name: string) =>
    name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);

  const getGreeting = () => {
    const h = currentTime.getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const formatTime = () => currentTime.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true
  });

  const formatDate = () => currentTime.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const addDigit = (digit: string) => {
    if (pin.length < 4 && !loggingIn) {
      const newPin = pin + digit;
      setPin(newPin);
      if (newPin.length === 4) verifyPin(newPin);
    }
  };

  const removeDigit = () => {
    if (pin.length > 0) {
      setPin(pin.slice(0, -1));
      setPinError(false);
      setErrorMessage('');
    }
  };

  const verifyPin = async (enteredPin: string) => {
  setLoggingIn(true);
  try {
    // SECURITY: the entered PIN and the full staff record used to be written
    // to the console here, and the packaged build opens devtools, so every
    // login printed a working credential to a visible window.
    if (!selectedStaff) {
      setErrorMessage('Select an account first.');
      return;
    }
    // The account is part of the credential: the backend checks this PIN
    // against this account and no other.
    const result = await staffAPI.login(String(enteredPin), selectedStaff.id);
    login(result);
  } catch (err) {
    setShaking(true);
    setPinError(true);

    // The backend now locks out after repeated failures and returns the
    // remaining wait in its message. Showing our own hardcoded string instead
    // would leave a locked-out cashier retyping a correct PIN with no idea
    // why it keeps failing, so prefer the server's wording when it differs.
    const message = err instanceof Error && err.message ? err.message : '';
    const isLockout = /try again in/i.test(message);
    setErrorMessage(isLockout ? message : 'Incorrect PIN. Try again.');
    setPin('');
    setTimeout(() => {
      setShaking(false);
      setPinError(false);
      // A lockout notice stays put — it is still true after the shake ends.
      if (!isLockout) setErrorMessage('');
    }, 800);
  } finally {
    setLoggingIn(false);
  }
};

  const numpadKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      overflow: 'hidden',
      fontFamily: 'Inter, -apple-system, sans-serif',
      background: '#FFFEF0',
    }}>

      {/* ── LEFT PANEL ── */}
      <div style={{
        width: '42%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        padding: '36px 40px',
        overflow: 'hidden',
        background: '#FFFEF0',
        borderRight: '1px solid #E8E4DA',
      }}>

        {/* Logo image */}
        <div style={{ position: 'relative', zIndex: 1, marginBottom: 20 }}>
          <img
            src={cowLogo}
            alt={restaurantName}
            style={{
              width: '100%',
              maxWidth: 460,
              height: 370,
              borderRadius: 16,
              objectFit: 'cover',
              display: 'block',
            }}
          />
        </div>

        {/* Time + Greeting — pushed further down */}
        <div style={{ position: 'relative', zIndex: 1, marginTop: 10 }}>
          <div style={{
            fontSize: 44,
            fontWeight: 800,
            color: '#000000',
            letterSpacing: '-2px',
            lineHeight: 1,
            marginBottom: 8,
          }}>
            {formatTime()}
          </div>
          <div style={{
            fontSize: 14,
            color: '#6B6B63',
            fontWeight: 500,
            marginBottom: 20,
          }}>
            {formatDate()}
          </div>

          {/* Divider */}
          <div style={{
            width: 40, height: 3,
            background: '#000000',
            borderRadius: 2, marginBottom: 20,
          }} />

          <div style={{
            fontSize: 22,
            fontWeight: 700,
            color: '#000000',
            letterSpacing: '-0.5px',
            lineHeight: 1.35,
          }}>
            {getGreeting()},<br />
            <span style={{ color: '#6B6B63', fontWeight: 400, fontSize: 17 }}>
              select your account to begin.
            </span>
          </div>
        </div>

        {/* Spacer pushes the badge to the bottom */}
        <div style={{ flex: 1 }} />

        {/* Security badge */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '7px 14px',
            background: '#FBFEFE',
            border: '1px solid #E8E4DA',
            borderRadius: 9999,
          }}>
            <Shield size={12} color="#A3A39A" />
            <span style={{ color: '#A3A39A', fontSize: 11, fontWeight: 500 }}>
              PIN-secured access · v1.0.0
            </span>
          </div>
        </div>

      </div>

      {/* ── RIGHT PANEL ── */}
      <div style={{
        flex: 1,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1F4E79',
        padding: '40px 48px',
        position: 'relative',
        overflow: 'hidden',
      }}>

        <div style={{ width: '100%', maxWidth: 380, position: 'relative', zIndex: 1 }}>

          {/* Header */}
          <div style={{ marginBottom: 32 }}>
            <h2 style={{
              color: '#FFFFFF', fontSize: 24, fontWeight: 700,
              letterSpacing: '-0.5px', margin: '0 0 6px 0',
            }}>
              Sign in
            </h2>
            <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14, margin: 0, fontWeight: 400 }}>
              Choose your account and enter your PIN
            </p>
          </div>

          {/* ACCOUNT SELECTOR */}
          <div style={{ marginBottom: 22 }}>
            <label style={{
              display: 'block',
              color: 'rgba(255,255,255,0.7)',
              fontSize: 11, fontWeight: 600,
              letterSpacing: '1.1px', textTransform: 'uppercase',
              marginBottom: 8,
            }}>
              Account
            </label>

            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                style={{
                  width: '100%', height: 50,
                  background: '#FFFFFF',
                  border: selectedStaff ? '1.5px solid #000000' : '1.5px solid #E5E5E0',
                  borderRadius: 10,
                  padding: '0 14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  cursor: 'pointer', outline: 'none',
                  transition: 'border-color 180ms, box-shadow 180ms',
                  boxShadow: selectedStaff ? '0 0 0 3px rgba(0,0,0,0.10)' : '0 1px 3px rgba(0,0,0,0.05)',
                }}
                onMouseEnter={e => {
                  if (!selectedStaff) {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#CFCFC8';
                  }
                }}
                onMouseLeave={e => {
                  if (!selectedStaff) {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#E5E5E0';
                  }
                }}
              >
                {selectedStaff ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%',
                      background: selectedStaff.color || '#DC2626',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <span style={{ color: 'white', fontSize: 11, fontWeight: 700 }}>
                        {getInitials(selectedStaff.name)}
                      </span>
                    </div>
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ color: '#111110', fontSize: 13, fontWeight: 600 }}>{selectedStaff.name}</div>
                      <div style={{ color: '#A3A39A', fontSize: 11 }}>{selectedStaff.role}</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Users size={15} color="#CFCFC8" />
                    <span style={{ color: '#CFCFC8', fontSize: 13 }}>Select account...</span>
                  </div>
                )}
                <ChevronDown
                  size={15} color="#A3A39A"
                  style={{
                    transform: dropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 180ms', flexShrink: 0,
                  }}
                />
              </button>

              {/* Dropdown */}
              {dropdownOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
                  background: '#FFFFFF',
                  border: '1.5px solid #E5E5E0',
                  borderRadius: 10,
                  overflow: 'hidden',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.10)',
                  zIndex: 100,
                  maxHeight: 240, overflowY: 'auto',
                }}>
                  {loading ? (
                    <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
                      <Loader2 size={18} color="#CFCFC8" style={{ animation: 'spin 1s linear infinite' }} />
                    </div>
                  ) : staffList.length === 0 ? (
                    <div style={{ padding: '14px 16px', color: '#A3A39A', fontSize: 13 }}>
                      No active staff found.
                    </div>
                  ) : staffList.map((staff: Staff) => (
                    <div
                      key={staff.id}
                      onClick={() => {
                        setSelectedStaff(staff);
                        setDropdownOpen(false);
                        setPin('');
                        setPinError(false);
                        setErrorMessage('');
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 14px', cursor: 'pointer',
                        borderBottom: '1px solid #F0F0EB',
                        background: selectedStaff?.id === staff.id ? '#FFF7F0' : 'transparent',
                        transition: 'background 100ms',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#FAFAF7'; }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLDivElement).style.background =
                          selectedStaff?.id === staff.id ? '#FFF7F0' : 'transparent';
                      }}
                    >
                      <div style={{
                        width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                        background: staff.color || '#DC2626',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <span style={{ color: 'white', fontSize: 12, fontWeight: 700 }}>
                          {getInitials(staff.name)}
                        </span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#111110', fontSize: 13, fontWeight: 600 }}>{staff.name}</div>
                        <div style={{ color: '#A3A39A', fontSize: 11 }}>{staff.role}</div>
                      </div>
                      <div style={{
                        padding: '2px 9px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
                        background: staff.role === 'Manager' ? '#F5F5F0' : '#FFF0E6',
                        color: staff.role === 'Manager' ? '#A3A39A' : '#DC2626',
                        border: staff.role === 'Manager' ? '1px solid #E5E5E0' : '1px solid rgba(220,38,38,0.20)',
                      }}>
                        {staff.role}
                      </div>
                      {selectedStaff?.id === staff.id && <Check size={14} color="#DC2626" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* PIN SECTION */}
          <div style={{
            maxHeight: selectedStaff ? 500 : 0,
            opacity: selectedStaff ? 1 : 0,
            overflow: 'hidden',
            transition: 'max-height 400ms cubic-bezier(0.4,0,0.2,1), opacity 300ms ease',
          }}>
            <label style={{
              display: 'block',
              color: '#6B6B63',
              fontSize: 11, fontWeight: 600,
              letterSpacing: '1.1px', textTransform: 'uppercase',
              marginBottom: 16,
            }}>
              PIN
            </label>

            {/* PIN dots */}
            <div style={{
              display: 'flex', justifyContent: 'center', gap: 14,
              marginBottom: 6,
              animation: shaking ? 'shake 0.4s ease' : 'none',
            }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} style={{
                  width: 13, height: 13, borderRadius: '50%',
                  background: pinError ? '#EF4444' : pin.length > i ? '#DC2626' : 'transparent',
                  border: `2px solid ${pinError ? '#EF4444' : pin.length > i ? '#DC2626' : '#D1D1CC'}`,
                  boxShadow: pin.length > i && !pinError ? '0 0 6px rgba(220,38,38,0.45)' : 'none',
                  transition: 'all 140ms',
                }} />
              ))}
            </div>

            {/* Error */}
            <p style={{
              color: '#EF4444', fontSize: 12,
              textAlign: 'center', margin: '0 0 18px 0', height: 18,
              opacity: errorMessage ? 1 : 0, transition: 'opacity 180ms',
            }}>
              {errorMessage || ' '}
            </p>

            {/* Numpad */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {numpadKeys.map(n => (
                <button
                  key={n}
                  onClick={() => addDigit(String(n))}
                  disabled={loggingIn}
                  style={{
                    height: 52, borderRadius: 9,
                    background: '#FFFFFF',
                    border: '1.5px solid #E5E5E0',
                    color: '#111110', fontSize: 18, fontWeight: 600,
                    cursor: 'pointer', transition: 'all 90ms', outline: 'none',
                    fontFamily: 'Inter, sans-serif',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#DC2626';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 0 3px rgba(220,38,38,0.10)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#E5E5E0';
                    (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)';
                  }}
                  onMouseDown={e => (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.94)'}
                  onMouseUp={e => (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'}
                >
                  {n}
                </button>
              ))}

              


              {/* Back / clear account */}
              <button
                onClick={() => {
                  setSelectedStaff(null);
                  setPin('');
                  setPinError(false);
                  setErrorMessage('');
                }}
                style={{
                  height: 52, borderRadius: 9,
                  background: '#FFFFFF',
                  border: '1.5px solid #E5E5E0',
                  color: '#A3A39A', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 90ms', outline: 'none',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = '#CFCFC8';
                  (e.currentTarget as HTMLButtonElement).style.color = '#6B6B63';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = '#E5E5E0';
                  (e.currentTarget as HTMLButtonElement).style.color = '#A3A39A';
                }}
              >
                <ChevronLeft size={17} />
              </button>

              {/* 0 */}
              <button
                onClick={() => addDigit('0')}
                disabled={loggingIn}
                style={{
                  height: 52, borderRadius: 9,
                  background: '#FFFFFF',
                  border: '1.5px solid #E5E5E0',
                  color: '#111110', fontSize: 18, fontWeight: 600,
                  cursor: 'pointer', transition: 'all 90ms', outline: 'none',
                  fontFamily: 'Inter, sans-serif',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = '#DC2626';
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 0 3px rgba(220,38,38,0.10)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = '#E5E5E0';
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)';
                }}
                onMouseDown={e => (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.94)'}
                onMouseUp={e => (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'}
              >
                0
              </button>

              {/* Backspace */}
              <button
                onClick={removeDigit}
                style={{
                  height: 52, borderRadius: 9,
                  background: '#FFFFFF',
                  border: '1.5px solid #E5E5E0',
                  color: '#A3A39A', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 90ms', outline: 'none',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = '#FFF5F5';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.25)';
                  (e.currentTarget as HTMLButtonElement).style.color = '#EF4444';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = '#FFFFFF';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = '#E5E5E0';
                  (e.currentTarget as HTMLButtonElement).style.color = '#A3A39A';
                }}
              >
                <Delete size={17} />
              </button>
            </div>

            {/* Loading state */}
            {loggingIn && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 8, marginTop: 18,
                color: '#A3A39A', fontSize: 13,
              }}>
                <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                Verifying...
              </div>
            )}
          </div>

        </div>

        {/* Bottom right hint */}
        <div style={{
          position: 'absolute', bottom: 26, right: 32,
          color: '#CFCFC8', fontSize: 12,
        }}>
          {staffList.length > 0 ? `${staffList.length} account${staffList.length > 1 ? 's' : ''} available` : ''}
        </div>

      </div>

      <style>{`
        @keyframes shake {
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
  );
}