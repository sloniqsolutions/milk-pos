import React, { useState, useEffect, useMemo } from 'react';
import moment from 'moment';
import { ArrowLeft, FileText } from 'lucide-react';
import { reportsAPI } from '@/api/index';
import { useSettings } from '@/lib/SettingsContext';
import StockMovementTable from '@/components/StockMovementTable';

const FILTER_CHIPS = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: 'Last 7 Days', value: 'last7' },
  { label: 'Last 30 Days', value: 'last30' },
  { label: 'This Month', value: 'thisMonth' },
  { label: 'This Year', value: 'thisYear' },
  { label: 'Custom Range', value: 'custom' },
];

const BLUE = '#1B4C82';

/**
 * The full-screen version of what Reports.jsx already shows inline under
 * "Generate Sales Report" — same two tables (sales by day, stock movement),
 * same date-range filter, just given the whole screen rather than a card
 * shared with everything else Reports covers. Opened from Reports.jsx's own
 * "View Full Report" button, or directly from the sidebar/dashboard nav.
 *
 * Deliberately re-fetches rather than receiving Reports.jsx's data as props:
 * the two screens are reachable independently (a sidebar click here skips
 * Reports entirely), so this has to be able to load its own data regardless
 * of whether Reports ever ran first.
 */
export default function SummaryReportScreen({ onNavigate }) {
  const { formatMoney } = useSettings();
  const [activeFilter, setActiveFilter] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [salesByDay, setSalesByDay] = useState([]);
  const [stockMovement, setStockMovement] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const { from, to } = useMemo(() => {
    const today = moment().format('YYYY-MM-DD');
    switch (activeFilter) {
      case 'today': return { from: today, to: today };
      case 'yesterday': {
        const y = moment().subtract(1, 'day').format('YYYY-MM-DD');
        return { from: y, to: y };
      }
      case 'last7': return { from: moment().subtract(6, 'days').format('YYYY-MM-DD'), to: today };
      case 'last30': return { from: moment().subtract(29, 'days').format('YYYY-MM-DD'), to: today };
      case 'thisMonth': return { from: moment().startOf('month').format('YYYY-MM-DD'), to: today };
      case 'thisYear': return { from: moment().startOf('year').format('YYYY-MM-DD'), to: today };
      case 'custom': return { from: customFrom || today, to: customTo || today };
      default: return { from: today, to: today };
    }
  }, [activeFilter, customFrom, customTo]);

  useEffect(() => {
    if (!from || !to) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      reportsAPI.detailed({ from, to }),
      reportsAPI.stockMovement({ from, to }),
    ])
      .then(([detailed, movement]) => {
        if (cancelled) return;
        const byDate = {};
        (Array.isArray(detailed) ? detailed : []).forEach((row) => {
          const date = moment(row.created_at).format('YYYY-MM-DD');
          if (!byDate[date]) byDate[date] = { date, orders: 0, revenue: 0, discounts: 0, net: 0 };
          byDate[date].orders += 1;
          byDate[date].revenue += Number(row.subtotal) || 0;
          byDate[date].discounts += Number(row.discount) || 0;
          byDate[date].net += Number(row.total) || 0;
        });
        setSalesByDay(Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)));
        setStockMovement(Array.isArray(movement) ? movement : []);
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message || 'Failed to load the summary report.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to]);

  return (
    <div className="flex-1 h-full overflow-y-auto" style={{ background: '#F7F9FC' }}>
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onNavigate && (
            <button
              onClick={() => onNavigate('reports')}
              className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-gray-100 transition-colors"
              title="Back to Reports"
            >
              <ArrowLeft size={18} color="#6B7280" />
            </button>
          )}
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: '#EAF2FB' }}>
            <FileText size={18} color={BLUE} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Summary Report</h1>
            <p className="text-xs text-gray-500">Sales and stock movement together, for one date range</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="flex items-center gap-2 overflow-x-auto flex-wrap">
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.value}
              onClick={() => setActiveFilter(chip.value)}
              className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all"
              style={{
                background: activeFilter === chip.value ? BLUE : '#FFFFFF',
                color: activeFilter === chip.value ? '#FFFFFF' : '#6B7280',
                border: activeFilter === chip.value ? `1px solid ${BLUE}` : '1px solid #D1D5DB',
              }}
            >
              {chip.label}
            </button>
          ))}
          {activeFilter === 'custom' && (
            <div className="flex items-center gap-2 ml-2">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded focus:outline-none focus:border-blue-600" />
              <span className="text-gray-400 text-xs">to</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded focus:outline-none focus:border-blue-600" />
            </div>
          )}
        </div>
      </div>

      {loadError && (
        <div className="mx-6 mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {loadError}
        </div>
      )}

      <div className="px-6 pb-8 space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-gray-900">Sales &amp; Stock Movement</h2>
            <p className="text-sm text-gray-500">{from} to {to}</p>
          </div>
          <StockMovementTable salesByDay={salesByDay} stockMovement={stockMovement} formatMoney={formatMoney} loading={loading} />
        </div>
      </div>
    </div>
  );
}
