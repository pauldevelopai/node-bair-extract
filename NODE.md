# Node identity card — Extract PDF

- **Slug:** `bair-extract`
- **Display name:** Extract PDF
- **Repo:** `pauldevelopai/node-bair-extract`
- **Product:** BE AI READY (BAIR) — commercial business vertical (`products: ["bair"]`)
- **Storage:** `host.store` (per-tenant JSON collections; no schema) — collections
  `extractions` (past runs + flag lists) and `rulesets` (reusable field-pattern +
  item-coding rules).
- **Hosted:** yes (the box's shared AI key).
- **What it does:** a business drops in a PDF and gets back **trusted structured
  data** as an Excel file — every line as printed, with the few risky cells
  flagged to check, nothing guessed. Implements the Session 5 *"Safely use AI to
  extract info from documents"* method: classify (text vs scan) → extract in CODE
  (never vision) → self-reconcile → double-pass → template-check → flag list →
  `.xlsx`. The safety steps are baked in so the user can't skip them.
- **Not on the GROUNDED newsroom front door** — it's a BAIR product; the registry
  `products` tag keeps the two storefronts separate.
