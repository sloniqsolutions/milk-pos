import React, { useState } from 'react';
import { Trash2, Plus, Minus, CreditCard, Banknote, Globe, Wallet, ChevronRight, Droplet } from 'lucide-react';
import { PAYMENT_METHODS, type PaymentMethod } from '@/lib/constants';
import { useSettings } from '@/lib/SettingsContext';
import AddMilkDahiModal from '@/components/pos/AddMilkDahiModal';

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';

interface CartItem {
  id: number;
  name: string;
  price: number;
  qty: number;
}

interface OrderCartProps {
  cart: CartItem[];
  onAddToCart?: (item: { id: number; name: string; price: number; variant_id?: number | null; qty?: number }) => void;
  orderType: 'Walk-in' | 'Delivery';
  deliveryCharge: number;
  discountValue: string;
  discountType: 'flat' | 'percent';
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  isEmployee: boolean;
  employeeDiscount: number;
  onIsEmployeeChange: (value: boolean) => void;
  paymentMethod: PaymentMethod;
  onDiscountValueChange: (value: string) => void;
  onDiscountTypeChange: (type: 'flat' | 'percent') => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  creditCustomer?: { id: number; name: string; phone?: string; address?: string; balance?: number } | null;
  onOpenCustomerPicker?: () => void;
  onOrderTypeChange: (type: 'Walk-in' | 'Delivery') => void;
  onUpdateQty: (id: number, name: string, delta: number) => void;
  onRemoveItem: (id: number, name: string) => void;
  onClearCart: () => void;
  onCharge: () => void;
}

const PAYMENT_ICONS: Record<PaymentMethod, React.ElementType> = {
  Cash: Banknote,
  Card: CreditCard,
  Online: Globe,
  Credit: Wallet,
};

export default function OrderCart({
  cart,
  onAddToCart,
  orderType,
  deliveryCharge,
  discountValue,
  discountType,
  discountAmount,
  taxRate,
  taxAmount,
  isEmployee,
  employeeDiscount,
  onIsEmployeeChange,
  paymentMethod,
  onDiscountValueChange,
  onDiscountTypeChange,
  onPaymentMethodChange,
  creditCustomer,
  onOpenCustomerPicker,
  onOrderTypeChange,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onCharge,
}: OrderCartProps) {
  const { formatMoney, currencySymbol, employeeDiscountRate } = useSettings();
  const [showAddMilkDahi, setShowAddMilkDahi] = useState(false);
  const subtotal = cart.reduce((sum: number, item: CartItem) => sum + (item.price * item.qty), 0);
  const appliedDelivery = orderType === 'Delivery' ? deliveryCharge : 0;
  const total = Math.max(0, subtotal - discountAmount - employeeDiscount) + taxAmount + appliedDelivery;

  return (
    <div
      style={{
        width: 420,
        height: '100%',
        background: '#FFFFFF',
        borderLeft: '1px solid #E5E9F0',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 18px', borderBottom: '1px solid #E5E9F0', flexShrink: 0 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: '#0F1720', margin: 0, letterSpacing: '-0.3px' }}>
          Current Order
        </h2>
        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 3 }}>
          {cart.length} {cart.length === 1 ? 'item' : 'items'}
        </div>
      </div>

      {/* Scrollable middle: Quick Add + Items live in ONE scroll region so
          they can never overlap or squeeze each other or the footer. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {onAddToCart && (
          <div style={{ padding: '12px 18px', borderBottom: '1px solid #E5E9F0', flexShrink: 0 }}>
            <button
              onClick={() => setShowAddMilkDahi(true)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                height: 40, borderRadius: 8, border: `1.5px solid ${BLUE}`, background: BLUE_TINT,
                color: BLUE_DARK, fontWeight: 700, fontSize: 13.5, cursor: 'pointer', transition: 'background 140ms',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#DCEAFA'; }}
              onMouseLeave={e => { e.currentTarget.style.background = BLUE_TINT; }}
            >
              <Droplet size={16} /> Add Milk / Dahi
            </button>
          </div>
        )}

        <div style={{ flex: 1, padding: '12px 18px', display: 'flex', flexDirection: 'column' }}>
          {cart.length === 0 ? (
            <div style={{
              flex: 1, minHeight: 130, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', textAlign: 'center',
              padding: '16px 0',
            }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>🥛</div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#0F1720', margin: '0 0 4px' }}>Cart is empty</p>
              <p style={{ fontSize: 13, color: '#9CA3AF', margin: 0 }}>Add items from the product list</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {cart.map((item: CartItem, idx: number) => (
                <div
                  key={`${item.id}-${item.name}`}
                  style={{
                    paddingBottom: 14, marginBottom: 14,
                    borderBottom: idx < cart.length - 1 ? '1px solid #E8E4DA' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#0F1720', paddingRight: 8, lineHeight: 1.4 }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0F1720', flexShrink: 0 }}>
                      {formatMoney(item.price * item.qty)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ fontSize: 12, color: '#6B6B63' }}>{formatMoney(item.price)} each</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        onClick={() => onUpdateQty(item.id, item.name, -0.5)}
                        style={{
                          width: 26, height: 26, borderRadius: '50%',
                          background: '#FBFEFE', color: '#0F1720',
                          border: '1.5px solid #E8E4DA', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Minus size={12} />
                      </button>
                      <span style={{ fontSize: 13, fontWeight: 700, width: 18, textAlign: 'center', color: '#0F1720' }}>
                        {roundQty(item.qty)}
                      </span>
                      <button
                        onClick={() => onUpdateQty(item.id, item.name, 0.5)}
                        style={{
                          width: 26, height: 26, borderRadius: '50%',
                          background: '#EAF2FB', color: '#1B4C82',
                          border: '1.5px solid #1B4C82', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Plus size={12} />
                      </button>
                      <button
                        onClick={() => onRemoveItem(item.id, item.name)}
                        style={{
                          width: 26, height: 26, borderRadius: '50%',
                          background: 'transparent', color: '#A3A39A',
                          border: 'none', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          marginLeft: 2,
                          transition: 'color 120ms',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#EF4444'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#A3A39A'; }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '14px 18px', background: '#EAF2FB', borderTop: '1px solid #E8E4DA', flexShrink: 0 }}>
        {/* Walk-in / Delivery toggle */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {(['Walk-in', 'Delivery'] as const).map(type => {
            const active = orderType === type;
            return (
              <button
                key={type}
                onClick={() => onOrderTypeChange(type)}
                style={{
                  flex: 1,
                  height: 34,
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: active ? '#1B4C82' : '#FBFEFE',
                  color: active ? '#FBFEFE' : '#6B6B63',
                  border: active ? '1px solid #1B4C82' : '1.5px solid #E8E4DA',
                  transition: 'all 140ms',
                }}
              >
                {type}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 13, color: '#6B6B63' }}>Subtotal</span>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#0F1720' }}>{formatMoney(subtotal)}</span>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: orderType === 'Delivery' ? 6 : 10,
        }}>
          <span style={{ fontSize: 13, color: '#6B6B63' }}>Discount</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1.5px solid #E8E4DA' }}>
              {(['flat', 'percent'] as const).map(type => {
                const active = discountType === type;
                return (
                  <button
                    key={type}
                    onClick={() => onDiscountTypeChange(type)}
                    style={{
                      width: 26, height: 26, fontSize: 12, fontWeight: 700,
                      border: 'none', cursor: 'pointer',
                      background: active ? '#1B4C82' : '#EAF2FB',
                      color: active ? '#FBFEFE' : '#A3A39A',
                    }}
                    title={type === 'flat' ? 'Flat amount' : 'Percent of subtotal'}
                  >
                    {type === 'flat' ? currencySymbol : '%'}
                  </button>
                );
              })}
            </div>
            <input
              type="number"
              min="0"
              value={discountValue}
              onChange={e => onDiscountValueChange(e.target.value)}
              placeholder="0"
              disabled={cart.length === 0}
              style={{
                width: 66, height: 26, borderRadius: 6,
                border: '1.5px solid #E8E4DA', background: '#FBFEFE',
                padding: '0 8px', fontSize: 13, fontWeight: 600,
                color: '#0F1720', textAlign: 'right', outline: 'none',
                fontFamily: 'Inter, sans-serif',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = '#1B4C82'; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E8E4DA'; }}
            />
          </div>
        </div>

        {discountAmount > 0 && (
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            marginBottom: orderType === 'Delivery' ? 6 : 10,
          }}>
            <span style={{ fontSize: 12, color: '#6B6B63' }}>
              Discount applied{discountType === 'percent' ? ` (${Number(discountValue) || 0}%)` : ''}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#16A34A' }}>
              − {formatMoney(discountAmount)}
            </span>
          </div>
        )}

        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid #E8E4DA',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 13, color: '#6B6B63' }}>Staff purchase</span>
            <span style={{ fontSize: 11, color: '#A3A39A' }}>
              {employeeDiscountRate}% off automatically
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isEmployee}
            aria-label="Staff purchase"
            onClick={() => onIsEmployeeChange(!isEmployee)}
            disabled={cart.length === 0}
            style={{
              width: 44, height: 24, borderRadius: 12, position: 'relative',
              border: 'none', padding: 0,
              cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
              opacity: cart.length === 0 ? 0.5 : 1,
              background: isEmployee ? '#1B4C82' : '#D7DEE9',
              transition: 'background 140ms',
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: isEmployee ? 23 : 3,
              width: 18, height: 18, borderRadius: 9, background: '#FBFEFE',
              transition: 'left 140ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        {employeeDiscount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: '#6B6B63' }}>
              Staff Discount ({employeeDiscountRate}%)
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#16A34A' }}>
              − {formatMoney(employeeDiscount)}
            </span>
          </div>
        )}

        {taxAmount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: '#6B6B63' }}>
              Tax{taxRate ? ` (${taxRate}%)` : ''}
            </span>
            <span style={{ fontSize: 13, fontWeight: 500, color: '#0F1720' }}>
              {formatMoney(taxAmount, { decimals: taxAmount % 1 !== 0 })}
            </span>
          </div>
        )}
        {orderType === 'Delivery' && (
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            marginBottom: 10, paddingBottom: 10,
            borderBottom: '1px solid #E8E4DA',
          }}>
            <span style={{ fontSize: 13, color: '#6B6B63' }}>Delivery Charge</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: '#0F1720' }}>{formatMoney(deliveryCharge)}</span>
          </div>
        )}
        {orderType !== 'Delivery' && (
          <div style={{ borderBottom: '1px solid #E8E4DA', marginBottom: 10, paddingBottom: 10 }} />
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#0F1720' }}>Total</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#0F1720' }}>{formatMoney(total, { decimals: total % 1 !== 0 })}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {PAYMENT_METHODS.map(method => {
            const active = paymentMethod === method;
            const Icon = PAYMENT_ICONS[method];
            return (
              <button
                key={method}
                onClick={() => onPaymentMethodChange(method)}
                style={{
                  flex: 1, height: 32, borderRadius: 8,
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                  background: active ? '#1B4C82' : '#FBFEFE',
                  color: active ? '#FBFEFE' : '#6B6B63',
                  border: active ? '1.5px solid #1B4C82' : '1.5px solid #E8E4DA',
                  transition: 'all 140ms',
                }}
              >
                <Icon size={13} />
                {method}
              </button>
            );
          })}
        </div>

        {paymentMethod === 'Credit' && (
          <button
            onClick={onOpenCustomerPicker}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '10px 12px', marginBottom: 12,
              borderRadius: 8, cursor: 'pointer', textAlign: 'left',
              background: creditCustomer ? BLUE_TINT : '#FEF2F2',
              border: creditCustomer ? `1.5px solid ${BLUE}` : '1.5px solid #FECACA',
              transition: 'border-color 140ms',
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: creditCustomer ? BLUE_DARK : '#DC2626' }}>
                {creditCustomer ? creditCustomer.name : 'Select a customer'}
              </div>
              <div style={{ fontSize: 11, color: creditCustomer ? '#6B7280' : '#DC2626', marginTop: 2 }}>
                {creditCustomer
                  ? (creditCustomer.phone || 'Tap to change')
                  : 'Required for a credit sale'}
              </div>
            </div>
            <ChevronRight size={16} color="#A3A39A" />
          </button>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClearCart}
            disabled={cart.length === 0}
            style={{
              flex: 1, height: 42, borderRadius: 10,
              border: '1.5px solid #E8E4DA',
              background: '#FBFEFE', color: cart.length === 0 ? '#9CA3AF' : '#EF4444',
              fontSize: 14, fontWeight: 600,
              cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
              opacity: cart.length === 0 ? 0.5 : 1,
              transition: 'all 140ms',
            }}
            onMouseEnter={e => { if (cart.length > 0) e.currentTarget.style.background = '#FEF2F2'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#FBFEFE'; }}
          >
            Clear
          </button>
          <button
            onClick={onCharge}
            disabled={cart.length === 0 || (paymentMethod === 'Credit' && !creditCustomer)}
            style={{
              flex: 2, height: 42, borderRadius: 10, border: 'none',
              background: (cart.length === 0 || (paymentMethod === 'Credit' && !creditCustomer)) ? '#E5E9F0' : '#1B4C82',
              color: (cart.length === 0 || (paymentMethod === 'Credit' && !creditCustomer)) ? '#9CA3AF' : '#FBFEFE',
              fontSize: 14, fontWeight: 600,
              cursor: (cart.length === 0 || (paymentMethod === 'Credit' && !creditCustomer)) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              boxShadow: (cart.length > 0 && !(paymentMethod === 'Credit' && !creditCustomer)) ? '0 2px 8px rgba(27,76,130,0.28)' : 'none',
              transition: 'all 140ms',
            }}
            onMouseEnter={e => { if (cart.length > 0 && !(paymentMethod === 'Credit' && !creditCustomer)) e.currentTarget.style.background = '#123A66'; }}
            onMouseLeave={e => { if (cart.length > 0 && !(paymentMethod === 'Credit' && !creditCustomer)) e.currentTarget.style.background = '#1B4C82'; }}
          >
            <CreditCard size={17} />
            Charge Order
          </button>
        </div>
      </div>

      {onAddToCart && (
        <AddMilkDahiModal
          isOpen={showAddMilkDahi}
          onClose={() => setShowAddMilkDahi(false)}
          onAdd={onAddToCart}
        />
      )}
    </div>
  );
}

/**
 * Rounds a quantity to at most 2 decimal places, for display in the cart
 * list — custom Milk/Dahi amounts (see AddMilkDahiModal) can otherwise leave
 * a value like 1.1500000000000001 from plain floating point division.
 */
function roundQty(qty: number): number {
  return Math.round(qty * 100) / 100;
}

