// @ts-nocheck
import { useState, useEffect, useRef } from 'react';
import { X, Printer } from 'lucide-react';
import Receipt, { COPY_TYPES } from './Receipt';
import { useSettings } from '@/lib/SettingsContext';
import { buildEscPosCopies } from '@/lib/escpos-payload';

const COPY_TABS = [
  { value: 'all', label: 'Both Copies' },
  { value: 'customer', label: 'Customer' },
  { value: 'shop', label: 'Shop' },
];

/**
 * A page taller than the ticket is not a cosmetic issue on a continuous roll
 * — it is the exact bug reported on real hardware: the driver feeds blank
 * paper to fill out the page it was told to expect, the roll keeps running
 * with nothing printing on it, and the auto-cutter (which most drivers only
 * fire at the *end* of a page) never gets there. So this fallback is sized
 * from the actual copy count and item count rather than a fixed guess — a
 * three-copy print with 8 items and a three-copy print with 1 item are not
 * the same length, and a fallback that assumes the larger of the two on every
 * job is the same failure by a different route.
 */
function estimateHeightMm(copyCount, itemCount) {
  const HEADER_FOOTER_MM = 55; // banner + shop header + meta + totals + footer
  const PER_ITEM_MM = 6;
  const perCopy = HEADER_FOOTER_MM + Math.max(1, itemCount) * PER_ITEM_MM;
  return Math.max(60, Math.ceil(perCopy * Math.max(1, copyCount)));
}

/** Two animation frames guarantee a layout pass has actually happened; a
 * fixed setTimeout is a guess that can lose on a slow or busy machine. */
function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

export default function ReceiptModal({ open, onClose, orderData, autoPrintEnabled = true }) {
  const [selection, setSelection] = useState('all');
  const settings = useSettings();
  const { autoPrint, paperSize, printMode, escposPrinter } = settings;

  /**
   * The ESC/POS path — see electron/escpos-receipt.js and
   * electron/print-raw-windows.js for why this exists at all (the BC-87AC's
   * driver doesn't reliably honor the HTML path's custom @page size, which
   * shows up as blank paper before/between copies). Only attempted when
   * Settings → Printer has it turned on and a printer chosen, and only
   * available inside the Electron app (window.electronAPI). Returns whether
   * it succeeded — false means the caller should fall back to window.print().
   */
  const printViaEscPos = async (copyTypes) => {
    if (printMode !== 'escpos') return false;
    if (!escposPrinter) return false;
    if (typeof window === 'undefined' || !window.electronAPI?.printEscPos) return false;

    try {
      const copies = buildEscPosCopies(orderData, copyTypes, settings);
      const result = await window.electronAPI.printEscPos({
        printerName: escposPrinter,
        paperWidthMm: paperSize === '58mm' ? 58 : 80,
        copies,
      });
      if (!result?.success) {
        console.error('ESC/POS print failed, falling back to browser print:', result?.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('ESC/POS print failed, falling back to browser print:', err);
      return false;
    }
  };

  const writePageSize = (pageMm, heightMm) => {
    let tag = document.getElementById('receipt-page-size');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'receipt-page-size';
      document.head.appendChild(tag);
    }
    tag.textContent =
      `@media print { @page { size: ${pageMm}mm ${heightMm}mm; margin: 0; } }`;
  };

  const sizePageToReceipt = async (copyCount = 1, itemCount = 1) => {
    // print head can actually reach. Laying the receipt out at the full roll
    // width pushed its right-hand edge past the printable area, so lines came
    // out cut off rather than wrapped.
    const roll = paperSize === '58mm'
      ? { pageMm: 58, contentMm: 48 }
      : { pageMm: 80, contentMm: 72 };

    // Publish the content width so the print stylesheet lays the receipt out
    // at exactly the width we are about to measure.
    document.documentElement.style.setProperty('--receipt-width', `${roll.contentMm}mm`);

    await nextPaint();
    if (document.fonts && document.fonts.ready) {
      // Race against a short timeout: a font that never finishes loading must
      // not be able to hang the print indefinitely.
      try {
        await Promise.race([
          document.fonts.ready,
          new Promise((resolve) => setTimeout(resolve, 400)),
        ]);
      } catch { /* best effort */ }
    }

    try {
      const area = document.getElementById('printable-area');
      const copies = document.querySelectorAll('#printable-area .receipt-copy');

      if (!area || !copies.length) {
        // The modal hasn't painted its receipts yet. Rather than leave the
        // stale (or absent) page-size rule in place — which is exactly how a
        // 200mm fallback ends up printing 90mm of ticket and 110mm of blank
        // roll — size it from what we already know is coming.
        writePageSize(roll.pageMm, estimateHeightMm(copyCount, itemCount));
        return;
      }

      /*
       * Measure the receipt as it will be on paper, not as it is on screen.
       *
       * On screen it is ~340px (90mm) wide; on paper 72mm, where the same text
       * wraps onto more lines and the receipt is taller. The rules that cause
       * that — the printable width and the word breaking — live inside
       * `@media print`, so they are not in effect while measuring. The
       * `.measuring-print` class carries the same rules outside the media
       * query; it is applied for the instant of the measurement and removed.
       *
       * Without it the page came out shorter than the receipt and the overflow
       * printed onto a second page, which on a roll is more paper, not less.
       *
       * `@page` sizes every page in the job identically — Chromium has no way
       * to give page 2 a different height than page 1 here — so this has to
       * be the TALLEST copy being printed, not just the first one in the DOM.
       * Measuring only the first copy is exactly the bug reported printing
       * "Both Copies": the customer and shop copies are the same height, so
       * it happened to work by coincidence once the (shorter) kitchen ticket
       * was removed, but a single-copy measurement is one content change away
       * from clipping every copy after the first again.
       */
      area.classList.add('measuring-print');
      const heightPx = Math.max(...Array.from(copies, (c) => c.offsetHeight));
      area.classList.remove('measuring-print');

      if (!heightPx) {
        writePageSize(roll.pageMm, estimateHeightMm(copyCount, itemCount));
        return;
      }

      // CSS px are 1/96in by definition, so this conversion is exact. The few
      // extra millimetres give the cutter somewhere to land.
      const heightMm = Math.ceil((heightPx * 25.4) / 96) + 5;
      writePageSize(roll.pageMm, heightMm);
    } catch {
      // Never leave the page size unset — an oversized fallback page is the
      // one thing guaranteed to print blank roll with no cut.
      writePageSize(roll.pageMm, estimateHeightMm(copyCount, itemCount));
    }
  };

  /**
   * Settings has an "auto print" switch that nothing ever read, so a shop that
   * turned it on still had to click Print on every single sale.
   *
   * The guard matters: this fires once per receipt, not on every render, and
   * the ref is reset when the modal closes so the next sale prints again. A
   * reprint opened from the Orders screen passes autoPrintEnabled={false},
   * because silently firing the printer on a reprint would be a surprise.
   */
  const printedFor = useRef(null);

  useEffect(() => {
    if (!open || !orderData) {
      printedFor.current = null;
      return;
    }
    if (!autoPrint || !autoPrintEnabled) return;

    const key = orderData?.orderInfo?.orderNumber ?? 'current';
    if (printedFor.current === key) return;
    printedFor.current = key;

    // sizePageToReceipt already waits out the paint before measuring, so
    // there is no separate arbitrary delay here to be wrong about on a slow
    // machine.
    let cancelled = false;
    const copyTypes = selection === 'all' ? COPY_TYPES : [selection];
    const itemCount = (orderData?.items || []).length;
    printViaEscPos(copyTypes).then((printed) => {
      if (cancelled || printed) return;
      sizePageToReceipt(copyTypes.length, itemCount).then(() => {
        if (!cancelled) window.print();
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderData, autoPrint, autoPrintEnabled]);

  if (!open || !orderData) return null;

  const copiesToPrint = selection === 'all' ? COPY_TYPES : [selection];

  const handlePrint = async () => {
    const printed = await printViaEscPos(copiesToPrint);
    if (printed) return;
    await sizePageToReceipt(copiesToPrint.length, (orderData?.items || []).length);
    window.print();
  };

  const printLabel = selection === 'all'
    ? 'Print Both Copies'
    : `Print ${COPY_TABS.find(t => t.value === selection)?.label} Copy`;

  return (
    /*
      `flex + items-center` clips the top of the content once it grows
      taller than the viewport — the overflow goes above the scrollable
      area and becomes unreachable. Two full receipts stacked can easily
      exceed the viewport, which is why the first copy was cut off. Block
      layout with auto margins centres short content and scrolls tall
      content correctly.
    */
    <div
      className="fixed inset-0 print-root"
      style={{
        background: 'rgba(17,17,17,0.6)',
        backdropFilter: 'blur(4px)',
        zIndex: 50,
        overflowY: 'auto',
        padding: '24px 16px',
      }}
      onClick={onClose}
    >
      <div
        className="flex flex-col items-center print-root"
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 400, margin: '0 auto' }}
      >
        <div className="w-full flex justify-end mb-4 pr-4 no-print">
          <button
            onClick={onClose}
            style={{
              width: 36, height: 36, borderRadius: 18,
              background: '#FFFFFF', color: '#111827',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(17,17,17,0.12)',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Copy selector — screen only, never printed. */}
        <div
          className="no-print"
          style={{
            display: 'flex', gap: 6, marginBottom: 16,
            background: '#FFFFFF', padding: 6, borderRadius: 12,
            boxShadow: '0 4px 12px rgba(17,17,17,0.10)',
          }}
        >
          {COPY_TABS.map(tab => {
            const active = selection === tab.value;
            return (
              <button
                key={tab.value}
                onClick={() => setSelection(tab.value)}
                style={{
                  padding: '8px 14px', borderRadius: 8,
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  background: active ? '#111111' : 'transparent',
                  color: active ? '#FFFFFF' : '#6B6B63',
                  border: 'none',
                  transition: 'all 140ms',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/*
          Printable area. Every selected copy is rendered here; the print
          stylesheet puts a page break after each one so a single print
          dialog produces the whole stack, cut between tickets.
        */}
        <div
          id="printable-area"
          style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          {copiesToPrint.map(copyType => (
            <Receipt key={copyType} {...orderData} copyType={copyType} />
          ))}
        </div>

        <button
          onClick={handlePrint}
          className="flex items-center gap-2 transition-all duration-150 no-print"
          style={{
            height: 48, padding: '0 32px', borderRadius: 24,
            background: '#111111',
            boxShadow: '0 4px 20px rgba(17,17,17,0.35)',
            color: '#FFFFFF', fontSize: 16, fontWeight: 700,
            border: 'none', cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
            marginBottom: 24,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#000000'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#111111'; }}
        >
          <Printer size={20} />
          {printLabel}
        </button>
      </div>
    </div>
  );
}
