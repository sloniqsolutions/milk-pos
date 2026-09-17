/**
 * Shared plain-HTTP client for talking to the cloud.
 *
 * No dependency beyond Node's own `http`/`https` on purpose — this is the
 * only thing the till and the cloud need to agree on, and adding a library
 * here would be one more thing that has to be installed correctly on a
 * machine that might be offline when it matters most.
 *
 * Used by db/cloud-sync.js (pushing sales), sync/downlink.js (pulling the
 * menu/staff/settings) and sync/heartbeat.js (the live status ping) — each
 * previously carried its own copy of this.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * @param {Buffer|null} payload  Already-encoded bytes, or null for no body.
 * @param {object} extraHeaders  Merged in after Authorization/Content-Length,
 *   so a caller sending a non-JSON body (backup upload's gzip stream, with
 *   its own Content-Type and X-Backup-* headers) can override both.
 */
function requestRaw(method, cloudUrl, path, apiKey, payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, cloudUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;

    // Pairing (see routes/cloud.js) has no key yet — it's what the call is
    // exchanging a one-time code *for*. Every other caller passes one.
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    if (payload) headers['Content-Length'] = payload.length;
    Object.assign(headers, extraHeaders);

    const req = lib.request(url, { method, headers, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
        } else {
          let message = `HTTP ${res.statusCode}`;
          try { message = JSON.parse(data).error || message; } catch (e) { /* not JSON */ }
          reject(new Error(message));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

function request(method, cloudUrl, path, apiKey, body) {
  const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const headers = payload ? { 'Content-Type': 'application/json' } : {};
  return requestRaw(method, cloudUrl, path, apiKey, payload, headers);
}

const getJson = (cloudUrl, path, apiKey) => request('GET', cloudUrl, path, apiKey, null);
const postJson = (cloudUrl, path, apiKey, body) => request('POST', cloudUrl, path, apiKey, body);
const deleteJson = (cloudUrl, path, apiKey) => request('DELETE', cloudUrl, path, apiKey, null);

/** For a body that isn't JSON — a gzip stream, with its own headers (see sync/backup-push.js). */
const postRaw = (cloudUrl, path, apiKey, buffer, headers) =>
  requestRaw('POST', cloudUrl, path, apiKey, buffer, headers);

module.exports = { getJson, postJson, postRaw, deleteJson };
