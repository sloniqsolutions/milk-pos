import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Package, Edit2, AlertCircle, Droplet, Trash2 } from 'lucide-react';
import { inventoryAPI, ApiError } from '@/api/index';
import SearchBar from '@/components/pos-ui/SearchBar';
import Modal from '@/components/pos-ui/Modal';
import useDialogs from '@/lib/useDialogs';

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';

interface Ingredient {
  id: number;
  name: string;
  unit: string;
  stock: number;
  low_stock_threshold: number;
}

/** YYYY-MM-DD in local time — matches what the date <input> reads/writes and
 * what the backend stores entries under (see backend/routes/inventory.js). */
const todayStr = () => new Date().toLocaleDateString('en-CA');

const dateInputStyle = {
  width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8,
  fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' as const,
};
const dateInputFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF';
};
const dateInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC';
};

export default function InventoryScreen() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedIngredient, setSelectedIngredient] = useState<Ingredient | null>(null);
  const { alertCard, dialog } = useDialogs();

  // Add form state
  const [addName, setAddName] = useState('');
  const [addUnit, setAddUnit] = useState('Litre');
  const [addStock, setAddStock] = useState('0');
  const [addThreshold, setAddThreshold] = useState('0');
  const [addDate, setAddDate] = useState(todayStr());

  // Edit form state
  const [editAction, setEditAction] = useState<'add' | 'subtract' | 'set'>('add');
  const [editAmount, setEditAmount] = useState('');
  const [editThreshold, setEditThreshold] = useState('');
  const [editDate, setEditDate] = useState(todayStr());

  // Convert to Yogurt modal state
  const [showYogurtModal, setShowYogurtModal] = useState(false);
  const [yogurtMilkAmount, setYogurtMilkAmount] = useState('');
  const [yogurtAmount, setYogurtAmount] = useState('');
  const [yogurtDate, setYogurtDate] = useState(todayStr());

  // Report Waste modal state
  const [showWasteModal, setShowWasteModal] = useState(false);
  const [wasteIngredientId, setWasteIngredientId] = useState('');
  const [wasteAmount, setWasteAmount] = useState('');
  const [wasteDate, setWasteDate] = useState(todayStr());

  const milkIngredient = ingredients.find(i => i.name === 'Milk');
  const yogurtIngredient = ingredients.find(i => i.name === 'Yogurt');

  // Name or unit, so "Litre" narrows to everything counted in litres.
  const visibleIngredients = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ingredients;
    return ingredients.filter(i =>
      String(i.name || '').toLowerCase().includes(q) ||
      String(i.unit || '').toLowerCase().includes(q)
    );
  }, [ingredients, search]);

  useEffect(() => {
    fetchInventory();
  }, []);

  const fetchInventory = async () => {
    try {
      const data = await inventoryAPI.getAll();
      setIngredients(data);
    } catch (err) {
      console.error('Failed to fetch inventory:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim()) return;

    try {
      await inventoryAPI.create({
        name: addName.trim(),
        unit: addUnit.trim(),
        stock: parseFloat(addStock) || 0,
        low_stock_threshold: parseFloat(addThreshold) || 0,
        date: addDate,
      });
      setShowAddModal(false);
      setAddName('');
      setAddStock('0');
      setAddThreshold('0');
      setAddDate(todayStr());
      fetchInventory();
    } catch (err) {
      console.error(err);
      alertCard({
        title: 'Could not add ingredient',
        message: err instanceof Error ? err.message : 'Failed to add ingredient',
      });
    }
  };

  const openEditModal = (ing: Ingredient) => {
    setSelectedIngredient(ing);
    setEditAction('add');
    setEditAmount('');
    setEditThreshold(ing.low_stock_threshold.toString());
    setEditDate(todayStr());
    setShowEditModal(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIngredient) return;

    try {
      // 1. Update stock if amount is provided
      if (editAmount !== '') {
        const amt = parseFloat(editAmount);
        if (!isNaN(amt)) {
          const payload = editAction === 'set'
            ? { stock: amt, date: editDate }
            : { action: editAction, amount: amt, date: editDate };

          await inventoryAPI.updateStock(selectedIngredient.id, payload);
        }
      }

      // 2. Update threshold if changed
      const currentThreshold = parseFloat(editThreshold);
      if (!isNaN(currentThreshold) && currentThreshold !== selectedIngredient.low_stock_threshold) {
        await inventoryAPI.updateThreshold(selectedIngredient.id, currentThreshold);
      }

      setShowEditModal(false);
      fetchInventory();
    } catch (err) {
      console.error(err);
    }
  };

  const openYogurtModal = () => {
    setYogurtMilkAmount('');
    setYogurtAmount('');
    setYogurtDate(todayStr());
    setShowYogurtModal(true);
  };

  const handleConvertSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const milkAmt = parseFloat(yogurtMilkAmount);
    const yogurtAmt = parseFloat(yogurtAmount);
    if (!(milkAmt > 0) || !(yogurtAmt > 0)) return;

    try {
      await inventoryAPI.convertToYogurt({ milk_amount: milkAmt, yogurt_amount: yogurtAmt, date: yogurtDate });
      setShowYogurtModal(false);
      fetchInventory();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_MILK') {
        alertCard({ title: 'Not enough milk', message: 'Not enough milk in stock for this conversion.', tone: 'warning' });
      } else {
        alertCard({
          title: 'Could not convert',
          message: err instanceof Error ? err.message : 'Failed to convert milk to yogurt',
        });
      }
    }
  };

  const openWasteModal = () => {
    setWasteIngredientId(ingredients[0] ? String(ingredients[0].id) : '');
    setWasteAmount('');
    setWasteDate(todayStr());
    setShowWasteModal(true);
  };

  const handleWasteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(wasteAmount);
    if (!wasteIngredientId || !(amt > 0)) return;

    try {
      await inventoryAPI.reportWaste({ ingredient_id: parseInt(wasteIngredientId, 10), amount: amt, date: wasteDate });
      setShowWasteModal(false);
      fetchInventory();
    } catch (err) {
      alertCard({
        title: 'Could not report waste',
        message: err instanceof Error ? err.message : 'Failed to report waste',
      });
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', background: '#F7F9FC', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '20px 32px',
        background: '#FFFFFF',
        borderBottom: '1px solid #E5E9F0',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: BLUE_TINT,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Package size={20} color={BLUE} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: '#0F1720', margin: 0 }}>Inventory Management</h1>
            <p style={{ fontSize: 13, color: '#6B7280', margin: '2px 0 0' }}>Track and adjust ingredient stock levels</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={openWasteModal}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 16px', background: '#FFFFFF', color: '#B91C1C',
              borderRadius: 8, border: '1.5px solid #FCA5A5', fontWeight: 600, fontSize: 14,
              cursor: 'pointer', transition: 'background 140ms'
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#FEF2F2'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#FFFFFF'; }}
          >
            <Trash2 size={17} /> Report Waste
          </button>
          <button
            onClick={openYogurtModal}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 16px', background: BLUE_TINT, color: BLUE_DARK,
              borderRadius: 8, border: `1.5px solid ${BLUE}`, fontWeight: 600, fontSize: 14,
              cursor: 'pointer', transition: 'background 140ms'
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#DCEAFA'; }}
            onMouseLeave={e => { e.currentTarget.style.background = BLUE_TINT; }}
          >
            <Droplet size={17} /> Convert to Yogurt
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 18px', background: BLUE, color: '#FFF',
              borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14,
              cursor: 'pointer', boxShadow: '0 4px 10px rgba(27,76,130,0.28)',
              transition: 'background 140ms'
            }}
            onMouseEnter={e => { e.currentTarget.style.background = BLUE_DARK; }}
            onMouseLeave={e => { e.currentTarget.style.background = BLUE; }}
          >
            <Plus size={18} /> New Ingredient
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, padding: 32, overflowY: 'auto' }}>
        <div style={{ marginBottom: 20 }}>
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search ingredients by name or unit..."
            resultCount={visibleIngredients.length}
            totalCount={ingredients.length}
          />
        </div>
        <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #E5E9F0', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: '#F7F9FC', borderBottom: '1px solid #E5E9F0' }}>
                <th style={{ padding: '16px 24px', fontSize: 12, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ingredient</th>
                <th style={{ padding: '16px 24px', fontSize: 12, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current Stock</th>
                <th style={{ padding: '16px 24px', fontSize: 12, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Low Stock Threshold</th>
                <th style={{ padding: '16px 24px', width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Loading inventory...</td>
                </tr>
              ) : visibleIngredients.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>
                    {search.trim()
                      ? `No ingredients match "${search.trim()}".`
                      : 'No ingredients found. Add one to get started.'}
                  </td>
                </tr>
              ) : (
                visibleIngredients.map((ing) => {
                  const isLowStock = ing.stock <= ing.low_stock_threshold;
                  return (
                    <tr 
                      key={ing.id} 
                      style={{ borderBottom: '1px solid #E5E9F0', cursor: 'pointer', transition: 'background 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = BLUE_TINT}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      onClick={() => openEditModal(ing)}
                    >
                      <td style={{ padding: '16px 24px', fontWeight: 600, color: '#0F1720' }}>
                        {ing.name}
                      </td>
                      <td style={{ padding: '16px 24px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: isLowStock ? '#EF4444' : '#0F1720',
                            background: isLowStock ? '#FEF2F2' : 'transparent',
                            padding: isLowStock ? '4px 10px' : '0',
                            borderRadius: 6,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6
                          }}>
                            {isLowStock && <AlertCircle size={15} color="#EF4444" />}
                            {ing.stock} {ing.unit}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '16px 24px', color: '#6B7280', fontSize: 14, fontWeight: 500 }}>
                        {ing.low_stock_threshold} {ing.unit}
                      </td>
                      <td style={{ padding: '16px 24px', textAlign: 'right' }}>
                        <Edit2 size={16} color="#9CA3AF" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Modal */}
      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="New Ingredient" width={440}>
        <form onSubmit={handleAddSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Ingredient Name *</label>
            <input required autoFocus value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. Pure Milk" style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' }} onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }} onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Unit *</label>
            <input required value={addUnit} onChange={e => setAddUnit(e.target.value)} placeholder="e.g. Litre, kg, pcs" style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' }} onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }} onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }} />
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Starting Stock</label>
              <input type="number" step="any" min="0" required value={addStock} onChange={e => setAddStock(e.target.value)} style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' }} onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }} onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Low Threshold</label>
              <input type="number" step="any" min="0" required value={addThreshold} onChange={e => setAddThreshold(e.target.value)} style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC', boxSizing: 'border-box' }} onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }} onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }} />
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Date</label>
            <input type="date" required value={addDate} onChange={e => setAddDate(e.target.value)} style={dateInputStyle} onFocus={dateInputFocus} onBlur={dateInputBlur} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button type="button" onClick={() => setShowAddModal(false)} style={{ padding: '10px 16px', background: '#FFFFFF', color: '#6B7280', borderRadius: 8, border: '1.5px solid #E5E9F0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
            <button type="submit" style={{ padding: '10px 18px', background: BLUE, color: '#FFF', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14, cursor: 'pointer', boxShadow: '0 4px 10px rgba(27,76,130,0.28)' }}>Add Ingredient</button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      {selectedIngredient && (
        <Modal isOpen={showEditModal} onClose={() => setShowEditModal(false)} title={`Adjust ${selectedIngredient.name}`} width={440}>
          <form onSubmit={handleEditSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: BLUE_TINT, borderRadius: 8, padding: '10px 14px', border: '1px solid #C8DCED' }}>
              <span style={{ fontSize: 13, color: '#6B7280' }}>Current Stock: </span>
              <strong style={{ fontSize: 15, color: BLUE_DARK }}>{selectedIngredient.stock} {selectedIngredient.unit}</strong>
            </div>
            
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Stock Adjustment</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select 
                  value={editAction} 
                  onChange={e => setEditAction(e.target.value as any)}
                  style={{ padding: '10px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, background: '#F7F9FC', color: '#0F1720', outline: 'none' }}
                >
                  <option value="add">Add (+)</option>
                  <option value="subtract">Subtract (-)</option>
                  <option value="set">Set to (=)</option>
                </select>
                <input 
                  type="number" 
                  step="any" 
                  placeholder="Amount" 
                  autoFocus
                  value={editAmount} 
                  onChange={e => setEditAmount(e.target.value)} 
                  style={{ flex: 1, padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC' }} 
                  onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
                />
                <span style={{ display: 'flex', alignItems: 'center', padding: '0 10px', color: '#6B7280', fontSize: 14, background: '#F1F4F9', borderRadius: 8, fontWeight: 600 }}>
                  {selectedIngredient.unit}
                </span>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Low Stock Threshold</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="number"
                  step="any"
                  required
                  value={editThreshold}
                  onChange={e => setEditThreshold(e.target.value)}
                  style={{ flex: 1, padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, outline: 'none', background: '#F7F9FC' }}
                  onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
                />
                <span style={{ display: 'flex', alignItems: 'center', padding: '0 10px', color: '#6B7280', fontSize: 14, background: '#F1F4F9', borderRadius: 8, fontWeight: 600 }}>
                  {selectedIngredient.unit}
                </span>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Date</label>
              <input type="date" required value={editDate} onChange={e => setEditDate(e.target.value)} style={dateInputStyle} onFocus={dateInputFocus} onBlur={dateInputBlur} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button type="button" onClick={() => setShowEditModal(false)} style={{ padding: '10px 16px', background: '#FFFFFF', color: '#6B7280', borderRadius: 8, border: '1.5px solid #E5E9F0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
              <button type="submit" style={{ padding: '10px 18px', background: BLUE, color: '#FFF', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14, cursor: 'pointer', boxShadow: '0 4px 10px rgba(27,76,130,0.28)' }}>Save Changes</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Convert to Yogurt Modal */}
      <Modal isOpen={showYogurtModal} onClose={() => setShowYogurtModal(false)} title="Convert Milk to Yogurt" width={440}>
        <form onSubmit={handleConvertSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: BLUE_TINT, borderRadius: 8, padding: '10px 14px', border: '1px solid #C8DCED', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: '#6B7280' }}>
              Milk in stock: <strong style={{ color: BLUE_DARK }}>{milkIngredient ? `${milkIngredient.stock} ${milkIngredient.unit}` : '—'}</strong>
            </span>
            <span style={{ fontSize: 13, color: '#6B7280' }}>
              Yogurt in stock: <strong style={{ color: BLUE_DARK }}>{yogurtIngredient ? `${yogurtIngredient.stock} ${yogurtIngredient.unit}` : '—'}</strong>
            </span>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Milk Used ({milkIngredient?.unit || 'Litre'})</label>
            <input type="number" step="any" min="0" required autoFocus value={yogurtMilkAmount} onChange={e => setYogurtMilkAmount(e.target.value)} placeholder="e.g. 5" style={dateInputStyle} onFocus={dateInputFocus} onBlur={dateInputBlur} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Yogurt Added (grams)</label>
            <input type="number" step="any" min="0" required value={yogurtAmount} onChange={e => setYogurtAmount(e.target.value)} placeholder="e.g. 4500" style={dateInputStyle} onFocus={dateInputFocus} onBlur={dateInputBlur} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Date</label>
            <input type="date" required value={yogurtDate} onChange={e => setYogurtDate(e.target.value)} style={dateInputStyle} onFocus={dateInputFocus} onBlur={dateInputBlur} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button type="button" onClick={() => setShowYogurtModal(false)} style={{ padding: '10px 16px', background: '#FFFFFF', color: '#6B7280', borderRadius: 8, border: '1.5px solid #E5E9F0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
            <button type="submit" style={{ padding: '10px 18px', background: BLUE, color: '#FFF', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14, cursor: 'pointer', boxShadow: '0 4px 10px rgba(27,76,130,0.28)' }}>Convert</button>
          </div>
        </form>
      </Modal>

      {/* Report Waste Modal */}
      <Modal isOpen={showWasteModal} onClose={() => setShowWasteModal(false)} title="Report Waste" width={440}>
        <form onSubmit={handleWasteSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Ingredient</label>
            <select
              required
              value={wasteIngredientId}
              onChange={e => setWasteIngredientId(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #E5E9F0', borderRadius: 8, fontSize: 14, background: '#F7F9FC', color: '#0F1720', outline: 'none', boxSizing: 'border-box' }}
            >
              {ingredients.map(ing => (
                <option key={ing.id} value={ing.id}>{ing.name} ({ing.stock} {ing.unit} in stock)</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Amount Wasted</label>
            <input type="number" step="any" min="0" required value={wasteAmount} onChange={e => setWasteAmount(e.target.value)} placeholder="e.g. 2" style={dateInputStyle} onFocus={dateInputFocus} onBlur={dateInputBlur} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Date</label>
            <input type="date" required value={wasteDate} onChange={e => setWasteDate(e.target.value)} style={dateInputStyle} onFocus={dateInputFocus} onBlur={dateInputBlur} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button type="button" onClick={() => setShowWasteModal(false)} style={{ padding: '10px 16px', background: '#FFFFFF', color: '#6B7280', borderRadius: 8, border: '1.5px solid #E5E9F0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
            <button type="submit" style={{ padding: '10px 18px', background: '#B91C1C', color: '#FFF', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14, cursor: 'pointer', boxShadow: '0 4px 10px rgba(185,28,28,0.28)' }}>Report Waste</button>
          </div>
        </form>
      </Modal>
      {dialog}
    </div>
  );
}
