/**
 * Vehicle Label — the windshield sticker, matched to the reference PDF.
 *
 * The reference (286.9 × 119.6 pt ≈ 101 × 42 mm, one car per page) carries:
 *   • four text lines, labels right-aligned into a shared colon column
 *     (baselines 24.28 / 37.00 / 49.71 / 62.43 pt from the top, 10 pt font)
 *   • a 21×21-module QR of the VIN at (230, 10), 2 pt per module
 *   • a Code-128 barcode of the VIN at (8.45, 72.875), 270 × 40 pt
 * Every geometry constant below is read straight out of that PDF's content
 * stream, so a print of 1 page or 10 lands on the same spots.
 */
import type { TrackRow } from './excelTracking'
import { code128Svg } from './dnir'
import { borrowDocTitle, fileStamp } from './printDoc'

// ── QR encoder — byte mode, error-correction L, no dependencies ──────────────
// A 17-character VIN fills a version-1 (21×21) symbol at level L exactly —
// which is precisely what the reference sticker uses. Longer payloads step up
// a version; the layout keeps the same 42 pt box either way.

/** GF(256) tables for Reed-Solomon (polynomial 0x11d). */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x; GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}
function rsRemainder(data: number[], degree: number): number[] {
  // generator polynomial for `degree` ECC codewords
  // g(x) = (x − α⁰)(x − α¹)…, coefficients highest degree first
  let gen = [1]
  for (let d = 0; d < degree; d++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let i = 0; i < gen.length; i++) {
      next[i] ^= gen[i] // × x
      if (gen[i]) next[i + 1] ^= GF_EXP[(GF_LOG[gen[i]] + d) % 255] // × α^d
    }
    gen = next
  }
  const rem = new Array(degree).fill(0)
  for (const b of data) {
    const factor = b ^ rem[0]
    rem.shift(); rem.push(0)
    if (factor === 0) continue
    for (let i = 0; i < degree; i++) rem[i] ^= GF_EXP[(GF_LOG[gen[i + 1]] + GF_LOG[factor]) % 255]
  }
  return rem
}

/** [total codewords, ECC codewords, alignment centre] per version (level L, one block). */
const QR_VER: Record<number, [number, number, number]> = {
  1: [19, 7, 0], 2: [34, 10, 18], 3: [55, 15, 22], 4: [80, 20, 26],
}

/** Encode text (Latin-1 bytes) → boolean matrix, smallest version that fits. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...text].map((c) => c.charCodeAt(0) & 0xff)
  // mode(4) + count(8) + payload must fit the version's data codewords
  const needBits = 4 + 8 + bytes.length * 8
  let version = 4
  for (const v of [1, 2, 3, 4]) if (needBits <= QR_VER[v][0] * 8) { version = v; break }
  const [dataCw, eccCw, alignPos] = QR_VER[version]
  const size = 17 + version * 4

  // bit stream: mode 0100, 8-bit count, bytes, terminator, pad
  const bits: number[] = []
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }
  push(0b0100, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  const capBits = dataCw * 8
  push(0, Math.min(4, capBits - bits.length))
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0))
  for (let p = 0; data.length < dataCw; p++) data.push(p % 2 ? 0x11 : 0xec)
  const all = [...data, ...rsRemainder(data, eccCw)]

  // matrix scaffolding
  const m: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null))
  const setFinder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
      const dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
      m[rr][cc] = dark
    }
  }
  setFinder(0, 0); setFinder(0, size - 7); setFinder(size - 7, 0)
  for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0; m[i][6] = i % 2 === 0 }
  if (alignPos) {
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const rr = alignPos + dr, cc = alignPos + dc
      if (m[rr][cc] !== null) continue // overlaps a finder → that pattern wins
      m[rr][cc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
    }
  }
  m[size - 8][8] = true // dark module
  // reserve format areas
  const fmtCells: [number, number][] = []
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { fmtCells.push([i, 8], [8, i]) }
  }
  for (let i = 0; i < 7; i++) fmtCells.push([size - 1 - i, 8])
  for (let i = 0; i < 8; i++) fmtCells.push([8, size - 1 - i])
  for (const [r, c] of fmtCells) if (m[r][c] === null) m[r][c] = false

  // place data bits in the zig-zag
  const cells: [number, number][] = []
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) if (m[r][c] === null) cells.push([r, c])
    }
    upward = !upward
  }
  const dataBits: number[] = []
  for (const b of all) for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1)
  const placed = new Set(cells.map(([r, c]) => r * size + c))
  cells.forEach(([r, c], i) => { m[r][c] = (dataBits[i] ?? 0) === 1 })

  // try all 8 masks, keep the lowest-penalty one (standard rules N1–N4)
  const MASKS: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ]
  const fmtBits = (mask: number): number => {
    const fmt = (0b01 << 3) | mask // level L
    let rem = fmt << 10
    for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10)
    return ((fmt << 10) | rem) ^ 0x5412
  }
  const applyFmt = (g: boolean[][], mask: number) => {
    const f = fmtBits(mask)
    const bit = (i: number) => ((f >> i) & 1) === 1
    for (let i = 0; i <= 5; i++) g[8][i] = bit(14 - i)
    g[8][7] = bit(8); g[8][8] = bit(7); g[7][8] = bit(6)
    for (let i = 0; i <= 5; i++) g[i][8] = bit(i)
    for (let i = 0; i < 7; i++) g[size - 1 - i][8] = bit(14 - i)
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i)
    g[size - 8][8] = true
  }
  const penalty = (g: boolean[][]): number => {
    let score = 0
    for (let pass = 0; pass < 2; pass++) {
      for (let r = 0; r < size; r++) {
        let run = 1
        for (let c = 1; c <= size; c++) {
          const cur = c < size ? (pass ? g[c][r] : g[r][c]) : null
          const prev = pass ? g[c - 1][r] : g[r][c - 1]
          if (cur !== null && cur === prev) run++
          else { if (run >= 5) score += 3 + (run - 5); run = 1 }
        }
      }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) score += 3
    }
    const pat1 = [true, false, true, true, true, false, true, false, false, false, false]
    const pat2 = [...pat1].reverse()
    for (let pass = 0; pass < 2; pass++) for (let r = 0; r < size; r++) {
      for (let c = 0; c + 11 <= size; c++) {
        const seg = Array.from({ length: 11 }, (_, i) => (pass ? g[c + i][r] : g[r][c + i]))
        if (pat1.every((v, i) => v === seg[i]) || pat2.every((v, i) => v === seg[i])) score += 40
      }
    }
    let dark = 0
    for (const row of g) for (const v of row) if (v) dark++
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10
    return score
  }
  let best: boolean[][] | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row, r) => row.map((v, c) =>
      placed.has(r * size + c) ? (v as boolean) !== MASKS[mask](r, c) : (v as boolean)))
    applyFmt(g, mask)
    const s = penalty(g)
    if (s < bestScore) { bestScore = s; best = g }
  }
  return best as boolean[][]
}

function qrSvg(text: string): string {
  const m = qrMatrix(text)
  const n = m.length
  const rects: string[] = []
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) rects.push(`<rect x="${c}" y="${r}" width="1" height="1"/>`)
  return `<svg viewBox="0 0 ${n} ${n}" width="100%" height="100%" shape-rendering="crispEdges" fill="#000">${rects.join('')}</svg>`
}

// ── the label page — geometry from the reference PDF ─────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * How wide a value may be before it reaches the QR.
 *
 * The value starts at 87.2 pt (the 84 pt colon column + 3.2 pt gap) and the QR
 * begins at 230 pt; 4 pt of air keeps ink off its quiet zone.
 */
const VALUE_MAX_PT = 230 - 84 - 3.2 - 4
const VALUE_PT = 10
const VALUE_MIN_PT = 5.5

/**
 * Shrink any value that would run under the QR — measured IN the label
 * document, at print time.
 *
 * The reference sticker's model names are short; a real one — "BYD ATTO 3
 * (410KM-PREMIUM)" — runs to 235.7 pt at 10 pt and the QR is painted straight
 * over its tail, so the printed label reads "…(410KM-PREMIUM" with the closing
 * bracket (and on longer names, whole words) missing.
 *
 * Measured here rather than when the HTML is built, because the two documents
 * do not resolve the font the same way: the app has Roboto as a webfont, this
 * page has only what the machine has installed, so a width computed in the app
 * under-reads and the text still overflowed. Reading it where it is actually
 * laid out cannot be wrong.
 *
 * Batched — every width first, then every write, then one correction pass for
 * rounding — so 263 labels do not force 263 separate reflows. Everything else
 * stays exactly where the reference PDF puts it; only a value that would
 * otherwise be swallowed gets smaller.
 */
const FIT_SCRIPT = `<script>(function(){try{
  var MAXPT=${VALUE_MAX_PT}, BASE=${VALUE_PT}, MIN=${VALUE_MIN_PT}, MAX=MAXPT*96/72;
  var els=[].slice.call(document.querySelectorAll('.vl'));
  var w=els.map(function(e){return e.getBoundingClientRect().width});
  var over=[];
  els.forEach(function(e,i){
    if(w[i]<=MAX) return;
    var s=Math.max(MIN,Math.floor(BASE*MAX/w[i]*10)/10);
    e.style.fontSize=s+'pt'; over.push([e,s]);
  });
  over.forEach(function(x){
    var e=x[0], s=x[1];
    while(s>MIN&&e.getBoundingClientRect().width>MAX){s=Math.round((s-0.2)*10)/10;e.style.fontSize=s+'pt'}
  });
}catch(err){}})();<\/script>`

function labelSection(r: TrackRow): string {
  const c = r.cells
  const model = (c['Model name'] || c['Model'] || '—').trim()
  const color = (c['Color'] || '—').trim()
  const line = (label: string, value: string) =>
    `<div class="ln"><span class="lb">${esc(label)} :</span><span class="vl">${esc(value)}</span></div>`
  return `<section class="lbl">
    <div class="txt">
      ${line('Product Brand', 'BYD')}
      ${line('Vehicle Model', model)}
      ${line('Color', color)}
      ${line('Vin', r.vin)}
    </div>
    <div class="qr">${qrSvg(r.vin)}</div>
    <div class="bar">${code128Svg(r.vin)}</div>
  </section>`
}

/**
 * Print order: the VIN's LAST 6 CHARACTERS, ascending.
 *
 * The stack of stickers comes off the printer and is walked down a row of cars,
 * and the yard reads a car by its last 6 ("034892") — not by the whole VIN and
 * not by whatever order the grid happened to be filtered in. Sorting here, not
 * at the button, means every route to a label print comes out in the same order.
 *
 * Compared as fixed-width text, which for the all-digit serials BYD uses is the
 * same as counting up; a VIN with a letter in the last 6 still lands somewhere
 * stable instead of NaN. Ties fall back to the full VIN.
 */
const labelSerial = (vin: string) => vin.trim().toUpperCase().slice(-6)
export function sortVehicleLabelRows(rows: TrackRow[]): TrackRow[] {
  return [...rows].sort((a, b) => {
    const sa = labelSerial(a.vin), sb = labelSerial(b.vin)
    if (sa !== sb) return sa < sb ? -1 : 1
    return a.vin < b.vin ? -1 : a.vin > b.vin ? 1 : 0
  })
}

export function buildVehicleLabelHtml(rows: TrackRow[]): string {
  // 286.9 × 119.6 pt page · text colon column at 86 pt · QR (230,10) 42 pt ·
  // barcode (8.45, 72.875) 270 × 40 pt — all lifted from the reference PDF
  const ordered = sortVehicleLabelRows(rows)
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vehicle Label</title><style>
    @page { size: 286.9pt 119.6pt; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: #fff; }
    .lbl { position: relative; width: 286.9pt; height: 119.6pt; overflow: hidden;
      page-break-after: always; break-after: page;
      font-family: Roboto, 'Helvetica Neue', Arial, sans-serif; color: #000; }
    .lbl:last-child { page-break-after: auto; break-after: auto; }
    .txt { position: absolute; left: 0; top: 16.9pt; }
    .ln { display: flex; align-items: baseline; font-size: 10pt; line-height: 12.719pt; white-space: nowrap; }
    .lb { display: inline-block; width: 84pt; text-align: right; }
    .vl { margin-left: 3.2pt; }
    .qr { position: absolute; left: 230pt; top: 10pt; width: 42pt; height: 42pt; }
    .bar { position: absolute; left: 8.45pt; top: 72.875pt; width: 270pt; height: 40pt; }
    .bar svg { width: 100%; height: 100%; display: block; }
  </style></head><body>${ordered.map(labelSection).join('')}${FIT_SCRIPT}</body></html>`
}

/** Print one sticker page per row — 1 car or 10, same layout on every sheet. */
export function printVehicleLabels(rows: TrackRow[]): void {
  if (!rows.length) return
  const html = buildVehicleLabelHtml(rows)
  if (import.meta.env.DEV) (window as unknown as { __lastLabelHtml?: string }).__lastLabelHtml = html
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)
  const idoc = iframe.contentWindow?.document
  if (!idoc) { iframe.remove(); return }
  idoc.open(); idoc.write(html); idoc.close()
  // ── hold the document until the print job has actually taken it ──
  // 263 stickers is 263 pages of SVG: a fixed 150 ms was not always enough for
  // the layout to finish before print(), and tearing the iframe down 1.5 s
  // later pulled the document out from under a preview that was still building
  // pages — the browser's PDF (and the printer) then ran short of the count on
  // screen. Print when the document says it is ready, and let go only when the
  // job is done.
  const win = iframe.contentWindow
  let gone = false
  const drop = () => { if (gone) return; gone = true; setTimeout(() => iframe.remove(), 500) }
  win?.addEventListener?.('afterprint', drop)
  // Safari / older Chrome never fire afterprint on an iframe — the print
  // media query flipping back off says the same thing
  const mql = win?.matchMedia?.('print')
  mql?.addEventListener?.('change', (e) => { if (!e.matches) drop() })
  const go = () => {
    // one more frame so the last page is laid out, not just parsed
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // the saved PDF is named after the PAGE's title, not this iframe's
      borrowDocTitle(`Vinlable ${rows.length} ใบ ${fileStamp()}`, win)
      try { win?.focus(); win?.print() } catch { /* noop */ }
      // last resort: never leak the iframe if no print event ever arrives
      setTimeout(drop, 10 * 60 * 1000)
    }))
  }
  if (idoc.readyState === 'complete') go()
  else win?.addEventListener?.('load', go, { once: true })
}
