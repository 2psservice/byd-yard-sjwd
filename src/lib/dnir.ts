/**
 * DN / IR printable generator for the SJWD yard.
 *  • IR (Inspector Report Form, FM-SJWD-OPS-006) — the real form rendered to an
 *    image background (public/ir-form.png) with the per-VIN data overlaid at the
 *    exact AMS coordinates → 1:1 with the official sheet. One A4 page per VIN.
 *  • DN (Delivery Note) — AMS trip manifest with Code-128 VIN barcodes.
 */
import type { TrackRow } from './excelTracking'

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cell = (r: TrackRow, ...keys: string[]): string => {
  for (const k of keys) { const v = r.cells[k]; if (v && String(v).trim()) return String(v).trim() }
  return ''
}

// ── IR field positions — measured 1:1 from the AMS example PDFs ──────────────
// Every coordinate below is the text BASELINE origin (x, y) in PDF points,
// extracted span-by-span from the reference files, and the font is the exact
// TH Sarabun New the AMS embeds (bundled at /fonts/THSarabunNew.ttf). The CSS
// converts baseline → div top with the font's own ascent, so what Chromium
// prints lands on the same spot the AMS prints.

/** div top offset for a baseline: TH Sarabun New hhea ascent 844, descent 457
 *  (upm 1000) → with line-height:1 Chromium puts the baseline at
 *  ((1 − 1.301) / 2 + 0.844) em = 0.6935 em below the line-box top. */
const SARABUN_BASELINE_EM = 0.6935
const irField = (cls: string, x: number, yBase: number, size: number, val: string) =>
  val ? `<div class="${cls}" style="left:${x}pt;top:${(yBase - SARABUN_BASELINE_EM * size).toFixed(2)}pt;font-size:${size}pt">${esc(val)}</div>` : ''

/** The values one IR sheet carries, shared by both print styles. */
function irData(r: TrackRow, siteName?: string) {
  return {
    model: cell(r, 'Model name', 'Model'),
    color: cell(r, 'Color'),
    engMotor: [cell(r, 'Engine No.', 'Model Code'), cell(r, 'Front Motor no.', 'Rear Motor no.')].filter(Boolean).join(' '),
    yard: cell(r, 'Location yard', 'storage Yard') || siteName || '',
    dealer: cell(r, 'Dealer Location', 'Dealer Code'),
  }
}

const TRAILER_LICENSE = 'Trailer License Plate No.:..............................'
const TRAILER_COMPANY = 'Trailer Company Name:................................'

// ── Inspector Report (IR) — official form image + data overlay (A4) ──────────
function irSheetHtml(r: TrackRow, siteName?: string): string {
  const d = irData(r, siteName)
  const F = (x: number, y: number, size: number, val: string) => irField('irf', x, y, size, val)
  return `<section class="ir-sheet">
    <img class="ir-bg" src="/ir-form.png" alt="">
    ${F(180, 78.68, 12, r.vin)}
    ${F(25, 109.68, 10, d.model)}
    ${F(290, 111.68, 12, d.engMotor)}
    ${F(397, 111.68, 12, d.color)}
    ${F(100, 123.68, 12, d.yard)}
    ${F(325, 123.68, 12, d.dealer)}
    ${F(350, 581.68, 12, TRAILER_LICENSE)}
    ${F(350, 596.68, 12, TRAILER_COMPANY)}
  </section>`
}

// ── IR "paper" overlay — data only, printed onto pre-printed IR forms (Letter) ──
function irPaperSheetHtml(r: TrackRow, siteName?: string): string {
  const d = irData(r, siteName)
  const P = (x: number, y: number, val: string) => irField('irpf', x, y, 12, val)
  return `<section class="irp-sheet">
    ${P(15, 113, d.model)}
    ${P(130, 113, d.color)}
    ${P(198, 113, r.vin)}
    ${P(293, 113, d.engMotor)}
    ${P(119, 129, d.yard)}
    ${P(289, 129, d.dealer)}
    ${P(385, 531, TRAILER_LICENSE)}
    ${P(385, 556, TRAILER_COMPANY)}
  </section>`
}

// ── Code 128 → inline SVG bars (no deps, prints crisply) ─────────────────────
// Starts in code-set B and switches to code-set C for a trailing digit run of
// ≥4 (an odd-length run keeps its first digit in B) — decoded module-for-module
// from the AMS reference barcodes, so the same data draws the same bars.
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112']
function barcodeSvg(text: string): string {
  if (!text) return ''
  const vals = [104] // Start B
  let i = 0
  while (i < text.length) {
    const rest = text.length - i
    if (/^\d+$/.test(text.slice(i)) && rest >= 4) {
      if (rest % 2) { vals.push(text.charCodeAt(i) - 32); i++ }
      vals.push(99) // Code C
      for (; i < text.length; i += 2) vals.push(+text.slice(i, i + 2))
      break
    }
    const v = text.charCodeAt(i) - 32
    vals.push(v >= 0 && v < 95 ? v : 0)
    i++
  }
  let sum = vals[0]
  for (let k = 1; k < vals.length; k++) sum += vals[k] * k
  vals.push(sum % 103, 106) // checksum + Stop
  const w = vals.map((v) => C128[v]).join('')
  let x = 0; const rects: string[] = []
  for (let k = 0; k < w.length; k++) { const bw = +w[k]; if (k % 2 === 0 && bw) rects.push(`<rect x="${x}" width="${bw}" height="10"/>`); x += bw }
  return `<svg class="bc" viewBox="0 0 ${x} 10" preserveAspectRatio="none">${rects.join('')}</svg>`
}

// ── DN geometry — measured span-by-span from the AMS reference PDF ───────────
// Same technique as the IR: every coordinate is the PDF value in points.
// Vertical column-line centers; column i spans DN_COLS[i]..DN_COLS[i+1].
const DN_COLS = [10.5, 39.5, 188.5, 287.5, 387.5, 456.5, 525.5, 584.5]
const DN_HEAD_TOP = 157.89   // table header top line (center)
const DN_HEAD_BOT = 194.12   // header bottom = first data row top
const DN_ROW_H = 43.945      // data row height
const DN_LINE_H = 15.61      // multi-line cell line height
const DN_ROWS_MAX = 8        // rows per sheet — keeps the signature block on-page

/** Thai footer labels — 600-dpi crops from the reference PDF itself. The AMS
 *  bold face only survives as a subset whose Thai needs the GSUB table the PDF
 *  stripped, so the browser would misplace tone marks; the crops are the
 *  reference's own rendering. dx/dy place the crop against the label's
 *  (x, baseline) anchor. */
const DN_TH: Record<string, { f: number; dx: number; dy: number; w: number; h: number }> = {
  'ผู้ตรวจปล่อย':             { f: 0, dx: 0.52, dy: -7.93, w: 41.40, h: 10.92 },
  'ลายเซ็น':                 { f: 1, dx: 0.28, dy: -8.41, w: 25.68, h: 8.52 },
  'วันที่':                   { f: 2, dx: 0.28, dy: -9.49, w: 14.16, h: 9.60 },
  'เวลา':                    { f: 3, dx: 0.64, dy: -4.93, w: 14.64, h: 5.04 },
  'หมายเลขทะเบียนรถเทรลเลอร์': { f: 4, dx: 0.16, dy: -8.05, w: 99.00, h: 8.16 },
  'บริษัทรถเทรลเลอร์':         { f: 5, dx: 0.16, dy: -8.05, w: 60.84, h: 8.16 },
  'หน่วยรักษาความปลอดภัย':     { f: 6, dx: 0.16, dy: -7.57, w: 84.96, h: 7.80 },
  'ผู้รับ':                   { f: 7, dx: 0.52, dy: -7.81, w: 13.20, h: 10.92 },
}

const dots = (n: number) => '.'.repeat(n)
/** Chromium's print engine quantises a line box's baseline offset to whole CSS
 *  pixels (0.75pt) — measured per font size with a probe sheet, TH Sarabun New,
 *  line-height:1 (and 15.61pt for .dnk). Aiming the box top so that snapped
 *  offset lands the baseline on the PDF's own value leaves only the 0.75pt-grid
 *  rounding of the top itself (≤0.375pt). */
const DN_BASE_OFF: Record<number, number> = { 10: 6.75, 12: 8.25, 14: 9.0, 18: 12.0 }
const DN_CELL_OFF = 9.75 // .dnk first-line baseline offset
const dnTop = (yBase: number, off: number) => (Math.round((yBase - off) / 0.75) * 0.75).toFixed(2)
/** absolute single-line text at a PDF baseline (r = regular, b = bold) */
const dnT = (bold: boolean, x: number, yBase: number, size: number, text: string) =>
  `<div class="${bold ? 'dnb' : 'dnr'}" style="left:${x}pt;top:${dnTop(yBase, DN_BASE_OFF[size])}pt;font-size:${size}pt">${esc(text)}</div>`
/** centered (page-wide) single-line text at a baseline */
const dnC = (yBase: number, size: number, html: string, bold = true) =>
  `<div class="${bold ? 'dnb' : 'dnr'} dnc" style="top:${dnTop(yBase, DN_BASE_OFF[size])}pt;font-size:${size}pt">${html}</div>`
/** column-wide centered block (wraps at DN_LINE_H); firstBase = 1st line baseline */
const dnCell = (col: number, firstBase: number, text: string) =>
  text ? `<div class="dnk" style="left:${DN_COLS[col]}pt;width:${(DN_COLS[col + 1] - DN_COLS[col]).toFixed(2)}pt;top:${dnTop(firstBase, DN_CELL_OFF)}pt">${esc(text)}</div>` : ''
/** Thai footer label crop at its measured anchor */
const dnTh = (label: string, x: number, yBase: number) => {
  const m = DN_TH[label]
  return `<img class="dnth" src="/dn-th/${m.f}.png" alt="${esc(label)}" style="left:${(x + m.dx).toFixed(2)}pt;top:${(yBase + m.dy).toFixed(2)}pt;width:${m.w}pt;height:${m.h}pt">`
}
const dnLine = (x: number, y: number, w: number, h: number) =>
  `<div class="dnl" style="left:${x.toFixed(2)}pt;top:${y.toFixed(2)}pt;width:${w.toFixed(2)}pt;height:${h.toFixed(2)}pt"></div>`

/** Delivery Note (ใบส่งมอบรถยนต์) — rebuilt 1:1 against the AMS reference:
 *  same TH Sarabun New faces, same coordinates, same dot-leader runs. */
function dnSheetHtml(rows: TrackRow[], seq0: number, grouping: string, trip: string, printDate: string): string {
  const parts: string[] = []
  // ── page header ──
  parts.push(dnT(false, 20, 18.44, 10, `Grouping : ${grouping || '—'}`))
  parts.push(dnT(false, 440, 18.44, 10, `Print Date ${printDate}`))
  parts.push(dnC(55.19, 18, 'Delivery Note'))
  parts.push(`<div class="dnbc" style="left:202.90pt;top:69.07pt;width:189.00pt;height:28.30pt">${barcodeSvg(trip)}</div>`)
  parts.push(dnC(114.78, 14, `Trip No : <span class="dnr-in">${esc(trip)}</span>`))
  // Vehicle List band
  parts.push('<div class="dnbox" style="left:10pt;top:126.18pt;width:575.28pt;height:26.21pt"></div>')
  parts.push(dnC(143.00, 14, 'Vehicle List'))

  // ── table grid ──
  const n = rows.length
  const tblBot = DN_HEAD_BOT + n * DN_ROW_H            // bottom line center
  parts.push(dnLine(10, DN_HEAD_TOP - 0.5, 574.28, 1)) // header top
  for (let i = 0; i <= n; i++) parts.push(dnLine(10, DN_HEAD_BOT + i * DN_ROW_H - 0.5, 574.28, 1))
  for (const x of DN_COLS) parts.push(dnLine(x - 0.5, DN_HEAD_TOP - 0.5, 1, tblBot - DN_HEAD_TOP + 1))

  // ── table header (regular 12pt, first baseline 12.63pt under the top line) ──
  const headBase = DN_HEAD_TOP + 12.63
  // the last header breaks exactly where the AMS breaks it
  const HEADS = ['Seq.', 'Vin No. Barcode', 'Destination', 'Model Code', 'Engine No.', 'Color Code', 'Location on\nthe trailer']
  HEADS.forEach((h, c) => parts.push(dnCell(c, headBase, h)))

  // ── rows ──
  rows.forEach((r, i) => {
    const T = DN_HEAD_BOT + i * DN_ROW_H
    parts.push(dnCell(0, T + 12.63, String(seq0 + i + 1)))
    parts.push(`<div class="dnbc" style="left:47.01pt;top:${(T + 5.43).toFixed(2)}pt;width:133.83pt;height:17.26pt">${barcodeSvg(r.vin)}</div>`)
    parts.push(dnCell(1, T + 35.96, r.vin))
    parts.push(dnCell(2, T + 12.63, cell(r, 'Dealer Location', 'Dealer Code')))
    parts.push(dnCell(3, T + 12.63, cell(r, 'Model Code', 'Model')))
    parts.push(dnCell(4, T + 12.63, cell(r, 'Engine No.')))
    parts.push(dnCell(5, T + 12.63, cell(r, 'Color')))
    parts.push(dnCell(6, T + 12.63, cell(r, 'Location on the trailer')))
  })

  // ── signature block — flows under the table (reference offsets from its
  //    bottom line), every x/dot-count verbatim from the measured spans ──
  const B = tblBot
  parts.push(`<img class="dnth" src="/dn-logo.png" alt="SIAM JWD" style="left:100pt;top:${(B + 18.50).toFixed(2)}pt;width:90pt;height:45pt">`)
  // per-row signature groups: rows 1-2 sit at x=210, rows 4-5 at x=208
  const sig = (y: number, o: number) => [
    dnT(true, 210 - o, y, 12, 'Signature'), dnT(false, 245.56 - o, y, 12, ' ' + dots(42)),
    dnT(true, 329.15 - o, y, 12, ' Date'), dnT(false, 357.50 - o, y, 12, dots(42)),
    dnT(true, 439.15 - o, y, 12, ' Time'), dnT(false, 467.50 - o, y, 12, dots(42)),
  ].join('')
  const y1 = B + 40.63, y2 = B + 91.24, y3 = B + 137.47, y4 = B + 183.69, y5 = B + 229.92
  parts.push(dnT(true, 20, y1, 12, 'Release Approval'), sig(y1, 0))
  parts.push(dnTh('ผู้ตรวจปล่อย', 20, y1 + 15.00), dnTh('ลายเซ็น', 210, y1 + 15.00), dnTh('วันที่', 333, y1 + 15.00), dnTh('เวลา', 443, y1 + 15.00))
  parts.push(dnT(true, 20, y2, 12, 'Trailer No.'), dnT(false, 60, y2, 12, dots(75)), sig(y2, 0))
  parts.push(dnTh('หมายเลขทะเบียนรถเทรลเลอร์', 20, y2 + 15.62), dnTh('ลายเซ็น', 210, y2 + 15.62), dnTh('วันที่', 332, y2 + 15.62), dnTh('เวลา', 444, y2 + 15.62))
  parts.push(dnT(true, 20, y3, 12, 'Trailer Company'), dnT(false, 83.66, y3, 12, dots(138)))
  parts.push(dnTh('บริษัทรถเทรลเลอร์', 20, y3 + 15.61))
  parts.push(dnT(true, 20, y4, 12, 'Security'), dnT(false, 58, y4, 12, dots(77)), sig(y4, 2))
  parts.push(dnTh('หน่วยรักษาความปลอดภัย', 20, y4 + 15.61), dnTh('ลายเซ็น', 208, y4 + 15.61), dnTh('วันที่', 330, y4 + 15.61), dnTh('เวลา', 442, y4 + 15.61))
  parts.push(dnT(true, 20, y5, 12, 'Receiver'), dnT(false, 58, y5, 12, dots(77)), sig(y5, 2))
  parts.push(dnTh('ผู้รับ', 20, y5 + 15.61), dnTh('ลายเซ็น', 210, y5 + 15.61), dnTh('วันที่', 332, y5 + 15.61), dnTh('เวลา', 444, y5 + 15.61))

  return `<section class="dn-sheet">${parts.join('')}</section>`
}

/* The AMS's own TH Sarabun New — same files the reference PDFs embed. A unique
 * family name so an installed system font can never shadow it with different
 * metrics. The bold face is the DN reference's embedded subset (its exact
 * outlines) with a rebuilt cmap — it carries every glyph of the DN's static
 * bold labels. */
const SARABUN_FACE = `
@font-face { font-family:'THSarabunNew AMS'; src:url('/fonts/THSarabunNew.ttf') format('truetype'); font-weight:400; font-style:normal; }
@font-face { font-family:'THSarabunNew AMS Bold'; src:url('/fonts/THSarabunNewBold.ttf') format('truetype'); font-weight:400; font-style:normal; }`

const CSS = `${SARABUN_FACE}
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin:0; font-family:'Sarabun','Noto Sans Thai',Tahoma,'Leelawadee UI',sans-serif; color:#111; }

/* ── Inspector Report (image-backed, data overlaid at AMS baselines) ── */
.ir-sheet { position:relative; width:595.2pt; height:841.68pt; overflow:hidden; page-break-after:always; }
.ir-sheet:last-child { page-break-after:auto; }
.ir-bg { position:absolute; left:0; top:0; width:595.2pt; height:841.68pt; }
.irf { position:absolute; line-height:1; white-space:nowrap; color:#000; font-family:'THSarabunNew AMS'; }

/* ── Delivery Note — absolute layout at the AMS reference coordinates ── */
.dn-sheet { position:relative; width:595.28pt; height:841.89pt; overflow:hidden; page-break-after:always; color:#000; }
.dn-sheet:last-child { page-break-after:auto; }
.dnr, .dnb { position:absolute; line-height:1; white-space:pre; }
.dnr { font-family:'THSarabunNew AMS'; }
.dnb { font-family:'THSarabunNew AMS Bold'; }
.dnc { left:0; right:0; text-align:center; }
.dnr-in { font-family:'THSarabunNew AMS'; }
.dnk { position:absolute; text-align:center; font-size:12pt; line-height:${DN_LINE_H}pt; font-family:'THSarabunNew AMS'; white-space:pre-line; }
.dnl { position:absolute; background:#000; }
.dnbox { position:absolute; border:1pt solid #000; }
.dnbc { position:absolute; }
.dnbc .bc { display:block; width:100%; height:100%; }
.bc rect { fill:#000; }
.dnth { position:absolute; }
`

// IR paper overlay — US Letter, the AMS's TH Sarabun New (matches the export 1:1)
const CSS_IRP = `${SARABUN_FACE}
@page { size: Letter portrait; margin: 0; }
* { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { margin:0; }
.irp-sheet { position:relative; width:612pt; height:792pt; overflow:hidden; page-break-after:always; color:#000;
  font-family:'THSarabunNew AMS'; }
.irp-sheet:last-child { page-break-after:auto; }
.irpf { position:absolute; line-height:1; white-space:nowrap; }
`

const htmlDoc = (title: string, body: string, css: string = CSS): string =>
  `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${body}</body></html>`

/** Inspector Report (IR) — one image-backed sheet per VIN. */
export const buildIrHtml = (rows: TrackRow[], siteName?: string): string =>
  htmlDoc(`IR — ${rows.length} VIN`, rows.map((r) => irSheetHtml(r, siteName)).join(''))
/** Delivery Note (DN) — one manifest per grouping (a DN *is* one trip, so cars
 *  from several groupings must never share a sheet). Long trips continue onto
 *  extra sheets with the sequence running on. */
export const buildDnHtml = (rows: TrackRow[]): string => {
  const byGroup = new Map<string, TrackRow[]>()
  for (const r of rows) {
    const g = cell(r, 'Grouping  Number') || '—'
    const list = byGroup.get(g)
    if (list) list.push(r); else byGroup.set(g, [r])
  }
  const d = new Date()
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const pad = (n: number) => String(n).padStart(2, '0')
  const printDate = `${pad(d.getDate())}/${mon}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sheets: string[] = []
  for (const [g, list] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const trip = cell(list[0], 'Trip No', 'Trip No.', 'TripNo') || cell(list[0], 'Grouping  Number') || list[0].vin
    for (let i = 0; i < list.length; i += DN_ROWS_MAX)
      sheets.push(dnSheetHtml(list.slice(i, i + DN_ROWS_MAX), i, g === '—' ? '' : g, trip, printDate))
  }
  return htmlDoc(`DN — ${byGroup.size} Grouping · ${rows.length} VIN`, sheets.join(''))
}
/** IR paper overlay (data only) — to print onto pre-printed IR forms. */
export const buildIrPaperHtml = (rows: TrackRow[], siteName?: string): string =>
  htmlDoc(`IR paper — ${rows.length} VIN`, rows.map((r) => irPaperSheetHtml(r, siteName)).join(''), CSS_IRP)

/** Render HTML in a hidden iframe, wait for images, then open the print dialog. */
function printHtml(html: string): void {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)
  const idoc = iframe.contentWindow?.document
  if (!idoc) { iframe.remove(); return }
  idoc.open(); idoc.write(html); idoc.close()
  let done = false
  const fire = () => {
    if (done) return; done = true
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print() } catch { /* noop */ }
    setTimeout(() => iframe.remove(), 1500)
  }
  // wait for images AND the embedded TH Sarabun New — printing before the font
  // loads falls back to a system font with different widths, off the boxes
  const imgs = Array.from(idoc.images || [])
  let pending = imgs.length + 1
  const one = () => { if (--pending <= 0) setTimeout(fire, 120) }
  imgs.forEach((im) => { if (im.complete) one(); else { im.onload = one; im.onerror = one } })
  const fonts = (idoc as Document & { fonts?: FontFaceSet }).fonts
  if (fonts?.ready) fonts.ready.then(one, one)
  else one()
  setTimeout(fire, 3500) // fallback if an image or the font stalls
}

/** Print the Inspector Report (IR) — one A4 page per VIN. */
export const printIr = (rows: TrackRow[], siteName?: string): void => { if (rows.length) printHtml(buildIrHtml(rows, siteName)) }
/** Print the Delivery Note (DN) — one manifest for the selected VINs. */
export const printDn = (rows: TrackRow[]): void => { if (rows.length) printHtml(buildDnHtml(rows)) }
/** Print the IR paper overlay (data only) onto pre-printed IR forms. */
export const printIrPaper = (rows: TrackRow[], siteName?: string): void => { if (rows.length) printHtml(buildIrPaperHtml(rows, siteName)) }
