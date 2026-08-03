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

// ── Code 128 (code-set B) → inline SVG bars (no deps, prints crisply) ──
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112']
function barcodeSvg(text: string, height: number): string {
  if (!text) return ''
  const vals = [104] // Start B
  for (const ch of text) { const v = ch.charCodeAt(0) - 32; vals.push(v >= 0 && v < 95 ? v : 0) }
  let sum = 104
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i
  vals.push(sum % 103, 106) // checksum + Stop
  const w = vals.map((v) => C128[v]).join('')
  let x = 0; const rects: string[] = []
  for (let i = 0; i < w.length; i++) { const bw = +w[i]; if (i % 2 === 0 && bw) rects.push(`<rect x="${x}" width="${bw}" height="${height}"/>`); x += bw }
  return `<svg class="bc" viewBox="0 0 ${x} ${height}" preserveAspectRatio="none">${rects.join('')}</svg>`
}

const DN_FOOT: { en: string; th: string; fill: boolean; sig: boolean }[] = [
  { en: 'Release Approval', th: 'ผู้ตรวจปล่อย', fill: false, sig: true },
  { en: 'Trailer No.', th: 'หมายเลขทะเบียนรถเทรลเลอร์', fill: true, sig: true },
  { en: 'Trailer Company', th: 'บริษัทรถเทรลเลอร์', fill: true, sig: false },
  { en: 'Security', th: 'หน่วยรักษาความปลอดภัย', fill: true, sig: true },
  { en: 'Receiver', th: 'ผู้รับ', fill: true, sig: true },
]
const dots = (n: number) => '.'.repeat(n)

/** Delivery Note (ใบส่งมอบรถยนต์) — AMS trip manifest with VIN barcodes. */
function dnSheetHtml(rows: TrackRow[]): string {
  const first = rows[0]
  const grouping = esc(cell(first, 'Grouping  Number')) || '—'
  const trip = cell(first, 'Grouping  Number') || first.vin
  const d = new Date()
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const pad = (n: number) => String(n).padStart(2, '0')
  const printDate = `${pad(d.getDate())}/${mon}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const body = rows.map((r, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td class="bcell">${barcodeSvg(r.vin, 30)}<div class="bv">${esc(r.vin)}</div></td>
      <td class="dest">${esc(cell(r, 'Dealer Location', 'Dealer Code'))}</td>
      <td class="c">${esc(cell(r, 'Model Code', 'Model'))}</td>
      <td class="c">${esc(cell(r, 'Engine No.'))}</td>
      <td class="c">${esc(cell(r, 'Color'))}</td>
      <td></td>
    </tr>`).join('')
  const foot = DN_FOOT.map((f) => `
    <div class="fr">
      <div class="fl"><div>${f.en}${f.fill ? ' ' + dots(48) : ''}</div><div class="th">${f.th}</div></div>
      ${f.sig ? `<div class="fs"><div>Signature ${dots(20)}</div><div class="th">ลายเซ็น</div></div>
      <div class="fs"><div>Date ${dots(20)}</div><div class="th">วันที่</div></div>
      <div class="fs"><div>Time ${dots(18)}</div><div class="th">เวลา</div></div>` : ''}
    </div>`).join('')
  return `<section class="dn-sheet">
    <div class="dn-head"><span>Grouping : ${grouping}</span><span>Print Date ${printDate}</span></div>
    <div class="dn-title">Delivery Note</div>
    <div class="dn-trip">${barcodeSvg(trip, 46)}<div class="tn">Trip No : ${esc(trip)}</div></div>
    <div class="dn-vt">Vehicle List</div>
    <table class="dn">
      <thead><tr>
        <th class="w-seq">Seq.</th><th class="w-bc">Vin No. Barcode</th><th class="w-dest">Destination</th>
        <th class="w-mc">Model Code</th><th class="w-en">Engine No.</th><th class="w-cc">Color Code</th><th class="w-loc">Location on the trailer</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="dn-foot">${foot}</div>
  </section>`
}

/* The AMS's own TH Sarabun New — same file the reference PDFs embed. A unique
 * family name so an installed system font can never shadow it with different
 * metrics. */
const SARABUN_FACE = `
@font-face { font-family:'THSarabunNew AMS'; src:url('/fonts/THSarabunNew.ttf') format('truetype'); font-weight:400; font-style:normal; }`

const CSS = `${SARABUN_FACE}
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin:0; font-family:'Sarabun','Noto Sans Thai',Tahoma,'Leelawadee UI',sans-serif; color:#111; }

/* ── Inspector Report (image-backed, data overlaid at AMS baselines) ── */
.ir-sheet { position:relative; width:595.2pt; height:841.68pt; overflow:hidden; page-break-after:always; }
.ir-sheet:last-child { page-break-after:auto; }
.ir-bg { position:absolute; left:0; top:0; width:595.2pt; height:841.68pt; }
.irf { position:absolute; line-height:1; white-space:nowrap; color:#000; font-family:'THSarabunNew AMS'; }

/* ── Delivery Note (AMS trip manifest) ── */
.dn-sheet { width:210mm; min-height:297mm; padding:9mm; page-break-after:always; }
.dn-sheet:last-child { page-break-after:auto; }
.dn-head { display:flex; justify-content:space-between; font-size:8px; padding:0 1px 6px; }
.dn-title { text-align:center; font-size:16px; font-weight:700; margin:2px 0; }
.dn-trip { text-align:center; margin:6px 0 10px; }
.bc rect { fill:#000; }
.dn-trip .bc { height:46px; width:240px; }
.dn-trip .tn { font-size:9px; font-weight:600; margin-top:3px; }
.dn-vt { border:1px solid #111; border-bottom:0; text-align:center; font-weight:700; font-size:9px; padding:3px; }
.dn { width:100%; border-collapse:collapse; }
.dn th, .dn td { border:1px solid #111; font-size:7.5px; padding:2px 3px; vertical-align:middle; }
.dn th { background:#fff; font-weight:700; text-align:center; line-height:1.15; }
.dn td.c { text-align:center; }
.dn .bcell { text-align:center; padding:3px 2px; }
.dn .bcell .bc { height:28px; width:97%; display:block; margin:0 auto; }
.dn .bv { font-size:7px; font-weight:600; margin-top:1px; letter-spacing:.3px; }
.dn .dest { font-size:7px; text-align:center; line-height:1.25; }
.dn .w-seq { width:5%; } .dn .w-bc { width:21%; } .dn .w-dest { width:25%; } .dn .w-mc { width:12%; } .dn .w-en { width:11%; } .dn .w-cc { width:10%; } .dn .w-loc { width:12%; }
.dn thead { display:table-header-group; }
.dn-foot { margin-top:22px; font-size:8px; }
.dn-foot .fr { display:flex; align-items:flex-start; gap:6px; margin-bottom:11px; }
.dn-foot .fl { width:36%; }
.dn-foot .fs { flex:1; white-space:nowrap; overflow:hidden; }
.dn-foot .th { font-size:7.5px; color:#333; margin-top:1px; }
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
 *  from several groupings must never share a sheet). */
export const buildDnHtml = (rows: TrackRow[]): string => {
  const byGroup = new Map<string, TrackRow[]>()
  for (const r of rows) {
    const g = cell(r, 'Grouping  Number') || '—'
    const list = byGroup.get(g)
    if (list) list.push(r); else byGroup.set(g, [r])
  }
  const sheets = [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, list]) => dnSheetHtml(list))
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
