/**
 * Defect-sheet export — the master-workbook "Defect-Yard / Defect-Factory /
 * Defect-Whale" sheets, shared by the Report page (full export) and the Damages
 * page (report a chosen set of VINs). Column widths / fonts / row heights were
 * measured 1:1 from the master file, so an exported sheet re-imports cleanly.
 */
import type { Damage, Unit } from '../types'
import { partLabel, defectLabel } from './damageLabel'
import { VIN_PHOTO_CELL } from './trackingColumns'

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
    case 'Position': return partLabel(dmg, 'en') === '—' ? '' : partLabel(dmg, 'en')
    case 'Defect': case 'Defect/NG': return defectLabel(dmg, 'en')
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

// ── photo report — the "Summary Defect list" template (BYD NYB sheet) ────────
// Layout measured 1:1 from the customer's file: 2-row header (Photo band merged
// over Export Label / Zoom / General View), Arial, grey header fills, light-green
// body rows 129 tall with one photo per cell, duplicate-VIN highlight on E,
// landscape A4 @ 55%. The Photo band GROWS with the data: a defect with 5 photos
// gets 5 defect-photo columns (Zoom, General  View, Photo 4, Photo 5, …).

const P_FIXED_W = [12.6640625, 29.77734375, 27.44140625, 20.77734375, 22.5546875] // A–E
const P_PHOTO_W = 33.33203125                       // every Photo-band column
const P_TAIL_W = [20.33203125, 18, 26.77734375]     // Part Defect / Problem / Remark
const P_HEAD_FIXED = ['No', 'Inspection Date', 'Model Name', 'Color Name', 'Vin Number']
const P_HEAD_TAIL = ['Part Defect', 'Problem', 'Remark']
// template spells "General  View" with 2 spaces; extra columns continue Photo 4, 5, …
const photoLabels = (n: number): string[] =>
  ['Export Label', 'Zoom', 'General  View', ...Array.from({ length: Math.max(0, n - 3) }, (_, i) => `Photo ${i + 4}`)].slice(0, n)
const P_GREY_DARK = 'FFBFBFBF'   // theme0 tint -0.25 — No + Photo band
const P_GREY_LIGHT = 'FFD9D9D9'  // theme0 tint -0.15 — all other headers
const P_GREEN = 'FFE2EFDA'       // theme9 (accent6) tint 0.8 — body rows
const P_DATE_FMT = '[$-1010409]d mmm yy;@'
const MEDIUM = { style: 'medium' as const }
const mediumBorder = { top: MEDIUM, left: MEDIUM, bottom: MEDIUM, right: MEDIUM }
// image size in px ≈ the full cell (col 33.33 chars ≈ 238px, row 129pt ≈ 172px,
// same as the template's own embedded shots ~227×169) so photos FILL the column
const P_IMG_W = 232
const P_IMG_H = 168

/** 1-based column number → A1-style letter(s). */
function colLetter(n: number): string {
  let s = ''
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}

/** All photos of one defect (photos[] with single-photo fallback). */
const defectPhotos = (d: Damage): string[] => (d.photos?.length ? d.photos : (d.photo ? [d.photo] : []))

/** dmg.at → Date pinned to UTC midnight of the LOCAL day, so the "d mmm yy"
 *  cell never slips a day when exceljs serializes it as UTC. */
function localDay(ts: number): Date {
  const d = new Date(ts)
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
}

/** URL / data-URL → workbook image id (cached — the same VIN-label shot repeats
 *  on every row of that car). null when the photo can't be read (row stays blank). */
async function photoImageId(wb: any, src: string | undefined, cache: Map<string, Promise<number | null>>): Promise<number | null> {
  if (!src) return null
  let p = cache.get(src)
  if (!p) {
    p = (async () => {
      try {
        let base64: string
        let extension: 'jpeg' | 'png' = 'jpeg'
        if (src.startsWith('data:')) {
          const m = src.match(/^data:image\/([a-z+]+);base64,(.+)$/i)
          if (!m) return null
          extension = /png/i.test(m[1]) ? 'png' : 'jpeg'
          base64 = m[2]
        } else {
          const res = await fetch(src)
          if (!res.ok) return null
          const blob = await res.blob()
          extension = /png/i.test(blob.type) ? 'png' : 'jpeg'
          base64 = await new Promise<string>((resolve, reject) => {
            const r = new FileReader()
            r.onerror = reject
            r.onload = () => resolve((r.result as string).split(',')[1] ?? '')
            r.readAsDataURL(blob)
          })
          if (!base64) return null
        }
        return wb.addImage({ base64, extension }) as number
      } catch { return null }
    })()
    cache.set(src, p)
  }
  return p
}

export interface PhotoReportSheet { name: string; rows: DefectExportRow[] }

/** Build one template-format photo sheet and embed its images. */
async function buildPhotoSheet(wb: any, name: string, rows: DefectExportRow[], trackByVin: Map<string, Record<string, string>>, cache: Map<string, Promise<number | null>>): Promise<void> {
  const ws = wb.addWorksheet(name, {
    views: [{ zoomScale: 70, zoomScaleNormal: 70 }],
    pageSetup: {
      paperSize: 9, orientation: 'landscape', scale: 55,
      margins: { left: 0, right: 0.118110236220472, top: 0.236220472440945, bottom: 0.354330708661417, header: 0.31496062992126, footer: 0.31496062992126 },
    },
  })
  // the Photo band = Export Label + one column per defect photo (at least the
  // template's 2: Zoom + General  View) — a 5-photo defect gets 5 photo columns
  const maxDefect = Math.max(2, ...rows.map((r) => defectPhotos(r.dmg).length))
  const band = 1 + maxDefect          // photo columns, starting at F
  const lastBandCol = 5 + band        // 1-based index of the band's last column
  ws.columns = [...P_FIXED_W, ...Array.from({ length: band }, () => P_PHOTO_W), ...P_TAIL_W].map((w) => ({ width: w }))

  // header (2 rows) — the Photo band spans F:<last>, everything else spans both rows
  const h1 = ws.addRow([...P_HEAD_FIXED, 'Photo', ...Array.from({ length: band - 1 }, () => ''), ...P_HEAD_TAIL]); h1.height = 68.4
  const h2 = ws.addRow(['', '', '', '', '', ...photoLabels(band), '', '', '']); h2.height = 79.2
  for (let c = 1; c <= 5; c++) ws.mergeCells(`${colLetter(c)}1:${colLetter(c)}2`)
  ws.mergeCells(`F1:${colLetter(lastBandCol)}1`)
  for (let c = lastBandCol + 1; c <= lastBandCol + 3; c++) ws.mergeCells(`${colLetter(c)}1:${colLetter(c)}2`)
  for (const row of [h1, h2]) row.eachCell({ includeEmpty: true }, (cell: any, col: number) => {
    // A1:A2 (merged) + the Photo band are the darker grey; row 2 col A is a
    // merge-slave of A1, so it must stay dark too or its pass repaints the master
    const dark = col === 1 || (row.number === 1 && col >= 6 && col <= lastBandCol)
    cell.font = { name: 'Arial', size: 11, bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dark ? P_GREY_DARK : P_GREY_LIGHT } }
    cell.border = mediumBorder
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })
  ws.getCell('B1').numFmt = P_DATE_FMT

  // body rows + collect photo placements
  const places: { id: Promise<number | null>; col: number; row: number }[] = []
  rows.forEach((r, i) => {
    const cells = trackByVin.get(r.unit.vin)
    const remark = [r.dmg.remark, (r.dmg.severity === 'major' || /HEAVY/i.test(String(r.dmg.categoryNG ?? ''))) ? 'HV NG' : '']
      .filter(Boolean).join(' · ')
    const row = ws.addRow([
      i + 1,
      r.dmg.at ? localDay(r.dmg.at) : '',
      cells?.['Model name'] || r.unit.modelName || '',
      cells?.['Color'] || r.unit.color || '',
      r.unit.vin,
      ...Array.from({ length: band }, () => ''),
      partLabel(r.dmg, 'en') === '—' ? '' : partLabel(r.dmg, 'en'),
      defectLabel(r.dmg, 'en'),
      remark,
    ])
    row.height = 129
    row.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.font = { name: 'Arial', size: 11 }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: P_GREEN } }
      cell.border = thinBorder
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    })
    row.getCell(2).numFmt = P_DATE_FMT
    const rowIdx = row.number - 1 // 0-based for image anchors
    const photos: (string | undefined)[] = [
      cells?.[VIN_PHOTO_CELL],        // F — Export Label (per-car VIN shot)
      ...defectPhotos(r.dmg),         // G… — every defect photo, one per column
    ]
    photos.forEach((src, pi) => {
      if (src) places.push({ id: photoImageId(wb, src, cache), col: 5 + pi, row: rowIdx })
    })
  })

  // duplicate-VIN highlight (the customer's file flags repeat VINs pink on E) —
  // exceljs can't serialize the native duplicateValues rule, so use the
  // equivalent COUNTIF expression (renders identically in Excel)
  const lastRow = Math.max(3, rows.length + 2)
  ws.addConditionalFormatting({
    ref: `E3:E${lastRow}`,
    rules: [{
      type: 'expression', priority: 1,
      formulae: [`COUNTIF($E$3:$E$${lastRow},E3)>1`],
      style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } }, font: { color: { argb: 'FF9C0006' } } },
    }],
  })

  for (const pl of places) {
    const id = await pl.id
    if (id == null) continue
    // fixed pixel extent (like the template's own shots) — a fractional tl/br
    // box renders shrunken in Excel/Google Sheets, so pin the size instead
    ws.addImage(id, {
      tl: { col: pl.col + 0.015, row: pl.row + 0.015 },
      ext: { width: P_IMG_W, height: P_IMG_H },
      editAs: 'oneCell',
    })
  }
}

/** Export the photo report (template format, embedded images) as .xlsx. */
export async function exportDefectPhotoExcel(sheets: PhotoReportSheet[], trackByVin: Map<string, Record<string, string>>, filename: string): Promise<void> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const cache = new Map<string, Promise<number | null>>()
  for (const { name, rows } of sheets) await buildPhotoSheet(wb, name, rows, trackByVin, cache)
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
