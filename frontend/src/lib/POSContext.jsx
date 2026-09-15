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

  const addMenuItem = async (item) => {
    try {
      const newItem = await menuAPI.create(item);
      setMenuItems(prev => [...prev, newItem]);
    } catch (error) {
      console.error('Failed to add menu item:', error.message);
    }
  };

  const updateMenuItem = async (id, data) => {
    try {
      const updated = await menuAPI.update(id, data);
      setMenuItems(prev => prev.map(item => item.id === id ? updated : item));
    } catch (error) {
      console.error('Failed to update menu item:', error.message);
    }
  };

  const deleteMenuItem = async (id) => {
    try {
      await menuAPI.delete(id);
      setMenuItems(prev => prev.filter(item => item.id !== id));
    } catch (error) {
      console.error('Failed to delete menu item:', error.message);
    }
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