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

// Deliberately quiet: one hairline colour, one muted text colour, and colour used
// only where it carries meaning (stock coming in). Numbers align on their digits.
const INK = '#111827';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const HAIRLINE = '#EEF0F3';

const thStyle = {
  padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 500,
  color: FAINT, textTransform: 'uppercase', letterSpacing: '0.04em',
  whiteSpace: 'nowrap', borderBottom: `1px solid ${HAIRLINE}`, background: '#FFFFFF',
};
const groupThStyle = { ...thStyle, textAlign: 'center', fontWeight: 600, color: MUTED, borderLeft: `1px solid ${HAIRLINE}` };
const tdBase = { padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const groupStart = { borderLeft: `1px solid ${HAIRLINE}` };

// Opening / Sold / Restocked / Converted / Waste / Closing per ingredient, plus
// Other for an ingredient that has one (see showOther below).
const BASE_COLS_PER_INGREDIENT = 6;

const CLOSING_HINT = "Closing = the stock left at the end of the day. It equals the next day's Opening.";

/** A quantity cell: the figure, or a faint dash when there is nothing to show. */
function Cell({ value, unit, sign = '', color = INK, style }) {
  const empty = value === null || value === undefined;
  return (
    <td style={{ ...tdBase, color: empty ? '#D1D5DB' : color, ...style }}>
      {empty ? '—' : `${sign}${fmtQty(value)} ${unit}`}
    </td>
  );
}

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

  // The date stays put while a wide table scrolls sideways.
  const stickyDate = { position: 'sticky', left: 0, zIndex: 1, background: '#FFFFFF' };

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 10, border: `1px solid ${HAIRLINE}`, overflow: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 380 + names.reduce((n, name) => n + colsFor(name) * 84, 0), fontSize: 13 }}>
        <thead>
          <tr>
            <th rowSpan={2} style={{ ...thStyle, ...stickyDate, textAlign: 'left', verticalAlign: 'bottom' }}>Date</th>
            <th colSpan={2} style={groupThStyle}>Sales</th>
            {names.map((name) => (
              <th key={name} colSpan={colsFor(name)} style={groupThStyle}>{name}</th>
            ))}
          </tr>
          <tr>
            <th style={{ ...thStyle, ...groupStart }}>Orders</th>
            <th style={thStyle}>Net</th>
            {names.map((name) => (
              <React.Fragment key={name}>
                <th style={{ ...thStyle, ...groupStart }}>Opening</th>
                <th style={thStyle}>Sold</th>
                <th style={thStyle}>Restocked</th>
                <th style={thStyle}>Converted</th>
                <th style={thStyle}>Waste</th>
                {showOther[name] && (
                  <th style={thStyle} title="Stock changes with no column of their own: manual removals, set-the-count corrections, and sales that never logged a stock movement.">Other</th>
                )}
                <th style={{ ...thStyle, color: MUTED, cursor: 'help' }} title={CLOSING_HINT}>Closing</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={colCount} style={{ padding: 32, textAlign: 'center', color: FAINT }}>Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={colCount} style={{ padding: 32, textAlign: 'center', color: FAINT }}>No data for this date range.</td></tr>
          ) : (
            rows.map((r) => (
              <tr key={r.date} style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
                <td style={{ ...tdBase, ...stickyDate, textAlign: 'left', fontWeight: 500, color: INK }}>
                  {moment(r.date).format('MMM D, YYYY')}
                </td>
                <td style={{ ...tdBase, ...groupStart, color: MUTED }}>{r.orders}</td>
                <td style={{ ...tdBase, fontWeight: 600, color: INK }}>{formatMoney(r.net)}</td>
                {names.map((name) => {
                  const ing = r.byIngredient[name];
                  const u = ing ? ing.unit : '';
                  return (
                    <React.Fragment key={name}>
                      <Cell style={groupStart} color={MUTED} unit={u}
                        value={ing && hasStatement && ing.opening_balance != null ? ing.opening_balance : null} />
                      <Cell unit={u} sign="-" value={ing && ing.sold > 0 ? ing.sold : null} />
                      <Cell unit={u} sign="+" color="#15803D" value={ing && ing.restocked > 0 ? ing.restocked : null} />
                      <Cell unit={u} sign={ing && ing.converted > 0 ? '+' : '-'} value={ing && ing.converted !== 0 ? Math.abs(ing.converted) : null} />
                      <Cell unit={u} sign="-" value={ing && ing.waste > 0 ? ing.waste : null} />
                      {showOther[name] && (
                        <Cell unit={u} sign={ing && ing.adjustment > 0 ? '+' : '-'}
                          value={ing && Math.abs(Number(ing.adjustment) || 0) >= EPSILON ? Math.abs(ing.adjustment) : null} />
                      )}
                      <td style={{ ...tdBase, fontWeight: 600, color: INK }}>
                        {ing && ing.closing_balance != null ? `${fmtQty(ing.closing_balance)} ${u}` : '—'}
                      </td>
                    </React.Fragment>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div style={{ padding: '10px 12px', fontSize: 12, color: FAINT, borderTop: `1px solid ${HAIRLINE}` }}>
        Opening + Restocked ± Converted − Sold − Waste ± Other = Closing
      </div>
    </div>
  );
}
