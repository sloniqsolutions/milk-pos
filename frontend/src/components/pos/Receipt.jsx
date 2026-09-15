import { useSettings } from '@/lib/SettingsContext';

/**
 * Plain and monochrome on purpose.
 *
 * This used to be a red-gradient card with a circular logo badge and a row of
 * star glyphs — a nice enough screen mock, but not what a thermal head can
 * actually produce. A thermal printer has one colour, and most drivers render
 * a CSS gradient or box-shadow as a dithered grey block, which costs print
 * time and looks like a smudge on the paper rather than a banner. Every
 * surface below is black text on white, which is also exactly the structure
 * the shop asked this to follow.
 */

const ReceiptHeader = ({ restaurant }) => (
  <div style={{ padding: '18px 20px 14px', textAlign: 'center' }}>
    <div style={{ fontWeight: 800, fontSize: 20, color: '#111111', letterSpacing: 0.2 }}>
      {restaurant?.name || 'Pure Milk'}
    </div>
    {restaurant?.tagline && (
      <div style={{ fontSize: 12, color: '#444444', marginTop: 3, fontStyle: 'italic' }}>
        {restaurant.tagline}
      </div>
    )}
    {(restaurant?.address || restaurant?.phone) && (
      <div style={{ fontSize: 11, color: '#444444', marginTop: 3 }}>
        {[restaurant?.address, restaurant?.phone].filter(Boolean).join(' · ')}
      </div>
    )}
  </div>
);

/** No "Table" row — Milk POS is walk-in and delivery, not table service. */
const ReceiptMeta = ({ orderInfo }) => {
  const { showCashier, showOrderNumber, showPayment } = useSettings();
  return (
    <div style={{ padding: '2px 20px 14px', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#333333' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div>Date: {orderInfo.date}</div>
        <div>Time: {orderInfo.time}</div>
        {showOrderNumber && <div>Order #: {orderInfo.orderNumber}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'right' }}>
        {showCashier && <div>Cashier: {orderInfo.cashier}</div>}
        {showPayment && <div>Payment: {orderInfo.paymentMethod}</div>}
        {orderInfo.orderType && <div>Type: {orderInfo.orderType}</div>}
      </div>
    </div>
  );
};

/**
 * Where the order is going. Printed on every copy of a delivery order — the
 * rider drives it, the till keeps the record — and hidden entirely when the
 * cashier skipped the prompt or the order is a walk-in.
 */
const ReceiptCustomer = ({ customer }) => {
  const has = customer && (customer.name || customer.phone || customer.address);
  if (!has) return null;
  return (
    <div style={{ padding: '12px 20px', fontSize: 12, color: '#222222' }}>
      <div style={{
        fontSize: 10.5, color: '#666666', textTransform: 'uppercase',
        fontWeight: 700, marginBottom: 6, letterSpacing: 0.5,
      }}>
        Deliver To
      </div>
      {customer.name && <div style={{ fontWeight: 700, fontSize: 13 }}>{customer.name}</div>}
      {customer.phone && <div style={{ marginTop: 2 }}>{customer.phone}</div>}
      {customer.address && (
        <div style={{ marginTop: 2, lineHeight: 1.35 }}>{customer.address}</div>
      )}
    </div>
  );
};

const ReceiptDivider = ({ dashed = true }) => (
  <div
    style={{
      borderTop: dashed ? '1.5px dashed #999999' : '1.5px solid #111111',
      margin: '0 20px',
    }}
  />
);

const ReceiptItemsTable = ({ items }) => {
  const { formatMoney } = useSettings();
  return (
    <div style={{ padding: '14px 20px' }}>
      <div style={{ display: 'flex', fontSize: 10.5, color: '#666666', textTransform: 'uppercase', fontWeight: 700, marginBottom: 10, letterSpacing: 0.4 }}>
        <div style={{ flex: 1 }}>Item</div>
        <div style={{ width: 50, textAlign: 'center' }}>Qty</div>
        <div style={{ width: 80, textAlign: 'right' }}>Amount</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, fontWeight: 500, fontSize: 13, color: '#111111' }}>
              {item.name}
            </div>
            <div style={{ width: 50, textAlign: 'center', fontSize: 13, color: '#111111' }}>
              x{item.quantity}
            </div>
            <div style={{ width: 80, textAlign: 'right', fontWeight: 700, fontSize: 13, color: '#111111' }}>
              {formatMoney(item.price * item.quantity)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const ReceiptTotals = ({ subtotal, discount, employeeDiscount, employeeDiscountRate, taxRate, taxAmount, deliveryCharge, total, orderType }) => {
  const { formatMoney, showTax } = useSettings();

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5, color: '#222222', fontWeight: 500 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Subtotal</span>
          <span>{formatMoney(subtotal)}</span>
        </div>
        {discount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Discount</span>
            <span>-{formatMoney(discount)}</span>
          </div>
        )}
        {/* Staff purchases carry their own discount line so the customer copy
            and the till copy both show why the price differs from the menu. */}
        {employeeDiscount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Staff Discount{employeeDiscountRate ? ` (${employeeDiscountRate}%)` : ''}</span>
            <span>-{formatMoney(employeeDiscount)}</span>
          </div>
        )}
        {showTax && taxAmount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Tax{taxRate ? ` (${taxRate}%)` : ''}</span>
            <span>{formatMoney(taxAmount, { decimals: taxAmount % 1 !== 0 })}</span>
          </div>
        )}
        {(deliveryCharge > 0 || orderType === 'Delivery') && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Delivery Charge</span>
            <span>{formatMoney(deliveryCharge)}</span>
          </div>
        )}
      </div>
      <ReceiptDivider dashed={false} />
      <div style={{
        padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontWeight: 800, fontSize: 14, color: '#111111' }}>TOTAL</span>
        <span style={{ fontWeight: 800, fontSize: 18, color: '#111111' }}>
          {formatMoney(total, { decimals: total % 1 !== 0 })}
        </span>
      </div>
      <ReceiptDivider dashed={false} />
    </div>
  );
};

const ReceiptFooter = ({ restaurant }) => (
  <div style={{ padding: '16px 20px 20px', textAlign: 'center' }}>
    <div style={{ fontWeight: 700, fontSize: 13, color: '#111111' }}>
      {restaurant?.footerMessage || 'Thank you for your purchase!'}
    </div>
    {/*
      Fixed attribution, not a shop setting — the same line the dashboard
      carries in its own footer. It travels with the software, not the shop's
      own branding, so it is not something Settings offers to edit or remove.
    */}
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #CCCCCC' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#444444' }}>POS Software By:</div>
      <div style={{ fontSize: 10, color: '#444444', marginTop: 2 }}>
        Virtiqo (Private) Limited &nbsp;+92 300 8536046
      </div>
      <div style={{ fontSize: 10, color: '#444444', marginTop: 1 }}>info@virtiqo.com</div>
    </div>
  </div>
);

/**
 * Which of the two printed copies this is. Both carry identical figures —
 * only the banner differs — so the pair can be separated after printing: one
 * to the customer, one kept at the till. There is no separate kitchen ticket:
 * a milk shop pours and bags what's in front of the cashier, it doesn't send
 * an order back to a kitchen.
 */
export const COPY_TYPES = ['customer', 'shop'];

const COPY_LABELS = {
  customer: 'CUSTOMER COPY',
  shop: 'SHOP COPY',
  restaurant: 'SHOP COPY',
};

const CopyBanner = ({ copyType }) => {
  if (!copyType || !COPY_LABELS[copyType]) return null;
  return (
    <div style={{
      textAlign: 'center', padding: '12px 0 0', fontSize: 12.5, fontWeight: 800,
      letterSpacing: 2, color: '#111111',
    }}>
      {COPY_LABELS[copyType]}
    </div>
  );
};

export default function Receipt({
  orderInfo,
  items,
  subtotal,
  discount,
  employeeDiscount,
  employeeDiscountRate,
  taxRate,
  taxAmount,
  deliveryCharge,
  total,
  restaurant,
  copyType,
  customer,
}) {
  // Settings offers a paper size, applied to both the screen preview and (via
  // the CSS variable ReceiptModal sets) the actual printed width.
  const { paperSize } = useSettings();
  const width = paperSize === '58mm' ? 260 : 340;

  return (
    <div
      className="receipt-copy"
      style={{
        width,
        background: '#FFFFFF',
        borderRadius: 10,
        boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
        border: '1px solid #DDDDDD',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Courier New', Courier, monospace",
        margin: '0 auto',
        overflow: 'hidden',
        color: '#111111',
      }}
    >
      <CopyBanner copyType={copyType} />
      <ReceiptHeader restaurant={restaurant} />
      <ReceiptDivider />
      <ReceiptMeta orderInfo={orderInfo} />
      <ReceiptCustomer customer={customer} />
      <ReceiptDivider />
      <ReceiptItemsTable items={items} />
      <ReceiptDivider />
      <ReceiptTotals
        subtotal={subtotal}
        discount={discount}
        employeeDiscount={employeeDiscount || 0}
        employeeDiscountRate={employeeDiscountRate || 0}
        taxRate={taxRate || 0}
        taxAmount={taxAmount || 0}
        deliveryCharge={deliveryCharge || 0}
        total={total}
        orderType={orderInfo?.orderType}
      />
      <ReceiptFooter restaurant={restaurant} />
      {/*
        A few millimetres of blank paper below the last printed line, on
        every copy, whether it prints alone or stacked with the other two.
        Without this the cutter lands right at the descender of the last
        line of text — fine on screen, awkward on a roll where the blade has
        nowhere to bite that isn't ink.
      */}
      <div className="receipt-cut-margin" style={{ height: 14 }} />
    </div>
  );
}
