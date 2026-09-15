/**
 * Cloud API client.
 *
 * Same-origin: the cloud serves this build in production, and Vite proxies
 * `/api` across in development. So there is no base URL to configure and no
 * CORS to negotiate — which also means the session cookie needs no
 * `SameSite=None`, and is never readable by this code.
 *
 * `credentials: 'include'` is what carries that cookie. It is httpOnly, so the
 * only evidence here that anyone is signed in is whether a request succeeds.
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

export const auth = {
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me'),
};

export const live = {
  read: () => request('GET', '/live'),
};

const qs = (params) => new URLSearchParams(params).toString();

export const reports = {
  kpi: (p) => request('GET', `/reports/kpi?${qs(p)}`),
  byCategory: (p) => request('GET', `/reports/by-category?${qs(p)}`),
  topItems: (p) => request('GET', `/reports/top-items?${qs(p)}`),
  cashierPerformance: (p) => request('GET', `/reports/cashier-performance?${qs(p)}`),
  detailed: (p) => request('GET', `/reports/detailed?${qs(p)}`),
  lineItems: (p) => request('GET', `/reports/line-items?${qs(p)}`),
  expensesByCategory: (p) => request('GET', `/reports/expenses-by-category?${qs(p)}`),
  expensesDetail: (p) => request('GET', `/reports/expenses-detail?${qs(p)}`),
  daily: (p) => request('GET', `/reports/daily?${qs(p)}`),
};

export const branches = {
  list: () => request('GET', '/branches'),
  /** How current each branch's synced data actually is. */
  completeness: () => request('GET', '/branches/completeness'),
};
