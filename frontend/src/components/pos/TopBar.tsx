import { useState, useEffect } from 'react';
import { Search, Bell, ScanLine, LayoutGrid, AlertTriangle, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { inventoryAPI } from '@/api/index';

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';

interface TopBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  onNavigate?: (page: string) => void;
  tableNumber?: string;
  onTableNumberChange?: (value: string) => void;
}

export default function TopBar({
  search,
  onSearchChange,
  onNavigate,
  tableNumber = '',
  onTableNumberChange,
}: TopBarProps) {
  const [lowStockCount, setLowStockCount] = useState(0);
  const [tableModalOpen, setTableModalOpen] = useState(false);
  const [tableDraft, setTableDraft] = useState('');
  const { isAdmin } = useAuth();

  const openTableModal = () => {
    setTableDraft(tableNumber);
    setTableModalOpen(true);
  };

  const commitTable = () => {
    onTableNumberChange?.(tableDraft.trim());
    setTableModalOpen(false);
  };

  useEffect(() => {
    if (!isAdmin) return;
    const fetchLowStock = async () => {
      try {
        const data = await inventoryAPI.lowStock();
        if (data?.count !== undefined) setLowStockCount(data.count);
      } catch (err) {
        console.error('Failed to fetch low stock count:', err);
      }
    };
    fetchLowStock();
    const interval = setInterval(fetchLowStock, 60000);
    return () => clearInterval(interval);
  }, [isAdmin]);

  return (
    <div
      style={{
        width: '100%',
        height: 60,
        background: '#FFFFFF',
        borderBottom: '1px solid #E5E9F0',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {/* Center: search */}
      <div style={{ position: 'relative', width: 380, maxWidth: '40%', marginLeft: 4 }}>
        <Search
          size={16}
          style={{ color: '#9CA3AF', position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
        />
        <input
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search products..."
          style={{
            width: '100%',
            height: 38,
            background: '#F1F4F9',
            border: '1.5px solid transparent',
            borderRadius: 10,
            padding: '0 12px 0 38px',
            fontSize: 13.5,
            color: '#0F1720',
            outline: 'none',
            fontFamily: 'Inter, sans-serif',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
          onBlur={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = '#F1F4F9'; }}
        />
      </div>

      {/* Low stock warning */}
      {lowStockCount > 0 && isAdmin && (
        <button
          onClick={() => onNavigate?.('inventory')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#FEF2F2', border: '1px solid #FECACA',
            padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
          }}
        >
          <AlertTriangle size={15} color="#EF4444" />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#DC2626' }}>
            {lowStockCount} {lowStockCount === 1 ? 'item' : 'items'} low on stock
          </span>
        </button>
      )}

      {/* Right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          title="Notifications"
          style={{
            width: 36, height: 36, borderRadius: 9,
            background: '#F1F4F9', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Bell size={17} style={{ color: '#6B7280' }} />
        </button>

        <button
          onClick={() => window.location.reload()}
          title="Refresh / Scan"
          style={{
            width: 36, height: 36, borderRadius: 9,
            background: '#F1F4F9', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <ScanLine size={17} style={{ color: '#6B7280' }} />
        </button>

        {tableNumber && (
          <button
            onClick={() => onTableNumberChange?.('')}
            title="Clear token"
            style={{
              height: 36, padding: '0 10px', gap: 6,
              background: '#EAF2FB', color: BLUE,
              border: 'none', borderRadius: 9,
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Token #{tableNumber}
            <X size={13} />
          </button>
        )}

        <button
          onClick={openTableModal}
          style={{
            height: 36, padding: '0 16px', gap: 6,
            background: BLUE, color: '#FFFFFF',
            border: 'none', borderRadius: 9,
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
            display: 'flex', alignItems: 'center',
            boxShadow: '0 4px 10px rgba(27,76,130,0.28)',
            transition: 'background 140ms',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = BLUE_DARK; }}
          onMouseLeave={e => { e.currentTarget.style.background = BLUE; }}
        >
          <LayoutGrid size={15} color="#FFFFFF" />
          {tableNumber ? 'Change Token' : 'Token #'}
        </button>
      </div>

      {/* Token modal */}
      {tableModalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,32,0.5)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setTableModalOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#FFFFFF', borderRadius: 16, padding: 24, width: '90%', maxWidth: 360, boxShadow: '0 10px 25px rgba(16,40,80,0.16)', display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <h3 style={{ fontSize: 17, fontWeight: 700, color: '#0F1720', margin: 0 }}>Token / Order Number</h3>
            <input
              autoFocus
              value={tableDraft}
              onChange={e => setTableDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitTable(); if (e.key === 'Escape') setTableModalOpen(false); }}
              placeholder="e.g. 12 or T4"
              maxLength={12}
              style={{ height: 46, borderRadius: 10, border: '1.5px solid #E5E9F0', background: '#FFFFFF', padding: '0 14px', fontSize: 16, fontWeight: 600, color: '#0F1720', outline: 'none', fontFamily: 'Inter, sans-serif' }}
              onFocus={e => { e.currentTarget.style.borderColor = BLUE; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setTableModalOpen(false)} style={{ flex: 1, height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0', background: '#FFFFFF', color: '#6B7280', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={commitTable} style={{ flex: 1, height: 42, borderRadius: 8, border: 'none', background: BLUE, color: '#FFFFFF', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Set Token</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
