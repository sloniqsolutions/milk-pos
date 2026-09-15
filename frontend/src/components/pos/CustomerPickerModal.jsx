import { useState, useEffect, useMemo } from 'react';
import { Search, Plus, Phone, MapPin, ArrowLeft, Wallet } from 'lucide-react';
import Modal from '@/components/pos-ui/Modal';
import { customersAPI } from '@/api/index';
import { useSettings } from '@/lib/SettingsContext';
import useDialogs from '@/lib/useDialogs';

const BLUE      = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';
const CREAM     = '#FFFDE0';

export default function CustomerPickerModal({ isOpen, onClose, onSelect }) {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const { formatMoney } = useSettings();
  const { alertCard, dialog } = useDialogs();

  useEffect(() => {
    if (!isOpen) return;
    setSearch('');
    setShowNewForm(false);
    setNewName('');
    setNewPhone('');
    setNewAddress('');
    fetchCustomers();
  }, [isOpen]);

  const fetchCustomers = async () => {
    setLoading(true);
    try {
      const data = await customersAPI.getAll({ sort: 'recent' });
      setCustomers(data);
    } catch (err) {
      console.error('Failed to fetch customers:', err);
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(c =>
      String(c.name || '').toLowerCase().includes(q) ||
      String(c.phone || '').toLowerCase().includes(q)
    );
  }, [customers, search]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const result = await customersAPI.create({
        name: newName.trim(),
        phone: newPhone.trim() || undefined,
        address: newAddress.trim() || undefined,
      });
      onSelect({ id: result.id, name: newName.trim(), phone: newPhone.trim(), address: newAddress.trim(), balance: 0 });
    } catch (err) {
      console.error(err);
      alertCard({
        title: 'Could not add customer',
        message: err instanceof Error ? err.message : 'Failed to add customer',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Modal isOpen={isOpen} onClose={onClose} title="Select Credit Customer" width={460}>
      {!showNewForm ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Search */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={16} style={{ position: 'absolute', left: 12, color: '#9CA3AF', pointerEvents: 'none' }} />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone..."
              style={{
                width: '100%', height: 42, borderRadius: 8,
                border: '1.5px solid #E5E9F0', background: '#F7F9FC',
                padding: '0 12px 0 36px', fontSize: 14, color: '#0F1720',
                outline: 'none', fontFamily: 'Inter, sans-serif', boxSizing: 'border-box',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
            />
          </div>

          {/* Customer list */}
          <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {loading ? (
              <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: '#9CA3AF' }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: '#9CA3AF' }}>
                {search ? `No customers match "${search}".` : 'No customers yet.'}
              </div>
            ) : (
              filtered.map(c => (
                <button
                  key={c.id}
                  onClick={() => onSelect(c)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 14px', borderRadius: 10,
                    border: '1.5px solid #E5E9F0',
                    background: '#FFFFFF', cursor: 'pointer', textAlign: 'left', width: '100%',
                    transition: 'all 140ms',
                    borderLeft: `4px solid ${BLUE}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = BLUE_TINT;
                    e.currentTarget.style.borderColor = BLUE;
                    e.currentTarget.style.borderLeftColor = BLUE;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = '#FFFFFF';
                    e.currentTarget.style.borderColor = '#E5E9F0';
                    e.currentTarget.style.borderLeftColor = BLUE;
                  }}
                >
                  {/* Avatar */}
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%',
                    background: BLUE, color: CREAM,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16, fontWeight: 800, flexShrink: 0,
                  }}>
                    {String(c.name || '?').trim().charAt(0).toUpperCase()}
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: BLUE_DARK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {c.phone && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <Phone size={11} color={BLUE} /> {c.phone}
                        </span>
                      )}
                      {c.address && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <MapPin size={11} color={BLUE} /> {c.address}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Balance badge */}
                  {(c.balance > 0) && (
                    <div style={{
                      flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Wallet size={12} color="#B45309" />
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#B45309' }}>
                          {formatMoney(c.balance)}
                        </span>
                      </div>
                      <span style={{ fontSize: 10, color: '#9CA3AF', marginTop: 1 }}>balance</span>
                    </div>
                  )}
                  {(!c.balance || c.balance <= 0) && (
                    <div style={{ flexShrink: 0 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, color: '#16A34A',
                        background: '#DCFCE7', padding: '2px 8px', borderRadius: 9999,
                      }}>
                        Clear
                      </span>
                    </div>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Add new customer button */}
          <button
            onClick={() => setShowNewForm(true)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              height: 42, borderRadius: 8, border: `1.5px dashed ${BLUE}`,
              background: BLUE_TINT, color: BLUE, fontSize: 14, fontWeight: 600,
              cursor: 'pointer', transition: 'background 140ms',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#D4E8FA'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = BLUE_TINT; }}
          >
            <Plus size={16} /> New Customer
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Back button */}
          <button
            onClick={() => setShowNewForm(false)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
              background: 'none', border: 'none', color: BLUE, fontSize: 13,
              fontWeight: 600, cursor: 'pointer', padding: 0,
            }}
          >
            <ArrowLeft size={14} /> Back to list
          </button>

          {/* Name field */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Customer Name *
            </label>
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Rashid Bhai"
              style={{
                width: '100%', height: 44, borderRadius: 8, boxSizing: 'border-box',
                border: '1.5px solid #E5E9F0', background: '#F7F9FC',
                padding: '0 12px', fontSize: 14, color: '#0F1720',
                outline: 'none', fontFamily: 'Inter, sans-serif',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
            />
          </div>

          {/* Phone field */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Phone Number
            </label>
            <input
              type="text"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="e.g. 0300-1234567"
              style={{
                width: '100%', height: 44, borderRadius: 8, boxSizing: 'border-box',
                border: '1.5px solid #E5E9F0', background: '#F7F9FC',
                padding: '0 12px', fontSize: 14, color: '#0F1720',
                outline: 'none', fontFamily: 'Inter, sans-serif',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
            />
          </div>

          {/* Address field */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Address
            </label>
            <textarea
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              placeholder="House / street / area"
              rows={2}
              style={{
                width: '100%', borderRadius: 8, boxSizing: 'border-box',
                border: '1.5px solid #E5E9F0', background: '#F7F9FC',
                padding: '10px 12px', fontSize: 14, color: '#0F1720',
                outline: 'none', fontFamily: 'Inter, sans-serif', resize: 'vertical',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
            />
          </div>

          {/* Submit */}
          <button
            onClick={handleCreate}
            disabled={!newName.trim() || saving}
            style={{
              height: 44, borderRadius: 8, border: 'none', marginTop: 4,
              background: !newName.trim() || saving ? '#E5E9F0' : BLUE,
              color: !newName.trim() || saving ? '#9CA3AF' : '#FFFFFF',
              fontSize: 14, fontWeight: 600,
              cursor: !newName.trim() || saving ? 'not-allowed' : 'pointer',
              boxShadow: !newName.trim() || saving ? 'none' : '0 4px 10px rgba(27,76,130,0.28)',
              transition: 'background 140ms',
            }}
            onMouseEnter={(e) => { if (newName.trim() && !saving) e.currentTarget.style.background = BLUE_DARK; }}
            onMouseLeave={(e) => { if (newName.trim() && !saving) e.currentTarget.style.background = BLUE; }}
          >
            {saving ? 'Saving...' : 'Add & Select'}
          </button>
        </div>
      )}
    </Modal>
    {dialog}
    </>
  );
}
