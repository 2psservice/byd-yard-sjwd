/**
 * Printable grouping sheets:
 *  • Grouping-to-Dealer — the delivery plan grouped by Grouping Number, with the
 *    yard Location + Lane load filled in (one A4 landscape sheet).
 *  • Find-car (ใบหารถ) — the same cars sorted by yard Location (A1..Z50) so a
 *    driver can walk the yard collecting them in order (one A4 portrait sheet).
 */

import { byYardLocation } from './groupingImport'
import { borrowDocTitle, fileStamp } from './printDoc'
import { departedViewFrom } from './siteScope'
import type { TrackRow } from './excelTracking'
import type { Site } from '../types'

export interface GroupPrintRow {
  no: number
  vin: string
  modelName: string
  model: string
  color: string
  deliveryLocation: string
  grouping: string
  groupUnit: number   // cars in this grouping number
  yardLocation: string // "N-V41" (blank if the car isn't placed in the yard)
  laneLoad: string    // "O1"
  /** set when someone typed this lane on the Grouping sheet (screen only) */
  laneBy?: string
  laneAt?: number
  receiveDate: string
  remark: string
}

/**
 * The row DN / IR print for one car of the Grouping sheet — every car the sheet lists prints, from the
 * best copy of its data: this yard's row (the import stamped 'Grouping  Number' + 'Dealer Location' onto
 * it) → the car as this yard last saw it, when it has gone out and its row now sits at the next yard →
 * its row at any yard, read only → the plan's own Model / Color / dealer. Only this yard's rows used to
 * print, so a run whose other cars had no row here printed just the one that did, and ticking only the
 * others greyed the buttons out (27/10 3D LCB: 6 of 7 cars showing Location ไม่พบ could not be printed).
 */
export function printRowFor(r: GroupPrintRow, own: TrackRow | undefined, any: TrackRow | undefined, siteId: string | null, sites: Site[]): TrackRow {
  if (own) return own
  if (any) return departedViewFrom(any, siteId, sites) ?? any
  return { vin: r.vin, cells: { Vin: r.vin, Model: r.model, 'Model name': r.modelName || r.model, Color: r.color,
    'Grouping  Number': r.grouping, 'Dealer Location': r.deliveryLocation } }
}

export interface GroupPrintMeta {
  siteLabel: string   // "NYB2", "Rayong", …
  date: string        // "06 July 2026"
  totalUnits: number
  groupCount: number
  /** Yard prefix for find-car Location codes ("N" → prints "N-P38"). */
  locPrefix?: string
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const CSS = `
@page { size: A4 landscape; margin: 8mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: 'Sarabun','Noto Sans Thai',Tahoma,'Leelawadee UI',sans-serif; color: #111; }
.title { text-align: center; font-size: 14px; font-weight: 700; margin: 2px 0 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #000; font-size: 9px; padding: 3px 4px; vertical-align: middle; }
th { background: #ffff00; font-weight: 700; text-align: center; }
td.c { text-align: center; }
td.vin { font-family: 'JetBrains Mono','Consolas',monospace; font-size: 9px; letter-spacing: .2px; }
tr.grp-alt td { background: #ffff00; }
.tot td { background: #ffff00; font-weight: 700; text-align: center; }
.note { text-align: center; font-size: 9px; margin-top: 4px; }
`
/**
 * ใบหารถ (Find-car sheet): portrait A4, typeset to match the FIS sheet the yard already prints
 * ("Rayong - Grouping to Dealer ( 180 Units / 29 Groups) Date 02 November 2026", Excel → PDF).
 * Every number below was measured out of that PDF (pdftotext boxes + the ruled lines at 144 dpi,
 * text widths checked against Carlito, Calibri's metric twin):
 *
 *   font     Calibri — data and title 11.6 pt (title bold), header 9.8 pt bold
 *   bands    title 25.5 pt · header 23.5 pt (yellow #FFFF00) · rows 19.44 pt
 *   columns  No 38.5 · Vin 120 · Model 76.5 · Color 66 · Location 98.5 · Lane load 76.5 · หมายเหตุ 120.5
 *   colour   Vin and Lane load cells: blue #0000FF text on light yellow #FFFFCC; the rest black on white
 *   every page repeats the title + header (Excel print titles) — here both live in <thead>
 *
 * Calibri ships with Windows; Carlito (same metrics) / Tahoma stand in elsewhere, and Thai
 * (หมายเหตุ) falls to Tahoma like Excel does. 38 rows per page fit A4 with ~20 pt to spare:
 * 25.5 + 23.5 + 38 × 19.44 = 787.7 pt of the 816.9 pt between the margins — and the break is
 * forced every 38 rows so a printer's own font substitution can never squeeze in a 39th.
 */
const FIND_ROWS_PER_PAGE = 38
const CSS_PORTRAIT = `
@page { size: A4 portrait; margin: 12.5pt 12pt; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #000; font-family: Calibri, Carlito, Tahoma, 'Leelawadee UI', 'Noto Sans Thai', sans-serif; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 0.75pt solid #000; padding: 0 3pt; vertical-align: middle; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
thead tr.ttl th { border: 0; background: #fff; height: 25.5pt; font-size: 11.6pt; font-weight: 700; }
thead tr.hd th { background: #ffff00; height: 23.5pt; font-size: 9.8pt; font-weight: 700; }
td { height: 19.44pt; font-size: 11.6pt; font-weight: 400; }
td.vin, td.lane { background: #ffffcc; color: #0000ff; }
td.rm { text-align: left; }
tbody tr:nth-child(${FIND_ROWS_PER_PAGE}n) { page-break-after: always; break-after: page; }
`
/** column widths (pt, from the FIS sheet) as percentages of the table */
const findCols = (w: number[]): string => {
  const sum = w.reduce((a, b) => a + b, 0)
  return `<colgroup>${w.map((x) => `<col style="width:${((x / sum) * 100).toFixed(2)}%">`).join('')}</colgroup>`
}
const FIND_COLS_LANE = [38.5, 120, 76.5, 66, 98.5, 76.5, 120.5]
const FIND_COLS = [38.5, 120, 76.5, 66, 98.5, 197] // ใบหารถ without Lane load: หมายเหตุ takes its width

const htmlDoc = (title: string, body: string, css: string): string =>
  `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`

const titleLine = (m: GroupPrintMeta): string =>
  `${esc(m.siteLabel)} - Grouping to Dealer ( ${m.totalUnits} Units / ${m.groupCount} ${m.groupCount === 1 ? 'Group' : 'Groups'}) Date ${esc(m.date)}`

/** ordered list of groups (grouping number → its rows), in first-seen order */
function groupRows(rows: GroupPrintRow[]): { grouping: string; rows: GroupPrintRow[] }[] {
  const order: string[] = []
  const map = new Map<string, GroupPrintRow[]>()
  for (const r of rows) {
    if (!map.has(r.grouping)) { map.set(r.grouping, []); order.push(r.grouping) }
    map.get(r.grouping)!.push(r)
  }
  return order.map((g) => ({ grouping: g, rows: map.get(g)! }))
}

// ── Grouping to Dealer sheet ───────────────────────────────────────────────
export function buildGroupingHtml(rows: GroupPrintRow[], meta: GroupPrintMeta): string {
  const groups = groupRows(rows)
  let n = 0
  const body = groups.map((g, gi) => g.rows.map((r, ri) => {
    n++
    const first = ri === 0
    const span = g.rows.length
    const alt = gi % 2 === 1 ? ' grp-alt' : ''
    return `<tr class="${alt.trim()}">
      <td class="c">${n}</td>
      <td class="vin">${esc(r.vin)}</td>
      <td class="c">${esc(r.model)}</td>
      <td class="c">${esc(r.color)}</td>
      <td>${esc(r.deliveryLocation)}</td>
      <td class="c">${esc(r.grouping)}</td>
      ${first ? `<td class="c" rowspan="${span}"><b>${g.rows.length}</b></td>` : ''}
      <td class="c">${esc(r.yardLocation)}</td>
      ${first ? `<td class="c" rowspan="${span}"><b>${esc(r.laneLoad)}</b></td>` : ''}
      ${first ? `<td class="c" rowspan="${span}">${esc(r.receiveDate || meta.date)}</td>` : ''}
      <td>${esc(r.remark)}</td>
    </tr>`
  }).join('')).join('')

  const table = `<table>
    <thead><tr>
      <th>No</th><th>Vin</th><th>Model</th><th>Color</th><th>Delivery Location</th>
      <th>Groupping Number</th><th>Grouping (Unit)</th><th>Location</th><th>Lane load</th>
      <th>วันที่ในการเข้ารับ</th><th>หมายเหตุ</th>
    </tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr class="tot">
      <td colspan="6">Total</td><td>${meta.totalUnits}</td><td>Cars.</td><td colspan="3"></td>
    </tr></tfoot>
  </table>
  <div class="note">( ${meta.groupCount} Group )</div>`

  return htmlDoc(titleLine(meta), `<div class="title">${titleLine(meta)}</div>${table}`, CSS)
}

// ── Find-car sheet (sorted by yard Location A1..Z50) ────────────────────────
export function buildFindCarHtml(rows: GroupPrintRow[], meta: GroupPrintMeta): string {
  // byYardLocation is shared with the Driver / Gate-out queues so the printed sheet
  // and the on-screen list walk the yard in the exact same order.
  const sorted = [...rows].sort((a, b) => byYardLocation(a.yardLocation, b.yardLocation))
  // print with the yard prefix ("P38" → "N-P38") — the code itself stays
  // unprefixed for sorting and for the landscape dealer sheet
  const locOf = (l: string) => (l && meta.locPrefix ? `${meta.locPrefix}-${l}` : l)
  const body = sorted.map((r, i) => `<tr>
    <td>${i + 1}</td>
    <td class="vin">${esc(r.vin)}</td>
    <td>${esc(r.model)}</td>
    <td>${esc(r.color)}</td>
    <td>${esc(locOf(r.yardLocation) || '—')}</td>
    <td class="lane">${esc(r.laneLoad)}</td>
    <td class="rm">${esc(r.remark)}</td>
  </tr>`).join('')

  // title + header sit in <thead> so every printed page repeats both, like the FIS sheet
  const table = `<table>${findCols(FIND_COLS_LANE)}
    <thead>
      <tr class="ttl"><th colspan="7">${titleLine(meta)}</th></tr>
      <tr class="hd"><th>No</th><th>Vin</th><th>Model</th><th>Color</th><th>Location</th><th>Lane load</th><th>หมายเหตุ</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`
  return htmlDoc(`หารถ ${titleLine(meta)}`, table, CSS_PORTRAIT)
}

// ── "ใบหารถ" (car-finding list) — arbitrary VIN set, no grouping/lane ────────
// Columns: No · Vin · Model · Color · Location · หมายเหตุ. Sorted by yard
// location so a driver walks the yard in order. Title "ใบหารถ N คัน".
export interface FindListRow {
  vin: string
  model: string
  color: string
  location: string  // yard code "N-N12" (or the raw cell fallback), '' when unknown
  /** Set when the car has left the yard: the gate-out date as "12AUG26" (or ''
   *  when it left but no readable date survives). A car with no location is
   *  usually not lost — it has already gone out — and "ไม่พบตำแหน่ง" sent
   *  drivers hunting the yard for it. */
  gateOut?: string
  remark: string
}

/** What the Location column says for one row — the same answer on screen, in
 *  the PDF and in the Excel, so a printed sheet never contradicts the panel. */
export function findLocationText(r: FindListRow): string {
  if (r.location) return r.location
  if (r.gateOut !== undefined) return r.gateOut ? `Gate out ${r.gateOut}` : 'Gate out'
  return ''
}

const findListTitle = (count: number, date: string): string =>
  `ใบหารถ ${count} คัน${date ? ` · ${date}` : ''}`

/** Rows print in the order they are GIVEN — the find-car screen sorts them
 *  (click a column header) and the sheet has to come out matching what is on
 *  screen. It used to re-sort by yard location here, which silently threw that
 *  choice away. Callers that want the walk-the-yard order pass rows already
 *  sorted with byYardLocation (which is still the screen's default). */
function findListTableHtml(rows: FindListRow[], title: string): string {
  const body = rows.map((r, i) => `<tr>
    <td>${i + 1}</td>
    <td class="vin">${esc(r.vin)}</td>
    <td>${esc(r.model)}</td>
    <td>${esc(r.color)}</td>
    <td>${esc(findLocationText(r) || '—')}</td>
    <td class="rm">${esc(r.remark)}</td>
  </tr>`).join('')
  return `<table>${findCols(FIND_COLS)}
    <thead>
      <tr class="ttl"><th colspan="6">${esc(title)}</th></tr>
      <tr class="hd"><th>No</th><th>Vin</th><th>Model</th><th>Color</th><th>Location</th><th>หมายเหตุ</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`
}

export function buildFindListHtml(rows: FindListRow[], date: string): string {
  const title = findListTitle(rows.length, date)
  return htmlDoc(title, findListTableHtml(rows, title), CSS_PORTRAIT)
}

export const printFindList = (rows: FindListRow[], date: string): void => {
  // "ใบหารถ 15 คัน 31 AUG26.pdf" — a folder of saved sheets says what each one is
  if (rows.length) printHtml(buildFindListHtml(rows, date), `ใบหารถ ${rows.length} คัน ${fileStamp(date)}`)
}

/** ใบหารถ .xlsx in the FIS sheet's style (see CSS_PORTRAIT): Calibri 11, bold 9.5 header on yellow,
 *  Vin / Lane load blue on light yellow, title + header repeated on every printed page.
 *  Widths are the FIS columns in Excel character units. */
function styleFindSheet(ws: any, title: string, headers: string[], widths: number[], blueCols: number[], leftCols: number[]): {
  addRow: (values: unknown[]) => void
} {
  const font = { name: 'Calibri', size: 11 }
  ws.columns = widths.map((w) => ({ width: w, style: { font } }))
  const titleRow = ws.addRow([title])
  ws.mergeCells(1, 1, 1, headers.length)
  titleRow.height = 24
  titleRow.getCell(1).font = { ...font, bold: true }
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }
  const thin = { style: 'thin', color: { argb: 'FF000000' } }
  const border = { top: thin, left: thin, bottom: thin, right: thin }
  const hr = ws.addRow(headers)
  hr.height = 22
  hr.eachCell((c: any) => {
    c.font = { name: 'Calibri', size: 9.5, bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
    c.alignment = { horizontal: 'center', vertical: 'middle' }
    c.border = border
  })
  ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    printTitlesRow: '1:2', margins: { left: 0.17, right: 0.17, top: 0.17, bottom: 0.17, header: 0, footer: 0 } }
  return {
    addRow: (values) => {
      const row = ws.addRow(values)
      row.height = 18.3
      row.eachCell({ includeEmpty: true }, (c: any, col: number) => {
        c.border = border
        c.alignment = { horizontal: leftCols.includes(col) ? 'left' : 'center', vertical: 'middle' }
        if (blueCols.includes(col)) {
          c.font = { ...font, color: { argb: 'FF0000FF' } }
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFCC' } }
        }
      })
    },
  }
}

/** Export the ใบหารถ list as a styled .xlsx (yellow header like the master sheets). */
export async function exportFindListXlsx(rows: FindListRow[], date: string): Promise<void> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const ws = wb.addWorksheet('ใบหารถ', { views: [{ state: 'frozen', ySplit: 2 }] })

  const sheet = styleFindSheet(ws, findListTitle(rows.length, date),
    ['No', 'Vin', 'Model', 'Color', 'Location', 'หมายเหตุ'], [6.9, 21.5, 13.7, 11.8, 17.7, 35.3], [2], [6])
  // given order wins — same reason as findListTableHtml above
  rows.forEach((r, i) => sheet.addRow([i + 1, r.vin, r.model, r.color, findLocationText(r) || '—', r.remark]))

  const stamp = new Date().toISOString().slice(0, 10)
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `SJWD-ใบหารถ-${rows.length}คัน-${stamp}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Excel exports (same layout as the printed sheets, yellow headers) ────────

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const downloadXlsx = async (wb: any, filename: string): Promise<void> => {
  const buf = await wb.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buf], { type: XLSX_MIME }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Grouping-to-Dealer sheet as .xlsx — 1:1 with the printout: merged group
 *  cells for Grouping (Unit) / Lane load / date, alternating group stripes,
 *  yellow Total row. */
export async function exportGroupingXlsx(rows: GroupPrintRow[], meta: GroupPrintMeta): Promise<void> {
  if (!rows.length) return
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const ws = wb.addWorksheet('Grouping', { views: [{ state: 'frozen', ySplit: 2 }] })

  const headers = ['No', 'Vin', 'Model', 'Color', 'Delivery Location', 'Groupping Number',
    'Grouping (Unit)', 'Location', 'Lane load', 'วันที่ในการเข้ารับ', 'หมายเหตุ']
  const widths = [5, 21, 13, 10, 42, 18, 13, 10, 10, 18, 16]
  ws.columns = widths.map((w) => ({ width: w, style: { font: { name: 'Tahoma', size: 10 } } }))

  const titleRow = ws.addRow([titleLine(meta)])
  ws.mergeCells(1, 1, 1, headers.length)
  titleRow.height = 22
  titleRow.getCell(1).font = { name: 'Tahoma', size: 12, bold: true }
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }

  const thin = { style: 'thin', color: { argb: 'FF000000' } }
  const border = { top: thin, left: thin, bottom: thin, right: thin }
  const hr = ws.addRow(headers)
  hr.height = 18
  hr.eachCell((c: any) => {
    c.font = { name: 'Tahoma', size: 10, bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    c.border = border
  })

  let n = 0
  let rowIdx = 3 // first data row (1=title, 2=header)
  for (const [gi, g] of groupRows(rows).entries()) {
    const start = rowIdx
    for (const r of g.rows) {
      n++
      const row = ws.addRow([n, r.vin, r.model, r.color, r.deliveryLocation, r.grouping,
        g.rows.length, r.yardLocation, r.laneLoad, r.receiveDate || meta.date, r.remark])
      row.height = 16
      row.eachCell({ includeEmpty: true }, (c: any, col: number) => {
        c.border = border
        c.alignment = { horizontal: col === 5 || col === 11 ? 'left' : 'center', vertical: 'middle' }
        if (gi % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3D6' } }
        if (col === 7 || col === 9) c.font = { name: 'Tahoma', size: 10, bold: true }
      })
      rowIdx++
    }
    if (g.rows.length > 1) for (const col of [7, 9, 10]) ws.mergeCells(start, col, rowIdx - 1, col)
  }

  const tot = ws.addRow(['Total', '', '', '', '', '', meta.totalUnits, 'Cars.', '', '', ''])
  ws.mergeCells(rowIdx, 1, rowIdx, 6)
  tot.height = 18
  tot.eachCell({ includeEmpty: true }, (c: any) => {
    c.font = { name: 'Tahoma', size: 10, bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
    c.alignment = { horizontal: 'center', vertical: 'middle' }
    c.border = border
  })

  const stamp = new Date().toISOString().slice(0, 10)
  await downloadXlsx(wb, `SJWD-Grouping-${meta.siteLabel}-${rows.length}คัน-${stamp}.xlsx`)
}

/** ใบหารถ of the grouping plan as .xlsx — sorted by yard location (same walk
 *  order as the printed sheet), with the Lane load column. */
export async function exportFindCarXlsx(rows: GroupPrintRow[], meta: GroupPrintMeta): Promise<void> {
  if (!rows.length) return
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const ws = wb.addWorksheet('ใบหารถ', { views: [{ state: 'frozen', ySplit: 2 }] })

  const sheet = styleFindSheet(ws, titleLine(meta),
    ['No', 'Vin', 'Model', 'Color', 'Location', 'Lane load', 'หมายเหตุ'], [6.9, 21.5, 13.7, 11.8, 17.7, 13.7, 21.6], [2, 6], [7])
  const sorted = [...rows].sort((a, b) => byYardLocation(a.yardLocation, b.yardLocation))
  const locOf = (l: string) => (l && meta.locPrefix ? `${meta.locPrefix}-${l}` : l)
  sorted.forEach((r, i) => sheet.addRow([i + 1, r.vin, r.model, r.color, locOf(r.yardLocation) || '—', r.laneLoad, r.remark]))

  const stamp = new Date().toISOString().slice(0, 10)
  await downloadXlsx(wb, `SJWD-ใบหารถ-${meta.siteLabel}-${rows.length}คัน-${stamp}.xlsx`)
}

/** Render HTML in a hidden iframe, wait a beat, then open the print dialog. */
function printHtml(html: string, fileName?: string): void {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)
  const idoc = iframe.contentWindow?.document
  if (!idoc) { iframe.remove(); return }
  idoc.open(); idoc.write(html); idoc.close()
  const fire = () => {
    // the saved PDF is named after the PAGE's title, not this iframe's
    if (fileName) borrowDocTitle(fileName, iframe.contentWindow)
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print() } catch { /* noop */ }
    setTimeout(() => iframe.remove(), 1500)
  }
  setTimeout(fire, 300)
}

export const printGrouping = (rows: GroupPrintRow[], meta: GroupPrintMeta): void => {
  if (rows.length) printHtml(buildGroupingHtml(rows, meta), `Grouping to Dealer ${meta.totalUnits} คัน ${fileStamp(meta.date)}`)
}
export const printFindCar = (rows: GroupPrintRow[], meta: GroupPrintMeta): void => {
  if (rows.length) printHtml(buildFindCarHtml(rows, meta), `ใบหารถ ${rows.length} คัน ${fileStamp(meta.date)}`)
}
