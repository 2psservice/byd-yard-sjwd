/**
 * "Shuttle to multiple yards" import — a manifest listing VINs headed OUT of
 * one origin (a port, another yard) toward TWO OR MORE candidate destination
 * yards, with no per-VIN column saying which one each car actually lands at.
 * That is only known once the physical car drives through a specific yard's
 * Gate-in — so every VIN here becomes a Pre Gate-in row with NO site tag yet,
 * carrying the chosen candidate sites instead (see siteScope.ts's
 * CANDIDATE_SITES_KEY / isPreGateInCandidate). Whichever site's Gate-in scans
 * it first claims it there; it drops off every OTHER candidate's queue the
 * same way an ordinary Pre Gate-in car does once it arrives (see
 * doTrackingGateIn in YardOps.tsx).
 *
 * The file itself is just a VIN list — no Location yard, no destination
 * column — so this parser reads whatever descriptive columns exist (Model,
 * Color, …) and otherwise only needs the VIN.
 */

const norm = (s?: string) => String(s ?? '').trim().toLowerCase()

/** Columns worth carrying onto the Pre Gate-in row when present — everything
 *  else in the file is dropped (this is a manifest, not a full tracking sheet). */
const CARRY_COLUMNS = ['Model name', 'Model', 'Model Code', 'Color', 'Engine No.', 'Front Motor no.', 'Rear Motor no.', 'Lot transfer', 'company']

export interface ShuttleParseRow {
  vin: string
  cells: Record<string, string>
}

export interface ShuttleParseResult {
  rows: ShuttleParseRow[]
  /** distinct VINs in the file (one row per VIN — later rows overwrite earlier ones) */
  totalRows: number
  skippedNoVin: number
}

export async function parseShuttleWorkbook(file: File): Promise<ShuttleParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false })
  if (!raw.length) throw new Error('ไฟล์ว่างเปล่า')

  let headerIdx = -1
  for (let i = 0; i < Math.min(5, raw.length); i++) {
    if (raw[i].some((c) => norm(c) === 'vin')) { headerIdx = i; break }
  }
  if (headerIdx < 0) throw new Error('ไม่พบคอลัมน์ VIN ในไฟล์')
  const header = raw[headerIdx].map((h) => String(h ?? ''))
  const colVin = header.findIndex((h) => norm(h) === 'vin')
  const carryCols = CARRY_COLUMNS
    .map((name) => ({ name, i: header.findIndex((h) => h.trim() === name) }))
    .filter((c) => c.i >= 0)

  const byVin = new Map<string, Record<string, string>>()
  let skippedNoVin = 0
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i]
    const vin = String(r[colVin] ?? '').trim().toUpperCase()
    if (!vin) { skippedNoVin++; continue }
    const cells: Record<string, string> = { Vin: vin }
    for (const { name, i: ci } of carryCols) { const v = String(r[ci] ?? '').trim(); if (v) cells[name] = v }
    byVin.set(vin, cells)
  }
  const rows: ShuttleParseRow[] = [...byVin.entries()].map(([vin, cells]) => ({ vin, cells }))
  return { rows, totalRows: rows.length, skippedNoVin }
}
