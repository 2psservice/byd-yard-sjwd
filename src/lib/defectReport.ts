/**
 * Defect-sheet export — the master-workbook "Defect-Yard / Defect-Factory /
 * Defect-Whale" sheets, shared by the Report page (full export) and the Damages
 * page (report a chosen set of VINs). Column widths / fonts / row heights were
 * measured 1:1 from the master file, so an exported sheet re-imports cleanly.
 */
import type { Damage, Unit } from '../types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** timestamp → "5-Jun-26" — the date shape the Defect sheets use (round-trips on re-import). */
export const defDate = (ts?: number): string => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`
}

/** Per-column alignment override for the defect sheets ('c'=center, 'l'=left). */
export interface DCol { h: string; w: number; align?: 'c' | 'l' }

export interface DefectSheetSpec {
  name: string
  tab: object
  fontSize: number
  headerH: number
  rowH: number
  defaultColWidth: number
  zoom: number
  cols: DCol[]
}

export const YARD_SHEET: DefectSheetSpec = {
  name: 'Defect-Yard', tab: { theme: 5, tint: 0.7999816888943144 }, fontSize: 11,
  headerH: 21, rowH: 21, defaultColWidth: 10.5, zoom: 80,
  cols: [
    { h: 'No', w: 7.5 },
    { h: 'VIN', w: 19.88 },
    { h: 'Model', w: 10.88 },
    { h: 'From', w: 14.88 },
    { h: 'Stock of Status ', w: 22.38 },
    { h: 'Category NG', w: 14.88 },
    { h: 'Category (Repair)', w: 18.88 },
    { h: 'Incharge', w: 11.88 },
    { h: 'Date', w: 8.88 },
    { h: 'Position', w: 60.5 },
    { h: 'Defect', w: 49.88, align: 'l' },
    { h: 'Status Repair', w: 15.38 },
    { h: 'Repair Date', w: 14.13 },
  ],
}

export const FACTORY_SHEET: DefectSheetSpec = {
  name: 'Defect-Factory', tab: { argb: 'FFFFC000' }, fontSize: 8,
  headerH: 14.45, rowH: 13.5, defaultColWidth: 8.25, zoom: 100,
  cols: [
    { h: 'no.', w: 6.38 },
    { h: 'Vin', w: 14.25 },
    { h: 'Model', w: 11.75 },
    { h: 'Stock of Status ', w: 11.75 },
    { h: 'Category defect', w: 19 },
    { h: 'Incharge', w: 19 },
    { h: 'Date', w: 11.75 },
    { h: 'Position', w: 19, align: 'l' },
    { h: 'Defect/NG', w: 19, align: 'l' },
    { h: 'Status Repair', w: 11.75, align: 'l' },
    { h: 'Repair Date', w: 11.75 },
  ],
}

export const WHALE_SHEET: DefectSheetSpec = {
  ...FACTORY_SHEET,
  name: 'Defect-Whale 28 rai', tab: { theme: 7, tint: 0.5999938962981048 }, defaultColWidth: 6.25,
  cols: [
    { h: 'no.', w: 6.38 },
    { h: 'Vin', w: 13.13 },
    { h: 'Model', w: 8.25 },
    { h: 'Stock of Status ', w: 12.75 },
    { h: 'Category defect', w: 14.63 },
    { h: 'Incharge', w: 9.38 },
    { h: 'Date', w: 7.25 },
    { h: 'Position', w: 20.75, align: 'l' },
    { h: 'Defect/NG', w: 33.88, align: 'l' },
    { h: 'Status Repair', w: 14.88, align: 'l' },
    { h: 'Repair Date', w: 10.75 },
  ],
}

export interface DefectExportRow { unit: Unit; dmg: Damage }

/** One defect record → master-sheet cell values, keyed by (trimmed) header. */
export function defectValue(header: string, seq: number, { unit, dmg }: DefectExportRow, cells: Record<string, string> | undefined): string | number {
  switch (header.trim()) {
    case 'No': case 'no.': return seq
    case 'VIN': case 'Vin': return unit.vin
    case 'Model': return cells?.['Model'] || unit.modelName || unit.model || ''
    case 'From': return ''
    case 'Stock of Status': return cells?.['Stock of Status'] || ''
    case 'Category NG': case 'Category defect': return dmg.categoryNG ?? ''
    case 'Category (Repair)': return dmg.categoryRepair ?? ''
    case 'Incharge': return dmg.incharge ?? ''
    case 'Date': return defDate(dmg.at)
    case 'Position': return dmg.area === '—' ? '' : dmg.area
    case 'Defect': case 'Defect/NG': return dmg.item ?? (dmg.type === '—' ? '' : dmg.type)
    case 'Status Repair': return dmg.statusRepair ?? (dmg.repairDate ? 'Repaired' : 'Waiting Repair')
    case 'Repair Date': return defDate(dmg.repairDate)
    default: return ''
  }
}

const THIN = { style: 'thin' as const }
const thinBorder = { top: THIN, left: THIN, bottom: THIN, right: THIN }
const fill = (color: object) => ({ type: 'pattern', pattern: 'solid', fgColor: color })

/** Add one master-format defect worksheet to a workbook. */
export function buildDefectSheet(wb: any, spec: DefectSheetSpec, rows: DefectExportRow[], trackByVin: Map<string, Record<string, string>>): void {
  const ws = wb.addWorksheet(spec.name, {
    views: [{ state: 'frozen', ySplit: 1, zoomScale: spec.zoom, zoomScaleNormal: spec.zoom }],
    properties: { tabColor: spec.tab, defaultRowHeight: spec.rowH, defaultColWidth: spec.defaultColWidth },
  })
  ws.columns = spec.cols.map((c) => ({
    width: c.w,
    style: {
      font: { name: 'Tahoma', size: spec.fontSize },
      alignment: c.align === 'l' ? { horizontal: 'left', vertical: 'middle' } : { horizontal: 'center', vertical: 'middle' },
      border: thinBorder,
    },
  }))
  const hr = ws.addRow(spec.cols.map((c) => c.h))
  hr.height = spec.headerH
  hr.eachCell({ includeEmpty: true }, (cell: any) => {
    cell.font = { name: 'Tahoma', size: spec.fontSize, bold: true }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = thinBorder
  })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.cols.length } }
  rows.forEach((r, i) => {
    ws.addRow(spec.cols.map((c) => defectValue(c.h, i + 1, r, trackByVin.get(r.unit.vin)))).height = spec.rowH
  })
}
void fill // fill kept exported-adjacent for parity with the tracking sheet; not needed for defect sheets

// ── standalone exports (Damages page): a chosen VIN set → xlsx / pdf ─────────

function downloadBlob(data: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Export the given sheets (spec + rows) as a styled .xlsx. */
export async function exportDefectExcel(sheets: { spec: DefectSheetSpec; rows: DefectExportRow[] }[], trackByVin: Map<string, Record<string, string>>, filename: string): Promise<void> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  for (const { spec, rows } of sheets) buildDefectSheet(wb, spec, rows, trackByVin)
  const buf = await wb.xlsx.writeBuffer()
  downloadBlob(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename)
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Print the given sheets as a PDF (one titled table per sheet, master headers). */
export function printDefectReport(sheets: { spec: DefectSheetSpec; rows: DefectExportRow[] }[], trackByVin: Map<string, Record<string, string>>, docTitle: string): void {
  const sections = sheets.map(({ spec, rows }) => {
    const head = spec.cols.map((c) => `<th>${esc(c.h.trim())}</th>`).join('')
    const body = rows.length
      ? rows.map((r, i) => `<tr>${spec.cols.map((c) => `<td class="${c.align === 'l' ? 'l' : 'c'}">${esc(defectValue(c.h, i + 1, r, trackByVin.get(r.unit.vin)))}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="c" colspan="${spec.cols.length}" style="color:#888">— ไม่มีข้อมูล —</td></tr>`
    return `<div class="sec">${esc(spec.name)} — ${rows.length} รายการ</div>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }).join('')
  const css = `
    @page { size: A4 landscape; margin: 8mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: 'Sarabun','Noto Sans Thai',Tahoma,sans-serif; color: #111; }
    .doc-title { text-align: center; font-size: 15px; font-weight: 700; margin: 2px 0 10px; }
    .sec { font-size: 12px; font-weight: 700; margin: 12px 0 4px; color: #b45309; page-break-after: avoid; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    th, td { border: 1px solid #000; font-size: 8.5px; padding: 2px 4px; vertical-align: middle; }
    th { background: #ffff00; font-weight: 700; text-align: center; }
    td.c { text-align: center; } td.l { text-align: left; }
    tbody tr:nth-child(even) td { background: #fafafa; }
  `
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(docTitle)}</title><style>${css}</style></head><body><div class="doc-title">${esc(docTitle)}</div>${sections}</body></html>`
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)
  const idoc = iframe.contentWindow?.document
  if (!idoc) { iframe.remove(); return }
  idoc.open(); idoc.write(html); idoc.close()
  setTimeout(() => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print() } catch { /* noop */ }
    setTimeout(() => iframe.remove(), 1500)
  }, 300)
}
