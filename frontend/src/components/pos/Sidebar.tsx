import React, { useState } from 'react';
import { Home as HomeIcon, User, ClipboardList, BarChart2, Settings, LogOut, GlassWater, Package, Clock, Wallet, Users, History } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { shiftsAPI } from '@/api/index';
import useDialogs from '@/lib/useDialogs';
import cowLogo from '@/assets/cow-logo.png';

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';

interface NavItem {
  id: string;
  icon: React.ElementType;
  label: string;
  adminOnly?: boolean;
}

interface SidebarProps {
  activePage: string;
  onNavigate: (page: string) => void;
}

const ADMIN_NAV: NavItem[] = [
  { id: 'reports',  icon: BarChart2,     label: 'Reports' },
  { id: 'orders',   icon: ClipboardList, label: 'Orders' },
  { id: 'customers',icon: Users,         label: 'Customers' },
  { id: 'menu',     icon: GlassWater,    label: 'Menu',      adminOnly: true },
  { id: 'inventory',icon: Package,       label: 'Inventory', adminOnly: true },
  { id: 'stock-history', icon: History,  label: 'Stock History', adminOnly: true },
  { id: 'cashier',  icon: User,          label: 'Staff',     adminOnly: true },
  { id: 'shifts',   icon: Clock,         label: 'Shifts' },
  { id: 'expenses', icon: Wallet,        label: 'Expenses' },
  { id: 'sale',     icon: HomeIcon,      label: 'Sale' },
  { id: 'settings', icon: Settings,      label: 'Settings',  adminOnly: true },
];

const MANAGER_NAV: NavItem[] = [
  { id: 'sale',     icon: HomeIcon,      label: 'Sale' },
  { id: 'orders',   icon: ClipboardList, label: 'Orders' },
  { id: 'customers',icon: Users,         label: 'Customers' },
  { id: 'menu',     icon: GlassWater,    label: 'Menu' },
  { id: 'inventory',icon: Package,       label: 'Inventory' },
  { id: 'stock-history', icon: History,  label: 'Stock History' },
  { id: 'shifts',   icon: Clock,         label: 'Shifts' },
  { id: 'expenses', icon: Wallet,        label: 'Expenses' },
  { id: 'reports',  icon: BarChart2,     label: 'Reports' },
];

export default function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { isAdmin, logout } = useAuth();
  const navItems = isAdmin ? ADMIN_NAV : MANAGER_NAV;
  const { alertCard, dialog } = useDialogs();
  const [checkingShift, setCheckingShift] = useState(false);

  /**
   * A shift left open when its owner signs out is exactly as much of a
   * problem as one left open when the app closes (see ElectronCloseGuard) —
   * the drawer goes uncounted and the day's totals freeze mid-shift. Unlike
   * the app-close case there is no OS-level dialog to replace here; this was
   * simply missing a check altogether; signing out ended the session with no
   * question asked.
   */
  const handleLogout = async () => {
    if (checkingShift) return;
    setCheckingShift(true);
    try {
      const shift = await shiftsAPI.current();
      if (shift) {
        await alertCard({
          title: 'Shift Still Open',
          message: 'Close your shift on the Shifts screen before signing out — the drawer needs to be counted first.',
          tone: 'warning',
        });
        return;
      }
    } catch (e) {
      // Can't reach the backend — don't trap someone who is trying to leave.
    } finally {
      setCheckingShift(false);
    }
    logout();
  };

  return (
    <>
    <div
      style={{
        width: 84,
        minWidth: 84,
        height: '100vh',
        background: '#FFFFFF',
        borderRight: '1px solid #E5E9F0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 16,
        paddingBottom: 0,
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        background: BLUE,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 18,
        flexShrink: 0,
        boxShadow: '0 4px 12px rgba(27,76,130,0.28)',
        overflow: 'hidden',
      }}>
        <img src={cowLogo} alt="Pure Milk" style={{ width: 26, height: 26, objectFit: 'contain' }} />
      </div>

      <div style={{ width: 36, height: 1, background: '#E5E9F0', marginBottom: 12 }} />

      {/* Nav items. minHeight: 0 lets this shrink inside the flex column instead
          of overflowing it — without it, Admin's extra items (menu, inventory,
          stock history, staff, settings) pushed the Logout button below the
          bottom of the screen on shorter windows, with no way to scroll to it. */}
      <div style={{ flex: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', gap: 4, padding: '0 10px', overflowY: 'auto' }}>
        {navItems.map(({ id, icon: Icon, label }) => {
          const isActive = activePage === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              style={{
                width: '100%',
                padding: '10px 0',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                background: isActive ? BLUE : 'transparent',
                borderRadius: 12,
                border: 'none',
                cursor: 'pointer',
                transition: 'background 140ms',
                boxShadow: isActive ? '0 4px 10px rgba(27,76,130,0.25)' : 'none',
              }}
              onMouseEnter={e => {
                if (!isActive) e.currentTarget.style.background = BLUE_TINT;
              }}
              onMouseLeave={e => {
                if (!isActive) e.currentTarget.style.background = 'transparent';
              }}
            >
              <Icon size={19} style={{ color: isActive ? '#FFFFFF' : '#8A93A3' }} />
              <span style={{
                fontSize: 10.5,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? '#FFFFFF' : '#8A93A3',
                letterSpacing: '0.1px',
              }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ width: 36, height: 1, background: '#E5E9F0', marginBottom: 10 }} />

      {/* Logout */}
      <div style={{ width: '100%', padding: '0 10px 16px' }}>
        <button
          onClick={handleLogout}
          disabled={checkingShift}
          style={{
            width: '100%',
            padding: '9px 0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            background: 'transparent',
            borderRadius: 10,
            border: 'none',
            cursor: checkingShift ? 'default' : 'pointer',
            opacity: checkingShift ? 0.6 : 1,
            transition: 'background 140ms',
          }}
          onMouseEnter={e => { if (!checkingShift) e.currentTarget.style.background = '#FEF2F2'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <LogOut size={19} style={{ color: '#EF4444' }} />
          <span style={{ fontSize: 10.5, fontWeight: 600, color: '#EF4444' }}>Logout</span>
        </button>
      </div>
    </div>
    {dialog}
    </>
  );
}
