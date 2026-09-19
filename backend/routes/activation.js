/**
 * Software activation, from the till's side.
 *
 * Open, deliberately: nothing else on this backend requires a session either
 * before the first staff account signs in, and activation has to work before
 * that — the app shows the activation screen instead of the PIN screen until
 * this says otherwise. See db/activation-config.js and, on the cloud side,
 * cloud/routes/activation.js.
 */

const express = require('express');
const router = express.Router();
const os = require('os');
const { postJson } = require('../db/cloud-http');
const {
  getDeviceId, readActivation, writeActivation, ACTIVATION_URL,
} = require('../db/activation-config');

router.get('/status', (req, res) => {
  res.json({ activated: !!readActivation() });
});

router.post('/activate', async (req, res) => {
  const key = typeof (req.body && req.body.key) === 'string' ? req.body.key.trim().slice(0, 200) : '';
  if (!key) return res.status(400).json({ error: 'Enter the product key.' });

  const deviceId = getDeviceId();

  try {
    const result = await postJson(ACTIVATION_URL, '/api/activation/activate', null, {
      key,
      device_id: deviceId,
      device_name: os.hostname(),
    });

    writeActivation({ device_id: deviceId, activated_at: new Date().toISOString() });
    res.json({ activated: true, label: result.label || null });
  } catch (err) {
    // A dropped connection, DNS failure or timeout comes back as a raw socket
    // message ("connect ECONNREFUSED 127.0.0.1:4000"). Say what it means instead.
    const network = /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|timed out|socket|network/i.test(String(err && err.message));
    res.status(network ? 503 : 400).json({
      error: network
        ? "We couldn't reach the activation service. Check this computer's internet connection and try again."
        : (err.message || 'Could not activate.'),
    });
  }
});

module.exports = router;
