// @ts-nocheck
import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Phone, MapPin, FileText, Wallet, ArrowDownRight, ArrowUpRight, UserCheck, Edit3, Printer, ArrowLeft, Calendar, DollarSign, Clock } from 'lucide-react';
import moment from 'moment';
import { customersAPI } from '@/api/index';
import { useSettings } from '@/lib/SettingsContext';
import PageHeader from '@/components/pos-ui/PageHeader';
import Modal from '@/components/pos-ui/Modal';
import Toast from '@/components/pos-ui/Toast';

const BLUE = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';
const CREAM = '#FFFDE0';

const SORTS = [
  { id: 'name', label: 'Name (A-Z)' },
  { id: 'balance', label: 'Highest Balance' },
  { id: 'recent', label: 'Recently Added' },
  { id: 'location', label: 'Address' },
];

export default function CustomersScreen() {
  const { formatMoney } = useSettings();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [toast, setToast] = useState(null);

  // New Customer Modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', address: '', notes: '' });

  // Full Screen Customer Detail / Ledger
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerData, setLedgerData] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [recordingPayment, setRecordingPayment] = useState(false);

  // Edit Customer Modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState({ id: null, name: '', phone: '', address: '', notes: '' });
  const [updating, setUpdating] = useState(false);

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customersAPI.getAll({ search, sort });
      setCustomers(data || []);
    } catch (err) {
      setToast({ message: err.message || 'Failed to load customers', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [search, sort]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const openCustomerDetail = async (customer) => {
    setSelectedCustomer(customer);
    setLedgerLoading(true);
    setPaymentAmount('');
    setPaymentNote('');
    try {
      const data = await customersAPI.getOne(customer.id);
      setLedgerData(data);
    } catch (err) {
      setToast({ message: err.message || 'Failed to load customer details', type: 'error' });
    } finally {
      setLedgerLoading(false);
    }
  };

  const handleCreateCustomer = async () => {
    if (!form.name.trim()) {
      setToast({ message: 'Customer name is required', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      await customersAPI.create({
        name: form.name.trim(),
        phone: form.phone.trim() || undefined,
        address: form.address.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      setToast({ message: 'Customer added successfully', type: 'success' });
      setAddModalOpen(false);
      setForm({ name: '', phone: '', address: '', notes: '' });
      fetchCustomers();
    } catch (err) {
      setToast({ message: err.message || 'Failed to create customer', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleEditCustomer = async () => {
    if (!editForm.name.trim()) {
      setToast({ message: 'Customer name is required', type: 'error' });
      return;
    }
    setUpdating(true);
    try {
      await customersAPI.update(editForm.id, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || undefined,
        address: editForm.address.trim() || undefined,
        notes: editForm.notes.trim() || undefined,
      });
      setToast({ message: 'Customer updated successfully', type: 'success' });
      setEditModalOpen(false);
      fetchCustomers();
      if (selectedCustomer && selectedCustomer.id === editForm.id) {
        openCustomerDetail({ ...selectedCustomer, ...editForm });
      }
    } catch (err) {
      setToast({ message: err.message || 'Failed to update customer', type: 'error' });
    } finally {
      setUpdating(false);
    }
  };

  const handleRecordPayment = async () => {
    const amt = Number(paymentAmount);
    if (!amt || amt <= 0) {
      setToast({ message: 'Enter a valid payment amount', type: 'error' });
      return;
    }
    const balance = ledgerData?.balance || 0;
    if (amt > balance) {
      setToast({
        message: balance > 0
          ? `Payment cannot exceed the outstanding balance of ${formatMoney(balance)}`
          : 'This customer has no outstanding balance to pay off',
        type: 'error',
      });
      return;
    }
    setRecordingPayment(true);
    try {
      await customersAPI.recordPayment(selectedCustomer.id, {
        amount: amt,
        note: paymentNote.trim() || undefined,
      });
      setToast({ message: 'Payment recorded successfully', type: 'success' });
      setPaymentAmount('');
      setPaymentNote('');
      openCustomerDetail(selectedCustomer);
      fetchCustomers();
    } catch (err) {
      setToast({ message: err.message || 'Failed to record payment', type: 'error' });
    } finally {
      setRecordingPayment(false);
    }
  };

  const handlePrintStatement = (data) => {
    const rows = [
      ...(data.orders || []).map(o => ({ ...o, type: 'order' })),
      ...(data.payments || []).map(p => ({ ...p, type: 'payment' })),
    ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const rowsHtml = rows.map(item => `
      <tr>
        <td>${moment(item.created_at).format('DD MMM YYYY, h:mm A')}</td>
        <td>${item.type === 'order' ? `Credit Order #${item.id}` : 'Payment Received'}</td>
        <td>${item.type === 'payment' && item.received_by ? item.received_by : ''}</td>
        <td>${item.note || ''}</td>
        <td style="text-align:right; color:${item.type === 'order' ? '#B91C1C' : '#15803D'}; font-weight: 600;">
          ${item.type === 'order' ? '+ ' + formatMoney(item.total) : '- ' + formatMoney(item.amount)}
        </td>
      </tr>
    `).join('');

    const monthlyHtml = (data.monthly_breakdown || []).map(m => `
      <tr>
        <td>${moment(m.month, 'YYYY-MM').format('MMMM YYYY')}</td>
        <td style="text-align:right;">${Number(m.litres).toFixed(1)} L</td>
        <td style="text-align:right;">${formatMoney(m.amount)}</td>
      </tr>
    `).join('');

    const win = window.open('', '_blank', 'width=800,height=900');
    if (!win) {
      setToast({ message: 'Please allow pop-ups to print the statement', type: 'error' });
      return;
    }
    win.document.write(`
      <html>
        <head>
          <title>Statement - ${data.name}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #111827; }
            h1 { font-size: 20px; margin-bottom: 4px; color: #1B4C82; }
            .muted { color: #6B7280; font-size: 13px; margin-bottom: 20px; }
            .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
            .stat { border: 1.5px solid #1B4C82; background: #FFFDE0; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
            .stat .label { font-size: 11px; color: #1B4C82; text-transform: uppercase; font-weight: 700; }
            .stat .value { font-size: 16px; font-weight: 700; margin-top: 2px; color: #123A66; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
            th, td { padding: 8px 10px; font-size: 13px; border-bottom: 1px solid #E5E7EB; text-align: left; }
            th { background: #EAF2FB; color: #1B4C82; font-weight: 700; }
            h2 { font-size: 15px; margin: 24px 0 8px; color: #1B4C82; }
          </style>
        </head>
        <body>
          <h1>${data.name} — Credit Statement</h1>
          <div class="muted">${data.phone || ''} ${data.address ? '· ' + data.address : ''} · Printed ${moment().format('DD MMM YYYY, h:mm A')}</div>

          <div class="stats">
            <div class="stat"><div class="label">Current Balance</div><div class="value">${formatMoney(data.balance)}</div></div>
            <div class="stat"><div class="label">Total Litres</div><div class="value">${Number(data.total_litres || 0).toFixed(1)} L</div></div>
            <div class="stat"><div class="label">Total Dahi</div><div class="value">${Number(data.total_dahi_kg || 0).toFixed(2)} kg</div></div>
            <div class="stat"><div class="label">Total Billed</div><div class="value">${formatMoney(data.total_credited || 0)}</div></div>
            <div class="stat"><div class="label">Total Paid</div><div class="value">${formatMoney(data.total_paid || 0)}</div></div>
            <div class="stat"><div class="label">Oldest Unpaid</div><div class="value">${data.days_outstanding > 0 ? data.days_outstanding + ' days' : '—'}</div></div>
          </div>

          ${monthlyHtml ? `<h2>Monthly Breakdown</h2><table><thead><tr><th>Month</th><th style="text-align:right;">Litres</th><th style="text-align:right;">Amount</th></tr></thead><tbody>${monthlyHtml}</tbody></table>` : ''}

          <h2>Full Transaction History</h2>
          <table>
            <thead><tr><th>Date</th><th>Description</th><th>By</th><th>Note</th><th style="text-align:right;">Amount</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </body>
      </html>
    `);
    win.document.close();
    win.focus();
    win.print();
  };

  // Full Screen Customer Detail View
  if (selectedCustomer) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', background: '#F7F9FC', overflow: 'hidden' }}>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

        {/* Customer Detail Top Bar */}
        <div style={{
          padding: '16px 28px',
          background: '#FFFFFF',
          borderBottom: '1px solid #E5E9F0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button
              onClick={() => { setSelectedCustomer(null); setLedgerData(null); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 8,
                border: '1.5px solid #E5E9F0', background: '#FFFFFF',
                color: BLUE, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                transition: 'all 140ms'
              }}
              onMouseEnter={e => { e.currentTarget.style.background = BLUE_TINT; e.currentTarget.style.borderColor = BLUE; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#FFFFFF'; e.currentTarget.style.borderColor = '#E5E9F0'; }}
            >
              <ArrowLeft size={16} /> All Customers
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 44, height: 44, borderRadius: '50%', background: BLUE, color: CREAM,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                fontWeight: 800, flexShrink: 0
              }}>
                {String(selectedCustomer.name || '?').trim().charAt(0).toUpperCase()}
              </div>
              <div>
                <h1 style={{ fontSize: 20, fontWeight: 800, color: BLUE_DARK, margin: 0 }}>{selectedCustomer.name}</h1>
                <div style={{ fontSize: 13, color: '#6B7280', display: 'flex', gap: 12, marginTop: 2 }}>
                  {selectedCustomer.phone && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Phone size={12} color={BLUE} /> {selectedCustomer.phone}
                    </span>
                  )}
                  {selectedCustomer.address && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <MapPin size={12} color={BLUE} /> {selectedCustomer.address}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => ledgerData && handlePrintStatement(ledgerData)}
              disabled={!ledgerData}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px',
                borderRadius: 8, border: `1.5px solid ${BLUE}`, background: '#FFFFFF',
                color: BLUE, fontSize: 13, fontWeight: 700, cursor: 'pointer'
              }}
            >
              <Printer size={15} /> Print Statement
            </button>
            <button
              onClick={() => {
                setEditForm({
                  id: selectedCustomer.id,
                  name: selectedCustomer.name,
                  phone: selectedCustomer.phone || '',
                  address: selectedCustomer.address || '',
                  notes: selectedCustomer.notes || ''
                });
                setEditModalOpen(true);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px',
                borderRadius: 8, border: 'none', background: BLUE,
                color: '#FFFFFF', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 4px 10px rgba(27,76,130,0.25)'
              }}
            >
              <Edit3 size={15} /> Edit Customer
            </button>
          </div>
        </div>

        {/* Main Content Viewport */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
          {ledgerLoading || !ledgerData ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: '#6B7280', fontSize: 15 }}>
              Loading customer record...
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Top KPI Cards Row */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 16
              }}>
                <div style={{
                  background: CREAM, borderRadius: 12, padding: '18px 20px',
                  border: `2px solid ${BLUE}`, boxShadow: '0 2px 8px rgba(27,76,130,0.08)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      Current Balance
                    </div>
                    <Wallet size={18} color={BLUE} />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: ledgerData.balance > 0 ? '#B45309' : BLUE_DARK, marginTop: 6 }}>
                    {formatMoney(ledgerData.balance)}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
                    {ledgerData.balance > 0 ? 'Payment pending' : 'All accounts clear'}
                  </div>
                </div>

                <div style={{
                  background: '#FFFFFF', borderRadius: 12, padding: '18px 20px',
                  border: '1.5px solid #E5E9F0', boxShadow: '0 1px 4px rgba(0,0,0,0.04)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      Litres Consumed To Date
                    </div>
                    <span style={{ fontSize: 18 }}>🥛</span>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: BLUE_DARK, marginTop: 6 }}>
                    {Number(ledgerData.total_litres || 0).toFixed(1)} L
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Milk bought in all past sales</div>
                </div>

                <div style={{
                  background: '#FFFFFF', borderRadius: 12, padding: '18px 20px',
                  border: '1.5px solid #E5E9F0', boxShadow: '0 1px 4px rgba(0,0,0,0.04)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      Dahi Consumed To Date
                    </div>
                    <span style={{ fontSize: 18 }}>🥣</span>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: BLUE_DARK, marginTop: 6 }}>
                    {Number(ledgerData.total_dahi_kg || 0).toFixed(2)} kg
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Dahi / yogurt bought in all past sales</div>
                </div>

                <div style={{
                  background: '#FFFFFF', borderRadius: 12, padding: '18px 20px',
                  border: '1.5px solid #E5E9F0', boxShadow: '0 1px 4px rgba(0,0,0,0.04)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      Total Credited
                    </div>
                    <DollarSign size={18} color={BLUE} />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: BLUE_DARK, marginTop: 6 }}>
                    {formatMoney(ledgerData.total_credited || 0)}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Total value of credit orders</div>
                </div>

                <div style={{
                  background: '#FFFFFF', borderRadius: 12, padding: '18px 20px',
                  border: '1.5px solid #E5E9F0', boxShadow: '0 1px 4px rgba(0,0,0,0.04)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      Total Received
                    </div>
                    <ArrowDownRight size={18} color="#16A34A" />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#16A34A', marginTop: 6 }}>
                    {formatMoney(ledgerData.total_paid || 0)}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>All payments collected</div>
                </div>

                <div style={{
                  background: '#FFFFFF', borderRadius: 12, padding: '18px 20px',
                  border: '1.5px solid #E5E9F0', boxShadow: '0 1px 4px rgba(0,0,0,0.04)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                      Oldest Unpaid
                    </div>
                    <Clock size={18} color={ledgerData.days_outstanding > 20 ? '#DC2626' : '#6B7280'} />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: ledgerData.days_outstanding > 20 ? '#DC2626' : BLUE_DARK, marginTop: 6 }}>
                    {ledgerData.days_outstanding > 0 ? `${ledgerData.days_outstanding} days` : '—'}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Age of oldest pending bill</div>
                </div>
              </div>

              {/* Middle Section: Quick Record Payment + Monthly Breakdown */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) 2fr', gap: 20 }}>
                {/* Record Payment Box */}
                <div style={{
                  background: '#FFFFFF', borderRadius: 12, padding: 20,
                  border: '1.5px solid #E5E9F0', display: 'flex', flexDirection: 'column', gap: 14
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: BLUE_TINT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Wallet size={18} color={BLUE} />
                    </div>
                    <div>
                      <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0F1720', margin: 0 }}>Record Payment</h3>
                      <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>Collect payment towards balance</p>
                    </div>
                  </div>

                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                      Payment Amount (Rs.) *
                    </label>
                    <input
                      type="number"
                      max={ledgerData?.balance || 0}
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(e.target.value)}
                      placeholder="e.g. 1000"
                      style={{
                        width: '100%', height: 42, borderRadius: 8,
                        border: `1.5px solid ${Number(paymentAmount) > (ledgerData?.balance || 0) ? '#DC2626' : '#E5E9F0'}`,
                        padding: '0 12px', fontSize: 15, fontWeight: 600, color: '#0F1720',
                        outline: 'none', background: '#F7F9FC', boxSizing: 'border-box'
                      }}
                      onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
                      onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
                    />
                    <div style={{
                      fontSize: 11, marginTop: 4,
                      color: Number(paymentAmount) > (ledgerData?.balance || 0) ? '#DC2626' : '#9CA3AF',
                    }}>
                      {Number(paymentAmount) > (ledgerData?.balance || 0)
                        ? `Exceeds the outstanding balance of ${formatMoney(ledgerData?.balance || 0)}`
                        : `Outstanding balance: ${formatMoney(ledgerData?.balance || 0)}`}
                    </div>
                  </div>

                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                      Note / Reference
                    </label>
                    <input
                      type="text"
                      value={paymentNote}
                      onChange={(e) => setPaymentNote(e.target.value)}
                      placeholder="e.g. Cash received / Online transfer"
                      style={{
                        width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                        padding: '0 12px', fontSize: 14, color: '#0F1720',
                        outline: 'none', background: '#F7F9FC', boxSizing: 'border-box'
                      }}
                      onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
                      onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
                    />
                  </div>

                  <button
                    onClick={handleRecordPayment}
                    disabled={!paymentAmount || Number(paymentAmount) <= 0 || Number(paymentAmount) > (ledgerData?.balance || 0) || recordingPayment}
                    style={{
                      height: 42, borderRadius: 8, border: 'none',
                      background: (!paymentAmount || Number(paymentAmount) <= 0 || Number(paymentAmount) > (ledgerData?.balance || 0) || recordingPayment) ? '#E5E9F0' : '#16A34A',
                      color: (!paymentAmount || Number(paymentAmount) <= 0 || Number(paymentAmount) > (ledgerData?.balance || 0) || recordingPayment) ? '#9CA3AF' : '#FFFFFF',
                      fontSize: 14, fontWeight: 700, cursor: recordingPayment ? 'not-allowed' : 'pointer',
                      boxShadow: (paymentAmount && Number(paymentAmount) > 0 && Number(paymentAmount) <= (ledgerData?.balance || 0)) ? '0 3px 8px rgba(22,163,74,0.25)' : 'none',
                      transition: 'background 140ms'
                    }}
                  >
                    {recordingPayment ? 'Saving...' : 'Receive Payment'}
                  </button>
                </div>

                {/* Monthly Breakdown Table */}
                <div style={{
                  background: '#FFFFFF', borderRadius: 12, padding: 20,
                  border: '1.5px solid #E5E9F0', display: 'flex', flexDirection: 'column'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: BLUE_TINT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Calendar size={18} color={BLUE} />
                    </div>
                    <div>
                      <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0F1720', margin: 0 }}>Monthly Breakdown</h3>
                      <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>Usage and spend by calendar month</p>
                    </div>
                  </div>

                  {(!ledgerData.monthly_breakdown || ledgerData.monthly_breakdown.length === 0) ? (
                    <div style={{ padding: '24px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
                      No monthly billing records found.
                    </div>
                  ) : (
                    <div style={{ border: '1px solid #E5E9F0', borderRadius: 8, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                          <tr style={{ background: '#F7F9FC', borderBottom: '1px solid #E5E9F0' }}>
                            <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: BLUE }}>Month</th>
                            <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: BLUE, textAlign: 'right' }}>Litres</th>
                            <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: BLUE, textAlign: 'right' }}>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ledgerData.monthly_breakdown.map(m => (
                            <tr key={m.month} style={{ borderBottom: '1px solid #F1F5F9' }}>
                              <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#0F1720' }}>
                                {moment(m.month, 'YYYY-MM').format('MMMM YYYY')}
                              </td>
                              <td style={{ padding: '10px 14px', fontSize: 13, color: '#0F1720', textAlign: 'right' }}>
                                {Number(m.litres).toFixed(1)} L
                              </td>
                              <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: BLUE_DARK, textAlign: 'right' }}>
                                {formatMoney(m.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Bottom Section: Full Transaction History Table */}
              <div style={{
                background: '#FFFFFF', borderRadius: 12, padding: 20,
                border: '1.5px solid #E5E9F0', display: 'flex', flexDirection: 'column'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0F1720', margin: 0 }}>Full Transaction History</h3>
                    <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0' }}>All credit orders and payment receipts</p>
                  </div>
                </div>

                {(!ledgerData.orders || ledgerData.orders.length === 0) && (!ledgerData.payments || ledgerData.payments.length === 0) ? (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14 }}>
                    No transactions recorded for this customer yet.
                  </div>
                ) : (
                  <div style={{ border: '1px solid #E5E9F0', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ background: '#F7F9FC', borderBottom: '1px solid #E5E9F0' }}>
                          <th style={{ padding: '12px 16px', fontSize: 12, fontWeight: 700, color: BLUE }}>Date & Time</th>
                          <th style={{ padding: '12px 16px', fontSize: 12, fontWeight: 700, color: BLUE }}>Transaction</th>
                          <th style={{ padding: '12px 16px', fontSize: 12, fontWeight: 700, color: BLUE }}>Received By / Staff</th>
                          <th style={{ padding: '12px 16px', fontSize: 12, fontWeight: 700, color: BLUE }}>Notes</th>
                          <th style={{ padding: '12px 16px', fontSize: 12, fontWeight: 700, color: BLUE, textAlign: 'right' }}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          ...(ledgerData.orders || []).map(o => ({ ...o, type: 'order' })),
                          ...(ledgerData.payments || []).map(p => ({ ...p, type: 'payment' }))
                        ]
                          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                          .map((item, idx) => (
                            <tr
                              key={`${item.type}-${item.id}-${idx}`}
                              style={{
                                borderBottom: '1px solid #F1F5F9',
                                background: item.type === 'order' ? '#FFFFFF' : '#F0FDF4'
                              }}
                            >
                              <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280' }}>
                                {moment(item.created_at).format('DD MMM YYYY, h:mm A')}
                              </td>
                              <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#0F1720' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {item.type === 'order' ? (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '2px 8px', borderRadius: 9999, background: '#FEE2E2', color: '#DC2626', fontSize: 11, fontWeight: 700
                                    }}>
                                      <ArrowUpRight size={12} /> Credit Order #{item.id}
                                    </span>
                                  ) : (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '2px 8px', borderRadius: 9999, background: '#DCFCE7', color: '#16A34A', fontSize: 11, fontWeight: 700
                                    }}>
                                      <ArrowDownRight size={12} /> Payment Received
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td style={{ padding: '12px 16px', fontSize: 13, color: '#0F1720' }}>
                                {item.received_by || item.cashier_name || '—'}
                              </td>
                              <td style={{ padding: '12px 16px', fontSize: 13, color: '#6B7280', fontStyle: item.note ? 'normal' : 'italic' }}>
                                {item.note || '—'}
                              </td>
                              <td style={{
                                padding: '12px 16px', fontSize: 14, fontWeight: 700, textAlign: 'right',
                                color: item.type === 'order' ? '#DC2626' : '#16A34A'
                              }}>
                                {item.type === 'order' ? `+ ${formatMoney(item.total)}` : `− ${formatMoney(item.amount)}`}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal: Edit Customer (shared) */}
        <Modal isOpen={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit Customer" width={480}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                Customer Name *
              </label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                style={{
                  width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                  padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                Phone Number
              </label>
              <input
                type="text"
                value={editForm.phone}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                style={{
                  width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                  padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                Address
              </label>
              <input
                type="text"
                value={editForm.address}
                onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                style={{
                  width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                  padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                Notes
              </label>
              <textarea
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                rows={2}
                style={{
                  width: '100%', borderRadius: 8, border: '1.5px solid #E5E9F0',
                  padding: '8px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box', resize: 'vertical'
                }}
              />
            </div>
            <button
              onClick={handleEditCustomer}
              disabled={!editForm.name.trim() || updating}
              style={{
                height: 44, borderRadius: 8, border: 'none', marginTop: 8,
                background: !editForm.name.trim() || updating ? '#E5E9F0' : BLUE,
                color: !editForm.name.trim() || updating ? '#9CA3AF' : '#FFFFFF',
                fontSize: 14, fontWeight: 600, cursor: updating ? 'not-allowed' : 'pointer'
              }}
            >
              {updating ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      </div>
    );
  }

  // Main Customers Screen List View
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', background: '#F7F9FC', overflow: 'hidden' }}>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <PageHeader
        title="Credit Customers"
        subtitle="Manage regular customers, track pending balances, and record payments"
        actionLabel="New Customer"
        onAction={() => setAddModalOpen(true)}
        centered
      />

      <div style={{ padding: '16px 24px', display: 'flex', gap: 12, alignItems: 'center', background: '#FFFFFF', borderBottom: '1px solid #E5E9F0' }}>
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={18} style={{ position: 'absolute', left: 12, color: '#9CA3AF' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers by name, phone or address..."
            style={{
              width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
              paddingLeft: 38, paddingRight: 12, fontSize: 14, outline: 'none', background: '#F7F9FC'
            }}
            onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = '#FFFFFF'; }}
            onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; e.currentTarget.style.background = '#F7F9FC'; }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 500 }}>Sort by:</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            style={{
              height: 42, padding: '0 12px', borderRadius: 8, border: '1.5px solid #E5E9F0',
              background: '#FFFFFF', fontSize: 14, outline: 'none', cursor: 'pointer'
            }}
          >
            {SORTS.map(s => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#6B7280' }}>Loading customers...</div>
        ) : customers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: '#9CA3AF' }}>
            <UserCheck size={48} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <div style={{ fontSize: 16, fontWeight: 600, color: '#374151' }}>No customers found</div>
            <div style={{ fontSize: 14, color: '#6B7280', marginTop: 4 }}>Add a customer to start tracking credit purchases</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {customers.map(c => (
              <div
                key={c.id}
                onClick={() => openCustomerDetail(c)}
                style={{
                  width: '100%', background: CREAM, borderRadius: 14,
                  border: `1.5px solid ${BLUE}`, padding: '20px 24px', cursor: 'pointer',
                  transition: 'all 150ms ease', boxShadow: '0 1px 4px rgba(27,76,130,0.08)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  gap: 20, flexWrap: 'wrap'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = '0 6px 18px rgba(27,76,130,0.18)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.borderColor = BLUE_DARK;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = '0 1px 4px rgba(27,76,130,0.08)';
                  e.currentTarget.style.transform = 'none';
                  e.currentTarget.style.borderColor = BLUE;
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: '1 1 260px', minWidth: 220 }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: '50%', background: BLUE, color: CREAM,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                    fontWeight: 800, flexShrink: 0
                  }}>
                    {String(c.name || '?').trim().charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: BLUE_DARK }}>{c.name}</div>
                    <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13, color: '#3B4A5A' }}>
                      {c.phone && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Phone size={13} color={BLUE} /> {c.phone}
                        </span>
                      )}
                      {c.address && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <MapPin size={13} color={BLUE} /> {c.address}
                        </span>
                      )}
                      {c.notes && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontStyle: 'italic' }}>
                          <FileText size={13} color="#8A95A5" /> {c.notes}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 24, flex: '0 0 auto' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7A8F', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      Balance
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: (c.balance || 0) > 0 ? '#B45309' : BLUE_DARK }}>
                      {formatMoney(c.balance || 0)}
                    </div>
                    <div style={{ fontSize: 12, color: '#6B7A8F', marginTop: 2 }}>
                      {Number(c.total_litres || 0).toFixed(1)} L lifetime
                      {Number(c.total_dahi_kg || 0) > 0 ? ` · ${Number(c.total_dahi_kg).toFixed(2)} kg dahi` : ''}
                    </div>
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 40, height: 40, borderRadius: 10, background: BLUE, flexShrink: 0
                  }}>
                    <Wallet size={18} color={CREAM} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal: New Customer */}
      <Modal isOpen={addModalOpen} onClose={() => setAddModalOpen(false)} title="Add New Customer" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Customer Name *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Rashid Bhai"
              style={{
                width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
              }}
              onFocus={e => { e.currentTarget.style.borderColor = BLUE; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; }}
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Phone Number
            </label>
            <input
              type="text"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="e.g. 0300-1234567"
              style={{
                width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
              }}
              onFocus={e => { e.currentTarget.style.borderColor = BLUE; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; }}
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Address
            </label>
            <input
              type="text"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="e.g. House 12, Street 4"
              style={{
                width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
              }}
              onFocus={e => { e.currentTarget.style.borderColor = BLUE; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; }}
            />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Notes
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Optional notes or instructions"
              rows={2}
              style={{
                width: '100%', borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '8px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box', resize: 'vertical'
              }}
              onFocus={e => { e.currentTarget.style.borderColor = BLUE; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#E5E9F0'; }}
            />
          </div>

          <button
            onClick={handleCreateCustomer}
            disabled={!form.name.trim() || saving}
            style={{
              height: 44, borderRadius: 8, border: 'none', marginTop: 8,
              background: !form.name.trim() || saving ? '#E5E9F0' : BLUE,
              color: !form.name.trim() || saving ? '#9CA3AF' : '#FFFFFF',
              fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: !form.name.trim() || saving ? 'none' : '0 4px 10px rgba(27,76,130,0.28)'
            }}
          >
            {saving ? 'Creating...' : 'Save Customer'}
          </button>
        </div>
      </Modal>

      {/* Modal: Edit Customer */}
      <Modal isOpen={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit Customer" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Customer Name *
            </label>
            <input
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              style={{
                width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Phone Number
            </label>
            <input
              type="text"
              value={editForm.phone}
              onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
              style={{
                width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Address
            </label>
            <input
              type="text"
              value={editForm.address}
              onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
              style={{
                width: '100%', height: 42, borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '0 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box'
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Notes
            </label>
            <textarea
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={2}
              style={{
                width: '100%', borderRadius: 8, border: '1.5px solid #E5E9F0',
                padding: '8px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box', resize: 'vertical'
              }}
            />
          </div>
          <button
            onClick={handleEditCustomer}
            disabled={!editForm.name.trim() || updating}
            style={{
              height: 44, borderRadius: 8, border: 'none', marginTop: 8,
              background: !editForm.name.trim() || updating ? '#E5E9F0' : BLUE,
              color: !editForm.name.trim() || updating ? '#9CA3AF' : '#FFFFFF',
              fontSize: 14, fontWeight: 600, cursor: updating ? 'not-allowed' : 'pointer'
            }}
          >
            {updating ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
