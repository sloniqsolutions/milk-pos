import React, { useMemo } from 'react';
import moment from 'moment';

/**
 * "45", "45.5", "0.63" — never "45.500000000001", never a trailing zero.
 * Two decimals, not one: a row is meant to add up like a statement, and a
 * 0.63 L custom sale shown as "0.6" would make it visibly miss by a hair.
 */
const fmtQty = (n) => String(Math.round((Number(n) || 0) * 100) / 100);

/** A change smaller than this is rounding noise, not a movement. */
const EPSILON = 0.005;

/** Movements are stored by calendar day; tolerate a full timestamp rather than splitting one day into two rows. */
const dayOf = (value) => String(value || '').slice(0, 10);

const thStyle = {
  padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 600,
  color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.03em',
  whiteSpace: 'nowrap', borderBottom: '1px solid #E5E7EB',
};

// Opening / Sold / Restocked / Converted / Waste / Closing per ingredient, plus
// Other for an ingredient that has one (see showOther below).
const BASE_COLS_PER_INGREDIENT = 6;

const CLOSING_HINT = "Closing = the stock left at the end of the day. It equals the next day's Opening.";

/**
 * One row per DAY, sales and every ingredient's stock movement side by
 * side — merged on request rather than kept as two separate tables, since
 * a day's sales and what it cost in stock are one story, not two.
 *
 * Which ingredients get a column: every one in `ingredientNames` (the full
 * ingredient list, so Milk still has its column on a week where only Yogurt
 * happened to move — leaving it out made the table look as though Milk had
 * simply not been tracked), plus any that appear in `stockMovement` that the
 * list didn't mention. Nothing is hardcoded to Milk/Dahi, so a third
 * ingredient just shows up here on its own.
 *
 * Reused by Reports.jsx (inline, under its own Summary tab) and
 * SummaryReportScreen.jsx (the full-screen version) — one definition, so
 * the two can never drift into showing different numbers for the same day.
 */
export default function StockMovementTable({ salesByDay, stockMovement, ingredientNames, formatMoney, loading }) {
  const { rows, names, showOther, hasStatement } = useMemo(() => {
    const seen = new Set();
    const names = [];
    [...(ingredientNames || []), ...(stockMovement || []).map((r) => r.name)].forEach((n) => {
      if (n && !seen.has(n)) { seen.add(n); names.push(n); }
    });
    names.sort();

    const byDate = {};
    (salesByDay || []).forEach((d) => {
      byDate[dayOf(d.date)] = { date: dayOf(d.date), orders: d.orders, net: d.net, byIngredient: {} };
    });
    (stockMovement || []).forEach((r) => {
      const day = dayOf(r.date);
      if (!day) return;
      if (!byDate[day]) byDate[day] = { date: day, orders: 0, net: 0, byIngredient: {} };
      byDate[day].byIngredient[r.name] = r;
    });
    const rows = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    // An older till or cloud does not send opening_balance/adjustment: Opening
    // then reads "—" and Other stays hidden rather than showing invented zeros.
    const hasStatement = (stockMovement || []).length === 0 || (stockMovement || []).some((r) => 'opening_balance' in r);
    // Other only earns a column for an ingredient with at least one non-zero day.
    const showOther = {};
    (stockMovement || []).forEach((r) => {
      if (Math.abs(Number(r.adjustment) || 0) >= EPSILON) showOther[r.name] = true;
    });
    return { rows, names, showOther, hasStatement };
  }, [salesByDay, stockMovement, ingredientNames]);

  const colsFor = (name) => BASE_COLS_PER_INGREDIENT + (showOther[name] ? 1 : 0);
  const colCount = 3 + names.reduce((n, name) => n + colsFor(name), 0);

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #E5E7EB', overflow: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 380 + names.reduce((n, name) => n + colsFor(name) * 84, 0) }}>
        <thead>
          <tr style={{ background: '#F9FAFB' }}>
            <th rowSpan={2} style={{ ...thStyle, textAlign: 'left', verticalAlign: 'bottom' }}>Date</th>
            <th colSpan={2} style={{ ...thStyle, textAlign: 'center', borderLeft: '1px solid #E5E7EB', fontWeight: 700, color: '#374151' }}>Sales</th>
            {names.map((name) => (
              <th key={name} colSpan={colsFor(name)} style={{ ...thStyle, textAlign: 'center', borderLeft: '1px solid #E5E7EB', fontWeight: 700, color: '#374151' }}>{name}</th>
            ))}
          </tr>
          <tr style={{ background: '#F9FAFB' }}>
            <th style={{ ...thStyle, textAlign: 'center', borderLeft: '1px solid #E5E7EB' }}>Orders</th>
            <th style={{ ...thStyle, color: '#EA580C' }}>Net</th>
            {names.map((name) => (
              <React.Fragment key={name}>
                <th style={{ ...thStyle, borderLeft: '1px solid #E5E7EB' }}>Opening</th>
                <th style={thStyle}>Sold</th>
                <th style={thStyle}>Restocked</th>
                <th style={thStyle}>Converted</th>
                <th style={thStyle}>Waste</th>
                {showOther[name] && (
                  <th style={thStyle} title="Stock changes with no column of their own: manual removals, set-the-count corrections, and sales that never logged a stock movement.">Other</th>
                )}
                <th style={{ ...thStyle, cursor: 'help' }} title={CLOSING_HINT}>Closing</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={colCount} style={{ padding: 32, textAlign: 'center', color: '#9CA3AF' }}>Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={colCount} style={{ padding: 32, textAlign: 'center', color: '#9CA3AF' }}>No data for this date range.</td></tr>
          ) : (
            rows.map((r, i) => (
              <tr key={r.date} style={{ borderBottom: '1px solid #F3F4F6', background: i % 2 === 0 ? '#FFFFFF' : '#FAFBFC' }}>
                <td style={{ padding: '10px 12px', fontWeight: 600, color: '#111827', whiteSpace: 'nowrap' }}>
                  {moment(r.date).format('MMM D, YYYY')}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center', color: '#374151', borderLeft: '1px solid #F3F4F6' }}>{r.orders}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#111827' }}>{formatMoney(r.net)}</td>
                {names.map((name) => {
                  const ing = r.byIngredient[name];
                  return (
                    <React.Fragment key={name}>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#6B7280', borderLeft: '1px solid #F3F4F6' }}>
                        {ing && hasStatement && ing.opening_balance != null ? `${fmtQty(ing.opening_balance)} ${ing.unit}` : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#111827' }}>
                        {ing && ing.sold > 0 ? `-${fmtQty(ing.sold)} ${ing.unit}` : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#15803D' }}>
                        {ing && ing.restocked > 0 ? `+${fmtQty(ing.restocked)} ${ing.unit}` : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#1D4ED8' }}>
                        {ing && ing.converted !== 0 ? `${ing.converted > 0 ? '+' : ''}${fmtQty(ing.converted)} ${ing.unit}` : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#EF4444' }}>
                        {ing && ing.waste > 0 ? `-${fmtQty(ing.waste)} ${ing.unit}` : '—'}
                      </td>
                      {showOther[name] && (
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#B45309' }}>
                          {ing && Math.abs(Number(ing.adjustment) || 0) >= EPSILON
                            ? `${ing.adjustment > 0 ? '+' : '-'}${fmtQty(Math.abs(ing.adjustment))} ${ing.unit}` : '—'}
                        </td>
                      )}
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#111827' }}>
                        {ing && ing.closing_balance != null ? `${fmtQty(ing.closing_balance)} ${ing.unit}` : '—'}
                      </td>
                    </React.Fragment>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div style={{ padding: '10px 12px', fontSize: 12, color: '#6B7280', borderTop: '1px solid #F3F4F6' }}>
        Opening + Restocked ± Converted − Sold − Waste ± Other = Closing
      </div>
    </div>
  );
}
