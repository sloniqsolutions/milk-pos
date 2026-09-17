/**
 * Renders a receipt copy as raw ESC/POS bytes instead of HTML.
 *
 * Why this exists: the till's normal print path (ReceiptModal.jsx) sizes an
 * exact `@page` in millimetres and calls window.print(), which goes through
 * Chromium's page-layout/GDI print pipeline and the printer's Windows driver.
 * The BlackCopper BC-87AC's driver doesn't reliably honor that custom page
 * size — it silently substitutes a fixed default paper form instead, which
 * is what produces blank feed before (or between, for multiple copies) the
 * actual receipt content. Sending the printer its own native command
 * language directly sidesteps the page-layout step entirely: there is no
 * page to mis-size, only a stream of ESC/POS text and control bytes ending
 * in a cut command.
 *
 * All formatting/business logic (currency, which fields to show, shop
 * identity) stays in the renderer, where SettingsContext already lives —
 * this module receives already-formatted strings (see the `copies` shape
 * documented below) and only does text-layout (padding/truncating to a fixed
 * character width) and ESC/POS control bytes. Keeping the money/formatting
 * logic in one place (the renderer) avoids it drifting from the HTML receipt
 * Receipt.jsx renders for everyone not using this path.
 */

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  INIT: Buffer.from([ESC, 0x40]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 1]),
  ALIGN_RIGHT: Buffer.from([ESC, 0x61, 2]),
  BOLD_ON: Buffer.from([ESC, 0x45, 1]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0]),
  DOUBLE_ON: Buffer.from([GS, 0x21, 0x11]),  // double width + height
  DOUBLE_OFF: Buffer.from([GS, 0x21, 0x00]),
  FEED: (n) => Buffer.from([ESC, 0x64, n]),
  CUT: Buffer.from([GS, 0x56, 0x01]),        // partial cut
};

/** Characters per line for Font A on each roll width — the usual defaults
 * for 58mm/80mm thermal heads; matches the widths ReceiptModal already uses
 * for the HTML path's content area (48mm / 72mm printable). */
function charsPerLine(paperWidthMm) {
  return paperWidthMm === 58 ? 32 : 42;
}

// Common punctuation that a shop name, address or customer detail is likely
// to actually contain, mapped to a plain-ASCII equivalent. Anything still
// outside 0x20-0x7E after this gets replaced with '?' rather than sent raw —
// Buffer's 'ascii' encoding masks the top bit instead of transliterating, so
// an unmapped character (from Node's own default punctuation, or Urdu text)
// silently turned into garbage on paper rather than an error anyone would see.
const ASCII_MAP = {
  '·': '-', '•': '-', '–': '-', '—': '-',
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '…': '...',
};

function toAscii(text) {
  let out = '';
  for (const ch of String(text)) {
    if (ASCII_MAP[ch]) { out += ASCII_MAP[ch]; continue; }
    const code = ch.codePointAt(0);
    out += (code >= 0x20 && code <= 0x7e) ? ch : '?';
  }
  return out;
}

function line(text = '') {
  return Buffer.concat([Buffer.from(toAscii(text), 'ascii'), Buffer.from('\n')]);
}

function divider(width, dashed = true) {
  return line((dashed ? '-' : '=').repeat(width));
}

/**
 * Truncates or pads a string to exactly `len` characters. ESC/POS text is
 * fixed-width, so every column has to be exact or the columns after it
 * drift — which means sanitizing to ASCII has to happen *before* this, not
 * in line() afterward: toAscii() can turn one non-ASCII character (an
 * ellipsis, an em dash) into a multi-character replacement, and doing that
 * after a string has already been padded to exactly `len` would throw the
 * column widths off by however many characters the replacement added.
 */
function fit(text, len) {
  const s = toAscii(text == null ? '' : text);
  return s.length > len ? s.slice(0, Math.max(0, len - 1)) + '.' : s.padEnd(len, ' ');
}

function fitRight(text, len) {
  const s = toAscii(text == null ? '' : text);
  return s.length > len ? s.slice(0, Math.max(0, len - 1)) + '.' : s.padStart(len, ' ');
}

/** Item name, qty and amount on one line if they fit; the name wraps to its
 * own line first when it doesn't, same as a printed receipt would rather
 * than silently truncating what was actually sold. */
function itemLines(item, width) {
  const qtyW = 6;   // "x12  "
  const amtW = 10;  // "Rs 1,234.5" worst case
  const nameW = width - qtyW - amtW;
  const qty = fit(item.qty, qtyW);
  const amt = fitRight(item.amount, amtW);

  if (item.name.length <= nameW) {
    return line(fit(item.name, nameW) + qty + amt);
  }
  // Wraps: name on its own line(s), qty/amount right-aligned on the last one.
  const words = item.name.split(' ');
  const rows = [];
  let cur = '';
  words.forEach((w) => {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > nameW) { rows.push(cur); cur = w; } else { cur = next; }
  });
  if (cur) rows.push(cur);

  const out = [];
  rows.forEach((row, i) => {
    if (i < rows.length - 1) {
      out.push(line(row));
    } else {
      out.push(line(fit(row, nameW) + qty + amt));
    }
  });
  return Buffer.concat(out);
}

function totalsLine(label, value, width) {
  const valueW = 12;
  return line(fit(label, width - valueW) + fitRight(value, valueW));
}

/**
 * Builds the full ESC/POS byte stream for one receipt copy.
 *
 * @param {object} copy — see escpos-receipt.js's module docstring; matches
 *   what ReceiptModal.jsx's buildEscPosCopy() sends.
 * @param {number} paperWidthMm — 58 or 80.
 */
function buildCopyBuffer(copy, paperWidthMm) {
  const width = charsPerLine(paperWidthMm);
  const parts = [CMD.INIT];

  if (copy.copyLabel) {
    parts.push(CMD.ALIGN_CENTER, CMD.BOLD_ON, line(copy.copyLabel), CMD.BOLD_OFF, line(''));
  }

  // Shop header
  parts.push(CMD.ALIGN_CENTER, CMD.DOUBLE_ON, line(copy.shopName || 'Pure Milk'), CMD.DOUBLE_OFF);
  if (copy.tagline) parts.push(line(copy.tagline));
  if (copy.addressLine) parts.push(line(copy.addressLine));
  parts.push(CMD.ALIGN_LEFT, divider(width));

  // Order meta — two columns' worth of lines, printed left then right since
  // a 32/42-char thermal line has no room for true side-by-side columns.
  (copy.metaLeft || []).forEach((l) => parts.push(line(l)));
  (copy.metaRight || []).forEach((l) => parts.push(line(l)));

  // Delivery-to block
  if (copy.customer && (copy.customer.name || copy.customer.phone || copy.customer.address)) {
    parts.push(divider(width), CMD.BOLD_ON, line('DELIVER TO'), CMD.BOLD_OFF);
    if (copy.customer.name) parts.push(line(copy.customer.name));
    if (copy.customer.phone) parts.push(line(copy.customer.phone));
    if (copy.customer.address) parts.push(line(copy.customer.address));
  }

  // Items
  parts.push(divider(width), CMD.BOLD_ON, line('ITEM'), CMD.BOLD_OFF);
  (copy.items || []).forEach((item) => parts.push(itemLines(item, width)));

  // Totals
  parts.push(divider(width));
  (copy.totalsLines || []).forEach((t) => parts.push(totalsLine(t.label, t.value, width)));
  parts.push(divider(width, false), CMD.BOLD_ON, CMD.DOUBLE_ON);
  parts.push(totalsLine(copy.total.label, copy.total.value, Math.ceil(width / 2)));
  parts.push(CMD.DOUBLE_OFF, CMD.BOLD_OFF, divider(width, false));

  // Footer
  parts.push(CMD.ALIGN_CENTER, CMD.BOLD_ON, line(copy.footerMessage || 'Thank you for your purchase!'), CMD.BOLD_OFF);
  parts.push(line(''), divider(width));
  parts.push(line('POS Software By:'));
  parts.push(line('Virtiqo (Private) Limited'));
  parts.push(line('+92 300 8536046'));
  parts.push(line('info@virtiqo.com'));

  parts.push(CMD.FEED(4), CMD.CUT);
  return Buffer.concat(parts);
}

/** Concatenates every copy's buffer — one spooler job prints the whole
 * stack, cut between each copy, same as the HTML path's page-break-per-copy. */
function buildReceiptBuffer(copies, paperWidthMm) {
  return Buffer.concat(copies.map((c) => buildCopyBuffer(c, paperWidthMm)));
}

module.exports = { buildReceiptBuffer, buildCopyBuffer };
