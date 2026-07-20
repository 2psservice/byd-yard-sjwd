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

// ── Inspector Report (IR) — real form image + data overlay (coords in PDF points) ──
function irSheetHtml(r: TrackRow): string {
  const eng = cell(r, 'Engine No.', 'Model Code')
  const motor = cell(r, 'Front Motor no.', 'Rear Motor no.')
  const engMotor = [eng, motor].filter(Boolean).join(' ')
  // F(left, top, size, value, wrapWidth?) — absolute overlay field in pt
  const F = (left: number, top: number, size: number, val: string, w?: number) =>
    val ? `<div class="irf${w ? ' wrap' : ''}" style="left:${left}pt;top:${top}pt;font-size:${size}pt;${w ? `width:${w}pt;` : ''}">${esc(val)}</div>` : ''
  return `<section class="ir-sheet">
    <img class="ir-bg" src="/ir-form.png" alt="">
    ${F(180, 68.5, 12, r.vin)}
    ${F(25, 101.5, 10, cell(r, 'Model name', 'Model'), 150)}
    ${F(290, 102, 12, engMotor)}
    ${F(397, 102, 12, cell(r, 'Color'))}
    ${F(471, 102, 12, cell(r, 'Location yard', 'storage Yard'))}
    ${F(100, 114, 12, 'Rayong yard')}
    ${F(325, 115, 9.5, cell(r, 'Dealer Location', 'Dealer Code'), 262)}
  </section>`
}

// ── IR "paper" overlay — data only, to print onto pre-printed IR forms ──
// 1:1 with the AMS export: US Letter, TH Sarabun New 12pt, exact coordinates.
function irPaperSheetHtml(r: TrackRow): string {
  const engMotor = [cell(r, 'Engine No.', 'Model Code'), cell(r, 'Front Motor no.', 'Rear Motor no.')].filter(Boolean).join(' ')
  const P = (left: number, top: number, val: string, wrap = false) =>
    val ? `<div class="irpf${wrap ? ' wrap' : ''}" style="left:${left}pt;top:${top}pt">${esc(val)}</div>` : ''
  return `<section class="irp-sheet">
    ${P(15, 102.9, cell(r, 'Model name', 'Model'))}
    ${P(130, 102.9, cell(r, 'Color'))}
    ${P(198, 102.9, r.vin)}
    ${P(293, 102.9, engMotor)}
    ${P(119, 118.9, 'Rayong yard')}
    ${P(289, 118.9, cell(r, 'Dealer Location', 'Dealer Code'), true)}
    <div class="irpf" style="left:385pt;top:520.9pt">Trailer License Plate No.:..............................</div>
    <div class="irpf" style="left:385pt;top:545.9pt">Trailer Company Name:................................</div>
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

const CSS = `
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin:0; font-family:'Sarabun','Noto Sans Thai',Tahoma,'Leelawadee UI',sans-serif; color:#111; }

/* ── Inspector Report (image-backed, data overlaid in PDF points) ── */
.ir-sheet { position:relative; width:595.2pt; height:841.68pt; overflow:hidden; page-break-after:always; }
.ir-sheet:last-child { page-break-after:auto; }
.ir-bg { position:absolute; left:0; top:0; width:595.2pt; height:841.68pt; }
.irf { position:absolute; line-height:1; white-space:nowrap; color:#000; font-family:'Arial Narrow',Arial,'Tahoma',sans-serif; }
.irf.wrap { white-space:normal; line-height:1.05; }

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

// IR paper overlay — US Letter, TH Sarabun New 12pt (matches the AMS data export 1:1)
const CSS_IRP = `
@import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600&display=swap');
@page { size: Letter portrait; margin: 0; }
* { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { margin:0; }
.irp-sheet { position:relative; width:612pt; height:792pt; overflow:hidden; page-break-after:always; color:#000;
  font-family:'TH Sarabun New','THSarabunNew','TH SarabunPSK','Sarabun',sans-serif; }
.irp-sheet:last-child { page-break-after:auto; }
.irpf { position:absolute; font-size:12pt; line-height:1; white-space:nowrap; }
.irpf.wrap { white-space:normal; width:186pt; word-break:break-all; }
`

const htmlDoc = (title: string, body: string, css: string = CSS): string =>
  `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${body}</body></html>`

/** Inspector Report (IR) — one image-backed sheet per VIN. */
export const buildIrHtml = (rows: TrackRow[]): string => htmlDoc(`IR — ${rows.length} VIN`, rows.map(irSheetHtml).join(''))
/** Delivery Note (DN) — one manifest listing all selected VINs. */
export const buildDnHtml = (rows: TrackRow[]): string => htmlDoc(`DN — ${rows.length} VIN`, dnSheetHtml(rows))
/** IR paper overlay (data only) — to print onto pre-printed IR forms. */
export const buildIrPaperHtml = (rows: TrackRow[]): string => htmlDoc(`IR paper — ${rows.length} VIN`, rows.map(irPaperSheetHtml).join(''), CSS_IRP)

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
  const imgs = Array.from(idoc.images || [])
  if (!imgs.length) { setTimeout(fire, 250); return }
  let pending = imgs.length
  const one = () => { if (--pending <= 0) setTimeout(fire, 120) }
  imgs.forEach((im) => { if (im.complete) one(); else { im.onload = one; im.onerror = one } })
  setTimeout(fire, 2500) // fallback if an image stalls
}

/** Print the Inspector Report (IR) — one A4 page per VIN. */
export const printIr = (rows: TrackRow[]): void => { if (rows.length) printHtml(buildIrHtml(rows)) }
/** Print the Delivery Note (DN) — one manifest for the selected VINs. */
export const printDn = (rows: TrackRow[]): void => { if (rows.length) printHtml(buildDnHtml(rows)) }
/** Print the IR paper overlay (data only) onto pre-printed IR forms. */
export const printIrPaper = (rows: TrackRow[]): void => { if (rows.length) printHtml(buildIrPaperHtml(rows)) }
