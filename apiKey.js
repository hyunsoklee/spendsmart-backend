// apiKey.js
// Only callers that send the shared key are answered.
// The key is APP_API_KEY in .env. The phone app sends it with every request.
// The link page is skipped here because it has its own guard: this Mac only.

require('dotenv').config();
const crypto = require('crypto');

const EXPECTED = process.env.APP_API_KEY;
if (!EXPECTED) {
  // Refuse to start without a key, so the data routes are never left open by accident.
  throw new Error('APP_API_KEY is missing from .env');
}

function sameKey(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(EXPECTED);
  // Compare in constant time, so the response time reveals nothing about the key.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  // Mounted on /api, so req.path here is the part after /api.
  if (req.path === '/link' || req.path.startsWith('/link/')) return next();

  if (!sameKey(req.get('X-Sprinkles-Key'))) {
    return res.status(401).json({ error: 'Not authorized' });
  }
  next();
}

module.exports = requireApiKey;