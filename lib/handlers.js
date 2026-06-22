// Standard /api/* handlers, auto-mounted by the runtime (createServer locally,
// createHostedServer online). Each takes the host facade + a request-like object
// and returns a plain object (the JSON response).
//
// The API-key flow is delegated to lib/keystore.js, which has TWO modes:
//   • LOCAL  — the key lives in the install's own .env (standard GROUNDED Node).
//   • HOSTED — the client submits THEIR OWN key; it is sealed at rest (AES-256-GCM)
//              per tenant and decrypted only in memory at call time. (Paul's call,
//              2026-06-22: hosted-first, client-BYOK, kept secure.)
// So unlike a standard Node, /api/setup is NOT refused when hosted — it accepts and
// securely stores the client's key.

import fs from 'node:fs/promises';
import { getStatus, save, remove } from './keystore.js';

const ACTIVITY_LOG = './data/processed/node_bair_extract_activity.json';

/** GET /api/setup — is a key configured, and how is it stored? (Never returns the key.) */
export async function getSetupStatus(host) {
  return getStatus(host);
}

/** POST /api/setup — validate + store the key for the current mode (local .env or
 *  hosted encrypted-at-rest). { provider:null, apiKey:null } removes it. */
export async function postSetup(host, body) {
  const { provider, apiKey } = body || {};
  if (provider === null && apiKey === null) return remove(host);
  return save(host, provider, apiKey);
}

/** GET /api/activity — local only; hosted activity lives in Postgres → []. */
export async function getActivity() {
  try { return JSON.parse(await fs.readFile(ACTIVITY_LOG, 'utf8')); } catch { return []; }
}
