# Extract PDF

A **BE AI READY** Node — drop in a PDF and get **trusted structured data** back as
an Excel file. Built on the shared GROUNDED Node runtime, so it runs on a
business's own machine **or** online.

The point isn't "AI reads my document." It's **safe** extraction: the document is
read in code (never retyped by a vision model), checked against itself twice, and
the few cells worth opening the original for are flagged for you. Nothing is
guessed — an unreadable cell is marked `[UNREADABLE]`, never invented.

## Run it locally
One line in your computer's built-in terminal — nothing to install by hand:

**macOS**
```bash
curl -fsSL https://grounded.developai.co.za/nodes/bair-extract/mac | bash
```
**Windows** (PowerShell)
```powershell
irm https://grounded.developai.co.za/nodes/bair-extract/windows | iex
```
The first time, it asks for an AI key (it shows you where to get one); the key and
your documents stay on your computer.

Or from a clone:
```bash
npm install
npm start        # → http://localhost:3000
```

## The method (Session 5)
1. **Classify** — text PDF or scan? Scans raise the verification posture.
2. **Extract in code** — parse the text layer (or OCR a scan one page at a time).
   The AI structures already-extracted text; it never "looks at the page."
3. **Self-reconcile** — row counts, re-added totals, missing units/rates.
4. **Double-pass** — run it twice independently and diff; disagreeing cells are
   proven suspect.
5. **Template-check** — validate predictable fields (refs, dates, quantities)
   against reusable plain-English rules; flag breaks, never auto-correct.
6. **Flag list → Excel** — the data with `[UNREADABLE]` intact, plus the shortlist
   of cells a human should actually check, written to a `.xlsx` ready to use.

## A note on privacy
This method protects **accuracy**, not confidentiality. Public / redacted /
paid-no-training documents are fine. Confidential pricing, unpublished bills of
quantities, NDA-marked files — stop and think about where the file and the
inference go. The app says so on every screen.

By **Develop AI** · part of [Grounded](https://grounded.developai.co.za) · BE AI READY.
