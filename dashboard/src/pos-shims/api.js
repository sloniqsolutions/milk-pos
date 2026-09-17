/**
 * The POS screens' API client, pointed at the cloud.
 *
 * Aliased over `@/api/index` in vite.config.js, so `frontend/src` is reused
 * completely unmodified — the screens keep importing `@/api/index` and get this
 * instead. Two things differ from the till's version, and nothing else:
 *
 *   - **Same-origin `/api`** rather than `http://localhost:3001/api`. The cloud
 *     serves this build, so there is no base URL to configure and no CORS.
 *   - **A session cookie** rather than a Bearer token. It is httpOnly, so this
 *     code cannot read it; `credentials: 'include'` is what carries it.
 *
 * **Most writes are refused, deliberately.** Expenses, shifts and stock belong
 * to the branch that records them, and there is no downlink for any of them —
 * they travel up, and only the menu, the shop-wide settings and the staff
 * roster come down. A write with no downlink could not reach a till that was
 * offline, which is exactly when someone would try, so an explicit refusal
 * beats a button that appears to work.
 *
 * Staff are the exception, and the reason is that a downlink now exists for
 * them: see cloud/routes/staff.js and backend/sync/staff-pull.js.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Request failed', res.status);
  return data;
}

const qs = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v != null && v !== '')
  );
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

/**
 * Refuse a write, with a message that says where the thing actually lives.
 *
 * Thrown rather than silently ignored: the screens already surface a failed
 * call, so the person sees why instead of wondering whether it saved.
 */
const readOnly = (what) => () => {
  throw new ApiError(
    `${what} is recorded at the branch, on the till. The dashboard shows it but cannot change it.`,
    403
  );
};

/* ------------------------------------------------------------- reports -- */

export const reportsAPI = {
  kpi: (p) => request('GET', `/reports/kpi${qs(p)}`),
  revenueOverTime: (p) => request('GET', `/reports/revenue-over-time${qs(p)}`),
  topItems: (p) => request('GET', `/reports/top-items${qs(p)}`),
  byCategory: (p) => request('GET', `/reports/by-category${qs(p)}`),
  hourlyHeatmap: (p) => request('GET', `/reports/hourly-heatmap${qs(p)}`),
  cashierPerformance: (p) => request('GET', `/reports/cashier-performance${qs(p)}`),
  detailed: (p) => request('GET', `/reports/detailed${qs(p)}`),
  lineItems: (p) => request('GET', `/reports/line-items${qs(p)}`),
  expensesByCategory: (p) => request('GET', `/reports/expenses-by-category${qs(p)}`),
  expensesDetail: (p) => request('GET', `/reports/expenses-detail${qs(p)}`),
  daily: (p) => request('GET', `/reports/daily${qs(p)}`),
  // The till's Reports screen (reused here unmodified) calls this as part of
  // its Promise.all alongside every report above — without it, one missing
  // method throws and the whole batch rejects, so the Reports tab loads
  // nothing at all rather than just missing a net-revenue figure.
  net: (p) => request('GET', `/reports/net${qs(p)}`),
};

export const branchesAPI = {
  getAll: () => request('GET', '/branches'),
  completeness: () => request('GET', '/branches/completeness'),
};

export const liveAPI = {
  read: () => request('GET', '/live'),
};

/* -------------------------------------------------- branch-owned, read-only */

export const expensesAPI = {
  list: (params = {}) => request('GET', `/expenses${qs(params)}`),
  categories: () => request('GET', '/expenses/categories'),
  // Real writes now — see cloud/routes/expenses.js. branch_id injected the
  // same way staffAPI.create does below: this dashboard is mono-branch, and
  // the reused ExpensesScreen.jsx form has no branch field to send one from.
  create: (data) => request('POST', '/expenses', { branch_id: 1, ...data }),
  remove: (id) => request('DELETE', `/expenses/1/${id}`),
};

export const shiftsAPI = {
  current: () => request('GET', '/shifts/current'),
  history: (limit = 10) => request('GET', `/shifts/history?limit=${limit}`),
  open: readOnly('A shift'),
  close: readOnly('A shift'),
  summary: (id) => request('GET', `/shifts/${id}/summary`),
};

/**
 * Which branch each staff row belongs to.
 *
 * The till's Staff screen calls `update(id, patch)` with the till's own staff
 * number and nothing else, because on a till that number is unique. Here it is
 * not: branch 1 and branch 2 both have a staff 3, and they are different
 * people, so the cloud addresses them as /staff/:branchId/:localId.
 *
 * Rather than change the shared screen's call signature, the branch is
 * remembered from the list it just rendered. The screen always lists before it
 * edits — there is no way to reach the edit form otherwise — so the entry is
 * always present by the time it is needed.
 */
const branchOfStaff = new Map();

export const staffAPI = {
  getAll: async () => {
    const rows = await request('GET', '/staff');
    if (Array.isArray(rows)) {
      rows.forEach(r => { if (r && r.id != null) branchOfStaff.set(Number(r.id), r.branch_id); });
    }
    return rows;
  },
  performance: (params = {}) => request('GET', `/staff/performance${qs(params)}`),

  // The till's own Cashier.jsx form (reused here as-is — see Shell.jsx) has
  // no branch field at all, because a till only ever means its own branch.
  // The cloud route still requires one, so it defaults here rather than
  // asking the dashboard to grow a field for a choice that does not exist:
  // there is exactly one branch (see cloud/middleware/branch-auth.js's own
  // hardcoded id 1, for the same reason). An explicit branch_id from the
  // caller still wins, in case that ever changes.
  create: (body) => request('POST', '/staff', { branch_id: 1, ...body }),

  update: (id, patch = {}) => {
    const branchId = patch.branch_id != null && patch.branch_id !== ''
      ? Number(patch.branch_id)
      : branchOfStaff.get(Number(id));
    if (!branchId) {
      throw new ApiError(
        'That account has no branch on file, so it cannot be changed from here. Open it at the till.',
        400);
    }
    // Dropped when it is not actually a move. The screen sends the form's
    // branch on every save, and the cloud refuses a genuine branch change —
    // passing an unchanged value through would turn every edit into that
    // refusal.
    const body = { ...patch };
    if (Number(body.branch_id) === branchId) delete body.branch_id;
    return request('PUT', `/staff/${branchId}/${id}`, body);
  },

  delete: (id) => {
    const branchId = branchOfStaff.get(Number(id));
    return request('DELETE', `/staff/${branchId}/${id}`);
  },

  // Not the dashboard's login — that is email and password, in auth.js.
  login: readOnly('Signing in'),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me'),
};

export const inventoryAPI = {
  getAll: () => request('GET', '/inventory'),
  lowStock: () => request('GET', '/inventory').then(
    rows => rows.filter(r => Number(r.stock) <= Number(r.low_stock_threshold))),
  // Real writes now for everything except stock itself — see
  // cloud/routes/inventory.js for why stock stays till-only (it's a real
  // physical count; the dashboard isn't at the shop to have counted it).
  // branch_id injected the same way staffAPI.create does below.
  create: (data) => request('POST', '/inventory', { branch_id: 1, ...data }),
  updateStock: readOnly('Stock'),
  updateThreshold: (id, threshold) => request('PUT', `/inventory/1/${id}`, { low_stock_threshold: threshold }),
  delete: (id) => request('DELETE', `/inventory/1/${id}`),
  // Real read now — see cloud/routes/inventory.js's GET /history, and
  // StockHistoryScreen.tsx (reused unaltered, same as InventoryScreen) in
  // Shell.jsx's own 'stock-history' tab.
  history: (params = {}) => request('GET', `/inventory/history${qs(params)}`),
  // Yogurt conversion and waste reporting stay till-only — a physical event
  // that happens at the shop, not something to log remotely. Stubbed so
  // InventoryScreen's buttons fail with the same explanatory message instead
  // of a raw "not a function" when that shared screen renders on the
  // dashboard.
  convertToYogurt: readOnly('Stock'),
  reportWaste: readOnly('Stock'),
};

/* ------------------------------------------------------------------ menu -- */

/*
 * The menu is the one thing the cloud owns outright, and the only thing that
 * travels down to the tills — so unlike everything above, these are real
 * writes. Every one moves the cloud's menu version, and the branches pull the
 * new menu on their next heartbeat.
 *
 * Deleting retires rather than removes, exactly as the till does: sales
 * reporting joins line items back to the menu, so a hard delete would take the
 * category off every past order.
 */
export const menuAPI = {
  getAll: () => request('GET', '/menu'),
  create: (item) => request('POST', '/menu', item),
  update: (id, item) => request('PUT', `/menu/${id}`, item),
  delete: (id) => request('DELETE', `/menu/${id}`),
};

export const dealsAPI = {
  getAll: () => request('GET', '/deals'),
  getOne: (id) => request('GET', `/deals/${id}`),
  create: (data) => request('POST', '/deals', data),
  update: (id, data) => request('PUT', `/deals/${id}`, data),
  delete: (id) => request('DELETE', `/deals/${id}`),
};

export const ordersAPI = {
  getAll: (params = {}) => request('GET', `/reports/detailed${qs(params)}`),
  create: readOnly('An order'),
  void: readOnly('Voiding an order'),
};

export const settingsAPI = {
  getAll: () => request('GET', '/settings'),
  update: readOnly('Settings'),
};

export const syncAPI = {
  now: readOnly('Syncing'),
  status: () => request('GET', '/branches/completeness'),
};

// The till's module exports these for its own token plumbing; the dashboard has
// none, but the screens import from this module so the names must exist.
export const setAuthToken = () => {};
export const getAuthToken = () => null;
export const setUnauthorizedHandler = () => {};
