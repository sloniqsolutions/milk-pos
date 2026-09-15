import React, { createContext, useContext } from 'react';

/**
 * `useAuth`, for the reused POS screens.
 *
 * Aliased over `@/context/AuthContext` in vite.config.js. The screens ask this
 * for two things — who is signed in, and whether they are an administrator —
 * and the answers here are simply different in kind from the till's:
 *
 *   - The till signs in with a 4-digit PIN at a keypad behind a counter. The
 *     dashboard signs in with email and password over the public internet, and
 *     that happens in App.jsx before any of these screens render. By the time
 *     they mount, the question "is anyone signed in" is already settled.
 *   - There is no inactivity lock. The till locks because anybody can walk up
 *     to it mid-service; a browser tab on the owner's own laptop is a different
 *     situation, and the session cookie expires in twelve hours regardless.
 *
 * `isAdmin` is true because the one dashboard account is the owner. That also
 * gets the screens' own admin gates right for free — Reports keeps its export
 * buttons, and the Staff screen renders at all.
 */

const AuthContext = createContext(null);

export function AuthProvider({ user, onSignOut, children }) {
  const value = {
    currentUser: {
      id: user.id,
      name: user.name || user.email,
      email: user.email,
      // The screens branch on the role string, and 'Admin' is what the till's
      // own `roleIsAdmin` recognises.
      role: 'Admin',
      branch_id: user.branchId ?? null,
    },
    // Never locked: signing in is handled above these screens, not inside them.
    isLocked: false,
    isAdmin: true,
    isManager: false,
    // Deprecated alias the till still carries; kept so an older screen importing
    // it does not fail at render time.
    isCashier: false,
    /*
     * Not a till. The owner has no cash drawer in front of them, so the screens
     * hide what only makes sense with one — opening and closing shifts,
     * recording a payout, counting stock. The server refuses those anyway; this
     * stops them being offered in the first place.
     */
    canOperateTill: false,
    login: () => {},
    logout: onSignOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside the dashboard AuthProvider');
  }
  return ctx;
}

export default AuthContext;
