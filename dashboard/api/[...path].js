/**
 * The whole cloud API, as one Vercel serverless function.
 *
 * The `[...path]` filename is Vercel's own catch-all convention — every
 * request under /api/* (/api/auth/login, /api/orders, /api/activation/status,
 * all of it) is routed to this one function, and the Express app inside
 * cloud/app.js does its own routing from there exactly as it does when
 * server.js runs it as a persistent process. Nothing is rewritten or
 * adapted: an Express app is already callable as `(req, res) => {}`, which
 * is all a Vercel Node function needs to be.
 *
 * Deploying this dashboard project on Vercel with its Root Directory set to
 * `dashboard` is what puts this file — and therefore the cloud API — on the
 * same origin as the dashboard's own static build, which is what lets the
 * session cookie stay a plain SameSite=Lax httpOnly cookie (see
 * cloud/app.js's own comment on this). Whatever env vars cloud/.env would
 * hold locally (DATABASE_URL above all) need to be set as this Vercel
 * project's environment variables instead — see cloud/.env.example.
 */

import cloudApp from '../../cloud/app.js';

export default cloudApp;