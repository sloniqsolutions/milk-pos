const BASE_URL = 'http://localhost:3001/api';

/**
 * Session token.
 *
 * The backend now enforces roles rather than trusting the UI, so every request
 * carries the token issued at login. It is held here (and mirrored into
 * localStorage by AuthContext) so a page reload keeps the session.
 */
const TOKEN_KEY = 'pos_session_token';

let authToken: string | null = null;
try {
  authToken = localStorage.getItem(TOKEN_KEY);
} catch (e) {
  authToken = null;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    // A blocked localStorage must not stop the till working this session.
  }
}

export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Called when the backend rejects our token, so the app can drop the user back
 * to the PIN screen instead of silently failing every request. AuthContext
 * registers the handler.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn;
}

/** Raised so callers can tell "not allowed" apart from a generic failure. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T = unknown>(method: string, path: string, body: unknown = null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const options: RequestInit = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${BASE_URL}${path}`, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));

    // 401 means the token is gone or expired: sign out rather than leaving the
    // user on a screen where nothing works. 403 is a live session without the
    // rights for this action, which is a message, not a sign-out.
    // A wrong PIN on a confirm-your-PIN prompt is also a 401, but the session
    // is fine — see backend/routes/cloud.js's restore-from-cloud.
    if (response.status === 401 && error.code !== 'INVALID_PIN') {
      setAuthToken(null);
      if (onUnauthorized) onUnauthorized();
    }

    throw new ApiError(error.error || 'Request failed', response.status, error.code);
  }
  return response.json();
}

interface MenuItem {
  id?: number;
  name: string;
  price: number;
  category: string;
  [key: string]: unknown;
}

interface Order {
  id?: number;
  items: unknown[];
  total: number;
  [key: string]: unknown;
}

interface Staff {
  id: number;
  name: string;
  role: string;
  pin?: string;
  color?: string;
  active?: number;
  [key: string]: unknown;
}

interface Settings {
  restaurant_name?: string;
  [key: string]: any;
}

interface ReportParams {
  startDate?: string;
  endDate?: string;
  [key: string]: unknown;
}

export const menuAPI = {
  getAll: () => request<MenuItem[]>('GET', '/menu'),
  create: (item: MenuItem) => request<MenuItem>('POST', '/menu', item),
  update: (id: number, item: MenuItem) => request<MenuItem>(`PUT`, `/menu/${id}`, item),
  delete: (id: number) => request<void>('DELETE', `/menu/${id}`),
};

export const ordersAPI = {
  create: (order: Order) => request<Order>('POST', '/orders', order),
  getAll: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<Order[]>(`GET`, `/orders${qs ? `?${qs}` : ''}`);
  },
  getOne: (id: number) => request<Order>('GET', `/orders/${id}`),
  void: (id: number) => request<Order>('PUT', `/orders/${id}/void`),
};

interface Customer {
  id?: number;
  name: string;
  phone?: string;
  address?: string;
  notes?: string;
  balance?: number;
  [key: string]: unknown;
}

export const customersAPI = {
  getAll: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<Customer[]>('GET', `/customers${qs ? `?${qs}` : ''}`);
  },
  getOne: (id: number) => request<Customer & { orders: unknown[]; payments: unknown[] }>('GET', `/customers/${id}`),
  create: (data: Customer) => request<{ id: number }>('POST', '/customers', data),
  update: (id: number, data: Customer) => request<{ success: boolean }>('PUT', `/customers/${id}`, data),
  recordPayment: (id: number, data: { amount: number; note?: string }) =>
    request<{ id: number }>('POST', `/customers/${id}/payments`, data),
};

export const reportsAPI = {
  kpi: (params: ReportParams) => request<Record<string, unknown>>('GET', `/reports/kpi?${new URLSearchParams(params as Record<string, string>).toString()}`),
  revenueOverTime: (params: ReportParams) => request<Record<string, unknown>>('GET', `/reports/revenue-over-time?${new URLSearchParams(params as Record<string, string>).toString()}`),
  topItems: (params: ReportParams) => request<Record<string, unknown>>('GET', `/reports/top-items?${new URLSearchParams(params as Record<string, string>).toString()}`),
  byCategory: (params: ReportParams) => request<Record<string, unknown>>('GET', `/reports/by-category?${new URLSearchParams(params as Record<string, string>).toString()}`),
  hourlyHeatmap: (params: ReportParams) => request<Record<string, unknown>>('GET', `/reports/hourly-heatmap?${new URLSearchParams(params as Record<string, string>).toString()}`),
  cashierPerformance: (params: ReportParams) => request<Record<string, unknown>>('GET', `/reports/cashier-performance?${new URLSearchParams(params as Record<string, string>).toString()}`),
  detailed: (params: ReportParams) => request<Record<string, unknown>>('GET', `/reports/detailed?${new URLSearchParams(params as Record<string, string>).toString()}`),
  /** One row per item sold, for the item-level CSV export. */
  lineItems: (params: ReportParams) => request<Record<string, unknown>[]>('GET', `/reports/line-items?${new URLSearchParams(params as Record<string, string>).toString()}`),
  net: (params: ReportParams) => request<{ revenue: number; expenses: number; net: number }>('GET', `/reports/net?${new URLSearchParams(params as Record<string, string>).toString()}`),
  /** One row per day per ingredient — sold/restocked/converted/waste that day,
   * plus closing stock and a days-remaining projection. See
   * backend/routes/reports.js's own /stock-movement for the full reasoning. */
  stockMovement: (params: ReportParams) => request<Record<string, unknown>[]>('GET', `/reports/stock-movement?${new URLSearchParams(params as Record<string, string>).toString()}`),
};

/**
 * The backend's own status. `setup` says whether a new install is still catching up
 * with its branch's data from the cloud (backend/sync/bootstrap.js), which the sign-in
 * screen waits for rather than letting someone in half way through it.
 */
export const systemAPI = {
  health: () => request<{ status: string; setup?: { state: string; seconds?: number } }>('GET', '/health'),
};

export const settingsAPI = {
  getAll: () => request<Settings>('GET', '/settings'),
  update: (data: Settings) => request<Settings>('PUT', '/settings', data),
  /** Upload a .db file to replace the live database. */
  restore: async (file: File) => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return request<{ success: boolean; message: string }>('POST', '/settings/restore', {
      filename: file.name,
      data: btoa(binary),
    });
  },
  backup: async () => {
    const response = await fetch(`${BASE_URL}/backup`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    if (!response.ok) throw new Error('Backup failed');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pos_backup_${new Date().toISOString().split('T')[0]}.db`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

export const staffAPI = {
  getAll: () => request<Staff[]>('GET', '/staff'),
  /** Names and colours for the sign-in screen; needs no session. */
  directory: () => request<Staff[]>('GET', '/staff/directory'),
  create: (data: Staff) => request<Staff>('POST', '/staff', data),
  update: (id: number, data: Staff) => request<Staff>('PUT', `/staff/${id}`, data),
  delete: (id: number) => request<void>('DELETE', `/staff/${id}`),
  /**
   * Sign in as a specific account. The id is required: the PIN is checked
   * against that account only, so a PIN cannot sign you in as someone else.
   */
  login: (pin: string, staffId: number) =>
    request<Staff & { token: string }>('POST', '/staff/login', { pin, staff_id: staffId }),
  logout: () => request<{ success: boolean }>('POST', '/staff/logout'),
  /** Verifies a restored session against the server instead of trusting localStorage. */
  me: () => request<{ id: number; name: string; role: string; is_admin: boolean }>('GET', '/staff/me'),
  performance: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<Record<string, unknown>>('GET', `/staff/performance${qs ? `?${qs}` : ''}`);
  },
};

interface Ingredient {
  id: number;
  name: string;
  unit: string;
  stock: number;
  low_stock_threshold: number;
  [key: string]: unknown;
}

/**
 * FIX (Bug 3): TopBar.tsx and InventoryScreen.tsx used bare `fetch('/api/...')`.
 * Those resolve against the Vite dev proxy in development but against
 * `file://` in the packaged Electron build, where they fail silently — which
 * meant Inventory was effectively dead in production. Everything now goes
 * through `request()`, which uses the absolute BASE_URL.
 */
export interface InventoryEntry {
  id: number;
  ingredient_id: number;
  type: 'stock' | 'yogurt_conversion' | 'waste';
  amount: number;
  entry_date: string;
  created_at: string;
  ingredient_name: string;
  ingredient_unit: string;
}

export const inventoryAPI = {
  getAll: () => request<Ingredient[]>('GET', '/inventory'),
  create: (data: { name: string; unit: string; stock?: number; low_stock_threshold?: number; date?: string }) =>
    request<Ingredient>('POST', '/inventory', data),
  updateStock: (id: number, body: { action?: 'add' | 'subtract'; amount?: number; stock?: number; date?: string }) =>
    request<Ingredient>('PUT', `/inventory/${id}/stock`, body),
  updateThreshold: (id: number, threshold: number) =>
    request<Ingredient>('PUT', `/inventory/${id}/threshold`, { threshold }),
  lowStock: () => request<{ count: number }>('GET', '/inventory/low-stock'),
  history: (params: { type?: string; ingredient_id?: number; from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') qs.set(k, String(v)); });
    const suffix = qs.toString();
    return request<InventoryEntry[]>('GET', `/inventory/history${suffix ? `?${suffix}` : ''}`);
  },
  convertToYogurt: (body: { milk_amount: number; yogurt_amount: number; date?: string }) =>
    request<{ milk: Ingredient; yogurt: Ingredient }>('POST', '/inventory/convert-to-yogurt', body),
  reportWaste: (body: { ingredient_id: number; amount: number; date?: string }) =>
    request<Ingredient>('POST', '/inventory/waste', body),
};

export const shiftsAPI = {
  current: () => request<Record<string, unknown> | null>('GET', '/shifts/current'),
  history: (limit = 10) => request<Record<string, unknown>[]>('GET', `/shifts/history?limit=${limit}`),
  open: (body: { opening_cash: number; staff_id?: number | null; staff_name?: string }) =>
    request<Record<string, unknown>>('POST', '/shifts/open', body),
  close: (body: { closing_cash: number }) =>
    request<Record<string, unknown>>('POST', '/shifts/close', body),
  summary: (id: number) => request<Record<string, unknown>>('GET', `/shifts/${id}/summary`),
};

export const activationAPI = {
  status: () => request<{ activated: boolean }>('GET', '/activation/status'),
  activate: (key: string) =>
    request<{ activated: boolean }>('POST', '/activation/activate', { key }),
};

export const cloudAPI = {
  status: () => request<{ paired: boolean; cloud_url?: string; branch_id?: number; branch_name?: string }>('GET', '/cloud/status'),
  pair: (body: { cloud_url: string; api_key: string }) =>
    request<{
      success: boolean; branch_name: string;
      // Set when this till had no orders of its own and the cloud already
      // had real history for the branch — see backend/routes/cloud.js's
      // /pair, which pulls that history down automatically in that case.
      auto_restored?: { staff: number; customers: number; orders: number; shifts: number; expenses: number; ingredients: number } | null;
      needs_pin_reset?: string[];
    }>('POST', '/cloud/pair', body),
  unpair: () => request<{ success: boolean }>('POST', '/cloud/unpair'),
  syncNow: () => request<{ success: boolean }>('POST', '/cloud/sync-now'),
  restoreFromCloud: (body: { pin: string }) =>
    request<{
      success: boolean;
      restored: Record<string, number>;
      needs_pin_reset: string[];
    }>('POST', '/cloud/restore-from-cloud', body),
};

export const expensesAPI = {
  categories: () => request<string[]>('GET', '/expenses/categories'),
  list: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ expenses: Record<string, unknown>[]; totals: Record<string, number> }>(
      'GET', `/expenses${qs ? `?${qs}` : ''}`);
  },
  create: (data: { category: string; description?: string; amount: number; from_drawer: boolean }) =>
    request<Record<string, unknown>>('POST', '/expenses', data),
  remove: (id: number) => request<{ success: boolean }>('DELETE', `/expenses/${id}`),
};



