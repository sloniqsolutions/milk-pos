import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { setAuthToken, setUnauthorizedHandler, staffAPI } from '@/api/index';

interface Staff {
  id: number;
  name: string;
  role: string;
  pin?: string;
  color?: string;
  active?: number;
  [key: string]: unknown;
}

interface AuthContextType {
  currentUser: Staff | null;
  isLocked: boolean;
  login: (staffObj: Staff) => void;
  logout: () => void;
  /** Full access: menu, deals, inventory, settings, staff, backups, exports. */
  isAdmin: boolean;
  /** Works the till: sales, shifts, orders and read-only reports. */
  isManager: boolean;
  /** @deprecated kept so older call sites keep compiling; same as isManager. */
  isCashier: boolean;
}

/**
 * Roles that carry full access.
 *
 * 'Owner' is the historical name and is still what the shop's own account
 * uses, so it is honoured alongside 'Admin' rather than renamed — renaming
 * would have locked the owner out of their own till on upgrade.
 *
 * Note this list previously included 'Manager', which meant a manager had the
 * *same* rights as the owner: inventory, staff administration and settings all
 * open. That was the opposite of what the shop wanted.
 */
const ADMIN_ROLES = ['Admin', 'Owner'];
export function roleIsAdmin(role?: string | null): boolean {
  return ADMIN_ROLES.includes(String(role || ''));
}

const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

const STORAGE_KEY = 'pos_current_user';
const TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
/** Don't hammer localStorage — mousemove fires continuously. */
const PERSIST_THROTTLE_MS = 30 * 1000;

interface StoredSession {
  user: Staff;
  lastActivity: number;
}

/**
 * Read the saved session, returning null if it is missing, malformed, or
 * older than the inactivity window.
 *
 * SECURITY FIX: the session used to be saved with no timestamp at all. The
 * 2-hour inactivity timer lived only in memory, so closing the app destroyed
 * the timer but left the saved session on disk — and the next launch restored
 * it unconditionally and skipped the PIN screen. Once anyone logged in on a
 * machine, the till stayed unlocked permanently, including after a reboot.
 */
function readStoredSession(): Staff | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);

    // Reject the old shape (a bare staff object with no timestamp). Anyone
    // upgrading from a previous build is asked to sign in once more.
    if (!parsed || typeof parsed !== 'object' || !parsed.user || !parsed.lastActivity) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    const session = parsed as StoredSession;
    const age = Date.now() - session.lastActivity;

    // A clock moved backwards, or the window has passed.
    if (age < 0 || age > TIMEOUT_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return session.user;
  } catch (e) {
    console.error('Failed to parse saved session:', e);
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function AuthProvider({ children }: AuthProviderProps) {
  // Resolve the session before first paint so the POS never flashes into
  // view for an unauthenticated user.
  const [currentUser, setCurrentUser] = useState<Staff | null>(() => readStoredSession());
  const [isLocked, setIsLocked] = useState<boolean>(() => readStoredSession() === null);

  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPersist = useRef<number>(0);
  const userRef = useRef<Staff | null>(currentUser);

  useEffect(() => {
    userRef.current = currentUser;
  }, [currentUser]);

  const persistSession = (user: Staff) => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ user, lastActivity: Date.now() } satisfies StoredSession)
    );
    lastPersist.current = Date.now();
  };

  const logout = () => {
    // Drop the server session too, so the token stops working the moment the
    // user signs out rather than lingering for the rest of its two hours.
    staffAPI.logout().catch(() => {});
    setAuthToken(null);
    setCurrentUser(null);
    setIsLocked(true);
    localStorage.removeItem(STORAGE_KEY);
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
  };

  const resetTimer = () => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(logout, TIMEOUT_MS);

    // Refresh the stored timestamp, throttled so mousemove doesn't cause
    // a localStorage write on every frame.
    const user = userRef.current;
    if (user && Date.now() - lastPersist.current > PERSIST_THROTTLE_MS) {
      persistSession(user);
    }
  };

  const login = (staffObj: Staff) => {
    // The backend enforces permissions from this token, not from anything the
    // client claims about itself.
    if (typeof staffObj.token === 'string') setAuthToken(staffObj.token);
    setCurrentUser(staffObj);
    setIsLocked(false);
    userRef.current = staffObj;
    persistSession(staffObj);
    resetTimer();
  };

  // Start the inactivity countdown for a session restored from disk.
  useEffect(() => {
    if (currentUser && !isLocked) resetTimer();
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset the timer on any user activity.
  useEffect(() => {
    if (!isLocked) {
      const events = ['mousedown', 'mousemove', 'keypress', 'touchstart', 'click'];
      events.forEach(e => window.addEventListener(e, resetTimer));
      return () => events.forEach(e => window.removeEventListener(e, resetTimer));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocked]);

  // Re-check expiry when the window regains focus. Without this, an app left
  // open overnight stays unlocked until the next mouse move fires the timer.
  useEffect(() => {
    const onFocus = () => {
      if (!isLocked && readStoredSession() === null) logout();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocked]);

  // If the backend rejects our token, fall back to the PIN screen rather than
  // leaving the user on a page where every request quietly fails.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCurrentUser(null);
      setIsLocked(true);
      localStorage.removeItem(STORAGE_KEY);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // A session restored from localStorage is checked against the server, so a
  // token that expired while the app was closed does not present a working-
  // looking till. The role comes back from the database, not from storage.
  useEffect(() => {
    if (!currentUser) return;
    staffAPI.me()
      .then(me => {
        setCurrentUser(prev => (prev ? { ...prev, role: me.role, name: me.name, id: me.id } : prev));
      })
      .catch(() => {
        setCurrentUser(null);
        setIsLocked(true);
        localStorage.removeItem(STORAGE_KEY);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Role checks
  const isAdmin = roleIsAdmin(currentUser?.role);
  const isManager = !!currentUser && !isAdmin;
  const isCashier = isManager;

  return (
    <AuthContext.Provider value={{ currentUser, isLocked, login, logout, isAdmin, isManager, isCashier }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
