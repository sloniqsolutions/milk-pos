/**
 * The whole cloud API, as one Vercel function.
 *
 * vercel.json rewrites every /api/* request here, with the path after /api/
 * carried in `__path`. The Express app inside cloud/app.js routes on the full
 * /api/... path, so the original path is put back before it sees the request,
 * whether Vercel passed the original URL or the rewritten one.
 *
 * Deploy with the Vercel project's Root Directory set to `dashboard` so the API
 * and the dashboard share one origin (the session cookie depends on that), and
 * set cloud/.env's variables (DATABASE_URL above all) on the Vercel project.
 */

import cloudApp from '../../cloud/app.js';

export default function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const carried = url.searchParams.get('__path');
  if (carried !== null) {
    url.searchParams.delete('__path');
    const rest = url.searchParams.toString();
    req.url = `/api/${carried.replace(/^\/+/, '')}${rest ? `?${rest}` : ''}`;
  }
  return cloudApp(req, res);
}
