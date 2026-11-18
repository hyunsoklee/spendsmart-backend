// linkRoutes.js
// The link page and its routes. Served only to this Mac:
// the app has no logins yet, so nothing else on the network may reach these.

const express = require('express');
const path = require('path');
const linking = require('./linking');

const router = express.Router();

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

function thisMacOnly(req, res, next) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;

  const fromThisMac = LOCAL_ADDRESSES.has(req.socket.remoteAddress);
  const askedForLocalhost = LOCAL_HOST.test(host);
  // A browser sends Origin on POSTs. It must be this same page, not another site.
  const fromThisPage = !origin || origin === `http://${host}`;

  if (!fromThisMac || !askedForLocalhost || !fromThisPage) {
    return res
      .status(403)
      .send('This page is only available on the Mac running Sprinkles, at http://localhost.');
  }
  next();
}

// Sends a message the page can show. Never includes a token.
function sendError(res, err) {
  const plaidError = err.response && err.response.data;
  const message = plaidError
    ? `${plaidError.error_code}: ${plaidError.error_message}`
    : err.message;
  const status = err.status || 500;
  if (status >= 500) console.error('Link page error:', message);
  res.status(status).json({ error: message, code: err.code || null });
}

function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.use(['/link', '/api/link'], thisMacOnly);

router.get('/link', (req, res) => {
  // Never let the browser keep an old copy of this page.
  res.sendFile(path.join(__dirname, 'public', 'link.html'), {
    cacheControl: false,
    headers: { 'Cache-Control': 'no-store' },
  });
});

router.get('/api/link/status', async (req, res) => {
  try {
    res.json(await linking.getLinkStatus());
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/api/link/token', async (req, res) => {
  try {
    const linkToken = await linking.createLinkToken(toId(req.body.userId));
    res.json({ linkToken });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/api/link/connections', async (req, res) => {
  try {
    const result = await linking.startConnection({
      userId: toId(req.body.userId),
      publicToken: req.body.publicToken,
      institutionId: req.body.institutionId || null,
      institutionName: req.body.institutionName || null,
      allowDuplicate: req.body.allowDuplicate === true,
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/api/link/accounts/:id/default-split', async (req, res) => {
  try {
    const splitUserId = req.body.splitUserId === null ? null : toId(req.body.splitUserId);
    if (req.body.splitUserId !== null && splitUserId === null) {
      return res.status(400).json({ error: 'Choose Shared or a person.' });
    }
    await linking.setCardDefaultSplit(toId(req.params.id), splitUserId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/api/link/connections/:id/sync', async (req, res) => {
  try {
    res.json(await linking.fetchCharges(toId(req.params.id)));
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;