// @ts-nocheck
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { settingsAPI } from '../api/index';

/**
 * Shop settings, loaded once and shared.
 *
 * Settings screen wrote nine keys that nothing ever read: tax_rate,
 * currency_symbol, currency_position, auto_print, show_tax, show_cashier,
 * show_order_number, show_payment and paper_size. An owner could set a 15% tax
 * rate, save it, see it persist across a restart — and never see tax on a
 * single receipt. This is where they become real.
 *
 * Money formatting lives here too, so the currency symbol is applied in one
 * place instead of being hardcoded as "Rs." at every call site.
 */

const SettingsContext = createContext(null);

const DEFAULTS = {
  restaurant_name: 'Pure Milk',
  restaurant_tagline: '',
  restaurant_address: '',
  restaurant_phone: '',
  receipt_footer: 'Thank you for your purchase!',
  tax_rate: '0',
  currency_symbol: 'Rs.',
  currency_position: 'before',
  delivery_price: '0',
  employee_discount_rate: '20',
  auto_print: 'true',
  show_tax: 'true',
  show_cashier: 'true',
  show_order_number: 'true',
  show_payment: 'true',
  paper_size: '80mm',
};

export function SettingsProvider({ children }) {
  const [raw, setRaw] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await settingsAPI.getAll();
      setRaw({ ...DEFAULTS, ...data });
    } catch (err) {
      // An unreachable backend must not blank the till; keep what we have.
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Settings are edited on another screen in the same window; refetching on
    // focus keeps the sale screen current without a manual reload.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const value = buildValue(raw, loading, refresh);

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

function buildValue(raw, loading, refresh) {
  const currencySymbol = raw.currency_symbol || 'Rs.';
  const currencyPosition = raw.currency_position === 'after' ? 'after' : 'before';

  /**
   * Format an amount for display.
   *
   * Grouped with separators for readability. `decimals` is off by default
   * because this menu is priced in whole rupees; a tax rate can still produce
   * fractions, so the receipt asks for them where it matters.
   */
  const formatMoney = (amount, { decimals = false } = {}) => {
    const n = Number(amount) || 0;
    const body = decimals
      ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : Math.round(n).toLocaleString();
    return currencyPosition === 'after'
      ? `${body} ${currencySymbol}`
      : `${currencySymbol} ${body}`;
  };

  return {
    loading,
    refresh,
    settings: raw,

    // Shop identity
    restaurant: {
      name: raw.restaurant_name || '',
      tagline: raw.restaurant_tagline || '',
      address: raw.restaurant_address || '',
      phone: raw.restaurant_phone || '',
      footerMessage: raw.receipt_footer || 'Thank you for your purchase!',
    },

    // Pricing
    taxRate: Math.max(0, Number(raw.tax_rate) || 0),
    deliveryPrice: Math.max(0, Number(raw.delivery_price) || 0),
    /** Percentage taken off a staff purchase. Applied server-side. */
    employeeDiscountRate: Math.max(0, Math.min(100, Number(raw.employee_discount_rate) || 0)),
    currencySymbol,
    currencyPosition,
    formatMoney,

    // Receipt behaviour
    autoPrint: raw.auto_print === 'true' || raw.auto_print === true,
    showTax: raw.show_tax !== 'false',
    showCashier: raw.show_cashier !== 'false',
    showOrderNumber: raw.show_order_number !== 'false',
    showPayment: raw.show_payment !== 'false',
    paperSize: raw.paper_size || '80mm',
  };
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
