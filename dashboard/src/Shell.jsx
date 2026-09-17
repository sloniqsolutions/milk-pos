import React, { useState } from 'react';
import cowLogo from '@/assets/cow-logo.png';
import LiveScreen from './LiveScreen';
import { AuthProvider } from './pos-shims/AuthContext';
import { POSProvider } from './pos-shims/POSContext';
import { SettingsProvider } from '@/lib/SettingsContext';

// The POS's own screens, rendered here rather than reimplemented. See
// vite.config.js for how their three environment-specific imports are replaced.
import Reports from '@/pages/Reports';
import ExpensesScreen from '@/pages/ExpensesScreen';
import ShiftsScreen from '@/pages/ShiftsScreen';
import Cashier from '@/pages/Cashier';
import InventoryScreen from '@/pages/InventoryScreen';
import StockHistoryScreen from '@/pages/StockHistoryScreen';
import MenuManagement from '@/pages/MenuManagement';
import SettingsScreen from './SettingsScreen';
import OrdersScreen from './OrdersScreen';
import CustomersScreen from './CustomersScreen';
import PayrollScreen from './PayrollScreen';
import BackupsScreen from './BackupsScreen';

/**
 * The signed-in frame.
 *
 * Live leads because it answers the question nothing else can — what is
 * happening in the shops right now. Everything after it is the till's own
 * screen, reading the branches' synced data.
 */
const TABS = [
  { key: 'live', label: 'Live', Screen: null },
  { key: 'reports', label: 'Reports', Screen: Reports },
  { key: 'orders', label: 'Orders', Screen: OrdersScreen },
  { key: 'customers', label: 'Customers', Screen: CustomersScreen },
  { key: 'expenses', label: 'Expenses', Screen: ExpensesScreen },
  { key: 'shifts', label: 'Shifts', Screen: ShiftsScreen },
  { key: 'staff', label: 'Staff', Screen: Cashier },
  // Wages live only here. Nothing on this tab is ever sent to a till.
  { key: 'payroll', label: 'Payroll', Screen: PayrollScreen },
  { key: 'inventory', label: 'Inventory', Screen: InventoryScreen },
  { key: 'stock-history', label: 'Stock History', Screen: StockHistoryScreen },
  // The only ones the dashboard can change. Everything above is recorded at a
  // till and travels upward; the menu is the one thing that travels down.
  // (No Deals tab: Milk POS is a flat, three-SKU menu with no combo/bundle
  // concept on the till at all — see frontend/db/menu-data.js — so there is
  // no till screen for this dashboard to reuse the way it reuses Menu, and
  // nothing on the till would ever read a deal down anyway.)
  { key: 'menu', label: 'Menu', Screen: MenuManagement },
  { key: 'backups', label: 'Backups', Screen: BackupsScreen },
  { key: 'settings', label: 'Settings', Screen: SettingsScreen },
];

/** Edited here, and pulled by every till on its next heartbeat. */
const CLOUD_OWNED = new Set(['menu', 'settings', 'staff']);

/**
 * Which tabs show only what the branches have sent, and cannot change it.
 *
 * Said once, plainly, rather than leaving someone to discover it by pressing a
 * button and getting an error. Shifts and Stock History are recorded purely
 * at the till with no path up at all. Expenses and Inventory used to belong
 * here too, back when they were fully read-only — they're partially
 * editable now (create/delete an expense, edit an ingredient's name/unit/
 * threshold — see cloud/routes/expenses.js and inventory.js), so the blanket
 * "cannot be changed from here" banner would just be wrong on those tabs now.
 */
const READ_ONLY = new Set(['shifts', 'stock-history']);

export default function Shell({ user, onSignOut }) {
  const [tab, setTab] = useState('live');
  const active = TABS.find(t => t.key === tab) || TABS[0];

  const tabStyle = (isActive) => ({
    padding: '7px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600,
    cursor: 'pointer', border: 'none', whiteSpace: 'nowrap',
    background: isActive ? '#1B4C82' : 'transparent',
    color: isActive ? '#FFFFFF' : '#6B7280',
  });

  return (
    <AuthProvider user={user} onSignOut={onSignOut}>
      <SettingsProvider>
        <POSProvider>
          <div style={{ minHeight: '100vh', background: '#F7F9FC' }}>
            <header style={{
              background: '#FFFFFF', borderBottom: '2px solid #EAF2FB',
              boxShadow: '0 1px 0 rgba(27,76,130,0.04)',
              padding: '10px 20px', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    overflow: 'hidden', border: '1.5px solid #EAF2FB',
                  }}>
                    <img src={cowLogo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  <span style={{ fontSize: 17, fontWeight: 800, color: '#123A66', letterSpacing: '-0.2px' }}>
                    Pure Milk POS
                  </span>
                </div>
                <nav style={{
                  display: 'flex', gap: 2, background: '#EAF2FB', padding: 3,
                  borderRadius: 10, overflowX: 'auto',
                }}>
                  {TABS.map(t => (
                    <button key={t.key} onClick={() => setTab(t.key)} style={tabStyle(tab === t.key)}>
                      {t.label}
                    </button>
                  ))}
                </nav>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>{user.email}</span>
                <button onClick={onSignOut} style={{
                  border: '1px solid #E5E9F0', background: '#FFFFFF', borderRadius: 8,
                  padding: '6px 13px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151',
                  flexShrink: 0, whiteSpace: 'nowrap',
                }}>
                  Sign out
                </button>
              </div>
            </header>

            {CLOUD_OWNED.has(tab) && tab !== 'settings' && (
              <div style={{
                background: '#F0FDF4', borderBottom: '1px solid #BBF7D0',
                color: '#166534', padding: '9px 20px', fontSize: 13,
              }}>
                {tab === 'staff'
                  ? `This is where staff are added and their PINs are set. A new
                     manager can sign in once their branch's till has synced —
                     usually within a minute — and the tills cannot change the
                     roster themselves.`
                  : `This is where the ${active.label.toLowerCase()} is edited.
                     Changes reach every branch on its next sync, and the tills
                     cannot change it themselves.`}
              </div>
            )}

            {/*
              Payroll is neither of the two categories above: it does not come
              up from the branches and it never goes down to them. Saying so is
              worth a line, because "why can't the manager see this" and "when
              does this reach the till" are both reasonable questions with the
              same answer.
            */}
            {tab === 'payroll' && (
              <div style={{
                background: '#FAF5FF', borderBottom: '1px solid #E9D5FF',
                color: '#6B21A8', padding: '9px 20px', fontSize: 13,
              }}>
                Wages stay here. Salaries are never sent to a till, so nobody
                signing in at a branch can see what anyone earns.
              </div>
            )}

            {READ_ONLY.has(tab) && (
              <div style={{
                background: '#EFF6FF', borderBottom: '1px solid #BFDBFE',
                color: '#1E40AF', padding: '9px 20px', fontSize: 13,
              }}>
                Showing what the branches have sent up. {active.label} is recorded
                at the till, so it cannot be changed from here.
              </div>
            )}

            {tab === 'live'
              ? <LiveScreen user={user} onSignOut={onSignOut} embedded />
              : (
                /*
                 * `pos-screen` unclamps the till's full-viewport shell. Several
                 * of these screens set `height: 100vh; overflow: hidden` inline,
                 * which is right beside a sidebar in Electron and wrong below a
                 * header in a browser — it puts the bottom of every report off
                 * the screen with no way to scroll to it. See styles.css.
                 */
                <div className="pos-screen">
                  <active.Screen />
                </div>
              )}

            {/*
              Attribution, on every page.
              
              Outside the screen switch so it sits below whichever tab is open,
              and outside `pos-screen` so the till screens' own full-height
              styling cannot push it off the bottom.
            */}
            <footer style={{
              padding: '18px 20px 24px', textAlign: 'center',
              fontSize: 12, color: '#9CA3AF',
            }}>
              Powered by{' '}
              <a
                href="https://www.virtiqo.com"
                target="_blank"
                // noopener because the opened page gets a handle on this one
                // otherwise; noreferrer so the dashboard's address is not sent
                // along with the click.
                rel="noopener noreferrer"
                style={{ color: '#6B7280', textDecoration: 'underline' }}
              >
                Virtiqo (Private) Limited
              </a>
            </footer>
          </div>
        </POSProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}
