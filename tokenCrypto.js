// Encrypts Plaid access tokens before they are stored, and decrypts them
// only at the moment of a sync.
// Method: AES-256-GCM. The key is TOKEN_ENCRYPTION_KEY in .env, never in git.
// Stored form: v1:<iv>:<tag>:<ciphertext>, each part base64.
require('dotenv').config();
const crypto = require('crypto');

const VERSION = 'v1';

function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('TOKEN_ENCRYPTION_KEY is missing from .env');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}

function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data]
    .map((part) => (Buffer.isBuffer(part) ? part.toString('base64') : part))
    .join(':');
}

function decryptToken(stored) {
  // Refuse plain text, so an unencrypted token can never be used by accident.
  if (!isEncrypted(stored)) {
    throw new Error('Stored token is not encrypted. Run scripts/encrypt-existing-tokens.js');
  }
  const [, iv, tag, data] = stored.split(':').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptToken, decryptToken, isEncrypted };