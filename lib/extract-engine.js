// The extraction engine — the Session 5 "Safely use AI to extract info from
// documents" method, baked in so the user can't skip the safety steps.
//
// THE GOVERNING RULE: never let the model retype the document by vision. For a
// TEXT PDF the text layer is pulled in CODE (pdf-parse); the model only STRUCTURES
// that already-extracted text. A SCAN has no text layer — there the model reads the
// PDF (vision-OCR via the API), treated as highest-risk. Either way the output is
// "every row exactly as printed; never clean, round or fix; [UNREADABLE] for any
// cell not readable with confidence; never guess."
//
// The SAFETY is mostly deterministic code (reconcile, template-check, double-pass
// diff, [UNREADABLE] collection) — that is the whole point. The model improves the
// structuring; the code is what makes the result trustworthy.

import { chat } from './ai.js';

// PDF text-layer extraction via the official pdf.js (maintained; pure JS — no
// native canvas needed for getTextContent). We reconstruct lines from glyph
// positions and mark column gaps with two spaces so the code fallback can split.
async function pdfText(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = new Map();                        // rounded-y → [{x, s, w}]
    for (const it of content.items) {
      if (typeof it.str !== 'string') continue;
      const y = Math.round(it.transform[5]);
      (lines.get(y) || lines.set(y, []).get(y)).push({ x: it.transform[4], s: it.str, w: it.width || 0 });
    }
    for (const y of [...lines.keys()].sort((a, b) => b - a)) {   // top → bottom
      const row = lines.get(y).sort((a, b) => a.x - b.x);
      let line = '', prevEnd = null;
      for (const cell of row) {
        if (prevEnd != null) { const gap = cell.x - prevEnd; line += gap > 8 ? '  ' : (/^\s/.test(cell.s) ? '' : ' '); }
        line += cell.s; prevEnd = cell.x + cell.w;
      }
      if (line.trim()) text += line + '\n';
    }
  }
  const numPages = doc.numPages;
  await doc.destroy();
  return { text, pageCount: numPages };
}

// ── Step 0: classify (deck slide 8) ──────────────────────────────────────────
export async function classify(buffer) {
  let text = '', pageCount = 0;
  try {
    const parsed = await pdfText(buffer);
    text = parsed.text || '';
    pageCount = parsed.pageCount || 0;
  } catch {
    text = ''; pageCount = 0;
  }
  const meaningful = text.replace(/\s+/g, '').length;
  const perPage = pageCount ? meaningful / pageCount : meaningful;
  // A real text layer carries hundreds of chars/page; a scan carries ~none.
  const fileType = perPage < 50 ? 'scan' : 'text';
  return { fileType, text, pageCount, charsPerPage: Math.round(perPage) };
}

// ── Number parsing (conservative — never fabricate) ──────────────────────────
// Handles "R 9 392.00", "9,392", "1 234,56", "(1 200)" negatives. Returns null when
// the value isn't clearly a number (so we never invent one).
export function toNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || /UNREADABLE/i.test(s)) return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/^\(|\)$/g, '');
  s = s.replace(/[^\d.,\-\s]/g, '').trim();   // drop currency letters/symbols
  s = s.replace(/\s+/g, '');
  if (!s) return null;
  // Decide decimal separator: if both . and , present, the LAST one is decimal.
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // comma only — treat as decimal if it looks like one (2 digits after), else thousands
    s = (/,\d{1,2}$/.test(s)) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// ── Deterministic code baseline parse (no model needed) ──────────────────────
// Splits the extracted text into rows/cells by column gaps. Rough but REAL — used
// as a fallback when no AI key is set, and as a sanity floor otherwise.
export function codeParse(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+$/,'')).filter((l) => l.trim());
  const rows = lines.map((l) => l.split(/\s{2,}|\t/).map((c) => c.trim()).filter((c) => c !== ''));
  // Header guess: first row with the most cells.
  let headerIdx = 0, maxCells = 0;
  rows.forEach((r, i) => { if (r.length > maxCells) { maxCells = r.length; headerIdx = i; } });
  return { columns: rows[headerIdx] || [], rows: rows.slice(headerIdx + 1), rawRows: rows };
}

// Deterministic total detection for the code-only path (no AI). Finds a row led by
// TOTAL/SUBTOTAL and maps its last number to the most "amount-like" column, so the
// re-add check (the headline safety net) still fires without a key. Returns the
// printedTotals map and the line-item rows with the total row removed.
export function detectTotals(columns, rows) {
  const amtIdx = (() => {
    const i = columns.findIndex((c) => /amount|total|value|price|cost/i.test(c));
    return i === -1 ? Math.max(0, columns.length - 1) : i;
  })();
  const amtCol = columns[amtIdx] || `Column ${amtIdx + 1}`;
  const printedTotals = {};
  const kept = [];
  for (const r of rows) {
    const first = (r[0] || '').toString().trim();
    if (/^(sub)?total\b/i.test(first)) {
      const nums = (r || []).map((c) => toNumber(c)).filter((n) => n != null);
      if (nums.length) { printedTotals[amtCol] = nums[nums.length - 1]; continue; }   // drop the total row
    }
    kept.push(r);
  }
  return { printedTotals, rows: kept };
}

// ── Step 1: AI structuring of ALREADY-EXTRACTED text (text path) ─────────────
const STRUCTURE_SYSTEM =
  'You convert text that was extracted from a document into structured rows. You are NOT reading an image — ' +
  'you are organising text that has already been pulled out by code. Rules, without exception:\n' +
  '1. Copy every value EXACTLY as printed. Do not clean, round, correct, reformat, or "fix" anything.\n' +
  '2. If any cell is not readable with confidence, output the literal string "[UNREADABLE]". NEVER guess.\n' +
  '3. Do not invent rows, columns, or totals that are not present.\n' +
  '4. Reply with STRICT JSON only, no prose, of the shape: ' +
  '{"columns":[..],"rows":[[..],..],"printedTotals":{"<columnName>":"<as printed>"}}. ' +
  'printedTotals holds any total/subtotal lines the document prints, keyed by the column they total.';

function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b !== -1) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}

async function aiStructure(host, { text, pdfBuffer, temperature }) {
  const user = pdfBuffer
    ? 'This is a SCANNED document with no reliable text layer. Read it and structure it under the rules. ' +
      'Anything you cannot read with confidence is "[UNREADABLE]".'
    : 'Structure the following extracted text under the rules.\n\n=== EXTRACTED TEXT ===\n' + text;
  const { text: out } = await chat(host, { system: STRUCTURE_SYSTEM, user, pdfBuffer, temperature, maxTokens: 4096 });
  const parsed = parseJsonLoose(out);
  if (!parsed || !Array.isArray(parsed.rows)) {
    return { columns: [], rows: [], printedTotals: {}, parseError: true };
  }
  return {
    columns: Array.isArray(parsed.columns) ? parsed.columns.map(String) : [],
    rows: parsed.rows.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : [String(r)])),
    printedTotals: parsed.printedTotals && typeof parsed.printedTotals === 'object' ? parsed.printedTotals : {},
  };
}

// ── Step 2: self-reconcile (deck slide 11) — pure code ───────────────────────
export function reconcile(structured) {
  const { columns, rows, printedTotals } = structured;
  const checks = [];
  // Row count (we can't know the source's true count without the source; we report
  // it and let the double-pass cross-check catch a miscount).
  checks.push({ name: 'row_count', ok: true, detail: `${rows.length} line item(s) extracted.` });

  // Column re-add: for every column the document prints a total for, re-sum and compare.
  const totals = [];
  for (const [colName, printedRaw] of Object.entries(printedTotals || {})) {
    const idx = columns.findIndex((c) => c.toLowerCase() === String(colName).toLowerCase());
    const printed = toNumber(printedRaw);
    if (idx === -1 || printed == null) { totals.push({ column: colName, printed: printedRaw, computed: null, ok: null, note: 'could not re-add' }); continue; }
    let sum = 0, counted = 0;
    for (const r of rows) { const n = toNumber(r[idx]); if (n != null) { sum += n; counted++; } }
    const computed = Math.round(sum * 100) / 100;
    const ok = Math.abs(computed - printed) < 0.005;
    totals.push({ column: colName, printed, computed, ok });
    checks.push({ name: 'total:' + colName, ok, detail: ok ? `Re-added ${counted} rows = printed total.` : `Re-added ${counted} rows = ${computed}, but the document prints ${printed}.` });
  }

  // Gap list: line items missing a unit/rate where the column otherwise has values.
  // Only ROWS that look like real line items (≥3 filled cells) count — so total
  // lines and free-text notes don't masquerade as gaps.
  const gaps = [];
  const isLineItem = (r) => (r || []).filter((c) => (c || '').toString().trim()).length >= 3;
  const items = rows.map((r, ri) => ({ r, ri })).filter((x) => isLineItem(x.r));
  columns.forEach((c, idx) => {
    if (!/unit|rate|qty|quantity|price/i.test(c)) return;
    const filled = items.filter((x) => (x.r[idx] || '').trim()).length;
    if (filled === 0 || filled === items.length) return;       // all-or-nothing isn't a gap
    items.forEach((x) => { if (!(x.r[idx] || '').trim()) gaps.push({ row: x.ri, column: c }); });
  });

  return { rowCount: rows.length, totals, gaps, checks };
}

// ── Step 3: double-pass diff (deck slides 12–13) ─────────────────────────────
export function doublePassDiff(a, b) {
  const diffs = [];
  const rA = a.rows || [], rB = b.rows || [];
  if (rA.length !== rB.length) {
    diffs.push({ kind: 'row_count', a: rA.length, b: rB.length, detail: `Pass 1 found ${rA.length} rows, pass 2 found ${rB.length}.` });
  }
  const n = Math.min(rA.length, rB.length);
  for (let i = 0; i < n; i++) {
    const w = Math.max((rA[i] || []).length, (rB[i] || []).length);
    for (let j = 0; j < w; j++) {
      const va = (rA[i][j] ?? '').toString().trim();
      const vb = (rB[i][j] ?? '').toString().trim();
      if (va !== vb) diffs.push({ kind: 'cell', row: i, col: j, a: va, b: vb });
    }
  }
  return diffs;
}

// ── Step 4: template-check predictable fields (deck slides 14–15) ────────────
// rules: [{ field, type:'ref'|'date'|'quantity'|'regex', pattern?, requireUnit?, maxMonthsAhead?, message? }]
export function templateCheck(structured, rules) {
  const flags = [];
  if (!Array.isArray(rules) || !rules.length) return flags;
  const { columns, rows } = structured;
  for (const rule of rules) {
    const idx = columns.findIndex((c) => c.toLowerCase() === String(rule.field || '').toLowerCase());
    if (idx === -1) continue;
    rows.forEach((r, ri) => {
      const value = (r[idx] ?? '').toString().trim();
      if (!value || /UNREADABLE/i.test(value)) return;     // [UNREADABLE] is its own flag
      const bad = validateField(value, rule);
      if (bad) flags.push({ row: ri, field: rule.field, value, message: rule.message || bad });
    });
  }
  return flags;
}

function validateField(value, rule) {
  switch (rule.type) {
    case 'regex':
      try { return new RegExp(rule.pattern).test(value) ? null : 'does not match the expected pattern'; }
      catch { return null; }
    case 'ref':
      // With a user pattern, that's the source of truth. Without one, the reliable
      // generic signal for O/0 (or I/l for 1) confusion is a DIGIT immediately
      // followed by a look-alike LETTER — e.g. "2O" in T2O26 — which a real numeric
      // reference never contains. "PO123" (letter-then-letter) and a clean
      // "T2026/047" (digits only) are left alone.
      if (rule.pattern) { try { return new RegExp(rule.pattern).test(value) ? null : 'breaks the reference pattern'; } catch { return null; } }
      if (/[0-9][OoIl]/.test(value)) return 'a digit is followed by a look-alike letter (O/o/I/l) — likely a misread of 0/1, check it';
      return null;
    case 'date': {
      const d = new Date(value.replace(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/, '$2 $1, $3'));
      if (Number.isNaN(d.getTime())) return 'is not a valid date';
      const now = new Date('2026-06-22T00:00:00Z');     // deterministic anchor; runtime has no Date.now in some contexts
      const months = (d - now) / (1000 * 60 * 60 * 24 * 30.4);
      const ahead = rule.maxMonthsAhead || 12;
      if (months > ahead) return `is ${Math.round(months)} months in the future — likely a typo (e.g. a wrong year)`;
      if (d.getUTCFullYear() > 2100 || d.getUTCFullYear() < 1990) return `has an out-of-range year (${d.getUTCFullYear()})`;
      return null;
    }
    case 'quantity':
      if (rule.requireUnit && !/[a-zA-Z%]/.test(value)) return 'is a number with no unit';
      if (toNumber(value) == null) return 'is not a readable quantity';
      return null;
    default:
      return null;
  }
}

// ── Collect every [UNREADABLE] cell (slide 16) ───────────────────────────────
export function collectUnreadable(structured) {
  const out = [];
  (structured.rows || []).forEach((r, ri) => (r || []).forEach((c, ci) => {
    if (/\[?UNREADABLE\]?/i.test(String(c))) out.push({ row: ri, col: ci, column: structured.columns?.[ci] || `col ${ci + 1}` });
  }));
  return out;
}

// ── Build the unified flag list — the ONLY cells a human should open the source for.
export function buildFlags({ reconciliation, diffs, templateFlags, unreadable }) {
  const flags = [];
  for (const t of reconciliation?.totals || []) {
    if (t.ok === false) flags.push({ kind: 'total_mismatch', severity: 'high', where: `Total of "${t.column}"`, detail: `re-added = ${t.computed}, printed = ${t.printed}` });
  }
  for (const g of reconciliation?.gaps || []) flags.push({ kind: 'gap', severity: 'medium', where: `Row ${g.row + 1} · ${g.column}`, detail: 'missing a unit/rate the column otherwise has' });
  for (const d of diffs || []) {
    if (d.kind === 'row_count') flags.push({ kind: 'rowcount_mismatch', severity: 'high', where: 'Whole document', detail: d.detail });
    else flags.push({ kind: 'double_pass_disagreement', severity: 'high', where: `Row ${d.row + 1}, col ${d.col + 1}`, detail: `pass 1 = "${d.a}" vs pass 2 = "${d.b}"` });
  }
  for (const f of templateFlags || []) flags.push({ kind: 'template_break', severity: 'medium', where: `Row ${f.row + 1} · ${f.field}`, detail: `"${f.value}" ${f.message}` });
  for (const u of unreadable || []) flags.push({ kind: 'unreadable', severity: 'high', where: `Row ${u.row + 1} · ${u.column}`, detail: 'marked [UNREADABLE] — read it off the source' });
  return flags;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
// Returns the full run result. `hasKey` decides whether the AI passes run; without
// a key we still do the code baseline + every code-based safety check (degraded but
// honest), and say so.
export async function extract(host, { buffer, rules, hasKey }) {
  const cls = await classify(buffer);
  let posture = cls.fileType === 'scan' ? 'high' : 'normal';
  let primary, secondary = null, diffs = [], mode;

  if (!hasKey) {
    // No AI: deterministic code parse only, plus TOTAL-row detection so the re-add
    // check still fires.
    const parsed = codeParse(cls.text);
    const totals = detectTotals(parsed.columns, parsed.rows);
    primary = { columns: parsed.columns, rows: totals.rows, printedTotals: totals.printedTotals };
    mode = 'code-only';
  } else if (cls.fileType === 'scan') {
    primary = await aiStructure(host, { pdfBuffer: buffer, temperature: 0 });
    secondary = await aiStructure(host, { pdfBuffer: buffer, temperature: 0.4 });
    diffs = doublePassDiff(primary, secondary);
    mode = 'ai-scan';
  } else {
    // TEXT path — the model structures the code-extracted TEXT (never reads the page).
    primary = await aiStructure(host, { text: cls.text, temperature: 0 });
    secondary = await aiStructure(host, { text: cls.text, temperature: 0.4 });
    diffs = doublePassDiff(primary, secondary);
    mode = 'ai-text';
    // If the text layer held NO structured rows, the tables are very likely embedded
    // as IMAGES (a hybrid PDF — a text-layer heading over image tables). The text
    // path can't see those, so fall back to reading the PDF directly (vision) — the
    // only way to recover image tables — treated as highest-risk. (OpenAI v1 can't
    // read a PDF here; on that error we keep the empty text result.)
    if ((primary.rows || []).length === 0) {
      try {
        const vp = await aiStructure(host, { pdfBuffer: buffer, temperature: 0 });
        if ((vp.rows || []).length > 0) {
          primary = vp;
          secondary = await aiStructure(host, { pdfBuffer: buffer, temperature: 0.4 });
          diffs = doublePassDiff(primary, secondary);
          mode = 'ai-text→vision';
          posture = 'high';
        }
      } catch { /* vision unsupported (e.g. OpenAI) → keep the text result */ }
    }
  }

  const reconciliation = reconcile(primary);
  const templateFlags = templateCheck(primary, rules);
  const unreadable = collectUnreadable(primary);
  const flags = buildFlags({ reconciliation, diffs, templateFlags, unreadable });

  const notes = [];
  if (!hasKey) notes.push('No AI key set — this is a plain code extraction. Add a key for AI structuring + the double-pass cross-check.');
  else if (mode === 'ai-text→vision') notes.push('No text-layer table found — read the document’s embedded images directly (highest-risk). Verify the flagged cells against the original.');
  else if (cls.fileType === 'scan') notes.push('Scanned document — highest-risk path. Verify the flagged cells against the original.');
  if ((primary.rows || []).length === 0) notes.push('No rows could be read from this document. It may carry no tabular data, or its tables are images too unclear to read — try a clearer copy, or a single-table page.');

  return {
    fileType: cls.fileType,
    posture,
    mode,
    pageCount: cls.pageCount,
    charsPerPage: cls.charsPerPage,
    columns: primary.columns || [],
    rows: primary.rows || [],
    printedTotals: primary.printedTotals || {},
    reconciliation,
    diffs,
    flags,
    notes,
  };
}
