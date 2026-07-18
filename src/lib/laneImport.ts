/**
 * Reads an "Update Location" export (gate-in receive file) — needs VinNo + LaneNo
 * columns. LaneNo is either "N-O15" (yard "N", block "OO", column 15) or the
 * block-name form "WCL21" (block "WCL", column 21). Digits = the block's COLUMN
 * (ช่องด้านบน); cars stack down that column's rows 1..8 — assigned later by the
 * import planner (max 8 cars per column). See parseLane.
 */

export interface LaneRow {
  vin: string
  lane: string
  modelName?: string
  colorName?: string
  gateInAt?: number
}

export interface LaneParseResult {
  rows: LaneRow[]
  headers: string[]
  total: number  // rows with a valid VIN
  noLane: number // VIN rows with an empty LaneNo
}

/** Parse a LaneNo into { prefix, block, row } — `row` is the lane digits, used
 *  as the block's column by the planner (cars stack down that column's rows 1..8).
 *
 *  `block` is the RAW token exactly as written in the file ("A", "O", "WCL") —
 *  NEVER guessed/expanded here, because yards name their blocks differently:
 *  Auto Tran 20 Rai uses "A"/"B"/"C"/"D"/"O", NYB2 uses "AA"/"NN"/"OO". The caller
 *  resolves the token against the ACTIVE yard's real blocks (see resolveBlock in
 *  ImportPage), so the same file works in any yard.
 *
 *  Accepted formats:
 *   A) yard-prefixed "N-O15"     → yard "N",  block "O",   col 15 (lenient separators)
 *   B) block-name direct "WCL21" → block "WCL", col 21 (optional "WCL-21")
 *   C) numeric yard, no separator "20A46" → yard "20", block "A", col 46
 *   D) bare single letter "B27"  → block "B", col 27 */
export function parseLane(lane: string): { prefix: string; block: string; row: number } | null {
  const s = String(lane).trim().toUpperCase()
  // A) "N-O15" — yard prefix + separator + 1-2 letter block + column
  let m = s.match(/^([A-Z0-9]{1,3})\s*[-\s]\s*([A-Z]{1,2})\s*[-\s]?\s*0*(\d{1,3})$/)
  if (m) { const row = +m[3]; return row ? { prefix: m[1], block: m[2], row } : null }
  // B) "WCL21" — block name (2-4 letters) directly + column, optional separator
  m = s.match(/^([A-Z]{2,4})\s*-?\s*0*(\d{1,3})$/)
  if (m) { const row = +m[2]; return row ? { prefix: '', block: m[1], row } : null }
  // C) "20A46" — numeric yard prefix glued to a 1-2 letter block + column
  m = s.match(/^(\d{1,3})\s*-?\s*([A-Z]{1,2})\s*-?\s*0*(\d{1,3})$/)
  if (m) { const row = +m[3]; return row ? { prefix: m[1], block: m[2], row } : null }
  // D) "B27" — bare single-letter block + column
  m = s.match(/^([A-Z])\s*-?\s*0*(\d{1,3})$/)
  if (m) { const row = +m[2]; return row ? { prefix: '', block: m[1], row } : null }
  return null
}

/** Map a parsed lane token onto the block this yard actually calls it.
 *  `drawn` = the yard's block ids + names, upper-cased. Tries the token as written,
 *  then its doubled form ("A" → "AA", for yards that name blocks AA/OO), then its
 *  halved form ("AA" → "A"). Falls back to the raw token so an unknown block still
 *  surfaces in the import's "blocks not on the plan" warning instead of vanishing. */
export function resolveBlock(token: string, drawn: Set<string>): string {
  const t = token.trim().toUpperCase()
  if (drawn.has(t)) return t
  if (t.length === 1 && drawn.has(t + t)) return t + t          // "A"  → "AA"
  if (t.length === 2 && t[0] === t[1] && drawn.has(t[0])) return t[0] // "AA" → "A"
  return t
}

const norm = (s: unknown) => String(s).trim().toLowerCase().replace(/[\s._\-#]/g, '')
const isVin = (s: string) => /^[A-Z0-9]{11,20}$/.test(s)

export async function parseLaneWorkbook(file: File): Promise<LaneParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })

  // first sheet with a header row (scanned in the top 5 rows) containing Vin + Lane
  let aoa: any[][] | null = null
  let headers: string[] = []
  let headerAt = 0
  outer: for (const name of wb.SheetNames) {
    const a = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false }) as any[][]
    for (let r = 0; r < Math.min(5, a.length); r++) {
      const hs = (a[r] as any[]).map((h) => String(h).trim())
      const has = (...names: string[]) => hs.some((h) => names.includes(norm(h)))
      if (has('vinno', 'vin') && has('laneno', 'lane')) { aoa = a; headers = hs; headerAt = r; break outer }
    }
  }
  if (!aoa) throw new Error('ไม่พบคอลัมน์ VinNo + LaneNo ในไฟล์')

  const idx = (...names: string[]) => headers.findIndex((h) => names.includes(norm(h)))
  const vinI = idx('vinno', 'vin')
  const laneI = idx('laneno', 'lane')
  const modelI = idx('modelname', 'model')
  const colorI = idx('colorname', 'color')
  const gateI = idx('gateindatetime', 'gateindate')

  const rows: LaneRow[] = []
  let total = 0
  let noLane = 0
  for (let r = headerAt + 1; r < aoa.length; r++) {
    const row = aoa[r]
    const vin = String(row[vinI] ?? '').trim().toUpperCase()
    if (!isVin(vin)) continue
    total++
    const lane = String(row[laneI] ?? '').trim()
    if (!lane) { noLane++; continue }
    const gateRaw = gateI >= 0 ? String(row[gateI] ?? '').trim() : ''
    const t = gateRaw ? Date.parse(gateRaw) : NaN
    rows.push({
      vin,
      lane,
      modelName: modelI >= 0 ? String(row[modelI] ?? '').trim() || undefined : undefined,
      colorName: colorI >= 0 ? String(row[colorI] ?? '').trim() || undefined : undefined,
      gateInAt: Number.isFinite(t) ? t : undefined,
    })
  }
  return { rows, headers, total, noLane }
}
