/**
 * CSV helpers shared by the report exports.
 *
 * Kept separate from the Reports screen so the escaping rules — the part that
 * silently corrupts a client's data when it is wrong — can be tested directly.
 */

/**
 * Encode one cell per RFC 4180.
 *
 * Two hazards are handled here:
 *
 *  1. Delimiters. A value containing a comma, double quote or newline must be
 *     wrapped in quotes with internal quotes doubled. The previous exporter
 *     instead stripped commas out of the item list, quietly altering the data
 *     to keep the row intact, and did nothing about quotes — a single `"` in an
 *     item name shifted every column after it.
 *
 *  2. Formula injection. Excel and Sheets execute a cell that begins with
 *     =, +, - or @. Item names are free text typed by staff, so a name like
 *     `=cmd|...` would run on open. Prefixing an apostrophe forces text.
 */
export function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Encode an array of cells into one CSV line. */
export function toCsvRow(cells) {
  return cells.map(escapeCell).join(',');
}

/**
 * Round money to 2dp and return a bare number.
 *
 * Currency symbols and thousands separators are deliberately omitted: a cell
 * reading `Rs. 1,250` is text to Excel and cannot be summed, which defeats the
 * point of exporting a spreadsheet.
 */
export function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Join rows into a CSV document.
 *
 * CRLF line endings per RFC 4180, and a UTF-8 BOM so Excel decodes the file as
 * UTF-8 rather than the machine's local codepage — without it any non-ASCII
 * item name is mangled on open.
 */
export function buildCsv(rows) {
  return '﻿' + rows.map(toCsvRow).join('\r\n');
}
