// @ts-nocheck
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { menuAPI } from '../api/index';

const POSContext = createContext();

/** How often the till quietly looks for menu changes made elsewhere (the dashboard, another till). */
const BACKGROUND_REFRESH_MS = 15000;

export function POSProvider({ children }) {
  const [menuItems, setMenuItems] = useState([]);
  const [loading, setLoading] = useState(true);
  // True while the menu is being re-read after a change made on this screen.
  // Distinct from `loading` (first load, which replaces the whole screen with a
  // spinner): screens show a veil over what they already have.
  const [refreshing, setRefreshing] = useState(false);
  const lastSeen = useRef('');

  /**
   * Re-reads the whole menu from the server.
   *
   * After a price edit the server re-prices every sibling size (0.5 Litre, 2
   * Litre, 250g ...) off the item that was edited, so patching just the edited
   * row into local state — what this used to do — left the siblings showing the
   * old prices until the app was reloaded. Reading it all back is what makes
   * the screen show what was actually stored.
   *
   * `silent` refreshes (background, on focus) show no veil and only touch state
   * when something changed, so the list does not flicker or lose scroll position.
   */
  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const data = await menuAPI.getAll();
      const rows = Array.isArray(data) ? data : [];
      const fingerprint = JSON.stringify(rows);
      if (fingerprint !== lastSeen.current) {
        lastSeen.current = fingerprint;
        setMenuItems(rows);
      }
    } catch (err) {
      // A failed background check must not blank a till that is mid-sale.
      console.error('Failed to load menu items:', err);
      if (!silent) throw err;
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh({ silent: true });
    const onFocus = () => refresh({ silent: true });
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => refresh({ silent: true }), BACKGROUND_REFRESH_MS);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(timer); };
  }, [refresh]);

  // These rethrow a failed write so MenuManagement.jsx can show the server's
  // actual reason instead of the click appearing to do nothing.
  const addMenuItem = async (item) => {
    await menuAPI.create(item);
    await refresh();
  };

  const updateMenuItem = async (id, data) => {
    await menuAPI.update(id, data);
    await refresh();
  };

  const deleteMenuItem = async (id) => {
    await menuAPI.delete(id);
    await refresh();
  };

  return (
    <POSContext.Provider value={{ menuItems, loading, refreshing, refresh, addMenuItem, updateMenuItem, deleteMenuItem }}>
      {children}
    </POSContext.Provider>
  );
}

export function usePOS() {
  return useContext(POSContext);
}
