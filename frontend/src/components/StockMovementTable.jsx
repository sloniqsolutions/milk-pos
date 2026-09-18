import React from 'react';
import moment from 'moment';

/** "45", "45.5" — never "45.500000000001", never a trailing ".0". */
const fmtQty = (n) => {
  const rounded = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/**
 * One row per day per ingredient — sold, restocked, converted, waste, and
 * where that leaves the shelf. Reused by Reports.jsx (inline, under the
 * existing Summary table) and SummaryReportScreen.jsx (the full-screen
 * version), both fed from the same reportsAPI.stockMovement() call, so
 * there is exactly one place this table's shape is defined.
 *
 * See backend/routes/reports.js's own /stock-movement for where
 * closing_balance and days_remaining come from, and why an early date can
 * legitimately show 0/— rather than a number — that route already clamps a
 * reconstructed balance at zero rather than show something impossible.
 */
export default function StockMovementTable({ rows, loading }) {
  return (
    <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #E5E7EB', overflow: 'hidden' }}>
      <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }}>
            <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
            <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Ingredient</th>
            <th className="py-3 px-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Sold</th>
            <th className="py-3 px-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Restocked</th>
            <th className="py-3 px-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Converted</th>
            <th className="py-3 px-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Waste</th>
            <th className="py-3 px-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Waste %</th>
            <th className="py-3 px-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Closing Balance</th>
            <th className="py-3 px-4 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Days Left</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={9} className="py-8 text-center text-gray-400">Loading…</td></tr>
          ) : !rows || rows.length === 0 ? (
            <tr><td colSpan={9} className="py-8 text-center text-gray-400">No stock movement in this date range.</td></tr>
          ) : (
            rows.map((r, i) => (
              <tr key={`${r.date}-${r.ingredient_id}`} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                <td className="py-3 px-4 font-medium text-gray-900">{moment(r.date).format('MMM D, YYYY')}</td>
                <td className="py-3 px-4 text-gray-700">{r.name}</td>
                <td className="py-3 px-4 text-right text-gray-900">{r.sold > 0 ? `${fmtQty(r.sold)} ${r.unit}` : '—'}</td>
                <td className="py-3 px-4 text-right text-green-700">{r.restocked > 0 ? `+${fmtQty(r.restocked)} ${r.unit}` : '—'}</td>
                <td className="py-3 px-4 text-right text-blue-700">
                  {r.converted !== 0 ? `${r.converted > 0 ? '+' : ''}${fmtQty(r.converted)} ${r.unit}` : '—'}
                </td>
                <td className="py-3 px-4 text-right text-red-500">{r.waste > 0 ? `-${fmtQty(r.waste)} ${r.unit}` : '—'}</td>
                <td className="py-3 px-4 text-right text-gray-500">{r.waste > 0 ? `${fmtQty(r.waste_pct)}%` : '—'}</td>
                <td className="py-3 px-4 text-right font-bold text-gray-900">
                  {r.closing_balance != null ? `${fmtQty(r.closing_balance)} ${r.unit}` : '—'}
                </td>
                <td className="py-3 px-4 text-right text-gray-600">
                  {r.days_remaining != null ? `${fmtQty(r.days_remaining)} days` : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
