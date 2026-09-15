import React, { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { menuAPI } from './api';

/**
 * `usePOS`, for the reused POS screens.
 *
 * On the till this holds the menu in memory so the sale screen can render it
 * without a round trip per keystroke. Here there is no sale screen, but the
 * Menu screen still saves *through this context* rather than calling the API
 * itself — so these mutators have to be real.
 *
 * An earlier version stubbed them out as no-ops, on the reasoning that the
 * cloud refused menu writes anyway. Once the cloud became the menu's owner that
 * stopped being true, and creating an item on the dashboard silently did
 * nothing: no request, no error, no new row. Deals kept working the whole time,
 * because that screen calls `dealsAPI` directly — which is what made it look
 * like a menu-specific bug rather than a missing stub.
 *
 * Each mutation re-reads the menu from the server afterwards rather than
 * patching local state from the response. It costs a round trip and it means
 * the screen shows what the cloud actually stored, so a write that half-failed
 * cannot leave the list claiming otherwise.
 */

const POSContext = createContext(null);

export function POSProvider({ children }) {
  const [menuItems, setMenuItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await menuAPI.getAll();
      setMenuItems(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (err) {
      setError(err);
      setMenuItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Run a write, then re-read.
   *
   * The screens call these without awaiting, so a rejection here would surface
   * as an unhandled rejection and nothing else. Reporting it on the context —
   * and rendering it below — is what stops a failed save looking like a
   * successful one.
   */
  const mutate = useCallback(async (fn) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      console.error('Menu change failed:', err.message);
      setError(err);
    }
    await refresh();
  }, [refresh]);

  const value = {
    menuItems,
    loading,
    error,
    refresh,
    addMenuItem: (item) => mutate(() => menuAPI.create(item)),
    updateMenuItem: (id, data) => mutate(() => menuAPI.update(id, data)),
    deleteMenuItem: (id) => mutate(() => menuAPI.delete(id)),
  };

  return (
    <POSContext.Provider value={value}>
      {/*
        The Menu screen has nowhere of its own to show a failed save, so it is
        shown here. Without it a rejected write is invisible: the list simply
        re-renders unchanged and looks like nothing was typed.
      */}
      {error && (
        <div style={{
          background: '#FEF2F2', borderBottom: '1px solid #FECACA',
          color: '#991B1B', padding: '9px 20px', fontSize: 13,
        }}>
          <strong>That change was not saved.</strong> {error.message}
        </div>
      )}
      {children}
    </POSContext.Provider>
  );
}

export function usePOS() {
  const ctx = useContext(POSContext);
  if (!ctx) throw new Error('usePOS must be used inside the dashboard POSProvider');
  return ctx;
}

export default POSContext;
