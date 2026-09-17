import { useMemo, useState, useEffect } from 'react';
import { Droplet } from 'lucide-react';
import { usePOS } from '@/lib/POSContext';
import { useSettings } from '@/lib/SettingsContext';
import { inventoryAPI } from '@/api/index';
import Modal from '@/components/pos-ui/Modal';

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';

/**
 * Replaces the old "Quick Add Milk" panel's litre/amount inputs.
 *
 * Two bugs lived there: entering a price snapped the resulting quantity to
 * the nearest 0.05 and then charged THAT rounded quantity back out — Rs 140
 * became "0.65L" and silently re-billed as Rs 143. The fix is to never
 * recompute the price from a rounded quantity: whichever amount was typed in
 * (Litres/Grams, or Price) is converted into the other with plain division
 * and displayed to 2 decimals, but the per-unit price stored on the cart line
 * is derived so price × quantity reproduces the typed price exactly.
 *
 * One product at a time — Milk (per litre) or Dahi (per kilogram, since
 * db/database.js's Dahi recipe consumes Yogurt in grams at 1000g per menu
 * "unit") — selected from the two cards above the inputs. The per-unit rate
 * always comes from the live menu (usePOS().menuItems), which is exactly
 * what MenuManagement's price edits update, so a changed menu price is
 * reflected here immediately.
 */
export default function AddMilkDahiModal({ isOpen, onClose, onAdd }) {
  const { menuItems } = usePOS();
  const { formatMoney, currencySymbol } = useSettings();

  const milkItem = useMemo(
    () => menuItems.find(i => i.category === 'Milk' && i.name === '1 Litre')
      || menuItems.find(i => i.category === 'Milk'),
    [menuItems]
  );
  const dahiItem = useMemo(() => menuItems.find(i => i.name === 'Dahi'), [menuItems]);

  const [product, setProduct] = useState('Milk');
  const [amount, setAmount] = useState('');   // litres, or grams for Dahi
  const [price, setPrice] = useState('');
  const [lastEdited, setLastEdited] = useState('amount'); // which field drives the other
  const [ingredients, setIngredients] = useState([]);

  useEffect(() => {
    if (!isOpen) return;
    setAmount(''); setPrice(''); setLastEdited('amount');
    inventoryAPI.getAll().then(setIngredients).catch(() => setIngredients([]));
  }, [isOpen]);

  // menu_items has no stock column — real stock lives on ingredients, so the
  // cards show the actual Milk/Yogurt levels rather than a nonexistent field.
  const milkStock = ingredients.find(i => i.name === 'Milk');
  const yogurtStock = ingredients.find(i => i.name === 'Yogurt');

  const item = product === 'Milk' ? milkItem : dahiItem;
  // Grams-per-menu-"unit" for Dahi (1000 = 1kg, matching the recipe in
  // db/database.js); 1 for Milk, whose menu unit already is 1 litre.
  const unitSize = product === 'Milk' ? 1 : 1000;
  const unitLabel = product === 'Milk' ? 'Litres' : 'Grams';
  const rate = item ? item.price / unitSize : 0; // price per litre, or per gram

  const amountNum = Number(amount) || 0;
  const priceNum = Number(price) || 0;

  // Quantity in the item's own unit (litres for Milk, "kg units" for Dahi —
  // i.e. what order_items.quantity must hold for the recipe multiplication in
  // routes/orders.js to deduct the right amount of stock).
  let qty = 0;
  let effectivePrice = rate;
  let displayAmount = amountNum;
  let displayPrice = priceNum;

  if (lastEdited === 'price' && priceNum > 0 && rate > 0) {
    // Floor, never round up — the shop should never end up giving out more
    // product than the price paid for. Flooring to 2 decimals of the item's
    // own unit (0.01L, or 0.01 "kg unit" = 10g) keeps this precise without
    // the old 0.05 snapping.
    const rawUnits = priceNum / rate;
    qty = Math.floor(rawUnits * 100) / 100;
    effectivePrice = qty > 0 ? priceNum / qty : rate; // price × qty reproduces priceNum exactly
    displayAmount = qty * unitSize;
    displayPrice = priceNum;
  } else if (lastEdited === 'amount' && amountNum > 0 && rate > 0) {
    qty = amountNum / unitSize;
    effectivePrice = rate;
    displayAmount = amountNum;
    displayPrice = rate * qty;
  }

  const canAdd = item && qty > 0;

  const handleAdd = () => {
    if (!canAdd) return;
    const label = product === 'Milk'
      ? `Milk (${qty.toFixed(2)} L)`
      : `Dahi (${Math.round(qty * unitSize)} g)`;
    onAdd({ id: item.id, name: label, price: effectivePrice, qty });
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Milk or Dahi" width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Product cards */}
        <div style={{ display: 'flex', gap: 10 }}>
          {[
            { key: 'Milk', label: 'Milk', unit: 'per Litre', data: milkItem, stock: milkStock },
            { key: 'Dahi', label: 'Dahi', unit: 'per KG', data: dahiItem, stock: yogurtStock },
          ].map(opt => {
            const active = product === opt.key;
            const disabled = !opt.data;
            return (
              <button
                key={opt.key}
                type="button"
                disabled={disabled}
                onClick={() => { setProduct(opt.key); setAmount(''); setPrice(''); setLastEdited('amount'); }}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                  padding: '14px 10px', borderRadius: 12,
                  border: `1.5px solid ${active ? BLUE : '#E5E9F0'}`,
                  background: active ? BLUE_TINT : '#FFFFFF',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                  transition: 'all 140ms',
                }}
              >
                <Droplet size={22} color={active ? BLUE : '#9CA3AF'} />
                <span style={{ fontSize: 14, fontWeight: 700, color: active ? BLUE_DARK : '#0F1720' }}>{opt.label}</span>
                <span style={{ fontSize: 11.5, color: '#6B7280' }}>
                  {opt.data ? `${formatMoney(opt.data.price)} ${opt.unit}` : 'Not in menu yet'}
                </span>
                {opt.stock && (
                  <span style={{ fontSize: 10.5, color: '#9CA3AF' }}>
                    Stock: {opt.stock.stock} {opt.stock.unit}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Amount / Price inputs */}
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              {unitLabel}
            </label>
            <input
              type="number" min="0" step="any"
              value={lastEdited === 'amount' ? amount : (displayAmount ? String(Math.round(displayAmount * 100) / 100) : '')}
              onChange={e => { setLastEdited('amount'); setAmount(e.target.value); }}
              placeholder={product === 'Milk' ? 'e.g. 1.5' : 'e.g. 500'}
              style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' }}
              onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Price ({currencySymbol})
            </label>
            <input
              type="number" min="0" step="any"
              value={lastEdited === 'price' ? price : (displayPrice ? String(Math.round(displayPrice * 100) / 100) : '')}
              onChange={e => { setLastEdited('price'); setPrice(e.target.value); }}
              placeholder="e.g. 140"
              style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' }}
              onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
            />
          </div>
        </div>

        {canAdd && (
          <div style={{ background: BLUE_TINT, borderRadius: 8, padding: '10px 14px', border: '1px solid #C8DCED', fontSize: 13, color: BLUE_DARK }}>
            Adding <strong>{product}</strong> — {product === 'Milk' ? `${qty.toFixed(2)} L` : `${Math.round(qty * unitSize)} g`} for <strong>{formatMoney(displayPrice)}</strong>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={onClose} style={{ padding: '10px 16px', background: '#FFFFFF', color: '#6B7280', borderRadius: 8, border: '1.5px solid #E5E9F0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button
            type="button"
            disabled={!canAdd}
            onClick={handleAdd}
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14,
              background: canAdd ? BLUE : '#E5E9F0', color: canAdd ? '#FFF' : '#9CA3AF',
              cursor: canAdd ? 'pointer' : 'not-allowed',
              boxShadow: canAdd ? '0 4px 10px rgba(27,76,130,0.28)' : 'none',
            }}
          >
            Add to Cart
          </button>
        </div>
      </div>
    </Modal>
  );
}
