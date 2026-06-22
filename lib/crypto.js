// At-rest encryption for the client's API key (hosted BYOK).
//
// Custody model (Paul's call, 2026-06-22): the client submits their own provider
// key to the hosted Node; we SEAL it at rest, decrypt only in memory at call time,
// never log it, and discard it immediately. No AWS KMS. We use Node's built-in
// crypto (AES-256-GCM) — the lightest possible route, no extra dependency — with a
// single box-held secret. (libsodium/age would be equivalent; built-in crypto adds
// nothing to install.)
//
// Honest limit of this model: the plaintext key briefly lives in this process's
// memory while a provider call is in flight. It is NEVER written to disk in the
// clear, never logged, and never returned to the browser. For "the key never
// touches our server at all", a future browser-held mode would be needed.

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

// The box secret. Set BAIR_EXTRACT_SECRET in the box .env to a base64 32-byte key
// (generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
// If absent we cannot seal keys — hosted BYOK is then disabled with a clear message
// rather than storing anything weakly.
export function secretAvailable() {
  return !!loadSecret();
}

function loadSecret() {
  const raw = process.env.BAIR_EXTRACT_SECRET || '';
  if (!raw) return null;
  let buf;
  try { buf = Buffer.from(raw, 'base64'); } catch { return null; }
  if (buf.length !== 32) return null;
  return buf;
}

/** Seal plaintext → a self-contained record { v, iv, tag, ct } (all base64). */
export function seal(plaintext) {
  const key = loadSecret();
  if (!key) throw new Error('Key storage is not configured on this server.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

/** Open a sealed record → plaintext. Throws if tampered or the secret changed. */
export function open(record) {
  const key = loadSecret();
  if (!key) throw new Error('Key storage is not configured on this server.');
  if (!record || !record.iv || !record.tag || !record.ct) throw new Error('No sealed key.');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(record.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/** Last-4 fingerprint for display ("…Q4kZ") — safe to show, never the whole key. */
export function tail(key) {
  const s = String(key || '');
  return s.length <= 4 ? '••••' : '…' + s.slice(-4);
}
