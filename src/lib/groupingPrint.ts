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
 * Find-car sheet: only 7 columns on a PORTRAIT page, so it is typeset 1:1 against
 * the approved printout — title 18.24pt / body 14.24pt, measured straight out of
 * that PDF (A4 portrait, 595.32 × 841.92 pt). The shared 9px/14px above is sized
 * for the 11-column LANDSCAPE dealer sheet; reused here it filled barely half the
 * page and was unreadable at arm's length, which is no good for a driver walking
 * the yard with the sheet in hand. Overrides come last so they win on specificity.
 */
const CSS_PORTRAIT = CSS.replace('A4 landscape', 'A4 portrait') + `
.title { font-size: 18.24pt; margin: 0 0 10px; }
th, td { font-size: 14.24pt; padding: 2px 6px; }
td.vin { font-size: 14.24pt; letter-spacing: 0; }
.note { font-size: 14.24pt; }
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
  const body = sorted.map((r, i) => `<tr>
    <td class="c">${i + 1}</td>
    <td class="vin">${esc(r.vin)}</td>
    <td class="c">${esc(r.model)}</td>
    <td class="c">${esc(r.color)}</td>
    <td class="c"><b>${esc(r.yardLocation || '—')}</b></td>
    <td class="c">${esc(r.laneLoad)}</td>
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
