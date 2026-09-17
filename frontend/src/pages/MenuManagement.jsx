// @ts-nocheck
import { useState, useMemo, useEffect } from 'react';
import { Plus, Pencil, Trash2, X, Package, Loader2, GlassWater, Droplet, Coffee, Pin } from 'lucide-react';
import { usePOS } from '@/lib/POSContext';
import { MENU_CATEGORIES, DEFAULT_CATEGORY } from '@/lib/constants';
import { useSettings } from '@/lib/SettingsContext';
import { useAuth } from '@/context/AuthContext';
import { cloudAPI } from '@/api/index';
import SearchBar from '@/components/pos-ui/SearchBar';
import useDialogs from '@/lib/useDialogs';

export const categoriesList = MENU_CATEGORIES;

const categoryIcon = {
  'Milk': GlassWater,
  'Yogurt': Package,
  'Butter & Ghee': Droplet,
  'Cheese & Paneer': Package,
  'Cream': Droplet,
  'Flavoured Drinks': Coffee,
};

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';

/**
 * The two items every other sized Milk/Dahi item prices off (see
 * backend/db/menu-pricing.js — "1 Litre" and "Dahi" are the one true
 * per-litre/per-kilogram rate; 0.5 Litre, 2 Litre, 0.5 KG, 2 KG etc. are all
 * derived from whichever they belong to and can't be edited independently).
 * Pinned to the top of the list and badged so it's obvious at a glance which
 * price actually controls the others.
 */
const isUniversalItem = (item) =>
  (item.category === 'Milk' && item.name === '1 Litre') ||
  (item.category === 'Dahi' && item.name === 'Dahi');

export default function MenuManagement() {
  const { formatMoney } = useSettings();
  const { isAdmin } = useAuth();
  const { menuItems, addMenuItem, updateMenuItem, deleteMenuItem, loading } = usePOS();
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [cloudPaired, setCloudPaired] = useState(false);
  const { confirm, alertCard, dialog } = useDialogs();

  // Mirrors backend/routes/menu.js's blockIfPaired: once this till is paired,
  // every write here is refused anyway (409 MENU_CLOUD_OWNED) so the menu can
  // only ever be edited from the dashboard. Checking this up front means the
  // buttons are gone rather than present-but-guaranteed-to-fail, which is
  // what used to make a blocked delete look like it silently did nothing.
  useEffect(() => {
    cloudAPI.status().then(s => setCloudPaired(!!s.paired)).catch(() => {});
  }, []);

  const canEdit = isAdmin && !cloudPaired;

  const availableCategories = useMemo(() => {
    const live = menuItems.map(i => i.category).filter(Boolean);
    return Array.from(new Set([...MENU_CATEGORIES, ...live]));
  }, [menuItems]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? menuItems.filter(i =>
          String(i.name || '').toLowerCase().includes(q) ||
          String(i.category || '').toLowerCase().includes(q))
      : menuItems;
    // Universal items first, so the price that controls every other
    // Milk/Dahi size is always the first thing seen in the list.
    return [...filtered].sort((a, b) => Number(isUniversalItem(b)) - Number(isUniversalItem(a)));
  }, [menuItems, search]);

  const openAdd = () => { setEditingItem(null); setModalOpen(true); };
  const openEdit = (item) => { setEditingItem(item); setModalOpen(true); };
  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Delete this item?',
      message: 'This removes it from the menu everywhere it is sold. This cannot be undone.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteMenuItem(id);
    } catch (error) {
      alertCard({
        title: 'Could Not Delete',
        message: error.message || 'Something went wrong.',
        tone: 'warning',
      });
    }
  };

  if (loading) {
    return (
      <div className="flex-1 h-full flex items-center justify-center" style={{ background: '#F7F9FC' }}>
        <div className="animate-spin" style={{ color: BLUE }}>
          <Loader2 size={32} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full overflow-y-auto" style={{ padding: 24, background: '#F7F9FC' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 24 }}>
          <h1 style={{ color: '#0F1720', fontWeight: 700, fontSize: 24 }}>Menu Management</h1>
          {canEdit && (
            <button
              onClick={openAdd}
              className="flex items-center gap-2 transition-all duration-150"
              style={{
                height: 40, padding: '0 20px', borderRadius: 10,
                background: BLUE,
                boxShadow: '0 4px 10px rgba(27, 76, 130, 0.28)',
                color: '#FFFFFF', fontSize: 14, fontWeight: 700,
                border: 'none', cursor: 'pointer',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              <Plus size={18} />
              Add New Item
            </button>
          )}
        </div>

        {!isAdmin && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 8,
            background: '#FEF3C7', color: '#92400E', fontSize: 13,
          }}>
            View only — changing the menu is restricted to an administrator.
          </div>
        )}

        {isAdmin && cloudPaired && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 8,
            background: '#EFF6FF', color: '#1E40AF', fontSize: 13,
          }}>
            The menu is managed from the dashboard once this till is connected to the cloud.
            Edit prices and items there — changes sync down automatically.
          </div>
        )}

        <div style={{ marginBottom: 20 }}>
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search items by name or category..."
            resultCount={visibleItems.length}
            totalCount={menuItems.length}
          />
        </div>

        {/* Item List */}
        {visibleItems.map(item => {
          const Icon = categoryIcon[item.category] || Package;
          const universal = isUniversalItem(item);
          return (
            <div
              key={item.id}
              className="flex items-center"
              style={{
                background: universal ? BLUE_TINT : '#FFFFFF',
                borderRadius: 16,
                border: `1px solid ${universal ? BLUE : '#E5E9F0'}`,
                boxShadow: '0 1px 3px rgba(16,40,80,0.06)',
                padding: 16, marginBottom: 10,
              }}
            >
              <div
                className="flex items-center justify-center flex-shrink-0"
                style={{ width: 44, height: 44, borderRadius: 10, background: universal ? '#FFFFFF' : BLUE_TINT }}
              >
                <Icon size={20} color={BLUE} />
              </div>
              <div style={{ marginLeft: 14, flex: 1, minWidth: 0 }}>
                <div style={{ color: '#0F1720', fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {item.name}
                  {universal && (
                    <span
                      title="Every other Milk/Dahi size is priced off this item"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        fontSize: 10.5, fontWeight: 700, color: BLUE_DARK,
                        background: '#FFFFFF', border: `1px solid ${BLUE}`,
                        borderRadius: 999, padding: '2px 8px',
                      }}
                    >
                      <Pin size={10} /> UNIVERSAL PRICE
                    </span>
                  )}
                </div>
                <div style={{ color: '#6B7280', fontSize: 12 }}>{item.category}</div>
                {item.description && (
                  <div
                    style={{
                      color: '#9CA3AF', fontSize: 11, marginTop: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                    title={item.description}
                  >
                    {item.description}
                  </div>
                )}
              </div>
              <div style={{ color: BLUE, fontWeight: 700, fontSize: 16, marginRight: 16 }}>
                {item.has_variants === 1 ? (
                  <span style={{ fontSize: 12, padding: '4px 8px', background: BLUE_TINT, borderRadius: 12, color: BLUE }}>Multiple Sizes</span>
                ) : (
                  formatMoney(item.price)
                )}
              </div>
              {canEdit && (
                <>
                  <IconBtn
                    icon={Pencil}
                    hoverBg={BLUE_TINT}
                    hoverColor={BLUE}
                    defaultColor="#6B7280"
                    onClick={() => openEdit(item)}
                  />
                  <IconBtn
                    icon={Trash2}
                    hoverBg="#FEF2F2"
                    hoverColor="#EF4444"
                    defaultColor="#6B7280"
                    onClick={() => handleDelete(item.id)}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>

      {modalOpen && (
        <ItemModal
          item={editingItem}
          categories={availableCategories}
          onClose={() => setModalOpen(false)}
          onSave={async (data) => {
            try {
              if (editingItem) {
                await updateMenuItem(editingItem.id, data);
              } else {
                await addMenuItem(data);
              }
              setModalOpen(false);
            } catch (error) {
              setModalOpen(false);
              alertCard({
                title: editingItem ? 'Could Not Save Changes' : 'Could Not Add Item',
                message: error.message || 'Something went wrong.',
                tone: 'warning',
              });
            }
          }}
        />
      )}
      {dialog}
    </div>
  );
}

function IconBtn({ icon: Icon, hoverBg, hoverColor, defaultColor, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center transition-all duration-150"
      style={{
        width: 36, height: 36, borderRadius: 8,
        background: 'transparent',
        border: 'none', cursor: 'pointer', marginLeft: 6,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.querySelector('svg').style.color = hoverColor;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.querySelector('svg').style.color = defaultColor;
      }}
    >
      <Icon size={16} style={{ color: defaultColor, transition: 'color 0.15s' }} />
    </button>
  );
}

function ItemModal({ item, categories = MENU_CATEGORIES, onClose, onSave }) {
  const { currencySymbol } = useSettings();
  const [name, setName] = useState(item?.name || '');
  const [price, setPrice] = useState(item?.price || '');
  const [category, setCategory] = useState(item?.category || DEFAULT_CATEGORY);
  const [imageUrl, setImageUrl] = useState(item?.image_url || '');
  const [description, setDescription] = useState(item?.description || '');
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImageUrl(reader.result?.toString() || '');
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSave = () => {
    if (!name.trim() || (item?.has_variants !== 1 && !price)) return;
    const finalCategory = addingCategory && newCategory.trim()
      ? newCategory.trim()
      : category;
    if (!finalCategory) return;
    onSave({
      name: name.trim(),
      price: Number(price) || 0,
      category: finalCategory,
      image_url: imageUrl,
      description: description.trim() || null,
    });
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'rgba(15,23,32,0.5)' }}>
      <div className="rounded-2xl p-6 w-full max-w-md shadow-2xl relative" style={{ background: '#FFFFFF' }}>
        <div className="flex justify-between items-center mb-6">
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0F1720' }}>
            {item ? 'Edit Item' : 'Add New Item'}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280' }}>
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: '#1F2530' }}>Item Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Pure Fresh Milk 1L"
              className="w-full px-3 py-2 rounded-lg border outline-none text-sm"
              style={{ borderColor: '#E5E9F0', background: '#F7F9FC', color: '#0F1720' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: '#1F2530' }}>Price ({currencySymbol})</label>
            <input
              type="number"
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="0.00"
              disabled={item?.has_variants === 1}
              className="w-full px-3 py-2 rounded-lg border outline-none text-sm"
              style={{ borderColor: '#E5E9F0', background: '#F7F9FC', color: '#0F1720' }}
            />
            {item?.has_variants === 1 && (
              <span style={{ fontSize: 11, color: '#6B7280' }}>Managed via size variants</span>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: '#1F2530' }}>Category</label>
            {!addingCategory ? (
              <div className="flex gap-2">
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg border outline-none text-sm"
                  style={{ borderColor: '#E5E9F0', background: '#F7F9FC', color: '#0F1720' }}
                >
                  {categories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setAddingCategory(true)}
                  className="px-3 py-2 text-xs font-semibold rounded-lg border"
                  style={{ borderColor: '#E5E9F0', color: BLUE, background: BLUE_TINT }}
                >
                  + New
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value)}
                  placeholder="Category Name"
                  className="flex-1 px-3 py-2 rounded-lg border outline-none text-sm"
                  style={{ borderColor: '#E5E9F0', background: '#F7F9FC', color: '#0F1720' }}
                />
                <button
                  type="button"
                  onClick={() => setAddingCategory(false)}
                  className="px-3 py-2 text-xs font-semibold rounded-lg border"
                  style={{ borderColor: '#E5E9F0', color: '#6B7280' }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: '#1F2530' }}>Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="e.g. Organic whole milk"
              className="w-full px-3 py-2 rounded-lg border outline-none text-sm"
              style={{ borderColor: '#E5E9F0', background: '#F7F9FC', color: '#0F1720' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: '#1F2530' }}>Image</label>
            <input
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="text-xs"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold rounded-lg border"
            style={{ borderColor: '#E5E9F0', color: '#6B7280' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-semibold rounded-lg text-white"
            style={{ background: BLUE }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}