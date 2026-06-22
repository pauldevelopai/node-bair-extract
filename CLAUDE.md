# node-bair-extract — Extract PDF (a BE AI READY Node)

Built on the shared GROUNDED runtime (`@developai/grounded-node-runtime`, pinned to
`#v0.14.0`). Copied from `node-template`/`node-verifier` — same wiring, so it runs
**locally** (one-command install, the business's own key) and **hosted** (online,
multi-tenant, the box's shared key) from one set of handlers.

> **Product split:** this is a commercial **BAIR** Node, not a GROUNDED newsroom
> Node. Its registry entry carries `products: ["bair"]` so it appears only in the
> BAIR storefront, never the GROUNDED newsroom front door.

## Files
- **`index.js`** (LOCAL) / **`server-hosted.js`** (HOSTED) — the two entry points,
  same handlers. Slug `bair-extract`, display name **Extract PDF**.
- **`lib/handlers.js`** — the standard `/api/*` surface, verbatim from the template
  (`getSetupStatus` / `postSetup` = the browser AI-key flow, server-managed when
  hosted; `getActivity`). Don't reinvent key handling — this is the standard.
- **`lib/extract-routes.js`** — **the Node's real work.** `mountExtractRoutes(app,
  getHost)`. Read/list routes are real; **`POST /api/extract` is a Phase-1 stub**
  to be replaced by the Phase-3 engine.
- **`public/`** — the dashboard. **Relative paths only** (`fetch("api/…")`,
  `<script src="app.js">`) so it works at `/` and under `/nodes/bair-extract/app/`.
  `mountKeyUI()` in `public/app.js` is copied from the template, re-themed terracotta.

## BAIR theme (not the GROUNDED newsroom chrome)
This Node wears the BE AI READY look (charcoal `#1c1b1a` + terracotta `#c75b39`),
not the GROUNDED newsroom chrome:
- `public/index.html` carries its OWN BAIR header (Extract PDF wordmark + "‹ Be AI
  Ready" back link) and does **not** include the `grounded-chrome.css/js` tags, so a
  local install renders standalone BAIR.
- It sets `window.GROUNDED_CHROME = { nav:false }` so the HOSTED runtime's injected
  `/nodes/chrome.js` skips the newsroom nav (Builder/Tracker). The terracotta family
  feedback bubbles + the runtime "run locally" footer still appear hosted — both
  on-brand. No edit to the shared `nodes/chrome.js` was needed (`nav:false` is its
  documented switch).

## Must-haves (already wired — keep them)
1. **No-cache app shell** — `server-hosted.js`'s `mountRoutes` sets
   `Cache-Control: no-cache` on non-`/api` GETs (or the chrome-injected
   `index.html` caches and UI updates don't show). Runs before custom routes.
2. **`getSetupStatus` returns `configured:true` when `GROUNDED_HOSTED`** (the key is
   server-managed online); `postSetup` refuses online. Keep that branch.

## The extraction engine — Session 5 method (Phase 3, replaces the stub)
The whole reason this Node is trustworthy enough to sell. **Never let the AI retype
the document by vision** — that is how `R 9 392` silently becomes `R 9 302`.
- **Step 0 — classify** (text layer vs scan). Surface `fileType` to the user;
  scans raise the verification posture. Never silently OCR.
- **Step 1 — extract in CODE.** Parse the text layer with a real parser; OCR scans
  one page at a time. The model only *structures already-extracted text* — it is
  never the primary reader. Output every row exactly as printed; write
  `[UNREADABLE]` for any cell not readable with confidence; never guess. Preserve
  `[UNREADABLE]` all the way to the Excel.
- **Step 2 — self-reconcile.** Row count vs source; re-add columns vs printed
  totals; list rows missing a unit/rate. Record pass/fail per check.
- **Step 3 — double-pass.** Run extraction twice independently, diff cell-by-cell;
  disagreeing cells are proven suspect. (`host.ai.chat` exposes no `temperature`,
  so the second pass is an *independent* run + prompt/model variation, not a
  temperature bump — decision flagged to Paul.)
- **Step 4 — template-check.** Validate predictable fields (ref / date / quantity)
  against reusable plain-English rules saved per tenant in `host.store` (`rulesets`).
  Flag breaks; never auto-correct.
- **Step 5 — flag list → Excel.** Return the data (`[UNREADABLE]` intact), the flag
  shortlist (failed totals, row-count mismatches, double-pass disagreements,
  template breaks, every `[UNREADABLE]`), the `fileType` verdict, and the
  reconciliation summary. Then write a `.xlsx` with a visible **Flags** sheet /
  highlight.
- **Step 5b — data-security gate.** This method protects *accuracy, not
  confidentiality.* Show the upload guidance (public/redacted/paid-no-training =
  fine; confidential pricing / unpublished BoQs / NDA docs = stop). Already in the
  dashboard copy; keep it visible.

### Deps to add in Phase 3 (not in package.json yet — additive, Node-only)
- A PDF text-layer parser — `pdf-parse` (or `pdfjs-dist`). **The runtime has no PDF
  parser** (`host.parse` is `docxToHtml` only), so the Node brings its own.
- An OCR path for scans — `tesseract.js` (local; keeps files on the box — preferred
  for the Data-Security framing) unless Paul opts for a cloud OCR.
- An `.xlsx` writer — `exceljs` (supports the highlightable Flags sheet). **Not the
  Claude `xlsx` skill** — that only runs in a Claude session, not in the deployed
  Node.

## Storage (`host.store`, per-tenant)
- `extractions` — one record per run: `{ id, filename, created_at, fileType, data,
  flags, reconciliation, ruleSetUsed }`. **Never** store the API key; scrub it from
  any thrown error or log.
- `rulesets` — reusable field-pattern + item-coding rules per tenant.

## Tenancy note (for hosting)
The stock hosted runtime scopes `host.store` by `user.id` (`tenantOf = u => u.id`
in the runtime's `server-hosted.js`), **not** by `newsroom_id` — so each individual
login gets a separate workspace. For a business that wants staff to share one set
of extractions, the runtime would need to scope by `newsroom_id` (a one-line
change affecting all Nodes). Flagged to Paul as a cross-cutting decision (same one
as the optional per-tenant BYOK).

## Deploy (Paul runs this — never auto-deployed)
1. `cd /home/ubuntu/nodes && bash deploy-node.sh bair-extract <port>`
2. Paste the Caddy app block it prints; `sudo systemctl restart caddy` (admin off →
   restart, not reload).
3. Add the `nodes.json` entry with `products: ["bair"]` (Part 2 makes the front
   door product-aware). Do **not** list it on the GROUNDED newsroom front door.
