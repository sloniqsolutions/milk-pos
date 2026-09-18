import React, { useState, useEffect, useRef } from 'react';
import Sidebar from '@/components/pos/Sidebar';
import SaleScreen from '@/pages/SaleScreen';
import MenuManagement from '@/pages/MenuManagement';
import Cashier from '@/pages/Cashier';
import Orders from '@/pages/Orders';
import Reports from '@/pages/Reports';
import SummaryReportScreen from '@/pages/SummaryReportScreen';
import Settings from '@/pages/Settings';
import InventoryScreen from '@/pages/InventoryScreen';
import StockHistoryScreen from '@/pages/StockHistoryScreen';
import ShiftsScreen from '@/pages/ShiftsScreen';
import ExpensesScreen from '@/pages/ExpensesScreen';
import CustomersScreen from '@/pages/CustomersScreen';
import LoginScreen from '@/pages/LoginScreen';
import AccessDenied from '@/components/AccessDenied';
import { POSProvider } from '@/lib/POSContext';
import { useAuth } from '@/context/AuthContext';

const screens: Record<string, React.ComponentType<{ onNavigate?: (page: string) => void }>> = {
  sale: SaleScreen,
  menu: MenuManagement,
  customers: CustomersScreen,
  cashier: Cashier,
  orders: Orders,
  reports: Reports,
  'summary-report': SummaryReportScreen,
  settings: Settings,
  inventory: InventoryScreen,
  'stock-history': StockHistoryScreen,
  shifts: ShiftsScreen,
  expenses: ExpensesScreen,
};

/**
 * Screens only an administrator may open.
 *
 * Menu, Deals and Inventory are not here: a manager opens them, but Menu and
 * Deals render read-only and every write is refused by the backend anyway.
 * Staff administration and Settings stay closed outright.
 */
const ADMIN_ONLY_SCREENS = new Set(['cashier', 'settings']);

/**
 * Where each role lands.
 *
 * An owner opens this app to read the day's numbers, so they start on Reports.
 * A manager opens it to serve the next customer, so they start on the till.
 */
const LANDING_SCREEN = { admin: 'reports', manager: 'sale' } as const;

export default function Home() {
  const { isLocked, isAdmin, currentUser } = useAuth();

  const [activePage, setActivePage] = useState<string | null>(null);

  /**
   * Land on the role's own screen at every sign-in.
   *
   * `activePage` outlives a sign-out, so without this the next person to sign
   * in inherited whatever screen the last one left open — a manager signing in
   * after the owner had been reading Reports would land on Reports, not the
   * till. Clearing it whenever the signed-in account changes (including to
   * nobody, on sign-out) makes `page` fall back to the landing screen below.
   */
  const signedInId = currentUser?.id ?? null;
  const lastSignedInId = useRef<number | null>(signedInId);

  useEffect(() => {
    if (lastSignedInId.current !== signedInId) {
      lastSignedInId.current = signedInId;
      setActivePage(null);
    }
  }, [signedInId]);

  if (isLocked) {
    return <LoginScreen />;
  }

  const landing = isAdmin ? LANDING_SCREEN.admin : LANDING_SCREEN.manager;
  const page = activePage ?? landing;

  const denied = ADMIN_ONLY_SCREENS.has(page) && !isAdmin;
  const ActiveScreen = screens[page] ?? screens[landing];

  return (
    <POSProvider>
      <div
        key={currentUser?.id ?? 'anon'}
        style={{
          width: '100vw',
          height: '100vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'row',
          background: '#F7F9FC',
          fontFamily: "'Inter', sans-serif",
        }}
      >
        <Sidebar activePage={page} onNavigate={setActivePage} />
        {denied ? (
          <AccessDenied message="This screen is restricted to an administrator." />
        ) : (
          <ActiveScreen onNavigate={setActivePage} />
        )}
      </div>
    </POSProvider>
  );
}
