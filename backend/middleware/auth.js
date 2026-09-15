/**
 * Session tokens and role enforcement.
 *
 * Until now every permission check lived in the React app: the sidebar hid
 * buttons and Home.tsx refused to render a couple of screens. None of that was
 * enforcement — the API honoured any request that reached it, so hiding the
 * Settings button stopped a manager changing the tax rate by accident, not on
 * purpose. Devtools are one keystroke away (F12), which makes the distinction
 * matter.
 *
 * A successful PIN login now issues a token. Mutating routes require one, and
 * the admin-only routes require an admin token, so a manager genuinely cannot
 * change prices, settings, the menu or staff — whatever the UI is showing.
 *
 * Tokens live in memory. This is a single-till app whose backend is restarted
 * with it, and a restart simply means everyone signs in again.
 */

const crypto = require('crypto');

/** Sessions expire after this long without use, matching the UI's auto-lock. */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/** token -> { staffId, name, role, expiresAt } */
const sessions = new Map();

/**
 * Roles that carry full access.
 *
 * 'Owner' is the historical name of the admin role and is still what the
 * shop's own account uses, so both are honoured rather than forcing a rename
 * that would lock the owner out on first launch.
 */
const ADMIN_ROLES = new Set(['Admin', 'Owner']);

function isAdminRole(role) {
  return ADMIN_ROLES.has(String(role || ''));
}

function pruneExpired(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function createSession(staff) {
  pruneExpired();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    staffId: staff.id,
    name: staff.name,
    role: staff.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function destroySession(token) {
  return sessions.delete(token);
}

function readToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Resolve the caller's session, sliding its expiry on each use so an active
 * till never logs itself out mid-shift.
 */
function getSession(req) {
  const token = readToken(req);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { ...session, token };
}

/** Attaches req.user when a valid token is present. Never rejects. */
function attachUser(req, res, next) {
  req.user = getSession(req);
  next();
}

/** Requires any signed-in user. */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in to continue', code: 'UNAUTHENTICATED' });
  }
  next();
}

/** Requires an admin. Managers get a message naming the reason. */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in to continue', code: 'UNAUTHENTICATED' });
  }
  if (!isAdminRole(req.user.role)) {
    return res.status(403).json({
      error: 'This action is restricted to an administrator.',
      code: 'FORBIDDEN',
    });
  }
  next();
}

/**
 * Guard only the methods that change something, leaving reads open to any
 * signed-in user. The manager has to read the menu, the deals and the settings
 * to ring up a sale at all — it is writing them that is restricted.
 */
function adminOnlyWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return requireAuth(req, res, next);
  }
  return requireAdmin(req, res, next);
}

module.exports = {
  ADMIN_ROLES,
  isAdminRole,
  createSession,
  destroySession,
  getSession,
  attachUser,
  requireAuth,
  requireAdmin,
  adminOnlyWrites,
  sessions,
};
