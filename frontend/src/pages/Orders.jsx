// @ts-nocheck
import { useState, useEffect, useMemo } from 'react';
import { Search, Eye, Printer, Ban, ClipboardX, X } from 'lucide-react';
import moment from 'moment';
import PageHeader from '@/components/pos-ui/PageHeader';
import DataTable from '@/components/pos-ui/DataTable';
import StatusPill from '@/components/pos-ui/StatusPill';
import Toast from '@/components/pos-ui/Toast';
import Modal from '@/components/pos-ui/Modal';
import ReceiptModal from '@/components/pos/ReceiptModal';
import { ordersAPI, settingsAPI } from '@/api/index';
import { useSettings } from '@/lib/SettingsContext';

const DATE_CHIPS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 Days' },
  { id: 'custom', label: 'Custom' },
];

const CARD_STYLE = {
  background: '#FFFFFF',
  border: '1px solid #E5E7EB',
  borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
};

/**
 * Currency comes from settings rather than a hardcoded "Rs.". This is a plain
 * module function, so the symbol is passed in by the component that has the
 * settings hook.
 */
function makeFormatCurrency(formatMoney) {
  return (amount) => formatMoney(amount);
}

function getDateRange(dateRange, customFrom, customTo) {
  const today = moment().format('YYYY-MM-DD');
  if (dateRange === 'today') return { from: today, to: today };
  if (dateRange === 'yesterday') {
    const y = moment().subtract(1, 'day').format('YYYY-MM-DD');
    return { from: y, to: y };
  }
  if (dateRange === 'last7') return { from: moment().subtract(6, 'day').format('YYYY-MM-DD'), to: today };
  if (dateRange === 'custom' && customFrom) return { from: customFrom, to: customTo || today };
  return {};
}

export default function Orders() {
  const { formatMoney } = useSettings();
  const formatCurrency = makeFormatCurrency(formatMoney);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [voidModal, setVoidModal] = useState(false);
  const [toast, setToast] = useState(null);
  const [filters, setFilters] = useState({ dateRange: 'today', search: '', status: 'all', payment: 'all' });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [receiptData, setReceiptData] = useState(null);
  const [restaurantDetails, setRestaurantDetails] = useState(null);

  useEffect(() => {
    settingsAPI.getAll().then((data) => {
      setRestaurantDetails({
        name: data.restaurant_name || '',
        tagline: data.restaurant_tagline || '',
        address: data.restaurant_address || '',
        phone: data.restaurant_phone || '',
        footerMessage: data.receipt_footer || 'Thank you for your purchase!',
      });
    }).catch(() => {});
  }, []);

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const { from, to } = getDateRange(filters.dateRange, customFrom, customTo);
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      if (filters.status !== 'all') params.status = filters.status;
      if (filters.payment !== 'all') params.payment_method = filters.payment;
      const data = await ordersAPI.getAll(params);
      setOrders(data);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchOrders(); }, [filters.dateRange, filters.status, filters.payment, customFrom, customTo]);

  const filteredOrders = useMemo(() => {
    if (!filters.search) return orders;
    const q = filters.search.toLowerCase();
    return orders.filter((o) =>
      String(o.id).includes(q) ||
      o.cashier_name?.toLowerCase().includes(q) ||
      o.items?.some((i) => i.name.toLowerCase().includes(q))
    );
  }, [orders, filters.search]);

  const summary = useMemo(() => {
    const totalRevenue = filteredOrders.reduce((s, o) => s + (o.status === 'voided' ? 0 : o.total), 0);
    const held = filteredOrders.filter((o) => o.status === 'held').length;
    const voided = filteredOrders.filter((o) => o.status === 'voided').length;
    return { count: filteredOrders.length, revenue: totalRevenue, held, voided };
  }, [filteredOrders]);

  const openDrawer = (order) => {
    setSelectedOrder(order);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => setSelectedOrder(null), 300);
  };

  const handleVoid = async () => {
    if (!selectedOrder) return;
    try {
      await ordersAPI.void(selectedOrder.id);
      setOrders((prev) => prev.map((o) => o.id === selectedOrder.id ? { ...o, status: 'voided', total: 0 } : o));
      setSelectedOrder((prev) => ({ ...prev, status: 'voided', total: 0 }));
      setVoidModal(false);
      setToast({ message: 'Order voided', type: 'success' });
    } catch {
      setToast({ message: 'Failed to void order', type: 'error' });
    }
  };

  const renderItems = (items) => {
    if (!items?.length) return '—';
    const names = items.slice(0, 2).map((i) => i.name).join(', ');
    const more = items.length > 2 ? ` + ${items.length - 2} more` : '';
    return (
      <span>
        {names}
        {more && <span style={{ color: '#9CA3AF' }}>{more}</span>}
      </span>
    );
  };

  const columns = [
    {
      key: 'id',
      label: 'Order #',
      render: (row) => (
        <button
          onClick={() => openDrawer(row)}
          style={{ background: 'none', border: 'none', color: '#DC2626', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
        >
          #{String(row.id).padStart(4, '0')}
        </button>
      ),
    },
    {
      key: 'time',
      label: 'Time',
      render: (row) => (
        <span style={{ color: '#374151' }}>{moment(row.created_at).format('h:mm A')}</span>
      ),
    },
    {
      key: 'items',
      label: 'Items',
      render: (row) => <span style={{ fontSize: 13 }}>{renderItems(row.items)}</span>,
    },
    {
      key: 'payment',
      label: 'Payment',
      render: (row) => <StatusPill status={row.payment_method || 'Cash'} />,
    },
    {
      key: 'cashier_name',
      label: 'Cashier',
      render: (row) => <span style={{ fontSize: 13, color: '#374151' }}>{row.cashier_name || 'Unknown'}</span>,
    },
    {
      key: 'is_employee',
      label: 'Staff',
      // Marks a staff purchase in the order list so a discounted total is
      // explainable at a glance rather than looking like a mis-ring.
      render: (row) => (row.is_employee ? (
        <span
          title={`Staff purchase — ${formatCurrency(row.employee_discount || 0)} off`}
          style={{
            padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
            background: '#FEF3C7', color: '#B45309',
          }}
        >
          STAFF
        </span>
      ) : <span style={{ color: '#D1D5DB' }}>—</span>),
    },
    {
      key: 'total',
      label: 'Total',
      render: (row) => <span style={{ fontWeight: 700 }}>{formatCurrency(row.total)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => <StatusPill status={row.status} />,
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (row) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => openDrawer(row)}
            style={{
              width: 32, height: 32, border: '1px solid #E5E7EB', borderRadius: 6,
              background: '#FFFFFF', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Eye size={16} color="#6B7280" />
          </button>
          <button
            onClick={() => openDrawer(row)}
            style={{
              width: 32, height: 32, border: '1px solid #E5E7EB', borderRadius: 6,
              background: '#FFFFFF', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Printer size={16} color="#6B7280" />
          </button>
        </div>
      ),
    },
  ];

  const subtotal = selectedOrder?.items?.reduce((s, i) => s + i.price * i.quantity, 0) || 0;

  const buildReceiptData = (order) => {
    const itemsSubtotal = order.items?.reduce((s, i) => s + i.price * i.quantity, 0) || 0;
    const deliveryCharge = Number(order.delivery_charge) || 0;
    return {
      orderInfo: {
        date: moment(order.created_at).format('DD/MM/YYYY'),
        time: moment(order.created_at).format('hh:mm A'),
        orderNumber: `#${order.id}`,
        // FIX (Bug 6): reprints now show the table the order was placed on.
        table: order.table_number || '—',
        paymentMethod: order.payment_method || 'Cash',
        cashier: order.cashier_name || 'Unknown',
        orderType: order.order_type || 'Dine-in',
      },
      items: (order.items || []).map((i) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price,
      })),
      subtotal: itemsSubtotal,
      discount: Math.max(0, (Number(order.discount) || 0) - (Number(order.employee_discount) || 0)),
      // The rate stored on the order, not the current setting: a reprint must
      // show the tax the customer was actually charged, even after the shop
      // changes its rate.
      taxRate: Number(order.tax_rate) || 0,
      taxAmount: Number(order.tax_amount) || 0,
      // `discount` on the order is the combined figure, so the manual portion
      // is whatever is left once the staff discount is taken out.
      employeeDiscount: Number(order.employee_discount) || 0,
      // A reprint of a delivery has to carry the address, or the rider gets a
      // ticket that does not say where to go.
      customer: {
        name: order.customer_name || '',
        phone: order.customer_phone || '',
        address: order.customer_address || '',
      },
      isEmployee: Number(order.is_employee) === 1,
      employeeDiscountRate: Number(order.employee_discount_rate) || 0,
      deliveryCharge,
      total: Number(order.total) || 0,
      restaurant: restaurantDetails,
    };
  };

  const handleReprint = (order) => {
    if (!restaurantDetails) return;
    setReceiptData(buildReceiptData(order));
  };

  return (
    <div style={{ flex: 1, height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#F7F9FC', fontFamily: "'Inter', sans-serif" }}>
      <div style={{ padding: 24, flex: 1, overflow: 'auto' }}>
        <PageHeader title="Orders" subtitle="View and manage past orders" />

        <div style={{ ...CARD_STYLE, height: 56, display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {DATE_CHIPS.map((chip) => (
              <button
                key={chip.id}
                onClick={() => setFilters({ ...filters, dateRange: chip.id })}
                style={{
                  padding: '6px 14px', borderRadius: 9999, fontSize: 13, fontWeight: 500, cursor: 'pointer',
                  background: filters.dateRange === chip.id ? '#1B4C82' : '#FFFFFF',
                  color: filters.dateRange === chip.id ? '#FFFFFF' : '#6B7280',
                  border: filters.dateRange === chip.id ? 'none' : '1px solid #E5E7EB',
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {filters.dateRange === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 13, color: '#6B7280' }}>From</label>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={{ height: 36, border: '1px solid #E5E7EB', borderRadius: 8, padding: '0 8px', fontSize: 13 }} />
              <label style={{ fontSize: 13, color: '#6B7280' }}>To</label>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={{ height: 36, border: '1px solid #E5E7EB', borderRadius: 8, padding: '0 8px', fontSize: 13 }} />
            </div>
          )}

          <div style={{ marginLeft: 'auto', position: 'relative', width: 220 }}>
            <Search size={16} color="#9CA3AF" style={{ position: 'absolute', left: 10, top: 10 }} />
            <input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="Search orders..."
              style={{ width: '100%', height: 36, border: '1px solid #E5E7EB', borderRadius: 8, padding: '0 12px 0 34px', fontSize: 14 }}
            />
          </div>

          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            style={{ width: 140, height: 36, border: '1px solid #E5E7EB', borderRadius: 8, padding: '0 8px', fontSize: 13 }}
          >
            <option value="all">All Status</option>
            <option value="completed">Completed</option>
            <option value="held">Held</option>
            <option value="voided">Voided</option>
          </select>

          <select
            value={filters.payment}
            onChange={(e) => setFilters({ ...filters, payment: e.target.value })}
            style={{ width: 130, height: 36, border: '1px solid #E5E7EB', borderRadius: 8, padding: '0 8px', fontSize: 13 }}
          >
            <option value="all">All</option>
            <option value="Cash">Cash</option>
            <option value="Card">Card</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 20, fontSize: 13, color: '#6B7280', marginBottom: 16 }}>
          <span><strong style={{ color: '#111827' }}>{summary.count}</strong> orders</span>
          <span>·</span>
          <span><strong style={{ color: '#111827' }}>{formatCurrency(summary.revenue)}</strong> total revenue</span>
          <span>·</span>
          <span><strong style={{ color: '#111827' }}>{summary.held}</strong> held</span>
          <span>·</span>
          <span><strong style={{ color: '#111827' }}>{summary.voided}</strong> voided</span>
        </div>

        <div style={{ ...CARD_STYLE, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 48, textAlign: 'center', color: '#6B7280' }}>Loading orders...</div>
          ) : (
            <DataTable
              columns={columns}
              data={filteredOrders}
              emptyIcon={ClipboardX}
              emptyTitle="No orders found"
              emptySubtitle="Try adjusting your filters"
            />
          )}
        </div>
      </div>

      {drawerOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={closeDrawer}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.2)' }} />
        </div>
      )}

      <div
        style={{
          position: 'fixed', top: 0, right: 0, width: 400, height: '100vh',
          background: '#FFFFFF', boxShadow: '-4px 0 24px rgba(0,0,0,0.1)', zIndex: 40,
          transform: drawerOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 300ms ease',
          display: 'flex', flexDirection: 'column', fontFamily: "'Inter', sans-serif",
        }}
      >
        {selectedOrder && (
          <>
            <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', borderBottom: '1px solid #E5E7EB' }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>Order #{String(selectedOrder.id).padStart(4, '0')}</span>
              <button onClick={closeDrawer} style={{ width: 32, height: 32, border: '1px solid #E5E7EB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={16} color="#6B7280" />
              </button>
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                {[
                  { label: 'DATE & TIME', value: moment(selectedOrder.created_at).format('MMM D, YYYY h:mm A') },
                  { label: 'CASHIER', value: selectedOrder.cashier_name || '—' },
                  { label: 'PAYMENT', value: selectedOrder.payment_method || 'Cash' },
                  { label: 'ORDER TYPE', value: selectedOrder.order_type || 'Dine-in' },
                ].map((cell) => (
                  <div key={cell.label}>
                    <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase' }}>{cell.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginTop: 4 }}>{cell.value}</div>
                  </div>
                ))}
                <div>
                  <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase' }}>STATUS</div>
                  <div style={{ marginTop: 4 }}><StatusPill status={selectedOrder.status} /></div>
                </div>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid #E5E7EB', margin: '0 0 20px' }} />

              <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 12 }}>Order Items</div>
              {selectedOrder.items?.map((item) => (
                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 14, color: '#111827' }}>{item.name}</div>
                    <div style={{ fontSize: 12, color: '#6B7280' }}>x{item.quantity}</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{formatCurrency(item.price * item.quantity)}</div>
                </div>
              ))}

              <hr style={{ border: 'none', borderTop: '1px solid #E5E7EB', margin: '20px 0' }} />

              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>Subtotal</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{formatCurrency(subtotal)}</span>
              </div>
              {selectedOrder.discount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#EF4444' }}>Discount</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#EF4444' }}>-{formatCurrency(selectedOrder.discount)}</span>
                </div>
              )}
              {Number(selectedOrder.delivery_charge) > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#6B7280' }}>Delivery Charge</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{formatCurrency(selectedOrder.delivery_charge)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>TOTAL</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: '#DC2626' }}>{formatCurrency(selectedOrder.total)}</span>
              </div>
            </div>

            <div style={{ height: 80, flexShrink: 0, padding: '16px 20px', borderTop: '1px solid #E5E7EB', display: 'flex', gap: 10 }}>
              <button
                onClick={() => handleReprint(selectedOrder)}
                className="flex items-center justify-center gap-2"
                style={{
                  flex: 1, background: '#FFFFFF', border: '1px solid #E5E7EB', color: '#374151',
                  height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}
              >
                <Printer size={16} /> Reprint Receipt
              </button>
              {selectedOrder.status !== 'voided' && (
                <button
                  onClick={() => setVoidModal(true)}
                  className="flex items-center justify-center gap-2"
                  style={{
                    flex: 1, background: '#FFFFFF', border: '1px solid #EF4444', color: '#EF4444',
                    height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer',
                  }}
                >
                  <Ban size={16} /> Void Order
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <Modal isOpen={voidModal} onClose={() => setVoidModal(false)} title="Void Order">
        <p style={{ fontSize: 14, color: '#6B7280', marginBottom: 16 }}>
          Are you sure you want to void Order #{String(selectedOrder?.id || '').padStart(4, '0')}? This cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setVoidModal(false)} style={{ flex: 1, height: 40, borderRadius: 8, border: '1px solid #E5E7EB', background: '#FFFFFF', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
          <button onClick={handleVoid} style={{ flex: 1, height: 40, borderRadius: 8, border: 'none', background: '#EF4444', color: '#FFFFFF', cursor: 'pointer', fontWeight: 600 }}>Void Order</button>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <ReceiptModal
        open={!!receiptData}
        onClose={() => setReceiptData(null)}
        orderData={receiptData}
        // A reprint is a deliberate act; firing the printer automatically the
        // moment the modal opens would be a surprise, so auto-print is a
        // new-sale behaviour only.
        autoPrintEnabled={false}
      />
    </div>
  );
}
