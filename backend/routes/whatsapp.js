const express = require('express');
const router = express.Router();
const db = require('../db/database');
const PDFDocument = require('pdfkit');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── CONFIG ────────────────────────────────────────────────────────────────────
// SECURITY: a live Meta access token, the phone number ID and the recipient's
// number were all hardcoded here and committed to a public repository, which
// let anyone send WhatsApp messages as this business. They are now read from
// the environment. The exposed token must be rotated in Meta Business Suite —
// moving it here does not invalidate the one that already leaked.
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const RECIPIENT_PHONE = process.env.WA_RECIPIENT_PHONE;
const WA_API_VERSION = process.env.WA_API_VERSION || 'v20.0';

const whatsappConfigured = () =>
  Boolean(WA_ACCESS_TOKEN && WA_PHONE_NUMBER_ID && RECIPIENT_PHONE);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function formatTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function formatRs(num) {
  return `Rs. ${Number(num || 0).toLocaleString('en-PK')}`;
}

// ── PDF BUILDER ───────────────────────────────────────────────────────────────
function buildPDF(data) {
  return new Promise((resolve, reject) => {
    const { kpi, topItems, categories, cashiers, orders, dateStr } = data;

    const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const BRAND_RED = '#DC2626';
    const DARK   = '#111827';
    const GRAY   = '#6B7280';
    const GREEN  = '#16A34A';
    const RED    = '#DC2626';
    const WHITE  = '#FFFFFF';
    const PAGE_W = doc.page.width - 80; // usable width

    // ── HEADER ──
    doc.rect(0, 0, doc.page.width, 75).fill('#000000');
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(22)
       .text('PURE MILK', 40, 18, { align: 'center' });
    doc.font('Helvetica').fontSize(11)
       .text('DAILY SALES REPORT — Rozana Ki Report', 40, 44, { align: 'center' });
    doc.fontSize(10).text(dateStr, 40, 60, { align: 'center' });

    doc.fillColor(DARK);
    let y = 95;

    // ── SECTION HELPER ──
    const section = (title, romanTitle) => {
      doc.rect(40, y - 2, PAGE_W, 22).fill('#FEEFD0');
      doc.fillColor(BRAND_RED).font('Helvetica-Bold').fontSize(13)
         .text(`${title}  (${romanTitle})`, 48, y + 2);
      doc.fillColor(DARK);
      y += 28;
    };

    const row = (label, value, bold = false, color = DARK) => {
      doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(label, 48, y, { continued: true });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color)
         .text(String(value), { align: 'right', width: PAGE_W - 8 });
      y += 16;
    };

    const divider = () => {
      doc.moveTo(40, y).lineTo(40 + PAGE_W, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
      y += 8;
    };

    // ── 1. KPI SUMMARY ──
    section('Daily KPI Summary', 'Aaj Ka Khulaasa');

    const totalRev = Number(kpi.total_revenue || 0);
    const totalOrd = Number(kpi.total_orders  || 0);
    const avgOrd   = Number(kpi.avg_order_value || 0);
    const totDisc  = Number(kpi.total_discounts || 0);

    row('Total Orders (Kul Orders):', totalOrd, true, BRAND_RED);
    row('Total Revenue (Kul Aamdani):', formatRs(totalRev), true, GREEN);
    row('Average Order Value (Avarege Raqam):', formatRs(avgOrd));
    row('Total Discounts Given (Kul Discount):', formatRs(totDisc), false, RED);

    const revTrend = Number(kpi.revenue_trend || 0);
    const trendColor = revTrend >= 0 ? GREEN : RED;
    const trendSign  = revTrend >= 0 ? '▲' : '▼';
    row(`Revenue vs Yesterday (Kal Se Farq):`, `${trendSign} ${Math.abs(revTrend)}%`, false, trendColor);

    y += 10;

    // ── 2. TOP SELLING ITEMS ──
    if (topItems.length > 0) {
      section('Top Selling Items', 'Sab Se Zyada Bikne Wale');

      // table header
      doc.rect(40, y, PAGE_W, 18).fill('#FEEFD0');
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY);
      doc.text('#', 48, y + 4).text('Item', 68, y + 4).text('Qty', 340, y + 4).text('Revenue', 400, y + 4).text('%', 490, y + 4);
      y += 22;

      topItems.forEach((item, i) => {
        const bg = i % 2 === 0 ? WHITE : '#FAFAFA';
        doc.rect(40, y - 2, PAGE_W, 16).fill(bg);
        doc.font('Helvetica').fontSize(9).fillColor(DARK);
        doc.text(String(i + 1), 48, y);
        doc.text(item.name || '—', 68, y, { width: 260 });
        doc.text(String(item.total_qty || 0), 340, y);
        doc.text(formatRs(item.total_revenue), 400, y);
        doc.text(`${item.percentage || 0}%`, 490, y);
        y += 17;
      });
      y += 8;
    }

    // ── 3. SALES BY CATEGORY ──
    if (categories.length > 0) {
      section('Sales by Category', 'Category Ke Mutabiq Bikri');
      categories.forEach((cat, i) => {
        const bg = i % 2 === 0 ? WHITE : '#FAFAFA';
        doc.rect(40, y - 2, PAGE_W, 16).fill(bg);
        doc.font('Helvetica').fontSize(9).fillColor(DARK);
        doc.text(cat.category || 'Uncategorized', 48, y, { width: 260 });
        doc.font('Helvetica-Bold').text(formatRs(cat.total_revenue), 400, y);
        doc.font('Helvetica').fillColor(GRAY).text(`${cat.percentage || 0}%`, 490, y);
        doc.fillColor(DARK);
        y += 17;
      });
      y += 8;
    }

    // ── 4. CASHIER PERFORMANCE ──
    if (cashiers.length > 0) {
      section('Cashier Performance', 'Cashier Ki Performance');
      cashiers.forEach(c => {
        row(`${c.cashier_name || 'Unknown'}:`, `${c.total_orders} orders — ${formatRs(c.total_revenue)}`, false, DARK);
      });
      y += 8;
    }

    // ── 5. ORDER-BY-ORDER DETAIL ──
    if (orders.length > 0) {
      // check if new page needed
      if (y > 680) { doc.addPage(); y = 50; }
      section('Order Details', 'Order Ki Tafseel');

      doc.rect(40, y, PAGE_W, 18).fill('#FEEFD0');
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY);
      doc.text('#', 48, y + 4).text('Time', 75, y + 4).text('Cashier', 140, y + 4)
         .text('Items', 220, y + 4).text('Discount', 380, y + 4).text('Total', 450, y + 4).text('Pay', 510, y + 4);
      y += 22;

      orders.forEach((o, i) => {
        if (y > 730) { doc.addPage(); y = 40; }
        const bg = i % 2 === 0 ? WHITE : '#FAFAFA';
        const rowH = 18;
        doc.rect(40, y - 2, PAGE_W, rowH).fill(bg);
        doc.font('Helvetica').fontSize(8).fillColor(DARK);
        doc.text(`#${o.id}`, 48, y);
        doc.text(formatTime(o.created_at), 75, y);
        doc.text(o.cashier_name || '—', 140, y, { width: 75 });
        const itemsSummary = (o.items_summary || '').substring(0, 35) + ((o.items_summary || '').length > 35 ? '…' : '');
        doc.text(itemsSummary, 220, y, { width: 155 });
        if (Number(o.discount) > 0) {
          doc.fillColor(RED).text(`-${formatRs(o.discount)}`, 378, y);
          doc.fillColor(DARK);
        } else {
          doc.text('—', 390, y);
        }
        doc.font('Helvetica-Bold').fillColor(GREEN).text(formatRs(o.total), 450, y);
        doc.font('Helvetica').fillColor(GRAY).text(o.payment_method || '—', 510, y);
        doc.fillColor(DARK);
        y += rowH;
      });
      y += 6;
    }

    // ── 6. ROMAN URDU SUMMARY ──
    if (y > 680) { doc.addPage(); y = 50; }
    section('Summary & Insights', 'Nateeja aur Tajziya');

    const insights = [];
    if (totalOrd === 0) {
      insights.push('Aaj koi order nahi aaya. Kal ki tayyari karein!');
    } else {
      insights.push(`Aaj kul ${totalOrd} orders aaye aur total Rs. ${totalRev.toLocaleString('en-PK')} ki aamdani hui.`);
      insights.push(`Har order ka avarege Rs. ${Math.round(avgOrd).toLocaleString('en-PK')} raha.`);
      if (totDisc > 0) insights.push(`Aaj total Rs. ${totDisc.toLocaleString('en-PK')} ki discount di gayi.`);
      if (revTrend > 10) insights.push(`Wah! Kal se ${revTrend}% zyada kamai hui — bohat acha din raha!`);
      else if (revTrend < -10) insights.push(`Aaj ki sales kal se ${Math.abs(revTrend)}% kam rahi — kal aur mehnat karein!`);
      if (topItems.length > 0) insights.push(`Sab se zyada bikne wala item: "${topItems[0].name}" — ${topItems[0].total_qty} pieces.`);
    }

    insights.forEach(line => {
      doc.font('Helvetica').fontSize(10).fillColor(DARK)
         .text(`• ${line}`, 48, y, { width: PAGE_W - 10 });
      y += doc.heightOfString(line, { width: PAGE_W - 10 }) + 6;
    });

    // ── FOOTER ──
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.rect(0, doc.page.height - 30, doc.page.width, 30).fill('#000000');
      doc.font('Helvetica').fontSize(8).fillColor(WHITE)
         .text(`Generated by Pure Milk POS  |  Page ${i + 1} of ${pageCount}  |  ${new Date().toLocaleString('en-PK')}`,
               40, doc.page.height - 18, { align: 'center' });
    }

    doc.end();
  });
}

// ── MAIN ROUTE ────────────────────────────────────────────────────────────────
router.post('/send-daily-report', async (req, res) => {
  if (!whatsappConfigured()) {
    return res.status(503).json({
      error: 'WhatsApp reporting is not configured. Set WA_ACCESS_TOKEN, ' +
             'WA_PHONE_NUMBER_ID and WA_RECIPIENT_PHONE in the environment.',
    });
  }

  const today = new Date().toISOString().split('T')[0];
  const dateStr = new Date().toLocaleDateString('en-PK', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  try {
    // 1. Fetch all data in parallel
    const [kpi, topItems, categories, cashiers, orders] = await Promise.all([
      Promise.resolve(db.prepare(`
        SELECT COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_revenue,
               COALESCE(AVG(total),0) as avg_order_value, COALESCE(SUM(discount),0) as total_discounts
        FROM orders WHERE DATE(created_at)=DATE(?) AND status!='voided'
      `).get(today)),
      Promise.resolve(db.prepare(`
        SELECT oi.name, SUM(oi.quantity) as total_qty, SUM(oi.price*oi.quantity) as total_revenue,
               COUNT(DISTINCT oi.order_id) as order_count
        FROM order_items oi JOIN orders o ON oi.order_id=o.id
        WHERE DATE(o.created_at)=DATE(?) AND o.status!='voided'
        GROUP BY oi.name ORDER BY total_qty DESC LIMIT 10
      `).all(today).map(i => {
        const totalRev2 = 0;
        return { ...i, percentage: 0 };
      })),
      Promise.resolve(db.prepare(`
        SELECT COALESCE(m.category,'Uncategorized') as category,
               SUM(oi.quantity) as total_qty, SUM(oi.price*oi.quantity) as total_revenue
        FROM order_items oi JOIN orders o ON oi.order_id=o.id
        LEFT JOIN menu_items m ON oi.menu_item_id=m.id
        WHERE DATE(o.created_at)=DATE(?) AND o.status!='voided'
        GROUP BY category ORDER BY total_revenue DESC
      `).all(today)),
      Promise.resolve(db.prepare(`
        SELECT cashier_name, COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_revenue
        FROM orders WHERE DATE(created_at)=DATE(?) AND status!='voided'
        GROUP BY cashier_name ORDER BY total_revenue DESC
      `).all(today)),
      Promise.resolve(db.prepare(`
        SELECT o.id, o.created_at, o.cashier_name, o.total, o.discount, o.payment_method,
               GROUP_CONCAT(oi.name || ' x' || oi.quantity, ', ') as items_summary
        FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
        WHERE DATE(o.created_at)=DATE(?) AND o.status!='voided'
        GROUP BY o.id ORDER BY o.created_at ASC
      `).all(today)),
    ]);

    // Fix category percentages
    const totalCatRev = categories.reduce((s, c) => s + c.total_revenue, 0);
    categories.forEach(c => {
      c.percentage = totalCatRev > 0 ? ((c.total_revenue / totalCatRev) * 100).toFixed(1) : 0;
    });

    // Fix top item percentages
    const totalItemRev = topItems.reduce((s, i) => s + i.total_revenue, 0);
    topItems.forEach(i => {
      i.percentage = totalItemRev > 0 ? ((i.total_revenue / totalItemRev) * 100).toFixed(1) : 0;
    });

    // Also fetch yesterday's KPI for trend
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];
    const prevKpi = db.prepare(`
      SELECT COALESCE(SUM(total),0) as total_revenue FROM orders
      WHERE DATE(created_at)=DATE(?) AND status!='voided'
    `).get(yStr);
    const revTrend = prevKpi.total_revenue > 0
      ? (((kpi.total_revenue - prevKpi.total_revenue) / prevKpi.total_revenue) * 100).toFixed(1)
      : 0;
    kpi.revenue_trend = revTrend;

    // 2. Build Text Message
    let textMsg = `*Aaj Ki Report — ${dateStr}*\n\n` +
      `📦 *Orders:* ${kpi.total_orders}\n` +
      `💰 *Revenue:* Rs. ${Number(kpi.total_revenue).toLocaleString('en-PK')}\n` +
      `🧾 *Avg Order:* Rs. ${Math.round(kpi.avg_order_value).toLocaleString('en-PK')}\n` +
      `🏷️ *Discounts:* Rs. ${Number(kpi.total_discounts).toLocaleString('en-PK')}\n\n`;

    if (topItems.length > 0) {
      textMsg += `*Top Selling Items:*\n`;
      topItems.slice(0, 5).forEach((item, i) => {
        textMsg += `${i + 1}. ${item.name || 'Unknown'} (${item.total_qty} qty)\n`;
      });
      textMsg += `\n`;
    }

    if (cashiers.length > 0) {
      textMsg += `*Cashiers:*\n`;
      cashiers.forEach(c => {
        textMsg += `- ${c.cashier_name || 'Unknown'}: Rs. ${Number(c.total_revenue).toLocaleString('en-PK')}\n`;
      });
      textMsg += `\n`;
    }

    textMsg += `_Tasty Bites POS se bheja gaya_`;

    // 3. Send Text Message
    const msgResp = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: RECIPIENT_PHONE,
          type: 'text',
          text: { body: textMsg },
        }),
      }
    );
    const msgData = await msgResp.json();
    if (msgData.error) {
      console.error('Message send failed:', msgData.error);
      return res.status(502).json({ error: 'Message send failed', details: msgData.error });
    }

    res.json({ success: true, message_id: msgData.messages?.[0]?.id });

  } catch (err) {
    console.error('WhatsApp report error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
