import { useState } from 'react';
import TopBar from '@/components/pos/TopBar';
import MenuPanel from '@/components/pos/MenuPanel';
import OrderCart from '@/components/pos/OrderCart';
import ReceiptModal from '@/components/pos/ReceiptModal';
import CustomerPickerModal from '@/components/pos/CustomerPickerModal';
import Modal from '@/components/pos-ui/Modal';
import NoShiftOverlay from '@/components/pos-ui/NoShiftOverlay';
import useDialogs from '@/lib/useDialogs';
import { ordersAPI } from '@/api/index';
import { Loader2, CreditCard } from 'lucide-react';
import { usePOS } from '@/lib/POSContext';
import { useAuth } from '@/context/AuthContext';
import moment from 'moment';
import { type PaymentMethod } from '@/lib/constants';
import { useSettings } from '@/lib/SettingsContext';

interface CartItem {
  id: number;
  name: string;
  price: number;
  qty: number;
  isDeal?: boolean;
  variant_id?: number | null;
}

interface RestaurantDetails {
  name: string;
  tagline: string;
  address: string;
  phone: string;
  footerMessage: string;
}

interface ReceiptData {
  orderInfo: {
    date: string;
    time: string;
    orderNumber: string;
    table: string;
    paymentMethod: string;
    cashier: string;
    orderType: string;
  };
  items: { name: string; quantity: number; price: number }[];
  subtotal: number;
  discount: number;
  employeeDiscount: number;
  employeeDiscountRate: number;
  isEmployee: boolean;
  taxRate: number;
  taxAmount: number;
  deliveryCharge: number;
  total: number;
  restaurant: RestaurantDetails;
  customer?: { name: string; phone: string; address: string };
}

interface SaleScreenProps {
  onNavigate?: (page: string) => void;
}

export default function SaleScreen({ onNavigate }: SaleScreenProps = {}) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState('');
  const [orderType, setOrderType] = useState<'Walk-in' | 'Delivery'>('Walk-in');

  const [discountValue, setDiscountValue] = useState('');
  const [discountType, setDiscountType] = useState<'flat' | 'percent'>('flat');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [tableNumber, setTableNumber] = useState('');
  const [isEmployee, setIsEmployee] = useState(false);
  const [creditCustomer, setCreditCustomer] = useState<{ id: number; name: string; phone?: string; address?: string; balance?: number } | null>(null);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);

  const [deliveryModalOpen, setDeliveryModalOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [noShiftPrompt, setNoShiftPrompt] = useState(false);
  const { loading } = usePOS();
  const { currentUser } = useAuth();
  const { alertCard, dialog } = useDialogs();

  const { restaurant: restaurantDetails, deliveryPrice, taxRate, employeeDiscountRate, formatMoney, refresh: refreshSettings } = useSettings();

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const deliveryCharge = orderType === 'Delivery' ? deliveryPrice : 0;

  const rawDiscount = discountType === 'percent'
    ? (subtotal * (Number(discountValue) || 0)) / 100
    : (Number(discountValue) || 0);
  const discount = Math.min(Math.max(0, Math.round(rawDiscount)), subtotal);

  const employeeDiscount = isEmployee ? Math.round(subtotal * employeeDiscountRate) / 100 : 0;
  const totalDiscount = Math.min(discount + employeeDiscount, subtotal);

  const taxable = Math.max(0, subtotal - totalDiscount);
  const taxAmount = Math.round(taxable * taxRate) / 100;
  const total = taxable + taxAmount + deliveryCharge;

  const handleAddToCart = (item: { id: number; name: string; price: number; isDeal?: boolean; variant_id?: number | null; qty?: number }) => {
    const addQty = item.qty && item.qty > 0 ? item.qty : 1;
    setCart((prev: CartItem[]) => {
      const existing = prev.find((c: CartItem) => c.id === item.id && c.name === item.name);
      if (existing) {
        return prev.map((c: CartItem) =>
          (c.id === item.id && c.name === item.name) ? { ...c, qty: c.qty + addQty } : c
        );
      }
      return [...prev, { id: item.id, name: item.name, price: item.price, qty: addQty, isDeal: item.isDeal, variant_id: item.variant_id }];
    });
  };

  const handleUpdateQty = (id: number, name: string, delta: number) => {
    setCart((prev: CartItem[]) =>
      prev
        .map((c: CartItem) => (c.id === id && c.name === name ? { ...c, qty: c.qty + delta } : c))
        .filter((c: CartItem) => c.qty > 0)
    );
  };

  const handleRemoveItem = (id: number, name: string) => {
    setCart((prev: CartItem[]) => prev.filter((c: CartItem) => !(c.id === id && c.name === name)));
  };

  const resetOrder = () => {
    setCart([]);
    setOrderType('Walk-in');
    setDiscountValue('');
    setDiscountType('flat');
    setPaymentMethod('Cash');
    setTableNumber('');
    setIsEmployee(false);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerAddress('');
    setCreditCustomer(null);
  };

  const handleClearCart = () => resetOrder();

  const handleOrderTypeChange = (type: 'Walk-in' | 'Delivery') => {
    setOrderType(type);
    if (type === 'Delivery') refreshSettings();
  };

  const handleCharge = () => setConfirmModalOpen(true);

  const confirmCharge = () => {
    setConfirmModalOpen(false);
    if (orderType === 'Delivery') {
      setDeliveryModalOpen(true);
      return;
    }
    placeOrder();
  };

  const placeOrder = async (customer?: { name: string; phone: string; address: string }) => {
    setDeliveryModalOpen(false);
    try {
      const items = cart.map((c: CartItem) => ({
        id: c.id,
        name: c.name,
        price: c.price,
        quantity: c.qty,
        is_deal: c.isDeal || false,
        variant_id: c.variant_id || null,
      }));

      const order = await ordersAPI.create({
        items,
        total,
        discount,
        payment_method: paymentMethod,
        customer_id: paymentMethod === 'Credit' ? creditCustomer?.id : null,
        order_type: orderType,
        delivery_charge: deliveryCharge,
        table_number: tableNumber || null,
        is_employee: isEmployee,
        customer_name: customer?.name || creditCustomer?.name || null,
        customer_phone: customer?.phone || creditCustomer?.phone || null,
        customer_address: customer?.address || creditCustomer?.address || null,
        cashier_id: currentUser?.id || null,
        cashier_name: currentUser?.name || 'Unknown',
      });

      setReceiptData({
        orderInfo: {
          date: moment().format('DD/MM/YYYY'),
          time: moment().format('hh:mm A'),
          // Always the real database id — sequential by construction (each
          // order is the previous one's id + 1). A fabricated random number
          // here used to be possible as a fallback; a receipt showing the
          // wrong order number is worse than one that is briefly blank.
          orderNumber: order.id ? `#${order.id}` : '—',
          table: tableNumber || '—',
          paymentMethod,
          cashier: currentUser?.name || 'Unknown',
          orderType,
        },
        items: cart.map((c: CartItem) => ({
          name: c.name,
          quantity: c.qty,
          price: c.price,
        })),
        subtotal: order.subtotal ?? subtotal,
        discount: order.manual_discount ?? discount,
        employeeDiscount: order.employee_discount ?? employeeDiscount,
        employeeDiscountRate: order.employee_discount_rate ?? employeeDiscountRate,
        isEmployee: (order.is_employee ?? (isEmployee ? 1 : 0)) === 1,
        taxRate: order.tax_rate ?? taxRate,
        taxAmount: order.tax_amount ?? taxAmount,
        deliveryCharge: order.delivery_charge ?? deliveryCharge,
        total: order.total ?? total,
        restaurant: restaurantDetails,
        customer: {
          name: order.customer_name ?? customer?.name ?? creditCustomer?.name ?? '',
          phone: order.customer_phone ?? customer?.phone ?? creditCustomer?.phone ?? '',
          address: order.customer_address ?? customer?.address ?? creditCustomer?.address ?? '',
        },
      });

      resetOrder();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Failed to charge order:', err);
      if (message.includes('shift is currently open')) {
        setNoShiftPrompt(true);
        return;
      }
      const isStockIssue = message.toLowerCase().includes('insufficient stock');
      alertCard({
        title: isStockIssue ? 'Out of Stock' : 'Could Not Complete Sale',
        message,
        tone: isStockIssue ? 'warning' : 'danger',
      });
    }
  };

  if (loading) {
    return (
      <div style={{ flex: 1, height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={32} style={{ color: 'rgba(0,0,0,0.3)' }} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        search={search}
        onSearchChange={setSearch}
        onNavigate={onNavigate}
        tableNumber={tableNumber}
        onTableNumberChange={setTableNumber}
      />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        <MenuPanel onAddToCart={handleAddToCart} search={search} />
        <OrderCart
          cart={cart}
          onAddToCart={handleAddToCart}
          orderType={orderType}
          deliveryCharge={deliveryPrice}
          discountValue={discountValue}
          discountType={discountType}
          discountAmount={discount}
          taxRate={taxRate}
          taxAmount={taxAmount}
          isEmployee={isEmployee}
          employeeDiscount={employeeDiscount}
          onIsEmployeeChange={setIsEmployee}
          paymentMethod={paymentMethod}
          onDiscountValueChange={setDiscountValue}
          onDiscountTypeChange={setDiscountType}
          onPaymentMethodChange={(method) => {
            setPaymentMethod(method);
            if (method === 'Credit') {
              setCustomerPickerOpen(true);
            } else {
              setCreditCustomer(null);
            }
          }}
          creditCustomer={creditCustomer}
          onOpenCustomerPicker={() => setCustomerPickerOpen(true)}
          onOrderTypeChange={handleOrderTypeChange}
          onUpdateQty={handleUpdateQty}
          onRemoveItem={handleRemoveItem}
          onClearCart={handleClearCart}
          onCharge={handleCharge}
        />
      </div>

      <Modal
        isOpen={deliveryModalOpen}
        onClose={() => setDeliveryModalOpen(false)}
        title="Delivery Details"
        width={440}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#6B6B63', lineHeight: 1.5 }}>
            These print on the receipt so the rider knows where the order is going.
            All optional — skip if the customer is a regular.
          </div>

          {[
            { label: 'Customer Name', value: customerName, set: setCustomerName, ph: 'e.g. Ahmed Khan', type: 'text' },
            { label: 'Phone Number', value: customerPhone, set: setCustomerPhone, ph: 'e.g. 0300-1234567', type: 'tel' },
          ].map(f => (
            <div key={f.label}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                {f.label}
              </label>
              <input
                type={f.type}
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
                placeholder={f.ph}
                style={{
                  width: '100%', height: 44, borderRadius: 8,
                  border: '1.5px solid #E5E9F0', background: '#F7F9FC',
                  padding: '0 12px', fontSize: 14, color: '#0F1720',
                  outline: 'none', fontFamily: 'Inter, sans-serif',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#1B4C82'; e.currentTarget.style.background = '#FFFFFF'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
              />
            </div>
          ))}

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Delivery Address
            </label>
            <textarea
              value={customerAddress}
              onChange={(e) => setCustomerAddress(e.target.value)}
              placeholder="House / street / area"
              rows={3}
              style={{
                width: '100%', borderRadius: 8,
                border: '1.5px solid #E5E9F0', background: '#F7F9FC',
                padding: '10px 12px', fontSize: 14, color: '#0F1720',
                outline: 'none', fontFamily: 'Inter, sans-serif', resize: 'vertical',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#1B4C82'; e.currentTarget.style.background = '#FFFFFF'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              onClick={() => placeOrder()}
              style={{
                flex: 1, height: 44, borderRadius: 8,
                border: '1.5px solid #E5E9F0', background: '#FFFFFF',
                color: '#6B7280', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Skip
            </button>
            <button
              onClick={() => placeOrder({
                name: customerName.trim(),
                phone: customerPhone.trim(),
                address: customerAddress.trim(),
              })}
              style={{
                flex: 2, height: 44, borderRadius: 8, border: 'none',
                background: '#1B4C82', color: '#FFFFFF',
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
                boxShadow: '0 4px 10px rgba(27,76,130,0.28)',
              }}
            >
              Save &amp; Print Receipt
            </button>
          </div>
        </div>
      </Modal>

      <ReceiptModal
        open={!!receiptData}
        onClose={() => setReceiptData(null)}
        orderData={receiptData}
      />

      <Modal
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title="Confirm Sale"
        width={420}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 14, color: '#6B7280', lineHeight: 1.5 }}>
            Are you sure you want to complete this sale?
          </div>
          <div style={{ background: '#EAF2FB', borderRadius: 10, padding: 16, border: '1px solid #C8DCED' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: '#6B7280' }}>Items</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F1720' }}>{cart.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: '#6B7280' }}>Order Type</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F1720' }}>{orderType}</span>
            </div>
            {deliveryCharge > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>Delivery Charge</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0F1720' }}>{formatMoney(deliveryCharge)}</span>
              </div>
            )}
            {employeeDiscount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>Staff Discount ({employeeDiscountRate}%)</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#16A34A' }}>
                  − {formatMoney(employeeDiscount)}
                </span>
              </div>
            )}
            {discount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>Discount</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#16A34A' }}>
                  − {formatMoney(discount)}
                  {discountType === 'percent' ? ` (${Number(discountValue) || 0}%)` : ''}
                </span>
              </div>
            )}
            {tableNumber && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>Token #</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0F1720' }}>{tableNumber}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: '#6B7280' }}>Payment Method</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F1720' }}>{paymentMethod}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid #C8DCED' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#1B4C82' }}>Total</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: '#1B4C82' }}>
                {formatMoney(total, { decimals: total % 1 !== 0 })}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button
              onClick={() => setConfirmModalOpen(false)}
              style={{
                flex: 1, height: 44, borderRadius: 8,
                border: '1.5px solid #E5E9F0', background: '#FFFFFF',
                color: '#6B7280', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={confirmCharge}
              style={{
                flex: 1, height: 44, borderRadius: 8, border: 'none',
                background: '#1B4C82', color: '#FFFFFF',
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                boxShadow: '0 4px 10px rgba(27,76,130,0.28)',
              }}
            >
              <CreditCard size={18} />
              Confirm Sale
            </button>
          </div>
        </div>
      </Modal>

      <CustomerPickerModal
        isOpen={customerPickerOpen}
        onClose={() => setCustomerPickerOpen(false)}
        onSelect={(customer: any) => {
          setCreditCustomer(customer);
          setCustomerPickerOpen(false);
        }}
      />

      <NoShiftOverlay
        show={noShiftPrompt}
        message="You need to open a shift before you can make a sale."
        onRedirect={() => {
          setNoShiftPrompt(false);
          onNavigate && onNavigate('shifts');
        }}
      />
      {dialog}
    </div>
  );
}
