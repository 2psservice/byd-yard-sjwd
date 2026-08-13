/**
 * Printable grouping sheets:
 *  • Grouping-to-Dealer — the delivery plan grouped by Grouping Number, with the
 *    yard Location + Lane load filled in (one A4 landscape sheet).
 *  • Find-car (ใบหารถ) — the same cars sorted by yard Location (A1..Z50) so a
 *    driver can walk the yard collecting them in order (one A4 portrait sheet).
 */

import { byYardLocation } from './groupingImport'

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
 * Find-car sheet (ใบหารถ): typeset 1:1 against the approved "Plan PM" printout —
 * every value below is measured straight out of that PDF (A4 portrait,
 * 595.2 × 841.7 pt): orange title bar #E87033 35.8pt tall / 19.3pt bold text,
 * yellow header row 43pt tall / 10.6pt bold, data rows 31.3pt tall / 14.2pt
 * "Aptos Narrow" with the No column at 17.6pt semibold, the Location column
 * filled #D9D9D9, and 1pt black rules throughout. The title + header rows live
 * in <thead> so they repeat on every page, same as the Excel original's print
 * titles.
 */
const PLAN_CSS = `
@page { size: A4 portrait; margin: 5mm 6mm 6mm 5mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #000; font-family: 'Aptos Narrow','Aptos','Arial Narrow','Sarabun','Noto Sans Thai',Tahoma,'Leelawadee UI',sans-serif; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1pt solid #000; vertical-align: middle; overflow: hidden; }
th.bar { background: #E87033; font-size: 19.3pt; font-weight: 700; height: 35.8pt; padding: 2pt 4pt; text-align: center; }
th.h { background: #ffff00; font-size: 10.6pt; font-weight: 700; height: 43pt; padding: 2pt 3pt; text-align: center; }
td { font-size: 14.2pt; height: 31.3pt; padding: 2pt 4pt; text-align: center; }
td.no { font-size: 17.6pt; font-weight: 600; }
td.loc { background: #D9D9D9; }
`

/** thead shared by both ใบหารถ variants — orange title bar + yellow header. */
const planHead = (title: string, headers: string[]): string =>
  `<thead>
    <tr><th class="bar" colspan="${headers.length}">${esc(title)}</th></tr>
    <tr>${headers.map((h) => `<th class="h">${esc(h)}</th>`).join('')}</tr>
  </thead>`

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
    <td class="no">${i + 1}</td>
    <td>${esc(r.vin)}</td>
    <td>${esc(r.model)}</td>
    <td>${esc(r.color)}</td>
    <td class="loc">${esc(locOf(r.yardLocation) || '—')}</td>
    <td>${esc(r.laneLoad)}</td>
    <td>${esc(r.remark)}</td>
  </tr>`).join('')

  // column proportions measured off the Plan PM sheet (No 7.8% · Vin 25% …)
  const table = `<table>
    <colgroup>
      <col style="width:7.8%"><col style="width:27%"><col style="width:10.7%"><col style="width:10.1%">
      <col style="width:15.7%"><col style="width:10.7%"><col style="width:18%">
    </colgroup>
    ${planHead(titleLine(meta), ['No', 'Vin', 'Model', 'Color', 'Location', 'Lane load', 'หมายเหตุ'])}
    <tbody>${body}</tbody>
  </table>`
  return htmlDoc(`หารถ ${titleLine(meta)}`, table, PLAN_CSS)
}

// ── "ใบหารถ" (car-finding list) — arbitrary VIN set, no grouping/lane ────────
// Columns: No · Vin · Model · Color · Location · หมายเหตุ. Sorted by yard
// location so a driver walks the yard in order. Title "ใบหารถ N คัน".
export interface FindListRow {
  vin: string
  model: string
  color: string
  location: string  // yard code "N-N12" (or the raw cell fallback), '' when unknown
  remark: string
}

const findListTitle = (count: number, date: string): string =>
  `ใบหารถ ${count} คัน${date ? ` · ${date}` : ''}`

function findListTableHtml(rows: FindListRow[], title: string): string {
  const sorted = [...rows].sort((a, b) => byYardLocation(a.location, b.location))
  const body = sorted.map((r, i) => `<tr>
    <td class="no">${i + 1}</td>
    <td>${esc(r.vin)}</td>
    <td>${esc(r.model)}</td>
    <td>${esc(r.color)}</td>
    <td class="loc">${esc(r.location || '—')}</td>
    <td>${esc(r.remark)}</td>
  </tr>`).join('')
  return `<table>
    <colgroup>
      <col style="width:7.8%"><col style="width:27.4%"><col style="width:12%"><col style="width:11%">
      <col style="width:16.8%"><col style="width:25%">
    </colgroup>
    ${planHead(title, ['No', 'Vin', 'Model', 'Color', 'Location', 'หมายเหตุ'])}
    <tbody>${body}</tbody>
  </table>`
}

export function buildFindListHtml(rows: FindListRow[], date: string): string {
  const title = findListTitle(rows.length, date)
  return htmlDoc(title, findListTableHtml(rows, title), PLAN_CSS)
}

export const printFindList = (rows: FindListRow[], date: string): void => {
  if (rows.length) printHtml(buildFindListHtml(rows, date))
}

/** Export the ใบหารถ list as a styled .xlsx (yellow header like the master sheets). */
export async function exportFindListXlsx(rows: FindListRow[], date: string): Promise<void> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const ws = wb.addWorksheet('ใบหารถ', { views: [{ state: 'frozen', ySplit: 2 }] })

  // same look as the printed sheet (measured off the approved Plan PM file):
  // orange title bar, yellow header, tall rows, big narrow type, grey Location
  const headers = ['No', 'Vin', 'Model', 'Color', 'Location', 'หมายเหตุ']
  const widths = [7, 23, 11, 10, 15, 24]
  ws.columns = widths.map((w) => ({ width: w, style: { font: { name: 'Aptos Narrow', size: 14 } } }))

  const thin = { style: 'thin', color: { argb: 'FF000000' } }
  const border = { top: thin, left: thin, bottom: thin, right: thin }

  const titleRow = ws.addRow([findListTitle(rows.length, date)])
  ws.mergeCells(1, 1, 1, headers.length)
  titleRow.height = 36
  titleRow.getCell(1).font = { name: 'Aptos', size: 19, bold: true }
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE87033' } }
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }
  titleRow.eachCell({ includeEmpty: true }, (c: any) => { c.border = border })

  const hr = ws.addRow(headers)
  hr.height = 43
  hr.eachCell((c: any) => {
    c.font = { name: 'Aptos', size: 10.5, bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } } // เหลืองเหมือนไฟล์ต้นฉบับ
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    c.border = border
  })

  const sorted = [...rows].sort((a, b) => byYardLocation(a.location, b.location))
  sorted.forEach((r, i) => {
    const row = ws.addRow([i + 1, r.vin, r.model, r.color, r.location || '—', r.remark])
    row.height = 31.5
    row.eachCell({ includeEmpty: true }, (c: any, col: number) => {
      c.border = border
      c.alignment = { horizontal: 'center', vertical: 'middle' }
      if (col === 1) c.font = { name: 'Aptos', size: 17.5, bold: true }
      if (col === 5) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }
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

  // same look as the printed sheet (measured off the approved Plan PM file)
  const headers = ['No', 'Vin', 'Model', 'Color', 'Location', 'Lane load', 'หมายเหตุ']
  const widths = [7, 23, 11, 10, 14, 11, 20]
  ws.columns = widths.map((w) => ({ width: w, style: { font: { name: 'Aptos Narrow', size: 14 } } }))

  const thin = { style: 'thin', color: { argb: 'FF000000' } }
  const border = { top: thin, left: thin, bottom: thin, right: thin }

  const titleRow = ws.addRow([`หารถ ${titleLine(meta)}`])
  ws.mergeCells(1, 1, 1, headers.length)
  titleRow.height = 36
  titleRow.getCell(1).font = { name: 'Aptos', size: 19, bold: true }
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE87033' } }
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }
  titleRow.eachCell({ includeEmpty: true }, (c: any) => { c.border = border })

  const hr = ws.addRow(headers)
  hr.height = 43
  hr.eachCell((c: any) => {
    c.font = { name: 'Aptos', size: 10.5, bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    c.border = border
  })

  const sorted = [...rows].sort((a, b) => byYardLocation(a.yardLocation, b.yardLocation))
  const locOf = (l: string) => (l && meta.locPrefix ? `${meta.locPrefix}-${l}` : l)
  sorted.forEach((r, i) => {
    const row = ws.addRow([i + 1, r.vin, r.model, r.color, locOf(r.yardLocation) || '—', r.laneLoad, r.remark])
    row.height = 31.5
    row.eachCell({ includeEmpty: true }, (c: any, col: number) => {
      c.border = border
      c.alignment = { horizontal: 'center', vertical: 'middle' }
      if (col === 1) c.font = { name: 'Aptos', size: 17.5, bold: true }
      if (col === 5) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }
    })
  })

  const stamp = new Date().toISOString().slice(0, 10)
  await downloadXlsx(wb, `SJWD-ใบหารถ-${meta.siteLabel}-${rows.length}คัน-${stamp}.xlsx`)
}

/** Render HTML in a hidden iframe, wait a beat, then open the print dialog. */
function printHtml(html: string): void {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)
  const idoc = iframe.contentWindow?.document
  if (!idoc) { iframe.remove(); return }
  idoc.open(); idoc.write(html); idoc.close()
  const fire = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print() } catch { /* noop */ }
    setTimeout(() => iframe.remove(), 1500)
  }
  setTimeout(fire, 300)
}

export const printGrouping = (rows: GroupPrintRow[], meta: GroupPrintMeta): void => { if (rows.length) printHtml(buildGroupingHtml(rows, meta)) }
export const printFindCar = (rows: GroupPrintRow[], meta: GroupPrintMeta): void => { if (rows.length) printHtml(buildFindCarHtml(rows, meta)) }
