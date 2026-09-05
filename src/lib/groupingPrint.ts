/**
 * Printable grouping sheets:
 *  • Grouping-to-Dealer — the delivery plan grouped by Grouping Number, with the
 *    yard Location + Lane load filled in (one A4 landscape sheet).
 *  • Find-car (ใบหารถ) — the same cars sorted by yard Location (A1..Z50) so a
 *    driver can walk the yard collecting them in order (one A4 portrait sheet).
 */

import { byYardLocation } from './groupingImport'
import { borrowDocTitle, fileStamp } from './printDoc'

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
  receiveDate: string
  remark: string
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
tr.grp-alt td { background: #fff3d6; }
.tot td { background: #ffff00; font-weight: 700; text-align: center; }
.note { text-align: center; font-size: 9px; margin-top: 4px; }
`
/**
 * Find-car sheet: few columns on a PORTRAIT page, originally typeset 1:1
 * against the approved printout (Plan PM 20 RAI) — every number below was
 * measured out of that PDF's content stream, not guessed:
 *
 *   page     A4 portrait 595.2 × 841.68 pt, content 13.44 … 577.56 (564.12 wide)
 *   title    19.32 pt, band 35.76 pt tall
 *   header   10.56 pt on the yellow band, 42.96 pt tall
 *   row      31.20 pt tall (baselines 729.94 · 698.74 · 667.51 … = 31.2 apart)
 *   Vin      14.16 pt   ·   No 17.64 pt (the number the driver reads first)
 *
 * That 1:1 scale only fit 23 rows per A4 portrait page (816.68pt of content
 * height between the 12.5pt top/bottom margins, minus the title band's own
 * height AND its margin-bottom, minus the header band, ÷ 31.2pt row height)
 * — a lot of paper for a 60-70 car lot. Scaled every dimension down together
 * (title/header/row/font/margins all by the same ~×0.785, so the sheet keeps
 * the same proportions, just smaller) to fit 30 rows on one page instead: 28
 * (title) + 3 (title margin) + 33.7 (header) + 30×24.5 (rows) = 799.7pt,
 * comfortably inside the 816.68pt available — verified against an actual
 * rendered PDF, not just this arithmetic (a rounding-sized overshoot here
 * silently pushes the 30th row onto a second page). Overrides come last so
 * they win on specificity.
 */
const CSS_PORTRAIT = CSS.replace('A4 landscape', 'A4 portrait')
  .replace('margin: 8mm', 'margin: 12.5pt 15pt') + `
body, th, td { font-family: 'Aptos Narrow','Aptos','Arial Narrow','Sarabun','Noto Sans Thai',Tahoma,sans-serif; }
.title { font-size: 15.2pt; height: 28pt; line-height: 28pt; margin: 0 0 3pt; }
th { font-size: 8.3pt; height: 33.7pt; padding: 1.6pt 4.7pt;
  font-family: 'Aptos SemiBold','Aptos','Sarabun','Noto Sans Thai',Tahoma,sans-serif; }
td { font-size: 11.1pt; height: 24.5pt; padding: 0 4.7pt; }
/* the row number is read first, from a walking distance — biggest type on the sheet */
td.no { font-size: 13.8pt; font-weight: 600;
  font-family: 'Aptos SemiBold','Aptos','Sarabun','Noto Sans Thai',Tahoma,sans-serif; }
td.vin { font-family: 'Aptos Narrow','Aptos','Arial Narrow','Consolas',monospace; font-size: 11.1pt; letter-spacing: 0; }
/* Lane load reads at a glance same as the header band — filled the whole column, not just bold text */
td.lane { background: #ffff00; font-weight: 700; }
.note { font-size: 11.1pt; }
`

const htmlDoc = (title: string, body: string, css: string): string =>
  `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`

const titleLine = (m: GroupPrintMeta): string =>
  `${esc(m.siteLabel)} - Grouping to Dealer ( ${m.totalUnits} Units / ${m.groupCount} Group) Date ${esc(m.date)}`

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
    <td class="c no">${i + 1}</td>
    <td class="vin">${esc(r.vin)}</td>
    <td class="c">${esc(r.model)}</td>
    <td class="c">${esc(r.color)}</td>
    <td class="c"><b>${esc(locOf(r.yardLocation) || '—')}</b></td>
    <td class="c lane">${esc(r.laneLoad)}</td>
    <td>${esc(r.remark)}</td>
  </tr>`).join('')

  const table = `<table>
    <thead><tr>
      <th>No</th><th>Vin</th><th>Model</th><th>Color</th><th>Location</th><th>Lane load</th><th>หมายเหตุ</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
  return htmlDoc(`หารถ ${titleLine(meta)}`, `<div class="title">${titleLine(meta)}</div>${table}`, CSS_PORTRAIT)
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
function findListTableHtml(rows: FindListRow[]): string {
  const body = rows.map((r, i) => `<tr>
    <td class="c no">${i + 1}</td>
    <td class="vin">${esc(r.vin)}</td>
    <td class="c">${esc(r.model)}</td>
    <td class="c">${esc(r.color)}</td>
    <td class="c"><b>${esc(findLocationText(r) || '—')}</b></td>
    <td>${esc(r.remark)}</td>
  </tr>`).join('')
  return `<table>
    <thead><tr>
      <th>No</th><th>Vin</th><th>Model</th><th>Color</th><th>Location</th><th>หมายเหตุ</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
}

export function buildFindListHtml(rows: FindListRow[], date: string): string {
  const title = findListTitle(rows.length, date)
  return htmlDoc(title, `<div class="title">${esc(title)}</div>${findListTableHtml(rows)}`, CSS_PORTRAIT)
}

export const printFindList = (rows: FindListRow[], date: string): void => {
  // "ใบหารถ 15 คัน 31 AUG26.pdf" — a folder of saved sheets says what each one is
  if (rows.length) printHtml(buildFindListHtml(rows, date), `ใบหารถ ${rows.length} คัน ${fileStamp(date)}`)
}

/** Export the ใบหารถ list as a styled .xlsx (yellow header like the master sheets). */
export async function exportFindListXlsx(rows: FindListRow[], date: string): Promise<void> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const ws = wb.addWorksheet('ใบหารถ', { views: [{ state: 'frozen', ySplit: 2 }] })

  const headers = ['No', 'Vin', 'Model', 'Color', 'Location', 'หมายเหตุ']
  const widths = [6, 22, 14, 12, 14, 24]
  ws.columns = widths.map((w) => ({ width: w, style: { font: { name: 'Tahoma', size: 10 } } }))

  // title row (merged across all columns)
  const titleRow = ws.addRow([findListTitle(rows.length, date)])
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
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } } // เหลืองเหมือนไฟล์ต้นฉบับ
    c.alignment = { horizontal: 'center', vertical: 'middle' }
    c.border = border
  })

  // given order wins — same reason as findListTableHtml above
  rows.forEach((r, i) => {
    const row = ws.addRow([i + 1, r.vin, r.model, r.color, findLocationText(r) || '—', r.remark])
    row.height = 16
    row.eachCell((c: any, col: number) => {
      c.border = border
      c.alignment = { horizontal: col === 6 ? 'left' : 'center', vertical: 'middle' }
    })
  })

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

  const headers = ['No', 'Vin', 'Model', 'Color', 'Location', 'Lane load', 'หมายเหตุ']
  const widths = [6, 22, 14, 12, 14, 11, 24]
  ws.columns = widths.map((w) => ({ width: w, style: { font: { name: 'Tahoma', size: 10 } } }))

  const titleRow = ws.addRow([`หารถ ${titleLine(meta)}`])
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
    c.alignment = { horizontal: 'center', vertical: 'middle' }
    c.border = border
  })

  const sorted = [...rows].sort((a, b) => byYardLocation(a.yardLocation, b.yardLocation))
  const locOf = (l: string) => (l && meta.locPrefix ? `${meta.locPrefix}-${l}` : l)
  sorted.forEach((r, i) => {
    const row = ws.addRow([i + 1, r.vin, r.model, r.color, locOf(r.yardLocation) || '—', r.laneLoad, r.remark])
    row.height = 16
    row.eachCell({ includeEmpty: true }, (c: any, col: number) => {
      c.border = border
      c.alignment = { horizontal: col === 7 ? 'left' : 'center', vertical: 'middle' }
      if (col === 5 || col === 6) c.font = { name: 'Tahoma', size: 10, bold: true }
    })
  })

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
