// @ts-nocheck
import { useState, useEffect, useRef } from 'react';
import { Store, Percent, Receipt, Printer, Clock, Database, Download, Send, Cloud, CheckCircle2, XCircle, LogOut } from 'lucide-react';
import PageHeader from '@/components/pos-ui/PageHeader';
import Toggle from '@/components/pos-ui/Toggle';
import Toast from '@/components/pos-ui/Toast';
import Modal from '@/components/pos-ui/Modal';
import { settingsAPI, reportsAPI, shiftsAPI, cloudAPI } from '@/api/index';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/lib/SettingsContext';
import useDialogs from '@/lib/useDialogs';

const NAV_ITEMS = [
  { id: 'restaurant', label: 'Restaurant', icon: Store },
  { id: 'tax', label: 'Tax & Pricing', icon: Percent },
  { id: 'receipt', label: 'Receipt', icon: Receipt },
  { id: 'printer', label: 'Printer', icon: Printer },
  { id: 'shift', label: 'Shift', icon: Clock },
  { id: 'backup', label: 'Data & Backup', icon: Database },
  { id: 'reports', label: 'Reports', icon: Send },
  { id: 'cloud', label: 'Branch & Cloud', icon: Cloud },
  { id: 'account', label: 'Account', icon: LogOut },
];

const CARD_STYLE = {
  background: '#FFFFFF',
  border: '1px solid #E5E7EB',
  borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
};

const INPUT_STYLE = {
  height: 40,
  border: '1px solid #E5E7EB',
  borderRadius: 8,
  padding: '0 12px',
  fontSize: 14,
  width: '100%',
  outline: 'none',
  fontFamily: "'Inter', sans-serif",
};

function SegmentedButton({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
              background: active ? '#DC2626' : '#FFFFFF',
              color: active ? '#FFFFFF' : '#374151',
              border: active ? '1px solid #DC2626' : '1px solid #E5E7EB',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function FieldLabel({ label, helper }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <label style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{label}</label>
      {helper && <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{helper}</div>}
    </div>
  );
}

export default function Settings() {
  // Saved settings are read back through the shared provider so this screen
  // renders money the same way the rest of the app does. `refreshSettings` is
  // called after a save so the change reaches the sale screen immediately.
  const { formatMoney, currencySymbol, refresh: refreshSettings } = useSettings();
  const { currentUser, logout } = useAuth();
  const [activeSection, setActiveSection] = useState('restaurant');
  const [toast, setToast] = useState(null);
  const { confirm, alertCard, dialog } = useDialogs();
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [checkingLogout, setCheckingLogout] = useState(false);

  /** Same shift-open guard as Sidebar.tsx's own Logout button — see its
   * comment. Added here too since the sidebar's copy can scroll off-screen
   * on Admin (more nav items than Manager) on a short window; this one
   * always has room since Settings' own nav never grows. */
  const handleLogout = async () => {
    if (checkingLogout) return;
    setCheckingLogout(true);
    try {
      const shift = await shiftsAPI.current();
      if (shift) {
        await alertCard({
          title: 'Shift Still Open',
          message: 'Close your shift on the Shifts screen before signing out — the drawer needs to be counted first.',
          tone: 'warning',
        });
        return;
      }
    } catch (e) {
      // Can't reach the backend — don't trap someone who is trying to leave.
    } finally {
      setCheckingLogout(false);
    }
    logout();
  };

  const [profile, setProfile] = useState({
    name: 'Pure Milk', tagline: '', address: '', phone: '', footerMessage: 'Thank you for your purchase!',
  });
  const [profileOriginal, setProfileOriginal] = useState(null);
  const [logoPreview, setLogoPreview] = useState(null);
  const fileInputRef = useRef(null);

  const [tax, setTax] = useState({ rate: 0, currency: 'Rs.', position: 'before', enableTax: false, deliveryPrice: 0, employeeRate: 20 });
  const [taxOriginal, setTaxOriginal] = useState(null);

  const [receiptSettings, setReceiptSettings] = useState({
    autoPrint: true, showTax: true, showCashier: true, showOrderNumber: true, showPayment: true, paperSize: '80mm',
  });

  const [printerType, setPrinterType] = useState('USB');
  const [printerIP, setPrinterIP] = useState('');

  // Print mode — 'html' is the existing window.print() path; 'escpos' sends
  // raw commands straight to a Windows printer's spooler (see
  // electron/print-raw-windows.js), for thermal printers whose driver
  // doesn't honor the HTML path's custom page size. availablePrinters comes
  // from Electron's own printer list, so the name picked here is guaranteed
  // valid — not in Electron (e.g. the dashboard reusing this screen), it
  // stays empty and the toggle below is disabled.
  const [printerSettings, setPrinterSettings] = useState({ printMode: 'html', escposPrinter: '' });
  const [availablePrinters, setAvailablePrinters] = useState([]);
  const [testPrinting, setTestPrinting] = useState(false);
  const hasElectronPrinting = typeof window !== 'undefined' && !!window.electronAPI?.printEscPos;

  useEffect(() => {
    if (!hasElectronPrinting) return;
    window.electronAPI.listPrinters().then(setAvailablePrinters).catch(() => setAvailablePrinters([]));
  }, [hasElectronPrinting]);

  /**
   * FIX (Bug 5): shift state used to be pure fiction — `shiftOrders = 23`,
   * `shiftRevenue = 12400` and three invented history rows that lived only in
   * React state and vanished on refresh. Everything below now comes from
   * /api/shifts, where totals are computed from real orders.
   */
  const [currentShift, setCurrentShift] = useState(null);
  const [shiftHistory, setShiftHistory] = useState([]);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [shiftBusy, setShiftBusy] = useState(false);
  const [openShiftModal, setOpenShiftModal] = useState(false);
  const [closeShiftModal, setCloseShiftModal] = useState(false);
  const [openingCash, setOpeningCash] = useState('');
  const [actualCash, setActualCash] = useState('');
  const [duration, setDuration] = useState('0h 0m');

  const shiftOpen = !!currentShift;
  const shiftStart = currentShift?.opened_at
    ? new Date(currentShift.opened_at.replace(' ', 'T') + 'Z').getTime()
    : null;
  const shiftOrders = Number(currentShift?.total_orders || 0);
  const shiftRevenue = Number(currentShift?.total_revenue || 0);
  const shiftCashRevenue = Number(currentShift?.cash_revenue || 0);
  const shiftDiscounts = Number(currentShift?.total_discounts || 0);

  const [lastBackup, setLastBackup] = useState('Never');
  const [restoring, setRestoring] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [resetConfirm, setResetConfirm] = useState('');
  const restoreInputRef = useRef(null);

  /**
   * Cloud connection. `cloudStatus` is null while loading, then either
   * `{ paired: false }` or `{ paired: true, cloud_url, branch_name, ... }` —
   * never the API key itself, which the till never sends back to its own UI
   * once it has written it (see backend/routes/cloud.js).
   */
  const [cloudStatus, setCloudStatus] = useState(null);
  const [cloudUrl, setCloudUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [cloudBusy, setCloudBusy] = useState(false);
  const [unpairModal, setUnpairModal] = useState(false);

  // Restoring from the cloud — see cloudAPI.restoreFromCloud and
  // backend/routes/cloud.js's /restore-from-cloud.
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePin, setRestorePin] = useState('');
  const [cloudRestoring, setCloudRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);

  const loadCloudStatus = () => {
    cloudAPI.status().then(setCloudStatus).catch(() => setCloudStatus({ paired: false }));
  };

  useEffect(() => { loadCloudStatus(); }, []);

  const handlePair = async () => {
    if (!cloudUrl.trim() || !apiKey.trim()) {
      setToast({ message: 'Enter both the cloud address and the API key', type: 'error' });
      return;
    }
    setCloudBusy(true);
    try {
      const result = await cloudAPI.pair({ cloud_url: cloudUrl.trim(), api_key: apiKey.trim() });
      setApiKey('');
      loadCloudStatus();
      setToast({ message: `Connected as ${result.branch_name}. Sales will start syncing.`, type: 'success' });
    } catch (err) {
      setToast({ message: err.message || 'Could not connect to the cloud', type: 'error' });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleUnpair = async () => {
    setCloudBusy(true);
    try {
      await cloudAPI.unpair();
      setUnpairModal(false);
      loadCloudStatus();
      setToast({ message: 'Cloud sync turned off. Nothing local was changed.', type: 'success' });
    } catch (err) {
      setToast({ message: err.message || 'Could not turn off cloud sync', type: 'error' });
    } finally {
      setCloudBusy(false);
    }
  };

  const handleRestoreFromCloud = async () => {
    if (!restorePin) {
      setToast({ message: 'Enter your PIN to confirm.', type: 'error' });
      return;
    }
    setCloudRestoring(true);
    try {
      const result = await cloudAPI.restoreFromCloud({ pin: restorePin });
      setRestorePin('');
      setRestoreOpen(false);
      setRestoreResult(result);
      setToast({
        message: `Restored ${result.restored.orders} orders and ${result.restored.customers} customers from the cloud.`,
        type: 'success',
      });
    } catch (err) {
      setToast({ message: err.message || 'Could not restore from the cloud', type: 'error' });
    } finally {
      setCloudRestoring(false);
    }
  };

  useEffect(() => {
    settingsAPI.getAll().then((data) => {
      const p = {
        name: data.restaurant_name || 'Pure Milk',
        tagline: data.restaurant_tagline || '',
        address: data.restaurant_address || '',
        phone: data.restaurant_phone || '',
        footerMessage: data.receipt_footer || 'Thank you for your purchase!',
      };
      setProfile(p);
      setProfileOriginal(p);
      setTax({
        rate: Number(data.tax_rate) || 0,
        currency: data.currency_symbol || 'Rs.',
        position: data.currency_position || 'before',
        enableTax: Number(data.tax_rate) > 0,
        deliveryPrice: Number(data.delivery_price) || 0,
        employeeRate: Number(data.employee_discount_rate) || 0,
      });
      setTaxOriginal({
        rate: Number(data.tax_rate) || 0,
        currency: data.currency_symbol || 'Rs.',
        position: data.currency_position || 'before',
        enableTax: Number(data.tax_rate) > 0,
        deliveryPrice: Number(data.delivery_price) || 0,
        employeeRate: Number(data.employee_discount_rate) || 0,
      });
      setReceiptSettings({
        autoPrint: data.auto_print === 'true',
        showTax: data.show_tax !== 'false',
        showCashier: data.show_cashier !== 'false',
        showOrderNumber: data.show_order_number !== 'false',
        showPayment: data.show_payment !== 'false',
        paperSize: data.paper_size || '80mm',
      });
      setPrinterSettings({
        printMode: data.print_mode === 'escpos' ? 'escpos' : 'html',
        escposPrinter: data.escpos_printer || '',
      });
      if (data.last_backup) setLastBackup(data.last_backup);
    }).catch(() => {});
  }, []);

  /** FIX (Bug 5): load the real shift state from the backend. */
  const loadShiftData = async () => {
    try {
      const [current, history] = await Promise.all([
        shiftsAPI.current(),
        shiftsAPI.history(5),
      ]);
      setCurrentShift(current);
      setShiftHistory(Array.isArray(history) ? history : []);
    } catch (err) {
      console.error('Failed to load shift data:', err);
    } finally {
      setShiftLoading(false);
    }
  };

  useEffect(() => {
    loadShiftData();
  }, []);

  // Keep the open shift's live totals fresh while the screen is showing.
  useEffect(() => {
    if (activeSection !== 'shift') return;
    const poll = setInterval(loadShiftData, 30000);
    return () => clearInterval(poll);
  }, [activeSection]);

  useEffect(() => {
    if (!shiftOpen || !shiftStart) return;
    const interval = setInterval(() => {
      const diff = Date.now() - shiftStart;
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setDuration(`${h}h ${m}m`);
    }, 1000);
    return () => clearInterval(interval);
  }, [shiftOpen, shiftStart]);

  const profileChanged = profileOriginal && JSON.stringify(profile) !== JSON.stringify(profileOriginal);
  const taxChanged = taxOriginal && JSON.stringify(tax) !== JSON.stringify(taxOriginal);

  const handleSaveProfile = async () => {
    await settingsAPI.update({
      restaurant_name: profile.name,
      restaurant_tagline: profile.tagline,
      restaurant_address: profile.address,
      restaurant_phone: profile.phone,
      receipt_footer: profile.footerMessage,
    });
    setProfileOriginal({ ...profile });
    refreshSettings();
    setToast({ message: 'Settings saved successfully', type: 'success' });
  };

  /**
   * Persist a receipt option immediately.
   *
   * These toggles previously only set React state — there was no Save button
   * in this section and nothing ever wrote them to the backend, so every
   * change was lost on navigation. They are switches, so saving on change is
   * the least surprising behaviour.
   */
  const updateReceiptSetting = async (patch) => {
    const next = { ...receiptSettings, ...patch };
    setReceiptSettings(next);
    try {
      await settingsAPI.update({
        auto_print: String(next.autoPrint),
        show_tax: String(next.showTax),
        show_cashier: String(next.showCashier),
        show_order_number: String(next.showOrderNumber),
        show_payment: String(next.showPayment),
        paper_size: next.paperSize,
      });
      refreshSettings();
    } catch (err) {
      setToast({ message: err.message || 'Could not save receipt settings', type: 'error' });
    }
  };

  const updatePrinterSetting = async (patch) => {
    const next = { ...printerSettings, ...patch };
    setPrinterSettings(next);
    try {
      await settingsAPI.update({
        print_mode: next.printMode,
        escpos_printer: next.escposPrinter,
      });
      refreshSettings();
    } catch (err) {
      setToast({ message: err.message || 'Could not save printer settings', type: 'error' });
    }
  };

  const handleTestPrint = async () => {
    if (printerSettings.printMode === 'escpos') {
      if (!printerSettings.escposPrinter) {
        setToast({ message: 'Choose a printer first.', type: 'error' });
        return;
      }
      setTestPrinting(true);
      try {
        const result = await window.electronAPI.printEscPos({
          printerName: printerSettings.escposPrinter,
          paperWidthMm: receiptSettings.paperSize === '58mm' ? 58 : 80,
          copies: [{
            copyLabel: null,
            shopName: profile.name || 'Pure Milk',
            tagline: profile.tagline,
            addressLine: [profile.address, profile.phone].filter(Boolean).join(' · '),
            metaLeft: [`Date: ${new Date().toLocaleDateString()}`, `Time: ${new Date().toLocaleTimeString()}`],
            metaRight: ['Test Print'],
            customer: null,
            items: [{ name: 'Test Item', qty: 'x1', amount: formatMoney(0) }],
            totalsLines: [{ label: 'Subtotal', value: formatMoney(0) }],
            total: { label: 'TOTAL', value: formatMoney(0) },
            footerMessage: 'This is a test print.',
          }],
        });
        if (result?.success) {
          setToast({ message: 'Test print sent.', type: 'success' });
        } else {
          setToast({ message: result?.error || 'Test print failed.', type: 'error' });
        }
      } catch (err) {
        setToast({ message: err.message || 'Test print failed.', type: 'error' });
      } finally {
        setTestPrinting(false);
      }
    } else {
      window.print();
    }
  };

  const handleSaveTax = async () => {
    await settingsAPI.update({
      tax_rate: String(tax.enableTax ? tax.rate : 0),
      currency_symbol: tax.currency,
      currency_position: tax.position,
      delivery_price: String(tax.deliveryPrice),
      employee_discount_rate: String(tax.employeeRate),
    });
    setTaxOriginal({ ...tax });
    refreshSettings();
    setToast({ message: 'Tax & pricing saved successfully', type: 'success' });
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => setLogoPreview(ev.target.result);
      reader.readAsDataURL(file);
    }
  };

  /**
   * FIX (Bug 5): the "Choose Backup File" button opened a file picker whose
   * <input> had no onChange handler at all — selecting a file did nothing
   * whatsoever, silently. This is the handler that was missing.
   */
  const handleRestoreFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const ok = await confirm({
      title: `Restore from "${file.name}"?`,
      message: 'This replaces ALL current data — orders, menu, staff and settings.',
      note: 'A safety copy of your current database is saved first, and the restore is applied the next time Pure Milk POS starts.',
      tone: 'danger',
      confirmLabel: 'Restore',
    });
    if (!ok) return;

    setRestoring(true);
    try {
      const result = await settingsAPI.restore(file);
      setToast({ message: result.message || 'Backup restored', type: 'success' });
    } catch (err) {
      setToast({ message: err.message || 'Restore failed', type: 'error' });
    } finally {
      setRestoring(false);
    }
  };

  const handleBackup = async () => {
    try {
      await settingsAPI.backup();
      const now = new Date().toLocaleString();
      setLastBackup(now);
      setToast({ message: 'Backup downloaded successfully', type: 'success' });
    } catch {
      setToast({ message: 'Backup failed', type: 'error' });
    }
  };

  /**
   * FIX (Bug 5): these used to only mutate local React state, so a shift
   * "existed" until you refreshed the page. Both now hit the API.
   */
  const handleStartShift = async () => {
    setShiftBusy(true);
    try {
      await shiftsAPI.open({
        opening_cash: Number(openingCash) || 0,
        staff_id: currentUser?.id || null,
        staff_name: currentUser?.name || 'Unknown',
      });
      await loadShiftData();
      setOpenShiftModal(false);
      setOpeningCash('');
      setToast({ message: 'Shift started', type: 'success' });
    } catch (err) {
      setToast({ message: err.message || 'Could not start shift', type: 'error' });
    } finally {
      setShiftBusy(false);
    }
  };

  const handleCloseShift = async () => {
    setShiftBusy(true);
    try {
      const closed = await shiftsAPI.close({ closing_cash: Number(actualCash) || 0 });
      await loadShiftData();
      setCloseShiftModal(false);
      setActualCash('');
      const variance = Number(closed?.variance || 0);
      setToast({
        message: variance === 0
          ? 'Shift closed — drawer balanced'
          : `Shift closed — drawer ${variance > 0 ? 'over' : 'short'} by ${formatMoney(Math.abs(variance))}`,
        type: variance === 0 ? 'success' : 'error',
      });
    } catch (err) {
      setToast({ message: err.message || 'Could not close shift', type: 'error' });
    } finally {
      setShiftBusy(false);
    }
  };

  /**
   * Expected drawer = opening float + CASH sales only. Card and online sales
   * never touch the till, so counting them was part of why the old figure was
   * meaningless. Computed server-side too; this is just the live preview.
   */
  const expectedCash = shiftOpen
    ? Number(currentShift?.opening_cash || 0) + shiftCashRevenue
    : 0;
  const cashDiff = Number(actualCash) - expectedCash;

  const renderRestaurant = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          style={{
            width: 80, height: 80, borderRadius: 9999,
            border: '2px dashed #E5E7EB', background: '#F9FAFB',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}
        >
          {logoPreview ? (
            <img src={logoPreview} alt="Logo" style={{ width: 80, height: 80, objectFit: 'cover' }} />
          ) : (
            <Store size={32} color="#D1D5DB" />
          )}
        </div>
        <div>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              background: '#FFFFFF', border: '1px solid #DC2626', color: '#DC2626',
              height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', cursor: 'pointer',
            }}
          >
            Upload Logo
          </button>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 6 }}>PNG or JPG, min 256x256</div>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoUpload} />
        </div>
      </div>

      <div>
        <FieldLabel label="Restaurant Name" />
        <input style={INPUT_STYLE} value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
      </div>
      <div>
        <FieldLabel label="Tagline" helper="Shown below restaurant name on receipts" />
        <input style={INPUT_STYLE} value={profile.tagline} onChange={(e) => setProfile({ ...profile, tagline: e.target.value })} />
      </div>
      <div>
        <FieldLabel label="Address" />
        <input style={INPUT_STYLE} value={profile.address} onChange={(e) => setProfile({ ...profile, address: e.target.value })} />
      </div>
      <div>
        <FieldLabel label="Phone Number" />
        <input style={INPUT_STYLE} value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
      </div>
      <div>
        <FieldLabel label="Receipt Footer Message" helper="Printed at the bottom of every receipt" />
        <input style={INPUT_STYLE} value={profile.footerMessage} onChange={(e) => setProfile({ ...profile, footerMessage: e.target.value })} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleSaveProfile}
          disabled={!profileChanged}
          style={{
            background: profileChanged ? '#DC2626' : '#E5E7EB',
            color: profileChanged ? '#FFFFFF' : '#9CA3AF',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px',
            border: 'none', cursor: profileChanged ? 'pointer' : 'not-allowed',
          }}
        >
          Save
        </button>
      </div>
    </div>
  );

  const renderTax = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Toggle
        value={tax.enableTax}
        onChange={(v) => setTax({ ...tax, enableTax: v })}
        label="Enable Tax on Orders"
        hint="Adds tax to every order total"
      />
      <div>
        <FieldLabel label="Tax Rate" helper="Percentage added to subtotal" />
        <input
          type="number"
          disabled={!tax.enableTax}
          value={tax.rate}
          onChange={(e) => setTax({ ...tax, rate: Number(e.target.value) })}
          style={{ ...INPUT_STYLE, width: 120, opacity: tax.enableTax ? 1 : 0.5 }}
        />
      </div>
      <div>
        <FieldLabel
          label="Staff Discount"
          helper="Percentage taken off when the cashier marks an order as a staff purchase"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            min="0"
            max="100"
            value={tax.employeeRate}
            onChange={(e) => setTax({ ...tax, employeeRate: Math.max(0, Math.min(100, Number(e.target.value))) })}
            style={{ ...INPUT_STYLE, width: 120 }}
          />
          <span style={{ fontSize: 13, color: '#6B7280' }}>%</span>
        </div>
      </div>
      <div>
        <FieldLabel label="Currency Symbol" />
        <SegmentedButton
          options={[{ value: 'Rs.', label: 'Rs.' }, { value: '$', label: '$' }, { value: '£', label: '£' }, { value: 'AED', label: 'AED' }]}
          value={tax.currency}
          onChange={(v) => setTax({ ...tax, currency: v })}
        />
      </div>
      <div>
        <FieldLabel label="Currency Position" />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {[
            { value: 'before', preview: `${tax.currency} 500` },
            { value: 'after', preview: `500 ${tax.currency}` },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTax({ ...tax, position: opt.value })}
              style={{
                padding: '10px 16px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                background: tax.position === opt.value ? '#DC2626' : '#FFFFFF',
                color: tax.position === opt.value ? '#FFFFFF' : '#374151',
                border: tax.position === opt.value ? '1px solid #DC2626' : '1px solid #E5E7EB',
              }}
            >
              {opt.value === 'before' ? `Before amount (${opt.preview})` : `After amount (${opt.preview})`}
            </button>
          ))}
        </div>
      </div>
      <div>
        <FieldLabel label="Delivery Price" helper="Added to orders when Delivery is selected (e.g. Rs. 150)" />
        <input
          type="number"
          min="0"
          value={tax.deliveryPrice}
          onChange={(e) => setTax({ ...tax, deliveryPrice: Number(e.target.value) })}
          style={{ ...INPUT_STYLE, width: 160 }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleSaveTax}
          disabled={!taxChanged}
          style={{
            background: taxChanged ? '#DC2626' : '#E5E7EB',
            color: taxChanged ? '#FFFFFF' : '#9CA3AF',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px',
            border: 'none', cursor: taxChanged ? 'pointer' : 'not-allowed',
          }}
        >
          Save
        </button>
      </div>
    </div>
  );

  const renderReceipt = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Toggle value={receiptSettings.autoPrint} onChange={(v) => updateReceiptSetting({ autoPrint: v })} label="Auto-print after charge" hint="Automatically sends to printer when order is completed" />
      <Toggle value={receiptSettings.showTax} onChange={(v) => updateReceiptSetting({ showTax: v })} label="Show tax on receipt" hint="Displays tax breakdown line" />
      <Toggle value={receiptSettings.showCashier} onChange={(v) => updateReceiptSetting({ showCashier: v })} label="Show cashier name" hint="Prints who processed the order" />
      <Toggle value={receiptSettings.showOrderNumber} onChange={(v) => updateReceiptSetting({ showOrderNumber: v })} label="Show order number" hint="Prints the order # at the top" />
      <Toggle value={receiptSettings.showPayment} onChange={(v) => updateReceiptSetting({ showPayment: v })} label="Show payment method" hint="Prints Cash or Card" />
      <div>
        <FieldLabel label="Paper Size" />
        <SegmentedButton
          options={[{ value: '58mm', label: '58mm' }, { value: '80mm', label: '80mm' }]}
          value={receiptSettings.paperSize}
          onChange={(v) => updateReceiptSetting({ paperSize: v })}
        />
      </div>
    </div>
  );

  const renderPrinter = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <FieldLabel label="Print Mode" />
        <SegmentedButton
          options={[
            { value: 'html', label: 'Browser Print Dialog' },
            { value: 'escpos', label: 'Direct ESC/POS (Recommended)' },
          ]}
          value={printerSettings.printMode}
          onChange={(v) => updatePrinterSetting({ printMode: v })}
        />
        <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
          {printerSettings.printMode === 'escpos'
            ? "Sends the receipt straight to the printer's own command language, bypassing Windows' page-layout printing entirely. Fixes blank paper feeding before or between copies on thermal printers whose driver doesn't honor a custom page size — including the BlackCopper BC-87AC."
            : "Uses your computer's normal print dialog. Works with any installed printer, but some thermal drivers substitute their own default paper size instead of the receipt's actual size, which can feed blank paper first."}
        </div>
      </div>

      {printerSettings.printMode === 'escpos' && (
        !hasElectronPrinting ? (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            background: '#FEF3C7', border: '1px solid #FDE68A',
            borderRadius: 8, padding: 12,
          }}>
            <Printer size={16} color="#92400E" style={{ marginTop: 1, flexShrink: 0 }} />
            <div style={{ fontSize: 13, color: '#92400E', lineHeight: 1.5 }}>
              Direct ESC/POS printing is only available in the installed till app, not this browser tab.
            </div>
          </div>
        ) : (
          <div>
            <FieldLabel label="Printer" />
            <select
              style={{ ...INPUT_STYLE, width: 280 }}
              value={printerSettings.escposPrinter}
              onChange={(e) => updatePrinterSetting({ escposPrinter: e.target.value })}
            >
              <option value="">Choose a printer…</option>
              {availablePrinters.map((p) => (
                <option key={p.name} value={p.name}>{p.name}{p.isDefault ? ' (Windows default)' : ''}</option>
              ))}
            </select>
            {availablePrinters.length === 0 && (
              <div style={{ fontSize: 12.5, color: '#9CA3AF', marginTop: 6 }}>
                No printers found. Install the BC-87AC in Windows first, then reopen this screen.
              </div>
            )}
          </div>
        )
      )}

      {printerSettings.printMode === 'html' && (
        <div>
          <FieldLabel label="Printer Type" />
          <SegmentedButton
            options={[{ value: 'USB', label: 'USB' }, { value: 'Network', label: 'Network' }, { value: 'Bluetooth', label: 'Bluetooth' }]}
            value={printerType}
            onChange={setPrinterType}
          />
          {printerType === 'Network' && (
            <div style={{ marginTop: 12 }}>
              <FieldLabel label="Printer IP Address" />
              <input style={{ ...INPUT_STYLE, width: 200 }} placeholder="192.168.1.100" value={printerIP} onChange={(e) => setPrinterIP(e.target.value)} />
            </div>
          )}
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 12,
            background: '#FEE2E2', border: '1px solid #FCA5A5',
            borderRadius: 8, padding: 12,
          }}>
            <Printer size={16} color="#92400E" style={{ marginTop: 1, flexShrink: 0 }} />
            <div style={{ fontSize: 13, color: '#92400E', lineHeight: 1.5 }}>
              Receipts print through your computer's print dialog, so any printer
              installed in Windows will work — including USB and network thermal
              printers. Set your receipt printer as the Windows default and choose
              the matching paper size in the Receipt tab.
            </div>
          </div>
        </div>
      )}

      <button
        onClick={handleTestPrint}
        disabled={testPrinting}
        className="flex items-center gap-2"
        style={{
          background: '#FFFFFF', border: '1px solid #DC2626', color: '#DC2626',
          height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px',
          cursor: testPrinting ? 'default' : 'pointer', opacity: testPrinting ? 0.6 : 1,
        }}
      >
        <Printer size={16} /> {testPrinting ? 'Sending…' : 'Send Test Print'}
      </button>
    </div>
  );

  const renderShift = () => (
    <div>
      {!shiftOpen ? (
        <div
          style={{
            border: '2px dashed #E5E7EB', borderRadius: 12, padding: 40,
            textAlign: 'center', marginBottom: 24,
          }}
        >
          <Clock size={40} color="#9CA3AF" style={{ margin: '0 auto 12px' }} />
          <div style={{ fontSize: 16, fontWeight: 600, color: '#374151', marginBottom: 16 }}>No Active Shift</div>
          <button
            onClick={() => setOpenShiftModal(true)}
            style={{
              background: '#DC2626', color: '#FFFFFF', height: 40, borderRadius: 8,
              fontWeight: 600, fontSize: 14, padding: '0 20px', border: 'none', cursor: 'pointer',
            }}
          >
            Open Shift
          </button>
        </div>
      ) : (
        <div style={{ border: '2px solid #22C55E', borderRadius: 12, padding: 24, marginBottom: 24 }}>
          <div style={{ fontSize: 14, color: '#374151', marginBottom: 8 }}>
            Shift Started: {shiftStart ? new Date(shiftStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '9:00 AM'}
          </div>
          <div style={{ fontSize: 14, color: '#374151', marginBottom: 8 }}>Duration: {duration}</div>
          <div style={{ fontSize: 14, color: '#374151', marginBottom: 8 }}>Opened by: {currentShift?.staff_name || '—'}</div>
          <div style={{ fontSize: 14, color: '#374151', marginBottom: 8 }}>Opening float: {formatMoney(currentShift?.opening_cash || 0)}</div>
          <div style={{ fontSize: 14, color: '#374151', marginBottom: 8 }}>Orders so far: {shiftOrders}</div>
          <div style={{ fontSize: 14, color: '#374151', marginBottom: 8 }}>Revenue so far: {formatMoney(shiftRevenue)}</div>
          <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 8 }}>
            Cash: {formatMoney(shiftCashRevenue)} · Card/Online: {formatMoney(currentShift?.non_cash_revenue || 0)}
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 16 }}>
            Expected in drawer: {formatMoney(expectedCash)}
          </div>
          <button
            onClick={() => setCloseShiftModal(true)}
            style={{
              background: '#FFFFFF', border: '1px solid #EF4444', color: '#EF4444',
              height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', cursor: 'pointer',
            }}
          >
            {shiftBusy ? 'Closing…' : 'Close Shift'}
          </button>
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 12 }}>Recent Shifts</div>
      {shiftLoading && (
        <div style={{ fontSize: 13, color: '#9CA3AF', padding: '10px 0' }}>Loading shifts…</div>
      )}

      {!shiftLoading && shiftHistory.length === 0 && (
        <div style={{ fontSize: 13, color: '#9CA3AF', padding: '10px 0' }}>
          No closed shifts yet.
        </div>
      )}

      {shiftHistory.map((sh) => {
        const opened = sh.opened_at ? new Date(sh.opened_at.replace(' ', 'T') + 'Z') : null;
        const closed = sh.closed_at ? new Date(sh.closed_at.replace(' ', 'T') + 'Z') : null;
        const fmtTime = (d) => (d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—');
        const variance = Number(sh.variance || 0);
        return (
          <div key={sh.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #F3F4F6' }}>
            <div style={{ fontSize: 13, color: '#374151' }}>
              {opened ? opened.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
              {' · '}{fmtTime(opened)}–{fmtTime(closed)}
              {' · '}{sh.total_orders} orders
              {' · '}{formatMoney(sh.total_revenue || 0)}
              {' · '}{sh.staff_name || '—'}
            </div>
            <div style={{
              fontSize: 12, fontWeight: 700,
              color: variance === 0 ? '#16A34A' : '#DC2626',
            }}>
              {variance === 0
                ? 'Balanced'
                : `${variance > 0 ? '+' : '−'}${formatMoney(Math.abs(variance))}`}
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderBackup = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ ...CARD_STYLE, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Backup Data</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Save a copy of all your data to your computer</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginTop: 8 }}>Last backup: {lastBackup}</div>
        <button
          onClick={handleBackup}
          className="flex items-center gap-2"
          style={{
            marginTop: 16, background: '#DC2626', color: '#FFFFFF',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', border: 'none', cursor: 'pointer',
          }}
        >
          <Download size={16} /> Backup Now
        </button>
      </div>

      <div style={{ ...CARD_STYLE, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Restore from Backup</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Load data from a previous backup file</div>
        <div style={{
          marginTop: 12, background: '#FEE2E2', border: '1px solid #FCA5A5',
          borderRadius: 8, padding: 12, fontSize: 13, color: '#92400E',
        }}>
          ⚠️ Restoring will replace all current data. This cannot be undone.
        </div>
        <button
          onClick={() => restoreInputRef.current?.click()}
          disabled={restoring}
          style={{
            marginTop: 16, background: '#FFFFFF', border: '1px solid #DC2626', color: '#DC2626',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px',
            cursor: restoring ? 'not-allowed' : 'pointer', opacity: restoring ? 0.6 : 1,
          }}
        >
          {restoring ? 'Verifying backup…' : 'Choose Backup File'}
        </button>
        <input
          ref={restoreInputRef}
          type="file"
          accept=".db"
          onChange={handleRestoreFile}
          style={{ display: 'none' }}
        />
      </div>

      <div style={{
        border: '1px solid #FEE2E2', background: '#FFF5F5', borderRadius: 12, padding: 20,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#DC2626' }}>Danger Zone</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
          Permanently delete all orders, menu items, and settings. This cannot be undone.
        </div>
        <button
          onClick={() => setResetModal(true)}
          style={{
            marginTop: 16, background: '#FFFFFF', border: '1px solid #EF4444', color: '#EF4444',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', cursor: 'pointer',
          }}
        >
          Reset All Data
        </button>
      </div>
    </div>
  );

  const handleSendReport = async () => {
    try {
      setIsGeneratingPdf(true);
      
      // 1. Try Automatic WhatsApp Send First
      setToast({ message: 'Sending automatic report...', type: 'info' });
      let autoSuccess = false;
      try {
        const response = await fetch('http://localhost:3001/api/whatsapp/send-daily-report', { method: 'POST' });
        if (response.ok) {
          autoSuccess = true;
          setToast({ message: 'Report sent automatically via WhatsApp!', type: 'success' });
        } else {
          console.warn('Auto-send failed, falling back to manual generation.');
        }
      } catch (err) {
        console.warn('Auto-send error, falling back to manual generation.', err);
      }

      if (autoSuccess) {
        setIsGeneratingPdf(false);
        return;
      }

      // 2. Fallback: Manual PDF Generation & Share
      setToast({ message: 'Generating manual report PDF...', type: 'info' });
      const today = new Date().toISOString().split('T')[0];
      const data = await reportsAPI.kpi({ startDate: today, endDate: today }).catch(() => ({}));
      
      const totalRevenue = data.total_revenue || 0;
      const totalOrders = data.total_orders || 0;
      
      const topItemsData = await reportsAPI.topItems({ startDate: today, endDate: today }).catch(() => []);
      const topItems = Array.isArray(topItemsData) ? topItemsData.slice(0, 5) : [];
      
      const dateStr = new Date().toLocaleDateString('en-PK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      
      // 1. Generate PDF
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      
      // Header
      doc.setFillColor(220, 38, 38); // Brand red header
      doc.rect(0, 0, 210, 40, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(22);
      doc.setFont("helvetica", "bold");
      doc.text("TASTY BITES - DAILY REPORT", 105, 20, { align: "center" });
      
      doc.setFontSize(12);
      doc.setFont("helvetica", "normal");
      doc.text(`Date: ${dateStr}`, 105, 30, { align: "center" });
      
      doc.setTextColor(0, 0, 0);
      
      // Overview Section
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("Daily Insights (Aaj Ka Khulasa)", 20, 60);
      
      doc.setDrawColor(200, 200, 200);
      doc.line(20, 65, 190, 65);
      
      doc.setFontSize(12);
      doc.setFont("helvetica", "normal");
      doc.text(`Total Orders (Kul Orders):`, 20, 75);
      doc.setFont("helvetica", "bold");
      doc.text(`${totalOrders}`, 150, 75);
      
      doc.setFont("helvetica", "normal");
      doc.text(`Total Revenue (Kul Aamdani):`, 20, 85);
      doc.setFont("helvetica", "bold");
      doc.text(formatMoney(totalRevenue), 150, 85);
      
      let y = 105;
      if (topItems.length > 0) {
        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        doc.text("Top Selling Items (Sab Se Zyada Bikne Wale)", 20, 105);
        doc.line(20, 110, 190, 110);
        y = 120;
        
        doc.setFontSize(12);
        topItems.forEach((item, index) => {
          doc.setFont("helvetica", "normal");
          doc.text(`${index + 1}. ${item.name || 'Item'}`, 20, y);
          doc.setFont("helvetica", "bold");
          doc.text(`Qty: ${item.total_qty || 0}`, 150, y);
          y += 10;
        });
        y += 10;
      }
      
      // Footer / AI Insight
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("Summary (Nateeja)", 20, y);
      doc.line(20, y + 5, 190, y + 5);
      
      doc.setFontSize(12);
      doc.setFont("helvetica", "normal");
      const insightText = totalOrders > 0 
        ? `Aaj ki sales report kafi achi hai! Total ${totalOrders} orders receive hue hain aur overall revenue ${formatMoney(totalRevenue)} raha. Keep it up and try to push more sales on the top items!`
        : `Aaj abhi tak koi order receive nahi hua.`;
      
      const splitText = doc.splitTextToSize(insightText, 170);
      doc.text(splitText, 20, y + 15);
      
      const pdfBlob = doc.output('blob');
      const fileName = `TastyBites_Daily_Report_${today}.pdf`;
      const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });
      
      const textMsg = `*Aaj Ki Report (${dateStr})*\n\n*Orders:* ${totalOrders}\n*Revenue:* ${formatMoney(totalRevenue)}\n\n_Detailed report PDF file attach kar di gayi hai!_`;
      
      // 2. Share or Download
      let shared = false;
      if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        try {
          await navigator.share({
            title: 'Daily Report',
            text: textMsg,
            files: [pdfFile]
          });
          setToast({ message: 'Shared successfully', type: 'success' });
          shared = true;
        } catch (e) {
          console.log('Share API failed or cancelled', e);
        }
      }
      
      if (!shared) {
        // Fallback: Download the file and open WhatsApp web
        doc.save(fileName);
        
        const encodedText = encodeURIComponent(textMsg + "\n\n(Please attach the downloaded PDF file)");
        const phone = '923195304725';
        const url = `https://wa.me/${phone}?text=${encodedText}`;
        
        window.open(url, '_blank');
        setToast({ message: 'Downloaded PDF. Please attach it on WhatsApp...', type: 'warning' });
      }
      
    } catch (error) {
      console.error('Report error:', error);
      setToast({ message: 'Failed to generate report', type: 'error' });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const renderReports = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ ...CARD_STYLE, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Daily Summary Report</div>
        <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Send today's sales and orders summary via WhatsApp</div>
        <button
          onClick={handleSendReport}
          disabled={isGeneratingPdf}
          className="flex items-center gap-2"
          style={{
            marginTop: 16, background: isGeneratingPdf ? '#86EFAC' : '#25D366', color: '#FFFFFF',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', border: 'none', 
            cursor: isGeneratingPdf ? 'not-allowed' : 'pointer', transition: 'all 0.2s ease-in-out'
          }}
        >
          {isGeneratingPdf ? (
            <>
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Generating PDF...
            </>
          ) : (
            <>
              <Send size={16} /> Send to WhatsApp (03195304725)
            </>
          )}
        </button>
      </div>
    </div>
  );

  const renderCloud = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {cloudStatus === null ? (
        <div style={{ fontSize: 13, color: '#9CA3AF' }}>Checking…</div>
      ) : cloudStatus.paired ? (
        <div style={{ ...CARD_STYLE, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CheckCircle2 size={20} color="#16A34A" />
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
              Paired as {cloudStatus.branch_name}
            </div>
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 8 }}>
            Sales, shifts, expenses, stock and staff sync to <strong>{cloudStatus.cloud_url}</strong> as
            they happen. This never affects what works locally — the cloud is a
            mirror, not a requirement.
          </div>
          <button
            onClick={() => setUnpairModal(true)}
            style={{
              marginTop: 16, background: '#FFFFFF', border: '1px solid #EF4444', color: '#EF4444',
              height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', cursor: 'pointer',
            }}
          >
            Turn Off Cloud Sync
          </button>
        </div>
      ) : null}

      {/*
        Pulling everything down from the cloud, for a replacement machine
        where the cloud — not this fresh local database — is the real
        history. See backend/routes/cloud.js's /restore-from-cloud and its
        own note on what cannot come back (payment-by-payment history, a PIN
        that was only ever set at a till).
      */}
      {cloudStatus && cloudStatus.paired && (
        <div style={{ ...CARD_STYLE, padding: 20, border: '1.5px solid #FDE68A', background: '#FFFBEB' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{
              width: 24, height: 24, borderRadius: '50%', background: '#FEF3C7', color: '#92400E',
              fontWeight: 800, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>!</span>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#92400E' }}>Restore from cloud</div>
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#78350F', lineHeight: 1.5 }}>
            If this is a replacement machine and the cloud holds the real
            history — not this fresh local database — pull everything down:
            orders, customers, staff, shifts, expenses and stock. This{' '}
            <strong>replaces</strong> whatever is on this machine right now.
          </p>

          {restoreResult && (
            <div style={{
              background: '#FFFFFF', border: '1px solid #FDE68A', borderRadius: 8,
              padding: '10px 12px', marginBottom: 12, fontSize: 12.5, color: '#78350F',
            }}>
              Restored {restoreResult.restored.orders} orders, {restoreResult.restored.customers} customers,{' '}
              {restoreResult.restored.staff} staff, {restoreResult.restored.shifts} shifts and{' '}
              {restoreResult.restored.expenses} expenses.
              {restoreResult.needs_pin_reset && restoreResult.needs_pin_reset.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <strong>PIN reset needed for: {restoreResult.needs_pin_reset.join(', ')}.</strong>{' '}
                  Their PIN was only ever set on the old till and could not be
                  recovered — set a new one from the Staff screen before they
                  try to sign in.
                </div>
              )}
            </div>
          )}

          {!restoreOpen ? (
            <button
              onClick={() => { setRestoreOpen(true); setRestoreResult(null); }}
              style={{
                height: 38, padding: '0 16px', borderRadius: 8, border: '1.5px solid #B45309',
                background: '#FFFFFF', color: '#B45309', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Restore from cloud…
            </button>
          ) : (
            <div style={{ background: '#FFFFFF', border: '1px solid #FDE68A', borderRadius: 10, padding: 14 }}>
              <label style={{ display: 'block', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Enter your PIN to confirm</span>
                <input
                  type="password"
                  autoFocus
                  value={restorePin}
                  onChange={(e) => setRestorePin(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRestoreFromCloud(); }}
                  style={{ ...INPUT_STYLE, marginTop: 6, maxWidth: 160 }}
                  placeholder="PIN"
                />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => { setRestoreOpen(false); setRestorePin(''); }}
                  disabled={cloudRestoring}
                  style={{
                    height: 38, padding: '0 14px', borderRadius: 8, border: '1px solid #E5E9F0',
                    background: '#FFFFFF', color: '#374151', fontSize: 13, fontWeight: 600,
                    cursor: cloudRestoring ? 'default' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleRestoreFromCloud}
                  disabled={cloudRestoring}
                  style={{
                    height: 38, padding: '0 14px', borderRadius: 8, border: 'none',
                    background: cloudRestoring ? '#FCD34D' : '#B45309', color: '#FFFFFF',
                    fontSize: 13, fontWeight: 700, cursor: cloudRestoring ? 'default' : 'pointer',
                  }}
                >
                  {cloudRestoring ? 'Restoring…' : 'Yes, replace local data with the cloud’s'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {cloudStatus && !cloudStatus.paired ? (
        <div style={{ ...CARD_STYLE, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <XCircle size={20} color="#9CA3AF" />
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Not connected to the cloud</div>
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 8, marginBottom: 16, lineHeight: 1.5 }}>
            Everything here works exactly the same without this. Connecting
            only adds a live mirror of sales, shifts, expenses, stock and
            staff on a dashboard you can check from anywhere. Ask the owner
            for the cloud address and API key, then enter them below.
          </div>
          <div>
            <FieldLabel label="Cloud Address" helper="e.g. https://milkpos.virtiqo.com" />
            <input
              style={INPUT_STYLE}
              value={cloudUrl}
              onChange={(e) => setCloudUrl(e.target.value)}
              placeholder="https://milkpos.virtiqo.com"
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <FieldLabel label="API Key" helper="Given to you by the owner — the same key on every till" />
            <input
              type="password"
              style={{ ...INPUT_STYLE, fontFamily: 'monospace' }}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste the API key"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            onClick={handlePair}
            disabled={cloudBusy}
            style={{
              marginTop: 20,
              background: cloudBusy ? '#E5E7EB' : '#DC2626',
              color: cloudBusy ? '#9CA3AF' : '#FFFFFF',
              height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px',
              border: 'none', cursor: cloudBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {cloudBusy ? 'Connecting…' : 'Connect to Cloud'}
          </button>
        </div>
      ) : null}
    </div>
  );

  const renderAccount = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ ...CARD_STYLE, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
          Signed in as {currentUser?.name || '—'}
        </div>
        <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
          {currentUser?.role || 'Staff'}
        </div>
        <button
          onClick={handleLogout}
          disabled={checkingLogout}
          className="flex items-center gap-2"
          style={{
            marginTop: 16, background: '#FFFFFF', border: '1px solid #EF4444', color: '#EF4444',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px',
            cursor: checkingLogout ? 'default' : 'pointer', opacity: checkingLogout ? 0.6 : 1,
          }}
        >
          <LogOut size={16} /> {checkingLogout ? 'Checking…' : 'Sign Out'}
        </button>
      </div>
    </div>
  );

  const sectionRenderers = {
    restaurant: renderRestaurant,
    tax: renderTax,
    receipt: renderReceipt,
    printer: renderPrinter,
    shift: renderShift,
    backup: renderBackup,
    reports: renderReports,
    cloud: renderCloud,
    account: renderAccount,
  };

  return (
    <div style={{ flex: 1, height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#FFFFFF', fontFamily: "'Inter', sans-serif" }}>
      <div style={{ padding: 24, flex: 1, overflow: 'auto' }}>
        <PageHeader title="Settings" />
        <div style={{ display: 'flex', gap: 20 }}>
          <nav style={{ ...CARD_STYLE, width: 200, flexShrink: 0, padding: 8 }}>
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const active = activeSection === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className="flex items-center"
                  style={{
                    width: '100%', gap: 10, padding: '10px 14px', borderRadius: 8,
                    fontSize: 14, fontWeight: 500, border: 'none', cursor: 'pointer',
                    background: active ? '#FEE2E2' : 'transparent',
                    color: active ? '#DC2626' : '#6B7280',
                  }}
                >
                  <Icon size={18} style={{ color: active ? '#DC2626' : '#6B7280' }} />
                  {label}
                </button>
              );
            })}
          </nav>
          <div style={{ ...CARD_STYLE, flex: 1, padding: 28, minHeight: 500 }}>
            {sectionRenderers[activeSection]?.()}
          </div>
        </div>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      {dialog}

      <Modal isOpen={openShiftModal} onClose={() => setOpenShiftModal(false)} title="Open Shift">
        <div>
          <FieldLabel label={`Opening Cash Amount (${currencySymbol})`} />
          <input style={INPUT_STYLE} type="number" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} />
          <button
            onClick={handleStartShift}
            disabled={shiftBusy}
            style={{
              marginTop: 20,
              background: shiftBusy ? '#E5E7EB' : '#111111',
              color: shiftBusy ? '#9CA3AF' : '#FFFFFF',
              height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', border: 'none', cursor: 'pointer',
            }}
          >
            {shiftBusy ? 'Starting…' : 'Start Shift'}
          </button>
        </div>
      </Modal>

      <Modal isOpen={closeShiftModal} onClose={() => setCloseShiftModal(false)} title="Close Shift" width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 14, color: '#374151' }}>Start: {shiftStart ? new Date(shiftStart).toLocaleTimeString() : '—'}</div>
          <div style={{ fontSize: 14, color: '#374151' }}>End: {new Date().toLocaleTimeString()}</div>
          <div style={{ fontSize: 14, color: '#374151' }}>Total orders: {shiftOrders}</div>
          <div style={{ fontSize: 14, color: '#374151' }}>Total revenue: {formatMoney(shiftRevenue)}</div>
          <div style={{ fontSize: 14, color: '#374151' }}>Total discounts given: {formatMoney(shiftDiscounts)}</div>
          <div style={{ fontSize: 13, color: '#6B7280', paddingTop: 4, borderTop: '1px solid #F3F4F6' }}>
            Opening float: {formatMoney(currentShift?.opening_cash || 0)}
            {' + '}Cash sales: {formatMoney(shiftCashRevenue)}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
            Expected cash in drawer: {formatMoney(expectedCash)}
          </div>
          <div style={{ fontSize: 12, color: '#9CA3AF' }}>
            Card and online sales are excluded — they never enter the till.
          </div>
          <div>
            <FieldLabel label="Actual Cash Count" />
            <input style={INPUT_STYLE} type="number" value={actualCash} onChange={(e) => setActualCash(e.target.value)} />
          </div>
          {actualCash && (
            <div style={{ fontSize: 14, fontWeight: 600, color: cashDiff >= 0 ? '#16A34A' : '#DC2626' }}>
              Cash Difference: {cashDiff >= 0 ? '+' : ''}{formatMoney(cashDiff)}
            </div>
          )}
          <button
            onClick={handleCloseShift}
            disabled={shiftBusy || actualCash === ''}
            style={{
              marginTop: 8,
              background: shiftBusy || actualCash === '' ? '#E5E7EB' : '#111111',
              color: shiftBusy || actualCash === '' ? '#9CA3AF' : '#FFFFFF',
              height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px', border: 'none', cursor: 'pointer',
            }}
          >
            Close Shift
          </button>
        </div>
      </Modal>

      <Modal isOpen={resetModal} onClose={() => { setResetModal(false); setResetConfirm(''); }} title="Reset All Data">
        <p style={{ fontSize: 14, color: '#6B7280', marginBottom: 16 }}>
          This will permanently delete all orders, menu items, and settings. Type CONFIRM to proceed.
        </p>
        <input style={INPUT_STYLE} value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)} placeholder="Type CONFIRM" />
        <button
          disabled={resetConfirm !== 'CONFIRM'}
          onClick={() => {
            setResetModal(false);
            setResetConfirm('');
            setToast({ message: 'All data has been reset', type: 'warning' });
          }}
          style={{
            marginTop: 16, background: resetConfirm === 'CONFIRM' ? '#EF4444' : '#E5E7EB',
            color: resetConfirm === 'CONFIRM' ? '#FFFFFF' : '#9CA3AF',
            height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14, padding: '0 20px',
            border: 'none', cursor: resetConfirm === 'CONFIRM' ? 'pointer' : 'not-allowed',
          }}
        >
          Reset All Data
        </button>
      </Modal>

      <Modal isOpen={unpairModal} onClose={() => setUnpairModal(false)} title="Turn Off Cloud Sync">
        <p style={{ fontSize: 14, color: '#6B7280', marginBottom: 16, lineHeight: 1.5 }}>
          This till stops sending new sales, shifts, expenses, stock and staff
          changes to the cloud. Nothing already synced is deleted, and nothing
          local changes — the dashboard will just stop hearing from this shop
          until it is paired again.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={() => setUnpairModal(false)}
            style={{
              height: 40, padding: '0 16px', borderRadius: 8, border: '1px solid #E5E7EB',
              background: '#FFFFFF', color: '#374151', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleUnpair}
            disabled={cloudBusy}
            style={{
              height: 40, padding: '0 16px', borderRadius: 8, border: 'none',
              background: cloudBusy ? '#E5E7EB' : '#EF4444',
              color: cloudBusy ? '#9CA3AF' : '#FFFFFF',
              fontSize: 14, fontWeight: 600, cursor: cloudBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {cloudBusy ? 'Turning off…' : 'Turn Off Cloud Sync'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
