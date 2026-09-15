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
  const key = String((req.body && req.body.key) || '').trim();
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
    res.status(400).json({ error: err.message || 'Could not activate.' });
  }
});

module.exports = router;
