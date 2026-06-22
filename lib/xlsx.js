// Excel output (deck slide 17): "trusted Excel, ready to use." Two sheets —
//   Data:  every row exactly as extracted, with flagged / [UNREADABLE] cells
//          highlighted so the eye goes straight to what to check.
//   Flags: the shortlist — the ONLY cells a human should open the original for.
// The flagged cells are a FEATURE, not an error: they are where the method earns
// its trust.

import ExcelJS from 'exceljs';

const FILL_FLAG = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6D6D6' } };   // soft red
const FILL_UNREAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E1B8' } }; // amber
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDE6' } };

export async function buildWorkbook(run) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Extract PDF · BE AI READY';

  // ── Data sheet ──
  const data = wb.addWorksheet('Data');
  const columns = (run.columns && run.columns.length) ? run.columns : (run.rows[0] || []).map((_, i) => `Column ${i + 1}`);
  data.addRow(columns);
  data.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = HEADER_FILL; });
  for (const r of run.rows || []) data.addRow(r);

  // Highlight flagged + [UNREADABLE] cells. Data rows start at excel row 2.
  const cellFlag = new Map();   // "ri,ci" → 'flag' | 'unread'
  const mark = (ri, ci, kind) => { if (ri != null && ci != null) cellFlag.set(`${ri},${ci}`, kind); };
  for (const f of run.flags || []) {
    if (f.kind === 'unreadable') { /* located via collectUnreadable below */ }
  }
  // Re-locate precise cell coords from the structured arrays.
  (run.rows || []).forEach((row, ri) => (row || []).forEach((val, ci) => {
    if (/\[?UNREADABLE\]?/i.test(String(val))) mark(ri, ci, 'unread');
  }));
  for (const d of run.diffs || []) if (d.kind === 'cell') mark(d.row, d.col, 'flag');
  for (const cell of cellFlag) {
    const [ri, ci] = cell[0].split(',').map(Number);
    const xc = data.getCell(ri + 2, ci + 1);
    xc.fill = cell[1] === 'unread' ? FILL_UNREAD : FILL_FLAG;
  }
  columns.forEach((_, i) => { data.getColumn(i + 1).width = 20; });

  // ── Flags sheet ──
  const flags = wb.addWorksheet('Flags');
  flags.addRow(['Severity', 'What', 'Where', 'Detail']);
  flags.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = HEADER_FILL; });
  const labelOf = { total_mismatch: 'Total doesn’t re-add', rowcount_mismatch: 'Row count differs between passes',
    double_pass_disagreement: 'Two passes disagree', template_break: 'Breaks your rule', unreadable: 'Unreadable — read off source', gap: 'Missing unit/rate' };
  if ((run.flags || []).length === 0) {
    flags.addRow(['—', 'No flags', '—', 'Nothing tripped the checks. Matching cells are not PROVEN correct, but nothing is proven suspect.']);
  } else {
    for (const f of run.flags) flags.addRow([f.severity || '', labelOf[f.kind] || f.kind, f.where || '', f.detail || '']);
  }
  flags.columns.forEach((c, i) => { c.width = i === 3 ? 60 : 28; });

  // ── Summary header on Flags sheet (top note) ──
  flags.spliceRows(1, 0, [`Extract PDF — ${run.fileType === 'scan' ? 'SCANNED (highest-risk)' : 'text'} document · ${run.rows?.length || 0} rows · ${(run.flags || []).length} cell(s) to check`]);
  flags.getRow(1).font = { italic: true, color: { argb: 'FF6B6B66' } };

  return wb;
}

export async function workbookBuffer(run) {
  const wb = await buildWorkbook(run);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
