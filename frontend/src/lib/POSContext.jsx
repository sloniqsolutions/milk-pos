// @ts-nocheck
import { createContext, useContext, useState, useEffect } from 'react';
import { menuAPI } from '../api/index';

const POSContext = createContext();

export function POSProvider({ children }) {
  const [menuItems, setMenuItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadMenu = async () => {
      try {
        console.log('Loading menu items...');
        const data = await menuAPI.getAll();
        console.log('Menu items loaded:', data);
        setMenuItems(data);
      } catch (err) {
        console.error('Failed to load menu items:', err);
      } finally {
        setLoading(false);
      }
    };
    loadMenu();
  }, []);

  // These used to swallow a failed write with just a console.error — so once
  // the till started refusing menu edits once paired (see backend/routes/menu.js's
  // blockIfPaired, MENU_CLOUD_OWNED), the screen looked like the click did
  // nothing at all: no error, item still sitting there. Rethrowing lets
  // MenuManagement.jsx show the server's actual reason instead.
  const addMenuItem = async (item) => {
    const newItem = await menuAPI.create(item);
    setMenuItems(prev => [...prev, newItem]);
  };

  const updateMenuItem = async (id, data) => {
    const updated = await menuAPI.update(id, data);
    setMenuItems(prev => prev.map(item => item.id === id ? updated : item));
  };

  const deleteMenuItem = async (id) => {
    await menuAPI.delete(id);
    setMenuItems(prev => prev.filter(item => item.id !== id));
  };

  return (
    <POSContext.Provider value={{ menuItems, loading, addMenuItem, updateMenuItem, deleteMenuItem }}>
      {children}
    </POSContext.Provider>
  );
}

export function usePOS() {
  return useContext(POSContext);
}