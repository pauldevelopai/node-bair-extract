// Provider call — direct to Anthropic / OpenAI with the per-request key.
//
// Why direct (not host.ai): hosted BYOK means the call must use the CLIENT's key,
// which the box-managed host.ai can't do; and the scan path needs to hand the model
// a PDF (vision-OCR), which host.ai has no surface for. Calling the API directly
// also gives us TEMPERATURE control — needed for the genuine double-pass (the stock
// host.ai.chat exposes none).
//
// The key is loaded per call, used in memory, and NEVER logged or echoed. Any error
// is scrubbed of the key before it leaves this module.

import { loadCredentials } from './keystore.js';

const DEFAULT_MODEL = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o' };

function scrub(msg, key) {
  let s = String(msg || '');
  if (key) s = s.split(key).join('[redacted-key]');
  return s;
}

/**
 * chat(host, opts) → { text, model, provider }
 *   opts: { system, user, model?, temperature?, maxTokens?, pdfBuffer? }
 * If pdfBuffer is given the PDF is sent to the model (scan path, Anthropic only in v1).
 * Throws { needKey:true } when no key is configured for this tenant/install.
 */
export async function chat(host, opts = {}) {
  const creds = await loadCredentials(host);
  if (!creds) { const e = new Error('No API key is configured.'); e.needKey = true; throw e; }
  const { provider, key } = creds;
  const model = opts.model || process.env.MODEL || DEFAULT_MODEL[provider];
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0;
  const maxTokens = opts.maxTokens || 4096;

  try {
    if (provider === 'anthropic') return await callAnthropic({ key, model, temperature, maxTokens, ...opts });
    return await callOpenAI({ key, model, temperature, maxTokens, ...opts });
  } catch (err) {
    // Never let a key leak through an error string.
    throw new Error(scrub(err.message, key));
  } finally {
    // Best-effort: drop our local reference to the plaintext key.
    creds.key = null;
  }
}

async function callAnthropic({ key, model, temperature, maxTokens, system, user, pdfBuffer }) {
  const content = [];
  if (pdfBuffer) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } });
  }
  content.push({ type: 'text', text: user });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text, model, provider: 'anthropic' };
}

async function callOpenAI({ key, model, temperature, maxTokens, system, user, pdfBuffer }) {
  if (pdfBuffer) {
    // v1: OpenAI has no direct PDF-document block here. Scan OCR needs Anthropic.
    const e = new Error('Reading a scanned PDF needs an Anthropic key in this version. Add an Anthropic key, or upload a text-based PDF.');
    e.scanUnsupported = true;
    throw e;
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system || '' }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
  return { text, model, provider: 'openai' };
}
