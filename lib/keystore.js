// API-key custody — one surface, two modes.
//
//   HOSTED (Node on the BAIR website): the client submits THEIR OWN key. We
//     live-validate it, SEAL it at rest (lib/crypto.js, AES-256-GCM), and store the
//     ciphertext per-tenant in host.store. Decrypted only in memory at call time.
//     Never logged, never returned to the browser.
//   LOCAL (laptop install): the key lives in the install's own .env, exactly like
//     every other GROUNDED Node. Nothing encrypted — it's the user's machine.
//
// Both modes flow through the SAME getStatus/save/load/remove so the engine and the
// /api/setup handlers don't branch.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { seal, open, secretAvailable, tail } from './crypto.js';

const ENV_PATH = '.env';
const COLLECTION = 'credentials';   // per-tenant store collection (hosted)
const KEY = 'self';                  // single record per tenant
export const HOSTED = () => !!process.env.GROUNDED_HOSTED;

// ── Live key check — a zero-cost GET to the provider's models endpoint. 200 = the
// key works; 401/403 = rejected; anything else / network error = couldn't verify.
export async function validateKey(provider, key) {
  try {
    const res = provider === 'anthropic'
      ? await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })
      : await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true };
    return { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, network: true, error: e.message };
  }
}

// ── Local .env read/write (laptop only) ──────────────────────────────────────
function readEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
function writeEnvFile(updates) {
  const merged = { ...readEnvFile(), ...updates };
  const order = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'MODEL', 'OPENAI_BASE_URL', 'NEWSROOM', 'PORT'];
  const lines = [
    '# Saved by the in-app setup screen. Update through the app, not by editing this.',
    '# Keep this file private — it contains your API key. (Already in .gitignore.)',
    '',
  ];
  for (const k of order) if (merged[k] !== undefined && merged[k] !== '') lines.push(`${k}=${merged[k]}`);
  for (const k of Object.keys(merged)) if (!order.includes(k) && merged[k]) lines.push(`${k}=${merged[k]}`);
  writeFileSync(ENV_PATH, lines.join('\n') + '\n');
  for (const [k, v] of Object.entries(updates)) { if (v) process.env[k] = v; else delete process.env[k]; }
}

// ── Status (never returns the key itself) ────────────────────────────────────
export async function getStatus(host) {
  if (HOSTED()) {
    if (!secretAvailable()) {
      return { configured: false, serverManaged: false, keyStorage: 'account', storageReady: false,
               activeProvider: null, message: 'Key storage is not configured on this server yet.' };
    }
    const rec = await host.store.get(COLLECTION, KEY).catch(() => null);
    return {
      configured: !!(rec && rec.sealed),
      serverManaged: false,           // the CLIENT manages it, not the box
      keyStorage: 'account',          // stored (encrypted) for their account
      storageReady: true,
      activeProvider: rec ? rec.provider : null,
      keyTail: rec ? rec.tail : null,
    };
  }
  // Local: read the install's own .env / process.env.
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const explicit = (process.env.AI_PROVIDER || '').toLowerCase();
  let activeProvider = null;
  if (explicit === 'anthropic' || explicit === 'openai') activeProvider = explicit;
  else if (hasAnthropic) activeProvider = 'anthropic';
  else if (hasOpenAI) activeProvider = 'openai';
  return {
    configured: !!activeProvider,
    serverManaged: false,
    keyStorage: 'device',             // stays on this computer
    storageReady: true,
    activeProvider,
    hasAnthropicKey: hasAnthropic,
    hasOpenAIKey: hasOpenAI,
  };
}

// ── Save (validate, then persist for the mode) ───────────────────────────────
export async function save(host, provider, rawKey) {
  if (!['anthropic', 'openai'].includes(provider)) return { ok: false, message: 'Pick Anthropic or OpenAI.' };
  const key = (rawKey || '').trim();
  if (key.length < 10) return { ok: false, message: 'Paste your API key into the key box.' };
  if (provider === 'anthropic' && !/^sk-ant-/.test(key)) return { ok: false, message: 'That doesn’t look like an Anthropic key — it should start with "sk-ant-".' };
  if (provider === 'openai' && !/^sk-/.test(key)) return { ok: false, message: 'That doesn’t look like an OpenAI key — it should start with "sk-".' };

  const v = await validateKey(provider, key);
  if (v.rejected) return { ok: false, message: `That key was rejected by ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}. Check you copied the whole key.` };

  if (HOSTED()) {
    if (!secretAvailable()) return { ok: false, message: 'Key storage is not configured on this server yet — tell Develop AI.' };
    const sealed = seal(key);   // AES-256-GCM at rest
    await host.store.put(COLLECTION, KEY, { provider, sealed, tail: tail(key), created_at: new Date().toISOString() });
    await host.log.run({ op: 'setup', provider, verified: !!v.ok, storage: 'account' }); // NB: no key, ever
    return { ok: true, provider, verified: !!v.ok, keyStorage: 'account',
             warning: v.network ? 'Saved — but we couldn’t reach the provider to confirm it just now.' : null };
  }
  // Local: write the install's .env.
  const updates = { AI_PROVIDER: provider };
  if (provider === 'anthropic') updates.ANTHROPIC_API_KEY = key; else updates.OPENAI_API_KEY = key;
  writeEnvFile(updates);
  await host.log.run({ op: 'setup', provider, verified: !!v.ok, storage: 'device' });
  return { ok: true, provider, verified: !!v.ok, keyStorage: 'device',
           warning: v.network ? 'Saved — but we couldn’t reach the provider to confirm it (no internet?).' : null };
}

// ── Remove ───────────────────────────────────────────────────────────────────
export async function remove(host) {
  if (HOSTED()) { await host.store.delete(COLLECTION, KEY).catch(() => {}); return { ok: true, reset: true }; }
  writeEnvFile({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', AI_PROVIDER: '' });
  return { ok: true, reset: true };
}

// ── Load credentials for a request (decrypt in memory; caller discards) ───────
// Returns { provider, key } or null. NEVER log the return value.
export async function loadCredentials(host) {
  if (HOSTED()) {
    const rec = await host.store.get(COLLECTION, KEY).catch(() => null);
    if (!rec || !rec.sealed) return null;
    let key;
    try { key = open(rec.sealed); } catch { return null; }  // tampered / secret rotated
    return { provider: rec.provider, key };
  }
  const provider = (process.env.AI_PROVIDER || '').toLowerCase()
    || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : null);
  if (!provider) return null;
  const key = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) return null;
  return { provider, key };
}
