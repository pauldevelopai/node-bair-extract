// Extract PDF — the Node's real surface (custom routes), mounted alongside the
// standard /api/* handlers.
//
//   Local  (index.js):         mountExtractRoutes(app, () => host)
//   Hosted (server-hosted.js): mountExtractRoutes(app, hostFor)   // per-request host
//
// Always go through the host interface (host.store / host.log) so the same code runs
// locally and hosted. The provider key is loaded per request, used in memory, and
// NEVER stored in the run record, logged, or echoed in an error.

import multer from 'multer';
import { extract } from './extract-engine.js';
import { workbookBuffer } from './xlsx.js';
import { loadCredentials } from './keystore.js';

const COLLECTION = 'extractions';
const RULESETS = 'rulesets';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const rid = () => `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

export function mountExtractRoutes(app, getHost) {
  const wrap = (fn) => async (req, res) => {
    let host;
    try {
      host = getHost(req);
      res.json(await fn(req, host));
    } catch (err) {
      console.error('extract route error:', err.message);   // message only — never the key
      res.status(500).json({ ok: false, error: err.message || 'extract error' });
      try { await host?.log?.error?.({ op: req.path, error: err, context: { method: req.method } }); }
      catch { /* swallow */ }
    }
  };

  // POST /api/extract — multipart PDF (field "pdf") + optional rules / rulesetId.
  // Runs the full Session-5 pipeline and persists the run per tenant.
  app.post('/api/extract', upload.single('pdf'), wrap(async (req, host) => {
    if (!req.file) return { ok: false, message: 'Choose a PDF to extract first.' };
    if (req.file.mimetype && !/pdf/i.test(req.file.mimetype) && !/\.pdf$/i.test(req.file.originalname || '')) {
      return { ok: false, message: 'That isn’t a PDF. Upload a .pdf file.' };
    }
    const creds = await loadCredentials(host);
    const hasKey = !!creds;
    if (creds) creds.key = null;     // we only needed to know IF a key exists here

    // Rules: an inline JSON array, or a saved ruleset id.
    let rules = [];
    if (req.body && req.body.rules) { try { rules = JSON.parse(req.body.rules); } catch { /* ignore */ } }
    else if (req.body && req.body.rulesetId) {
      const set = await host.store.get(RULESETS, String(req.body.rulesetId)).catch(() => null);
      if (set && Array.isArray(set.rules)) rules = set.rules;
    }

    const run = await extract(host, { buffer: req.file.buffer, rules, hasKey });
    const id = rid();
    const record = {
      id,
      filename: req.file.originalname || 'document.pdf',
      created_at: new Date().toISOString(),
      fileType: run.fileType,
      posture: run.posture,
      mode: run.mode,
      pageCount: run.pageCount,
      columns: run.columns,
      rows: run.rows,
      printedTotals: run.printedTotals,
      reconciliation: run.reconciliation,
      diffs: run.diffs,
      flags: run.flags,
      notes: run.notes,
      ruleCount: rules.length,
      // NB: the provider key is NEVER part of this record.
    };
    await host.store.put(COLLECTION, id, record);
    await host.log.run({ op: 'extract', fileType: run.fileType, rows: run.rows.length, flags: run.flags.length, hasKey });

    return {
      ok: true,
      id,
      needKey: !hasKey,
      fileType: run.fileType,
      posture: run.posture,
      rowCount: run.rows.length,
      flagCount: run.flags.length,
      flags: run.flags,
      reconciliation: run.reconciliation,
      notes: run.notes,
      xlsxUrl: `api/extractions/${id}/xlsx`,
    };
  }));

  // GET /api/extractions — list past runs for this tenant (most recent first, light).
  app.get('/api/extractions', wrap(async (_req, host) => {
    const runs = (await host.store.list(COLLECTION)).map((r) => r.value).filter(Boolean);
    runs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const extractions = runs.slice(0, 100).map((r) => ({
      id: r.id, filename: r.filename, created_at: r.created_at, fileType: r.fileType,
      rowCount: Array.isArray(r.rows) ? r.rows.length : null,
      flagCount: Array.isArray(r.flags) ? r.flags.length : null,
    }));
    return { ok: true, extractions };
  }));

  // GET /api/extractions/:id — one run in full (data + flag list + reconciliation).
  app.get('/api/extractions/:id', wrap(async (req, host) => {
    const run = await host.store.get(COLLECTION, String(req.params.id));
    if (!run) return { ok: false, message: 'No extraction with that id.' };
    return { ok: true, extraction: run };
  }));

  // GET /api/extractions/:id/xlsx — regenerate the Excel from the stored run.
  app.get('/api/extractions/:id/xlsx', async (req, res) => {
    try {
      const host = getHost(req);
      const run = await host.store.get(COLLECTION, String(req.params.id));
      if (!run) return res.status(404).json({ ok: false, message: 'No extraction with that id.' });
      const buf = await workbookBuffer(run);
      const safe = String(run.filename || 'extract').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}-extract.xlsx"`);
      res.send(buf);
    } catch (err) {
      console.error('xlsx error:', err.message);
      res.status(500).json({ ok: false, error: 'Could not build the Excel file.' });
    }
  });

  // Rulesets — reusable field-pattern + item-coding rules per tenant.
  app.get('/api/rulesets', wrap(async (_req, host) => {
    const rulesets = (await host.store.list(RULESETS)).map((r) => r.value).filter(Boolean);
    return { ok: true, rulesets };
  }));
  app.post('/api/rulesets', wrap(async (req, host) => {
    const name = String(req.body?.name || '').trim();
    const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
    if (!name) return { ok: false, message: 'Name the rule set.' };
    const id = String(req.body?.id || rid());
    const set = { id, name, rules, updated_at: new Date().toISOString() };
    await host.store.put(RULESETS, id, set);
    return { ok: true, ruleset: set };
  }));

  // GET /api/profile — shared cross-Node business profile (host.profile).
  app.get('/api/profile', wrap(async (_req, host) => ({
    ok: true,
    profile: host.profile ? await host.profile.get() : null,
  })));
}
