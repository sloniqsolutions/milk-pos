/**
 * Input checks shared by the till's routes.
 *
 * Every route used to trust whatever arrived: `parseFloat("abc")` became NaN
 * and was written to the database, a negative quantity added stock instead of
 * removing it, and an object where a number belonged reached SQLite and came
 * back as a raw 500. These helpers let a route say what it accepts in one line
 * and answer the person at the till in plain words when it is not met.
 */

/** A trimmed string capped at `max`, or '' for anything that is not text. */
function clean(value, max = 200) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, max);
}

/** A finite number from a number or a numeric string; NaN for anything else (including '', null, objects). */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** True for a real calendar day written YYYY-MM-DD ("2026-02-30" is not one). */
function isRealDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/**
 * A day a stock movement may be recorded against: a real date, not before the
 * business existed and not in the future (a far-future entry would sit outside
 * every report and quietly skew the balance history). Returns an error
 * message, or null when fine. An absent date is fine — callers default it.
 */
function checkEntryDay(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isRealDay(value)) return 'Enter the date as a real calendar day (for example 2026-09-19).';
  if (value < '2020-01-01') return 'That date is too far in the past. Please check it.';
  if (value > localDay(new Date(Date.now() + 24 * 3600 * 1000))) return 'That date is in the future. Please choose today or earlier.';
  return null;
}

module.exports = { clean, toNumber, isRealDay, checkEntryDay, localDay };
