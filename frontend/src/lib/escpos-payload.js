/**
 * Builds the plain-data "copy" object electron/escpos-receipt.js turns into
 * ESC/POS bytes, for one COPY_TYPES entry (see Receipt.jsx).
 *
 * This is the ESC/POS path's counterpart to Receipt.jsx's JSX — same fields,
 * same conditionals (showCashier/showOrderNumber/showPayment/showTax,
 * whether there's a delivery customer, whether discounts apply), just
 * emitted as formatted strings instead of styled divs. If Receipt.jsx's
 * content ever changes, this is the other place that needs the same change,
 * or the two print paths will silently diverge.
 */

const COPY_LABELS = {
  customer: 'CUSTOMER COPY',
  shop: 'SHOP COPY',
  restaurant: 'SHOP COPY',
};

export function buildEscPosCopy(orderData, copyType, settings) {
  const { formatMoney, showCashier, showOrderNumber, showPayment, showTax } = settings;
  const { orderInfo, items, subtotal, discount, employeeDiscount, employeeDiscountRate,
    taxRate, taxAmount, deliveryCharge, total, restaurant, customer } = orderData;

  const metaLeft = [`Date: ${orderInfo.date}`, `Time: ${orderInfo.time}`];
  if (showOrderNumber) metaLeft.push(`Order #: ${orderInfo.orderNumber}`);

  const metaRight = [];
  if (showCashier) metaRight.push(`Cashier: ${orderInfo.cashier}`);
  if (showPayment) metaRight.push(`Payment: ${orderInfo.paymentMethod}`);
  if (orderInfo.orderType) metaRight.push(`Type: ${orderInfo.orderType}`);

  const totalsLines = [{ label: 'Subtotal', value: formatMoney(subtotal) }];
  if (discount > 0) totalsLines.push({ label: 'Discount', value: `-${formatMoney(discount)}` });
  if (employeeDiscount > 0) {
    totalsLines.push({
      label: `Staff Discount${employeeDiscountRate ? ` (${employeeDiscountRate}%)` : ''}`,
      value: `-${formatMoney(employeeDiscount)}`,
    });
  }
  if (showTax && taxAmount > 0) {
    totalsLines.push({
      label: `Tax${taxRate ? ` (${taxRate}%)` : ''}`,
      value: formatMoney(taxAmount, { decimals: taxAmount % 1 !== 0 }),
    });
  }
  if (deliveryCharge > 0 || orderInfo.orderType === 'Delivery') {
    totalsLines.push({ label: 'Delivery Charge', value: formatMoney(deliveryCharge) });
  }

  const hasCustomer = customer && (customer.name || customer.phone || customer.address);

  return {
    copyLabel: COPY_LABELS[copyType] || null,
    shopName: restaurant?.name || 'Pure Milk',
    tagline: restaurant?.tagline || '',
    addressLine: [restaurant?.address, restaurant?.phone].filter(Boolean).join(' · '),
    metaLeft,
    metaRight,
    customer: hasCustomer ? customer : null,
    items: (items || []).map((item) => ({
      name: item.name,
      qty: `x${item.quantity}`,
      amount: formatMoney(item.price * item.quantity),
    })),
    totalsLines,
    total: { label: 'TOTAL', value: formatMoney(total, { decimals: total % 1 !== 0 }) },
    footerMessage: restaurant?.footerMessage || 'Thank you for your purchase!',
  };
}

export function buildEscPosCopies(orderData, copyTypes, settings) {
  return copyTypes.map((copyType) => buildEscPosCopy(orderData, copyType, settings));
}
