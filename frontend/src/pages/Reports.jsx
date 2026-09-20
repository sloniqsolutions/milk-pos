// @ts-nocheck
import { useState, useEffect, useMemo } from 'react';
import { DollarSign, ShoppingBag, TrendingUp, Tag, Wallet, Printer, Download, FileSpreadsheet, CreditCard, Droplet, Package } from 'lucide-react';
import { reportsAPI } from '@/api/index';
import StockMovementTable from '@/components/StockMovementTable';
import { buildCsv, money } from '@/lib/csv';
import { CATEGORY_FILTERS, buildView, summarize, hasCategoryData, fmtAmountQty } from '@/lib/detailedView';
import { filterLineItems, summarizeLineItems, hasLineCategoryData } from '@/lib/itemSalesView';
import { useSettings } from '@/lib/SettingsContext';
import { useAuth } from '@/context/AuthContext';
import writeXlsxFile from 'write-excel-file/browser';
import moment from 'moment';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, LabelList
} from 'recharts';

// The Items and Detailed tables render one <tr> per row with no
// virtualization. A wide date range on a shop with real volume can mean
// several thousand of them — React reconciling and painting that many DOM
// nodes synchronously blocks the main thread for seconds after the data has
// already arrived, which reads as the screen being stuck even though loading
// itself finished. Capping what's drawn keeps the table itself fast; anyone
// who actually needs every row already has Export for that.
const TABLE_ROW_CAP = 500;

/** "45", "45.5" — never "45.500000000001", never a trailing ".0". */
const fmtQty = (n) => {
  const rounded = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const FILTER_CHIPS = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: 'Last 7 Days', value: 'last7' },
  { label: 'Last 30 Days', value: 'last30' },
  { label: 'This Month', value: 'thisMonth' },
  { label: 'This Year', value: 'thisYear' },
  { label: 'Custom Range', value: 'custom' },
];

export default function Reports({ onNavigate }) {
  const [activeFilter, setActiveFilter] = useState('last7');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  
  const [dateRange, setDateRange] = useState('today');
  const [net, setNet] = useState({ revenue: 0, expenses: 0, net: 0 });
  const [kpi, setKpi] = useState({ revenue: 0, orders: 0, avg_order_value: 0, total_discounts: 0, credit_collected: 0, ingredient_usage: [] });
  const [revenueData, setRevenueData] = useState([]);
  const [topItems, setTopItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [heatmapData, setHeatmapData] = useState([]);
  const [cashierPerformance, setCashierPerformance] = useState([]);
  const [detailedReport, setDetailedReport] = useState([]);
  const [stockMovement, setStockMovement] = useState([]);
    const [lineItems, setLineItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [reportFormat, setReportFormat] = useState('summary');
  // Detailed and Item Sales: 'all' | 'Milk' | 'Dahi' (Dahi and yogurt are the same product).
  const [catFilter, setCatFilter] = useState('all');
  // Shop name (used to name the exported file) and money formatting both
  // come from the shared settings provider rather than a second fetch.
  const { formatMoney, restaurant } = useSettings();
  // A manager may read the day's figures but not take a copy out of the
  // building. Viewing needs the data, so this is a UI control rather than a
  // hard boundary — the settings and menu routes are the enforced ones.
  const { isAdmin } = useAuth();
  const restaurantName = restaurant.name || 'Pure Milk';

  // Same grouping the inline Summary table below used to do itself —
  // pulled out so it can also feed StockMovementTable's merged view.
  const salesByDay = useMemo(() => {
    const byDate = {};
    detailedReport.forEach((row) => {
      const date = moment(row.created_at).format('YYYY-MM-DD');
      if (!byDate[date]) byDate[date] = { date, orders: 0, revenue: 0, discounts: 0, net: 0 };
      byDate[date].orders += 1;
      byDate[date].revenue += Number(row.subtotal) || 0;
      byDate[date].discounts += Number(row.discount) || 0;
      byDate[date].net += Number(row.total) || 0;
    });
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  }, [detailedReport]);

  // The Milk / Dahi filter for the Detailed report (see lib/detailedView.js). An
  // older backend that does not send the per-category fields simply gets no filter.
  const categoryData = hasCategoryData(detailedReport);
  const activeCat = categoryData ? catFilter : 'all';
  const isFiltered = activeCat !== 'all';
  const catUnit = activeCat === 'Milk' ? 'L' : 'kg';
  const detailedView = useMemo(() => buildView(detailedReport, activeCat), [detailedReport, activeCat]);
  // Totals are always over EVERY order in the range, never just the rows drawn.
  const detailedSummary = useMemo(() => summarize(detailedReport, activeCat), [detailedReport, activeCat]);
  const overall = useMemo(() => summarize(detailedReport, 'all'), [detailedReport]);

  // The same Milk / Dahi filter for Item Sales (see lib/itemSalesView.js), sharing
  // the chips' state with Detailed. An older backend that does not classify each
  // line simply gets no filter. Totals are over EVERY line in the range.
  const lineData = hasLineCategoryData(lineItems);
  const activeLineCat = lineData ? catFilter : 'all';
  const lineFiltered = activeLineCat !== 'all';
  const lineUnit = activeLineCat === 'Milk' ? 'L' : 'kg';
  const lineView = useMemo(() => filterLineItems(lineItems, activeLineCat), [lineItems, activeLineCat]);
  const lineSummary = useMemo(() => summarizeLineItems(lineItems, activeLineCat), [lineItems, activeLineCat]);
  const productLabel = (cat) => (cat === 'Dahi' ? 'Dahi / Yogurt' : 'Milk');

  // Calculate dates based on filter
  const { from, to } = useMemo(() => {
    if (activeFilter === 'custom') return { from: customFrom, to: customTo };
    const today = moment().format('YYYY-MM-DD');
    switch (activeFilter) {
      case 'today': return { from: today, to: today };
      case 'yesterday': {
        const y = moment().subtract(1, 'days').format('YYYY-MM-DD');
        return { from: y, to: y };
      }
      // The range is inclusive of both ends, so "last 7 days" is today plus the
      // six before it. Subtracting 7 spanned 8 days and disagreed with the same
      // filter on the Orders screen, which uses 6.
      case 'last7': return { from: moment().subtract(6, 'days').format('YYYY-MM-DD'), to: today };
      case 'last30': return { from: moment().subtract(29, 'days').format('YYYY-MM-DD'), to: today };
      case 'thisMonth': return { from: moment().startOf('month').format('YYYY-MM-DD'), to: today };
      case 'thisYear': return { from: moment().startOf('year').format('YYYY-MM-DD'), to: today };
      default: return { from: null, to: null };
    }
  }, [activeFilter, customFrom, customTo]);

    const loadData = async (attempt = 0) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const params = { from, to };
      const [kData, rData, tData, cData, hData, cpData, dData, liData, nData, smData] = await Promise.all([
        reportsAPI.kpi(params),
        reportsAPI.revenueOverTime({ ...params, groupBy: activeFilter === 'today' ? 'hour' : 'day' }),
        reportsAPI.topItems(params),
        reportsAPI.byCategory(params),
        reportsAPI.hourlyHeatmap(params),
        reportsAPI.cashierPerformance(params),
        reportsAPI.detailed(params),
        reportsAPI.lineItems(params),
        reportsAPI.net(params),
        reportsAPI.stockMovement(params),
      ]);
      
      // Transform backend data to match frontend expectations
      setKpi({
        revenue: kData.total_revenue || 0,
        orders: kData.total_orders || 0,
        avg_order_value: kData.avg_order_value || 0,
        total_discounts: kData.total_discounts || 0,
        credit_collected: kData.credit_collected || 0,
        ingredient_usage: Array.isArray(kData.ingredient_usage) ? kData.ingredient_usage : []
      });
      setNet(nData);
      setStockMovement(Array.isArray(smData) ? smData : []);

      setRevenueData(rData.map(d => ({ ...d, date: d.period })));
      
      setTopItems(tData.map(d => ({ ...d, quantity: d.total_qty })));
      
      // FIX: "Sales by Category" always rendered zero. /reports/by-category
      // returns `total_revenue` and `total_qty`, but the pie's dataKey, the
      // centre total and every legend row all read `revenue` — which does not
      // exist on these rows, so each one formatted `undefined` as 0. Normalise
      // the shape here, the same way top items already are.
      setCategories(cData.map(d => ({
        ...d,
        revenue: Number(d.total_revenue) || 0,
        quantity: Number(d.total_qty) || 0,
      })));
      
      setHeatmapData(hData);
      
      setCashierPerformance(cpData.map(d => ({
        ...d,
        total_orders: d.total_orders || 0,
        total_revenue: d.total_revenue || 0,
        avg_order_value: d.avg_order_value || 0,
      })));
      
      // The backend now returns a real `subtotal` (summed from the order's own
      // line items) and a real `items` string. `subtotal` used to be aliased to
      // `total` here, which made the Subtotal column report the post-discount
      // figure and left Summary showing identical Revenue and Net Revenue
      // columns either side of a Discounts column that reconciled with neither.
      setDetailedReport(dData);
      setLineItems(liData);
      setIsLoading(false);
    } catch (err) {
      console.error('Failed to load reports:', err);
      // A cold serverless container can briefly fail its very first request
      // while it sets up its database connection (see cloud/db/schema.js) —
      // this used to be exactly what forced a manual refresh. Two quiet,
      // short-delayed retries clear it on their own, without the person
      // needing to notice anything went wrong.
      if (attempt < 2) {
        setTimeout(() => loadData(attempt + 1), 1500);
      } else {
        setLoadError('Could not load reports. Check your connection and try again.');
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (activeFilter !== 'custom' || (customFrom && customTo)) {
      loadData();
    }
  }, [from, to]);


  const PIE_COLORS = ['#DC2626', '#3B82F6', '#10B981', '#8B5CF6', '#F43F5E', '#06B6D4'];

  const printReport = () => {
    window.print();
  };

  /**
   * Build a Date that Excel will render as the intended calendar day.
   *
   * write-excel-file serialises a Date from its **UTC** components. A local
   * midnight here is 19:00 the previous day in UTC, so passing
   * `moment(x).startOf('day').toDate()` wrote every date one day early —
   * an order rung up on the 17th exported as the 16th. Pinning the value to
   * UTC midnight of the same calendar date makes the serial a whole number and
   * the rendered date correct regardless of the machine's timezone.
   */
  const excelDate = (value) => {
    const m = moment(value);
    return new Date(Date.UTC(m.year(), m.month(), m.date()));
  };

  const exportFileName = (suffix, ext) => {
    const safeName = String(restaurantName || 'Pure Milk').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return `${safeName}_${suffix}_${from}_to_${to}.${ext}`;
  };

  /**
   * ── Report definition ─────────────────────────────────────────────────────
   *
   * A report is described once — its columns and its records — and both the
   * CSV and the Excel export render from that single definition, so the two
   * can never drift apart in columns, ordering or arithmetic.
   *
   * `width` is in characters and only means anything to the Excel export.
   * A CSV carries no formatting at all, which is why a date column there shows
   * as ###### until the reader widens it: Excel parses the value as a date,
   * and a date is too wide for the default column. The xlsx export sets real
   * widths, so it opens readable.
   */
  const getReportTable = () => {
    if (reportFormat === 'summary') {
      const byDate = {};
      detailedReport.forEach(row => {
        const date = moment(row.created_at).format('YYYY-MM-DD');
        if (!byDate[date]) {
          byDate[date] = {
            orders: 0, qty: 0, gross: 0, discounts: 0,
            delivery: 0, net: 0, cash: 0, card: 0, online: 0,
            staffOrders: 0, staffDiscount: 0,
          };
        }
        const d = byDate[date];
        d.orders += 1;
        d.qty += Number(row.total_qty) || 0;
        d.gross += Number(row.subtotal) || 0;
        d.discounts += Number(row.discount) || 0;
        d.delivery += Number(row.delivery_charge) || 0;
        d.net += Number(row.total) || 0;
        if (row.is_employee) d.staffOrders += 1;
        d.staffDiscount += Number(row.employee_discount) || 0;
        const method = String(row.payment_method || '').toLowerCase();
        if (method === 'cash') d.cash += Number(row.total) || 0;
        else if (method === 'card') d.card += Number(row.total) || 0;
        else d.online += Number(row.total) || 0;
      });

      const records = Object.keys(byDate).sort().map(date => ({ date, ...byDate[date] }));
      const t = { orders: 0, qty: 0, gross: 0, discounts: 0, delivery: 0, net: 0, cash: 0, card: 0, online: 0, staffOrders: 0, staffDiscount: 0 };
      records.forEach(r => Object.keys(t).forEach(k => { t[k] += r[k]; }));

      return {
        name: 'Sales_Summary',
        records,
        columns: [
          { header: 'Date',             width: 13, type: 'date',  value: r => excelDate(moment(r.date, 'YYYY-MM-DD')), total: () => 'TOTAL' },
          { header: 'Orders',           width: 9,  type: 'int',   value: r => r.orders,          total: () => t.orders },
          { header: 'Items Sold',       width: 11, type: 'int',   value: r => r.qty,             total: () => t.qty },
          { header: 'Gross Sales',      width: 13, type: 'money', value: r => money(r.gross),    total: () => money(t.gross) },
          { header: 'Discounts',        width: 12, type: 'money', value: r => money(r.discounts),total: () => money(t.discounts) },
          { header: 'Delivery Charges', width: 16, type: 'money', value: r => money(r.delivery), total: () => money(t.delivery) },
          { header: 'Net Sales',        width: 13, type: 'money', value: r => money(r.net),      total: () => money(t.net) },
          { header: 'Cash',             width: 12, type: 'money', value: r => money(r.cash),     total: () => money(t.cash) },
          { header: 'Card',             width: 12, type: 'money', value: r => money(r.card),     total: () => money(t.card) },
          { header: 'Online',           width: 12, type: 'money', value: r => money(r.online),   total: () => money(t.online) },
          { header: 'Staff Orders',     width: 13, type: 'int',   value: r => r.staffOrders,     total: () => t.staffOrders },
          { header: 'Staff Discount',   width: 14, type: 'money', value: r => money(r.staffDiscount), total: () => money(t.staffDiscount) },
        ],
      };
    }

    if (reportFormat === 'items') {
      // What is on screen is what is exported: the filtered lines, and the same
      // totals the footer shows (lib/itemSalesView.js), over every line.
      const t = lineSummary;
      const label = lineFiltered ? (activeLineCat === 'Dahi' ? 'Dahi' : 'Milk') : null;
      const qtyValue = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
      const note = (r) => [
        r.category_inferred ? 'Category inferred from name' : '',
        r.category_review ? 'Check name: looks like Milk/Dahi but not classified' : '',
        r.amount_assumed ? 'Amount assumed from name' : '',
      ].filter(Boolean).join('; ');

      // Real amounts, never the raw quantity column, which mixes packs, litres and kilograms.
      const amountColumns = !lineData ? [] : lineFiltered
        ? [{ header: `Amount (${lineUnit})`, width: 12, type: 'money', value: r => qtyValue(r.amount), total: () => qtyValue(t.quantity) }]
        : [
          { header: 'Milk (L)',  width: 10, type: 'money', value: r => (r.category_group === 'Milk' ? qtyValue(r.amount) : 0), total: () => qtyValue(t.milkLitres) },
          { header: 'Dahi (kg)', width: 10, type: 'money', value: r => (r.category_group === 'Dahi' ? qtyValue(r.amount) : 0), total: () => qtyValue(t.dahiKg) },
        ];

      return {
        name: label ? `Item_Sales_${label}` : 'Item_Sales',
        records: lineView,
        columns: [
          { header: 'Order #',        width: 9,  type: 'int',   value: r => r.order_id, total: () => `TOTAL (${t.orders.toLocaleString()} orders)` },
          { header: 'Date',           width: 13, type: 'date',  value: r => excelDate(r.created_at) },
          { header: 'Time',           width: 11, type: 'text',  value: r => moment(r.created_at).format('hh:mm A') },
          { header: 'Cashier',        width: 16, type: 'text',  value: r => r.cashier_name || 'Unknown' },
          { header: 'Order Type',     width: 13, type: 'text',  value: r => r.order_type || 'Dine-in' },
          { header: 'Table/Token',    width: 13, type: 'text',  value: r => r.table_number || '' },
          { header: 'Payment Method', width: 16, type: 'text',  value: r => r.payment_method || '' },
          { header: 'Item',           width: 34, type: 'text',  value: r => r.item_name || '', total: () => `${t.lines.toLocaleString()} items` },
          { header: 'Category',       width: 18, type: 'text',  value: r => r.category || '' },
          ...(lineData ? [{ header: 'Product', width: 10, type: 'text', value: r => r.category_group || '' }] : []),
          // As sold (a pack count for Milk, kilograms or a fraction for a custom line): no total,
          // because it cannot be added up — the amount columns beside it can.
          { header: 'Qty (as sold)',  width: 12, type: 'money', value: r => Number(r.quantity) || 0 },
          ...amountColumns,
          { header: 'Unit Price',     width: 12, type: 'money', value: r => money(r.unit_price) },
          { header: 'Line Total',     width: 13, type: 'money', value: r => money(r.line_total), total: () => money(t.total) },
          ...(lineData ? [{ header: 'Note', width: 40, type: 'text', value: note }] : []),
        ],
      };
    }

    // Detailed: one row per order (or, filtered, one per order holding Milk / Dahi,
    // showing only that part). What is exported is what is on screen.
    const t = { lines: 0, qty: 0, subtotal: 0, discount: 0, delivery: 0, total: 0, employeeDiscount: 0, milk: 0, dahi: 0 };
    detailedView.forEach(r => {
      t.employeeDiscount += Number(r.employee_discount) || 0;
      t.lines += Number(r.line_count) || 0;
      t.qty += Number(r.total_qty) || 0;
      t.subtotal += Number(r.subtotal) || 0;
      t.discount += Number(r.discount) || 0;
      t.delivery += Number(r.delivery_charge) || 0;
      t.total += Number(r.total) || 0;
      t.milk += Number(r.milk_qty) || 0;
      t.dahi += Number(r.dahi_qty) || 0;
    });
    const qtyValue = (n) => Math.round((Number(n) || 0) * 100) / 100;

    if (isFiltered) {
      const label = activeCat === 'Dahi' ? 'Dahi' : 'Milk';
      return {
        name: `Order_Details_${label}`,
        records: detailedView,
        columns: [
          { header: 'Order #',        width: 9,  type: 'int',   value: r => r.id, total: () => 'TOTAL' },
          { header: 'Date',           width: 13, type: 'date',  value: r => excelDate(r.created_at) },
          { header: 'Time',           width: 11, type: 'text',  value: r => moment(r.created_at).format('hh:mm A') },
          { header: 'Cashier',        width: 16, type: 'text',  value: r => r.cashier_name || 'Unknown' },
          { header: 'Order Type',     width: 13, type: 'text',  value: r => r.order_type || 'Dine-in' },
          { header: 'Payment Method', width: 16, type: 'text',  value: r => r.payment_method || '' },
          { header: 'Status',         width: 12, type: 'text',  value: r => r.status || '' },
          { header: `${label} Items`, width: 46, type: 'text',  value: r => r.items || '' },
          { header: 'Mixed Order',    width: 12, type: 'text',  value: r => (r.is_mixed ? 'Yes' : 'No') },
          { header: 'Items',          width: 8,  type: 'int',   value: r => Number(r.line_count) || 0, total: () => t.lines },
          { header: `Qty (${catUnit})`, width: 11, type: 'money', value: r => qtyValue(r.total_qty), total: () => qtyValue(t.qty) },
          { header: 'Amount',         width: 13, type: 'money', value: r => money(r.total), total: () => money(t.total) },
        ],
      };
    }

    return {
      name: 'Order_Details',
      records: detailedView,
      columns: [
        { header: 'Order #',         width: 9,  type: 'int',   value: r => r.id, total: () => 'TOTAL' },
        { header: 'Date',            width: 13, type: 'date',  value: r => excelDate(r.created_at) },
        { header: 'Time',            width: 11, type: 'text',  value: r => moment(r.created_at).format('hh:mm A') },
        { header: 'Cashier',         width: 16, type: 'text',  value: r => r.cashier_name || 'Unknown' },
        { header: 'Order Type',      width: 13, type: 'text',  value: r => r.order_type || 'Dine-in' },
        { header: 'Table/Token',     width: 13, type: 'text',  value: r => r.table_number || '' },
        { header: 'Payment Method',  width: 16, type: 'text',  value: r => r.payment_method || '' },
        { header: 'Status',          width: 12, type: 'text',  value: r => r.status || '' },
        { header: 'Staff Purchase',  width: 14, type: 'text',  value: r => (r.is_employee ? 'Yes' : 'No') },
        { header: 'Staff Discount',  width: 14, type: 'money', value: r => money(r.employee_discount), total: () => money(t.employeeDiscount) },
        { header: 'Items',           width: 52, type: 'text',  value: r => r.items || '' },
        { header: 'Distinct Items',  width: 14, type: 'int',   value: r => Number(r.line_count) || 0, total: () => t.lines },
        // Real amounts, not the raw quantity column, which mixes litres, kilograms and packs.
        { header: 'Milk (L)',        width: 10, type: 'money', value: r => qtyValue(r.milk_qty),      total: () => qtyValue(t.milk) },
        { header: 'Dahi (kg)',       width: 10, type: 'money', value: r => qtyValue(r.dahi_qty),      total: () => qtyValue(t.dahi) },
        { header: 'Subtotal',        width: 12, type: 'money', value: r => money(r.subtotal),         total: () => money(t.subtotal) },
        { header: 'Discount',        width: 12, type: 'money', value: r => money(r.discount),         total: () => money(t.discount) },
        { header: 'Delivery Charge', width: 16, type: 'money', value: r => money(r.delivery_charge),  total: () => money(t.delivery) },
        { header: 'Total',           width: 13, type: 'money', value: r => money(r.total),            total: () => money(t.total) },
      ],
    };
  };

  /** Render one schema cell for CSV, where everything is ultimately text. */
  const csvCell = (col, record) => {
    const v = col.value(record);
    if (v instanceof Date) return moment(v).format('YYYY-MM-DD');
    return v;
  };

  const exportCSV = () => {
    const table = getReportTable();
    const rows = [table.columns.map(c => c.header)];

    table.records.forEach(record => {
      rows.push(table.columns.map(col => csvCell(col, record)));
    });

    // A column with no `total` contributes a blank cell to the totals row.
    rows.push(table.columns.map(col => (col.total ? col.total() : '')));

    const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(table.name, 'csv');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // The previous version never revoked the object URL, leaking the blob for
    // the lifetime of the window.
    window.URL.revokeObjectURL(url);
  };

  /**
   * Excel export.
   *
   * Unlike CSV this carries real column widths, so the date column is readable
   * the moment the file opens rather than rendering as ######, and dates and
   * money are written as genuine Excel types so they sort, filter and SUM
   * without the reader having to convert anything first.
   */
  const exportExcel = async () => {
    const table = getReportTable();

    const headerStyle = {
      value: null, fontWeight: 'bold', backgroundColor: '#F3F4F6',
      align: 'left', borderColor: '#D1D5DB', bottomBorderStyle: 'thin',
    };

    const cellFor = (col, value, bold) => {
      const base = bold ? { fontWeight: 'bold' } : {};
      if (value === null || value === undefined || value === '') {
        return { ...base, value: null, type: String };
      }
      if (value instanceof Date) {
        return { ...base, value, type: Date, format: 'yyyy-mm-dd', align: 'left' };
      }
      if (col.type === 'money') {
        return { ...base, value: Number(value), type: Number, format: '#,##0.00', align: 'right' };
      }
      if (col.type === 'int') {
        // The totals row puts the label "TOTAL" under an integer column.
        if (typeof value === 'string') return { ...base, value, type: String };
        return { ...base, value: Number(value), type: Number, format: '#,##0', align: 'right' };
      }
      return { ...base, value: String(value), type: String };
    };

    const data = [table.columns.map(c => ({ ...headerStyle, value: c.header, type: String }))];

    table.records.forEach(record => {
      data.push(table.columns.map(col => cellFor(col, col.value(record), false)));
    });

    data.push(table.columns.map(col => cellFor(col, col.total ? col.total() : null, true)));

    // write-excel-file v4 returns a writer rather than taking a fileName
    // option; `.toFile()` is what actually triggers the download.
    await writeXlsxFile(data, {
      columns: table.columns.map(c => ({ width: c.width })),
      sheet: 'Report',
      // Keep the header visible when scrolling a long report.
      stickyRowsCount: 1,
    }).toFile(exportFileName(table.name, 'xlsx'));
  };

  // Process Heatmap Data
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hours = Array.from({ length: 15 }, (_, i) => i + 9); // 9AM to 11PM (23:00)
  
  const heatmapGrid = days.map((day, dIdx) => {
    return hours.map(h => {
      const cell = heatmapData.find(hd => Number(hd.day_num) === dIdx && Number(hd.hour) === h);
      return {
        day, hour: h, orders: cell ? cell.orders : 0, revenue: cell ? cell.revenue : 0
      };
    });
  });

  const maxOrders = heatmapData.length > 0 ? Math.max(...heatmapData.map(d => d.orders || 0), 1) : 1;

  const getHeatmapColor = (orders) => {
    if (orders === 0) return '#FFFFFF';
    const intensity = orders / maxOrders;
    if (intensity < 0.2) return '#FCA5A5';
    if (intensity < 0.5) return '#DC2626';
    if (intensity < 0.8) return '#EA580C';
    return '#991B1B';
  };

    return (
    <div className="relative flex-1 flex flex-col h-full bg-[#F7F9FC] overflow-y-auto print:bg-white print:overflow-visible">
      {isLoading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white/70 backdrop-blur-[1px] print:hidden">
          <div className="h-10 w-10 rounded-full border-4 border-[#1B4C82] border-t-transparent animate-spin" />
          <p className="text-sm font-medium text-gray-600">Loading report…</p>
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white/90 print:hidden">
          <p className="text-sm font-medium text-red-600">{loadError}</p>
          <button
            onClick={() => loadData(0)}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: '#1B4C82' }}
          >
            Retry
          </button>
        </div>
      )}
      {/* Top Section - Date Filter Bar */}
      <div className="sticky top-0 z-10 flex items-center bg-white border-b border-gray-200 px-5 print:hidden" style={{ minHeight: 52 }}>
        <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap hide-scrollbar">
          {FILTER_CHIPS.map(chip => (
            <button
              key={chip.value}
              onClick={() => setActiveFilter(chip.value)}
              className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all"
              style={{
                background: activeFilter === chip.value ? '#1B4C82' : '#FFFFFF',
                color: activeFilter === chip.value ? '#FFFFFF' : '#6B7280',
                border: activeFilter === chip.value ? '1px solid #1B4C82' : '1px solid #D1D5DB',
              }}
            >
              {chip.label}
            </button>
          ))}
          {activeFilter === 'custom' && (
            <div className="flex items-center gap-2 ml-2">
              <input 
                type="date" 
                value={customFrom} 
                onChange={e => setCustomFrom(e.target.value)} 
                className="text-xs px-2 py-1.5 border border-gray-300 rounded focus:outline-none focus:border-blue-600"
              />
              <span className="text-gray-400 text-xs">to</span>
              <input 
                type="date" 
                value={customTo} 
                onChange={e => setCustomTo(e.target.value)} 
                className="text-xs px-2 py-1.5 border border-gray-300 rounded focus:outline-none focus:border-blue-600"
              />
              <button 
                onClick={loadData}
                className="px-3 py-1.5 bg-[#1B4C82] text-white text-xs font-bold rounded hover:bg-[#123A66]"
              >
                Apply
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="p-6 space-y-6 max-w-7xl mx-auto w-full print:p-0 print:block">
        
        {/* Section 1 - KPI Cards */}
        <div className="grid grid-cols-4 gap-4 print:hidden">
          <KpiCard title="Total Revenue" value={formatMoney(kpi.revenue)} icon={DollarSign} color="#1B4C82" />
          <KpiCard title="Orders Processed" value={kpi.orders} icon={ShoppingBag} color="#3B82F6" />
          <KpiCard title="Avg. Order Value" value={formatMoney(kpi.avg_order_value)} icon={TrendingUp} color="#10B981" />
          <KpiCard title="Discounts Given" value={formatMoney(kpi.total_discounts)} icon={Tag} color="#1B4C82" subtitle={`across ${detailedReport.filter(d => d.discount > 0).length} orders`} />
          <KpiCard
            title="Credit Collected"
            value={formatMoney(kpi.credit_collected)}
            icon={CreditCard}
            color="#B45309"
            subtitle="Paid back on old credit"
          />
          <KpiCard
            title="Net (After Expenses)"
            value={formatMoney(net.net)}
            icon={Wallet}
            color={net.net < 0 ? '#DC2626' : '#16A34A'}
            subtitle={net.net < 0 ? 'Expenses exceeded revenue' : 'After expenses'}
          />
        </div>

        {/*
          Section 1b - Ingredient usage. One card per ingredient rather than
          hardcoding Milk/Dahi by name, so a third ingredient just shows up
          here on its own. `used` is this date range only; the remaining
          figure underneath is always live stock right now, regardless of
          which range is picked — see backend/routes/reports.js's own note on
          why it reads off inventory_entries instead of recipes.
        */}
        {kpi.ingredient_usage.length > 0 && (
          <div className="grid grid-cols-4 gap-4 print:hidden">
            {kpi.ingredient_usage.map((ing, i) => (
              <KpiCard
                key={ing.id}
                title={`${ing.name} Used`}
                value={`${fmtQty(ing.used)} ${ing.unit}`}
                icon={i % 2 === 0 ? Droplet : Package}
                color="#0EA5E9"
                subtitle={`${fmtQty(ing.current_stock)} ${ing.unit} remaining in stock`}
              />
            ))}
          </div>
        )}

        {/* Section 2 - Revenue Over Time */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm print:hidden">
          <h3 className="text-sm font-bold text-gray-800 mb-4">Revenue Over Time</h3>
          <div style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                <XAxis dataKey="date" tick={{ fontSize: 12, fill: '#6B7280' }} tickMargin={10} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#6B7280' }} axisLine={false} tickLine={false} tickFormatter={val => formatMoney(val)} />
                <RechartsTooltip 
                  contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                  formatter={(value) => [formatMoney(value), 'Revenue']}
                />
                <Line type="monotone" dataKey="revenue" stroke="#DC2626" strokeWidth={3} dot={{ fill: '#FFFFFF', stroke: '#DC2626', strokeWidth: 2, r: 4 }} activeDot={{ r: 6, fill: '#DC2626', stroke: '#FFFFFF' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Section 3 - Top Items & Categories */}
        <div className="flex gap-6 print:hidden">
          <div className="w-3/5 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h3 className="text-sm font-bold text-gray-800 mb-4">Top Selling Items</h3>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topItems} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#E5E7EB" />
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#4B5563' }} width={120} axisLine={false} tickLine={false} />
                  <RechartsTooltip cursor={{ fill: '#F9FAFB' }} contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} />
                  <Bar dataKey="quantity" fill="#DC2626" radius={[0, 4, 4, 0]}>
                    <LabelList dataKey="quantity" position="right" style={{ fontSize: 12, fontWeight: 600, fill: '#111827' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          
          <div className="w-2/5 bg-white rounded-xl border border-gray-200 p-5 shadow-sm flex flex-col">
            <h3 className="text-sm font-bold text-gray-800 mb-4">Sales by Category</h3>
            <div className="flex-1 flex justify-center items-center relative" style={{ minHeight: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={categories} dataKey="revenue" nameKey="category" cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5}>
                    {categories.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip formatter={(value) => formatMoney(value)} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-gray-500 text-xs">Total</span>
                <span className="text-gray-900 font-bold text-sm">{formatMoney(categories.reduce((acc, c) => acc + c.revenue, 0))}</span>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {categories.map((c, idx) => (
                <div key={c.category} className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ background: PIE_COLORS[idx % PIE_COLORS.length] }} />
                    <span className="text-gray-600">{c.category}</span>
                  </div>
                  <div className="font-medium text-gray-900">{c.percentage}% <span className="text-gray-400 font-normal ml-1">({formatMoney(c.revenue)})</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Section 4 - Hourly Heatmap */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm print:hidden">
          <h3 className="text-sm font-bold text-gray-800 mb-4">Busiest Hours of the Day</h3>
          <div className="flex">
            {/* Y Axis - Days */}
            <div className="flex flex-col justify-between mt-6 mr-2">
              {days.map(d => <div key={d} className="text-xs font-medium text-gray-400 h-[36px] flex items-center">{d}</div>)}
            </div>
            {/* Grid */}
            <div className="flex-1">
              <div className="flex mb-2">
                {hours.map(h => <div key={h} className="text-[10px] text-gray-400 w-[36px] text-center flex-1">{h > 12 ? h-12+'p' : h === 12 ? '12p' : h+'a'}</div>)}
              </div>
              <div className="flex flex-col gap-[3px]">
                {heatmapGrid.map((dayRow, i) => (
                  <div key={i} className="flex gap-[3px]">
                    {dayRow.map((cell, j) => (
                      <div 
                        key={j} 
                        className="w-[36px] h-[36px] rounded flex-1 group relative border border-gray-100"
                        style={{ background: getHeatmapColor(cell.orders) }}
                      >
                        {cell.orders > 0 && (
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-max bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-xl">
                            {cell.day} {cell.hour > 12 ? cell.hour-12+'PM' : cell.hour+'AM'} — {cell.orders} orders — {formatMoney(cell.revenue)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Section 5 - Cashier Performance */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm print:hidden">
          <h3 className="text-sm font-bold text-gray-800 mb-4">Performance by Cashier</h3>
          {cashierPerformance.length > 0 ? (
            <div className="space-y-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 text-xs uppercase font-semibold border-b border-gray-200">
                    <th className="pb-3">Cashier</th>
                    <th className="pb-3 text-center">Orders</th>
                    <th className="pb-3 text-right">Revenue</th>
                    <th className="pb-3 text-right">Avg Order</th>
                  </tr>
                </thead>
                <tbody>
                  {cashierPerformance.map((cp, idx) => (
                    <tr key={idx} className="border-b border-gray-100 last:border-0">
                      <td className="py-3 font-medium text-gray-900">{cp.cashier_name || 'Unknown'}</td>
                      <td className="py-3 text-center text-gray-600">{cp.total_orders}</td>
                      <td className="py-3 text-right font-semibold text-gray-900">{formatMoney(cp.total_revenue)}</td>
                      <td className="py-3 text-right text-gray-600">{formatMoney(cp.avg_order_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ height: 200, marginTop: 16 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={cashierPerformance} layout="horizontal" margin={{ left: 100, right: 20, top: 10, bottom: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: '#6B7280' }} tickFormatter={val => formatMoney(val)} />
                    <YAxis type="category" dataKey="cashier_name" tick={{ fontSize: 11, fill: '#4B5563' }} width={90} axisLine={false} tickLine={false} />
                    <RechartsTooltip cursor={{ fill: '#F9FAFB' }} contentStyle={{ borderRadius: 8, border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} formatter={(value) => [formatMoney(value), 'Revenue']} />
                    <Bar dataKey="total_revenue" fill="#DC2626" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-400 text-sm">No cashier data available for this period</div>
          )}
        </div>

        {/* Section 6 - Sales Report Generator */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm pb-10" id="report-generator">
          <div className="flex justify-between items-center mb-6 print:hidden">
            <h3 className="text-sm font-bold text-gray-800">Generate Sales Report</h3>
            <div className="flex items-center gap-4">
              <div className="flex bg-gray-100 p-1 rounded-lg">
                <button 
                  onClick={() => setReportFormat('summary')} 
                  className={`px-4 py-1.5 text-xs font-semibold rounded-md ${reportFormat === 'summary' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
                >
                  Summary
                </button>
                <button
                  onClick={() => setReportFormat('detailed')}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-md ${reportFormat === 'detailed' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
                >
                  Detailed
                </button>
                <button
                  onClick={() => setReportFormat('items')}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-md ${reportFormat === 'items' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
                >
                  Item Sales
                </button>
              </div>
            </div>
          </div>

          {/* Detailed and Item Sales: show everything, or only the Milk / Dahi (yogurt) part of it. */}
          {((reportFormat === 'detailed' && categoryData) || (reportFormat === 'items' && lineData)) && (
            <div className="flex items-center gap-2 mb-4 flex-wrap print:hidden" role="group" aria-label="Filter by product">
              <span className="text-xs font-semibold text-gray-500 mr-1">Show</span>
              {CATEGORY_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setCatFilter(f.key)}
                  aria-pressed={(reportFormat === 'items' ? activeLineCat : activeCat) === f.key}
                  className={`px-4 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                    (reportFormat === 'items' ? activeLineCat : activeCat) === f.key
                      ? 'bg-[#1B4C82] border-[#1B4C82] text-white'
                      : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {reportFormat === 'items' && f.key === 'all' ? 'All items' : f.label}
                </button>
              ))}
            </div>
          )}

          <div id="printable-area" className="w-full">
            <div className="hidden print:block mb-6 text-center">
              <h2 className="text-xl font-bold">Sales Report{reportFormat === 'detailed' && isFiltered ? ` — ${productLabel(activeCat)} only` : ''}{reportFormat === 'items' && lineFiltered ? ` — ${productLabel(activeLineCat)} only` : ''}</h2>
              <p className="text-sm text-gray-500">{from} to {to}</p>
            </div>
            
            {reportFormat === 'summary' ? (
              // Sales and stock movement together — see StockMovementTable's
              // own note on why these are one merged table rather than two.
              <StockMovementTable
                salesByDay={salesByDay}
                stockMovement={stockMovement}
                ingredientNames={kpi.ingredient_usage.map((i) => i.name)}
                formatMoney={formatMoney}
                loading={isLoading}
              />
            ) : (
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 uppercase text-[11px] font-bold border-b border-gray-200">
                  {reportFormat === 'items' ? (
                    <>
                      <th className="py-3 px-4">Order #</th>
                      <th className="py-3 px-4">Time</th>
                      <th className="py-3 px-4">Item</th>
                      <th className="py-3 px-4">Category</th>
                      <th className="py-3 px-4 text-center">Qty</th>
                      <th className="py-3 px-4 text-right">Unit Price</th>
                      <th className="py-3 px-4 text-right text-orange-600">Line Total</th>
                    </>
                  ) : (
                    <>
                      <th className="py-3 px-4">Order #</th>
                      <th className="py-3 px-4">Time</th>
                      <th className="py-3 px-4">Items</th>
                      <th className="py-3 px-4 text-center">Payment</th>
                      <th className="py-3 px-4 text-center">Staff</th>
                      {isFiltered ? (
                        <>
                          <th className="py-3 px-4 text-right">Qty ({catUnit})</th>
                          <th className="py-3 px-4 text-right text-orange-600">Amount</th>
                        </>
                      ) : (
                        <>
                          <th className="py-3 px-4 text-right">Subtotal</th>
                          <th className="py-3 px-4 text-right">Discount</th>
                          <th className="py-3 px-4 text-right text-orange-600">Total</th>
                        </>
                      )}
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {reportFormat === 'items' ? (
                  // Item Sales view — one row per item sold.
                  lineView.slice(0, TABLE_ROW_CAP).map((row, i) => (
                    <tr key={`${row.order_key ?? row.order_id}-${i}`} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                      <td className="py-3 px-4 font-medium text-gray-900">#{row.order_id}</td>
                      <td className="py-3 px-4 text-gray-500 text-xs">{moment(row.created_at).format('MMM D, hh:mm A')}</td>
                      <td className="py-3 px-4 text-gray-700 text-xs">
                        {row.item_name}
                        {row.category_inferred && (
                          <span
                            className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-100 text-sky-700 align-middle"
                            title={`This line has no menu category (the item was removed from the menu). It is counted as ${row.category_group} because its name matches one this app writes.`}
                          >
                            INFERRED
                          </span>
                        )}
                        {row.category_review && (
                          <span
                            className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-700 align-middle"
                            title="The name looks like Milk or Dahi, but the item has no menu category and the name is not one this app writes, so it is counted under Other. Check it."
                          >
                            CHECK NAME
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-500 text-xs">{row.category}</td>
                      <td className="py-3 px-4 text-center text-gray-600">
                        {row.quantity}
                        {lineData && row.category_group !== 'Other' && (
                          // The real amount: "2 Litre" x 3 is quantity 3 but 6 litres.
                          <div
                            className="text-[10px] text-gray-400"
                            title={row.amount_assumed ? 'The item name gives no size, so 1 litre / 1 kg per unit is assumed.' : undefined}
                          >
                            = {fmtAmountQty(row.amount)} {row.category_group === 'Milk' ? 'L' : 'kg'}{row.amount_assumed ? ' ~' : ''}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right text-gray-600">{formatMoney(row.unit_price)}</td>
                      <td className="py-3 px-4 text-right font-bold text-gray-900">{formatMoney(row.line_total)}</td>
                    </tr>
                  ))
                ) : (
                  // Detailed view
                  detailedView.slice(0, TABLE_ROW_CAP).map((row, i) => (
                    <tr key={row.row_key ?? `${row.branch_name || ''}-${row.id}`} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                      <td className="py-3 px-4 font-medium text-gray-900">
                        #{row.id}
                        {isFiltered && row.is_mixed && (
                          <span
                            className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 text-violet-700 align-middle"
                            title={`This order also has ${row.other_category === 'Dahi' ? 'Dahi / Yogurt' : row.other_category}. Only the ${activeCat === 'Dahi' ? 'Dahi' : 'Milk'} part is shown and counted here. Whole order: ${formatMoney(row.order_total)}`}
                          >
                            MIXED
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-500 text-xs">{moment(row.created_at).format('MMM D, hh:mm A')}</td>
                      <td className="py-3 px-4 text-gray-600 text-xs truncate max-w-[200px]" title={row.items}>{row.items}</td>
                      <td className="py-3 px-4 text-center">
                        <span className={`px-2 py-1 rounded text-[10px] font-bold ${row.payment_method === 'Cash' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                          {row.payment_method}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        {row.is_employee ? (
                          <span
                            className="px-2 py-1 rounded text-[10px] font-bold bg-amber-100 text-amber-700"
                            title={`Staff purchase — ${formatMoney(row.employee_discount || 0)} off`}
                          >
                            STAFF
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      {isFiltered ? (
                        <>
                          <td className="py-3 px-4 text-right text-gray-600">{fmtAmountQty(row.total_qty)} {catUnit}</td>
                          <td className="py-3 px-4 text-right font-bold text-gray-900">{formatMoney(row.total || 0)}</td>
                        </>
                      ) : (
                        <>
                          <td className="py-3 px-4 text-right text-gray-600">{formatMoney(row.subtotal || 0)}</td>
                          <td className="py-3 px-4 text-right text-red-500">{row.discount > 0 ? `-${formatMoney(row.discount)}` : '—'}</td>
                          <td className="py-3 px-4 text-right font-bold text-gray-900">{formatMoney(row.total || 0)}</td>
                        </>
                      )}
                    </tr>
                  ))
                )}
                {(reportFormat === 'items' ? lineView.length : detailedView.length) === 0 && (
                  <tr>
                    <td colSpan={reportFormat === 'items' || isFiltered ? 7 : 8} className="py-8 text-center text-gray-400">
                      {reportFormat === 'items'
                        ? (lineFiltered
                          ? `No ${productLabel(activeLineCat)} items found for this date range.`
                          : 'No items found for this date range.')
                        : isFiltered
                          ? `No ${productLabel(activeCat)} orders found for this date range.`
                          : 'No orders found for this date range.'}
                    </td>
                  </tr>
                )}
              </tbody>
              {reportFormat === 'items' && lineView.length > 0 && (
                // Summed over ALL the lines in the range, not just the rows drawn: the table is
                // capped for speed, totals must not be. "Items" = order lines (the Detailed
                // footer's convention); quantity is the real amount, never the raw column.
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 align-top">
                    <td className="py-3 px-4 text-xs text-gray-700">
                      <div className="font-bold uppercase tracking-wide text-gray-600">
                        Total{lineFiltered ? ` - ${productLabel(activeLineCat)}` : ''}
                      </div>
                      <div title="Distinct orders holding these items">{lineSummary.orders.toLocaleString()} orders</div>
                    </td>
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4 text-xs text-gray-700" title="Item lines: one per item entered on an order">
                      {lineSummary.lines.toLocaleString()} items
                    </td>
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4 text-center text-xs text-gray-700 whitespace-nowrap">
                      {lineData && (lineFiltered ? (
                        <span className="font-semibold">{fmtAmountQty(lineSummary.quantity)} {lineUnit}</span>
                      ) : (
                        // Litres and kilograms cannot be added to each other, so they sit side by side.
                        <>
                          <div>Milk {fmtAmountQty(lineSummary.milkLitres)} L</div>
                          <div>Dahi {fmtAmountQty(lineSummary.dahiKg)} kg</div>
                          {lineSummary.otherLines > 0 && <div>Other {lineSummary.otherLines.toLocaleString()} items</div>}
                        </>
                      ))}
                    </td>
                    <td className="py-3 px-4" />
                    <td className="py-3 px-4 text-right font-bold text-gray-900 whitespace-nowrap">
                      {formatMoney(lineSummary.total)}
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td colSpan={7} className="pb-3 px-4 text-[11px] text-gray-500">
                      <span>Item total, before discounts, delivery and tax (those belong to a whole order and are not split by product).</span>
                      {lineData && (
                        <span>
                          {' '}Milk {formatMoney(lineSummary.milkValue)} + Dahi {formatMoney(lineSummary.dahiValue)}
                          {' '}+ Other {formatMoney(lineSummary.otherValue)} = {formatMoney(lineSummary.allValue)}.
                        </span>
                      )}
                      {lineSummary.inferredLines > 0 && (
                        <span> {lineSummary.inferredLines} line{lineSummary.inferredLines === 1 ? '' : 's'} counted by name (item removed from the menu).</span>
                      )}
                      {lineSummary.reviewLines > 0 && (
                        <span className="text-amber-600"> {lineSummary.reviewLines} line{lineSummary.reviewLines === 1 ? '' : 's'} look like Milk or Dahi but could not be classified and are counted under Other — see CHECK NAME.</span>
                      )}
                      {lineSummary.assumedLines > 0 && (
                        <span> {lineSummary.assumedLines} amount{lineSummary.assumedLines === 1 ? '' : 's'} assumed from a name with no size (~).</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              )}
              {reportFormat === 'detailed' && detailedView.length > 0 && (
                // Every figure here is summed over ALL orders in the range, not just
                // the rows drawn above: the table is capped for speed, totals must not be.
                // "Items" = order lines, i.e. one per item entered on an order. Quantities
                // are real amounts (Milk in litres, Dahi in kg), never the raw column.
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300">
                    <td colSpan={isFiltered ? 6 : 7} className="py-3 px-4 text-xs text-gray-700">
                      <span className="font-bold uppercase tracking-wide text-gray-600 mr-3">
                        Total{isFiltered ? ` - ${activeCat === 'Dahi' ? 'Dahi / Yogurt' : 'Milk'}` : ''}
                      </span>
                      <span title="Orders in this list">{detailedSummary.orders.toLocaleString()} orders</span>
                      <span className="mx-2 text-gray-300">|</span>
                      <span title="Item lines: one per item entered on an order">{detailedSummary.items.toLocaleString()} items</span>
                      <span className="mx-2 text-gray-300">|</span>
                      {isFiltered ? (
                        <span>{fmtAmountQty(detailedSummary.quantity)} {catUnit}</span>
                      ) : (
                        <span>Milk {fmtAmountQty(overall.milkLitres)} L, Dahi {fmtAmountQty(overall.dahiKg)} kg</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-gray-900 whitespace-nowrap">
                      {formatMoney(detailedSummary.total)}
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td colSpan={isFiltered ? 7 : 8} className="pb-3 px-4 text-[11px] text-gray-500">
                      {isFiltered && detailedSummary.mixedOrders > 0 && (
                        <span>
                          {detailedSummary.mixedOrders} of these orders also contain {activeCat === 'Milk' ? 'Dahi / Yogurt' : 'Milk'};
                          only the {activeCat === 'Dahi' ? 'Dahi' : 'Milk'} part of each is counted.{' '}
                        </span>
                      )}
                      <span>
                        Milk {formatMoney(overall.milkValue)} + Dahi {formatMoney(overall.dahiValue)}
                        {overall.otherValue > 0 ? ` + Other ${formatMoney(overall.otherValue)}` : ''} = {formatMoney(overall.itemsValue)}
                        {isFiltered ? ' of items' : ''}
                        {!isFiltered && overall.discounts > 0 ? `, less discounts ${formatMoney(overall.discounts)}` : ''}
                        {!isFiltered && overall.delivery > 0 ? `, plus delivery ${formatMoney(overall.delivery)}` : ''}
                        {!isFiltered && overall.tax > 0 ? `, plus tax ${formatMoney(overall.tax)}` : ''}
                        {!isFiltered && (overall.discounts > 0 || overall.delivery > 0 || overall.tax > 0) ? ` = ${formatMoney(detailedSummary.total)}` : ''}.
                      </span>
                      {isFiltered && (overall.discounts > 0 || overall.delivery > 0 || overall.tax > 0) && (
                        <span> Discounts, delivery and tax belong to a whole order, so they are not split by product.</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
            )}
            {reportFormat !== 'summary' && (reportFormat === 'items' ? lineView.length : detailedView.length) > TABLE_ROW_CAP && (
              <p className="text-center text-xs text-gray-400 py-3 print:hidden">
                Showing the first {TABLE_ROW_CAP.toLocaleString()} of{' '}
                {(reportFormat === 'items' ? lineView.length : detailedView.length).toLocaleString()} rows.
                Use Export below for the complete list.
              </p>
            )}
          </div>

          {/*
            Taking the figures out of the building — printed or downloaded — is
            an administrator action. A manager reads the day's numbers on
            screen. Print sits behind the same gate as the exports because a
            printout leaves the shop just as easily as a spreadsheet.
          */}
          {isAdmin ? (
            <div className="flex gap-4 mt-6 print:hidden">
              <button
                onClick={printReport}
                className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-bold hover:bg-gray-800 transition-colors"
              >
                <Printer size={16} /> Print Report
              </button>
              <button
                onClick={exportExcel}
                className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-bold hover:bg-gray-800 transition-colors"
              >
                <FileSpreadsheet size={16} /> Export Excel
              </button>
              <button
                onClick={exportCSV}
                className="flex items-center gap-2 px-6 py-2.5 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm font-bold hover:bg-gray-50 transition-colors"
              >
                <Download size={16} /> Export CSV
              </button>
            </div>
          ) : (
            <div className="mt-6 text-xs text-gray-400 print:hidden">
              Exporting and printing reports is restricted to an administrator.
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function KpiCard({ title, value, icon: Icon, color, subtitle }) {
  return (
    <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex items-center gap-4">
      <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${color}15` }}>
        <Icon size={24} color={color} />
      </div>
      <div>
        <div className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">{title}</div>
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        {subtitle && <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>}
      </div>
    </div>
  );
}