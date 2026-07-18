/**
 * Reads the "Tracking Status" sheet of the Yard master workbook.
 * Keeps only vehicles still IN the yard (Stock of Status not "Gate out from …"),
 * mapping every column cell 1:1 by its header text.
 */
import { SELECT_DATA_KEYS } from './trackingColumns'
import { isGateOutStamp } from './carStatus'

/** One field-level edit, logged by updateCell/bulkUpdate — covers every
 *  station's cell writes (Gate-in, Driver, PDI/PM/FC, Gate-out, Relocation)
 *  and admin edits from the Unit List context menu, since they all funnel
 *  through those two actions. */
export interface RowEvent {
  at: number
  by: string
  field: string  // column label (falls back to the raw key)
  from: string   // '' when the cell was previously empty
  to: string
}

export interface TrackRow {
  vin: string
  cells: Record<string, string>
  updatedAt?: number // last time this row's data changed (import / edit / status update)
  site?: string      // yard/site this vehicle belongs to (Site.id) — for per-yard separation
  history?: RowEvent[] // field-edit audit trail, newest last, capped (see updateCell/bulkUpdate)
  deletedAt?: number // tombstone: when set, this VIN was deleted — kept so every device
                     // learns of the deletion and never re-uploads a stale local copy
}

/** One defect/NG record from the Defect-Yard / Defect-Factory sheets. */
export interface DefectRow {
  vin: string
  source: 'yard' | 'factory' | 'whale'
  model?: string
  from?: string
  stockOfStatus?: string
  categoryNG?: string      // "Category NG" (yard) / "Category defect" (factory)
  categoryRepair?: string  // "Category (Repair)" — yard only
  incharge?: string
  date?: string
  position?: string
  defect?: string          // "Defect/NG"
  statusRepair?: string
  repairDate?: string
  remark?: string
}

/** Per-defect-sheet read diagnostics — shown in the import preview so the user
 *  can SEE the defect text was captured before confirming the merge. */
export interface DefectSheetInfo {
  source: 'yard' | 'factory' | 'whale'
  sheet: string      // actual sheet name in the workbook
  rows: number       // defect rows parsed
  withText: number   // rows where the defect detail text was found
  headers: string[]  // raw headers (diagnostics when withText < rows)
}

export interface ParseResult {
  rows: TrackRow[]
  headers: string[]
  total: number          // rows with a VIN
  inYard: number         // kept
  gatedOut: number       // gate-out rows (in gateOutRows, not rows)
  /** Rows whose "Stock of Status" says gate-out. NOT imported as new cars, but
   *  the Co-Inspection merge uses them to flip EXISTING VINs to Gate-out —
   *  otherwise a car that left the yard after its import stayed In Yard forever. */
  gateOutRows: TrackRow[]
  options: Record<string, string[]> // live distinct values for select columns
  defects: DefectRow[]   // from Defect-Yard / Defect-Factory sheets (Co Inspection)
  defectSheets: DefectSheetInfo[]
}

const TARGET_SHEET = 'Tracking Status'
const norm = (s: string) => String(s).trim().toLowerCase().replace(/[\s._\-#]/g, '')
const isVin = (s: string) => /^[A-Z0-9]{11,20}$/.test(s)

/** Parse a Defect-Yard / Defect-Factory sheet into defect records (by VIN). */
function parseDefectSheet(XLSX: any, ws: any, source: 'yard' | 'factory' | 'whale'): { rows: DefectRow[]; headers: string[] } {
  if (!ws) return { rows: [], headers: [] }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false }) as any[][]
  if (!aoa.length) return { rows: [], headers: [] }
  const headers = (aoa[0] as any[]).map((h) => String(h).trim())
  const idxOf = (name: string) => headers.findIndex((h) => norm(h) === norm(name))
  const vinIdx = headers.findIndex((h) => norm(h) === 'vin')
  if (vinIdx < 0) return { rows: [], headers }
  const col = (row: any[], name: string) => { const i = idxOf(name); return i >= 0 ? String(row[i] ?? '').trim() : '' }
  // header names vary per sheet / file version → try each candidate until one has a value
  const colAny = (row: any[], ...names: string[]) => { for (const n of names) { const v = col(row, n); if (v) return v } return '' }

  // defect-detail column — per the real files: Defect-Yard uses "Defect",
  // Defect-Factory / Whale use "Defect/NG". Read BOTH everywhere (prefer the
  // sheet's canonical one), plus any other "…defect…" header as a last resort.
  const prefer = source === 'yard' ? ['defect', 'defect/ng', 'defectng'] : ['defect/ng', 'defectng', 'defect']
  const defectCols: number[] = []
  for (const p of prefer) headers.forEach((h, i) => { if (norm(h) === p && !defectCols.includes(i)) defectCols.push(i) })
  headers.forEach((h, i) => {
    const n = norm(h)
    if (n.includes('defect') && !n.includes('category') && !defectCols.includes(i)) defectCols.push(i)
  })
  const defectOf = (row: any[]) => { for (const i of defectCols) { const v = String(row[i] ?? '').trim(); if (v) return v } return '' }

  const out: DefectRow[] = []
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r]
    const vin = String(row[vinIdx] ?? '').trim().toUpperCase()
    if (!isVin(vin)) continue
    const defect = defectOf(row)
    const position = col(row, 'Position')
    // "Category NG" (yard) / "Category defect" (factory) / "Category" (whale)
    const catNG = colAny(row, 'Category NG', 'Category defect', 'Category')
    if (!defect && !position && !catNG) continue // empty row
    out.push({
      vin, source,
      model:         col(row, 'Model') || undefined,
      from:          col(row, 'From') || undefined,
      stockOfStatus: col(row, 'Stock of Status') || undefined,
      categoryNG:    catNG || undefined,
      categoryRepair: colAny(row, 'Category (Repair)', 'Category Repair') || undefined,
      incharge:      col(row, 'Incharge') || undefined,
      date:          col(row, 'Date') || undefined,
      position:      position || undefined,
      defect:        defect || undefined,
      statusRepair:  colAny(row, 'Status Repair', 'Repair Status') || undefined,
      repairDate:    colAny(row, 'Repair Date', 'Repaired Date') || undefined,
      remark:        col(row, 'Remark') || undefined,
    })
  }
  return { rows: out, headers }
}

export async function parseTrackingWorkbook(file: File): Promise<ParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })

  // "Tracking Status" sheet, else a "tracking" sheet, else the first sheet that
  // actually has a "Vin" column (so Yard-to-Yard transfer files import too).
  const headerOf = (n: string): string[] => {
    const a = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, defval: '', blankrows: false })
    return ((a[0] as any[] | undefined) ?? []).map((h) => norm(String(h)))
  }
  // defect sheets (Co Inspection) — parsed regardless of the tracking sheet
  const yardWs = wb.SheetNames.find((n) => norm(n).includes('defectyard'))
  const factoryWs = wb.SheetNames.find((n) => norm(n).includes('defectfactory'))
  const whaleWs = wb.SheetNames.find((n) => norm(n).includes('defectwhale'))
  const defectSheets: DefectSheetInfo[] = []
  const collectDefects = (wsName: string | undefined, source: 'yard' | 'factory' | 'whale'): DefectRow[] => {
    if (!wsName) return []
    const { rows, headers } = parseDefectSheet(XLSX, wb.Sheets[wsName], source)
    defectSheets.push({ source, sheet: wsName, rows: rows.length, withText: rows.filter((r) => r.defect).length, headers })
    return rows
  }
  const defects: DefectRow[] = [
    ...collectDefects(yardWs, 'yard'),
    ...collectDefects(factoryWs, 'factory'),
    ...collectDefects(whaleWs, 'whale'),
  ]

  const sheetName =
    wb.SheetNames.find((n) => n.trim() === TARGET_SHEET) ||
    wb.SheetNames.find((n) => norm(n).includes('trackingstatus')) ||
    wb.SheetNames.find((n) => headerOf(n).includes('vin'))
  if (!sheetName) {
    // a Co Inspection file may carry only defect sheets — still valid
    if (defects.length) return { rows: [], headers: [], total: 0, inYard: 0, gatedOut: 0, gateOutRows: [], options: {}, defects, defectSheets }
    throw new Error(`ไม่พบคอลัมน์ "Vin" ในไฟล์ (sheets: ${wb.SheetNames.join(', ')})`)
  }

  const ws = wb.Sheets[sheetName]
  const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '', raw: false, blankrows: false })
  if (!aoa.length) throw new Error(`sheet "${sheetName}" ว่างเปล่า`)

  const headers = (aoa[0] as any[]).map((h) => String(h).trim())
  const vinIdx = headers.findIndex((h) => norm(h) === 'vin')
  if (vinIdx < 0) throw new Error('ไม่พบคอลัมน์ "Vin" ใน sheet')
  // gate-out is decided by "Gate Out time stamp" (authoritative), NOT "Stock of Status"
  const gotsIdx = headers.findIndex((h) => norm(h) === norm('Gate Out time stamp'))

  const byVin = new Map<string, TrackRow>()
  const gateOutByVin = new Map<string, TrackRow>()
  const optSets: Record<string, Set<string>> = {}
  let total = 0

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] as any[]
    const vin = String(row[vinIdx] ?? '').trim().toUpperCase()
    if (!isVin(vin)) continue
    total++
    // Gate-out ⟺ "Gate Out time stamp" holds a real date/timestamp. Empty, or a
    // pickup-plan value ("แผนรับวันที่ …"), means the car is STILL in the yard —
    // even if "Stock of Status" says "gate out" (a Total loss / not-yet-collected
    // car). isGateOutStamp handles the plan-vs-date distinction; this keeps the
    // parser routing consistent with deriveCarStatus.
    const gots = gotsIdx >= 0 ? String(row[gotsIdx] ?? '').trim() : ''
    const isGateOut = isGateOutStamp(gots)

    const cells: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]
      if (!key) continue
      const v = String(row[c] ?? '').trim()
      cells[key] = v
      if (!isGateOut && v && SELECT_DATA_KEYS.has(key)) {
        ;(optSets[key] ??= new Set()).add(v)
      }
    }
    cells['Vin'] = vin
    // map the transfer-file headers onto the canonical column keys so they display
    if (cells['Location'] && !cells['Location yard']) cells['Location yard'] = cells['Location']
    if (cells['Group'] && !cells['Grouping  Number']) cells['Grouping  Number'] = cells['Group']
    if (isGateOut) {
      // rows with a real gate-out timestamp: kept separately, never imported as a
      // new car (the master file carries ~57k historical gate-outs), but the merge
      // path uses these to flip an EXISTING VIN to Gate-out after it leaves
      gateOutByVin.set(vin, { vin, cells })
      continue
    }
    // imported vehicles start as Pre Gate-in
    if (!cells['Car Status']) cells['Car Status'] = 'Pre Gate-in'
    byVin.set(vin, { vin, cells })
  }

  const options: Record<string, string[]> = {}
  for (const k of Object.keys(optSets)) options[k] = [...optSets[k]].sort()

  return {
    rows: [...byVin.values()],
    headers,
    total,
    inYard: byVin.size,
    gatedOut: gateOutByVin.size,
    gateOutRows: [...gateOutByVin.values()],
    options,
    defects,
    defectSheets,
  }
}

// ── "Vin List Inventory" (Pre Gate-in) import ─────────────────────────────
// A different workbook shape from "Tracking Status": one sheet PER yard, each
// listing that yard's inventory. Only the sheets below are imported; every row
// becomes a Pre Gate-in car tagged to its sheet's yard, dated by "Gate In Date".

/** Sheet name (normalized) → yard. The yard string is written to "Location yard"
 *  so siteForRow tags each row to its own site (name must match the Site exactly). */
const VINLIST_SHEETS: { key: string; yard: string }[] = [
  { key: 'vinlistmasterrayong', yard: 'Rayong yard' },   // NOT "…RAYONG YARD" (old master)
  { key: 'soi5', yard: 'SOI 5' },
  { key: 'nyb2', yard: 'NYB2 Phase 2' },
  { key: '20rai', yard: 'Auto Tran 20Rai' },
  { key: '38rai', yard: 'Auto Tran 38Rai' },
]
const vinListYard = (sheetName: string): string | null =>
  VINLIST_SHEETS.find((m) => m.key === norm(sheetName))?.yard ?? null

/** Excel serial (1900 date system) or date-ish string → "YYYY-MM-DD" (sortable,
 *  parseable by the import date picker). "-"/blank → '' (grouped as unspecified). */
function excelDateToStr(XLSX: any, v: any): string {
  const s = String(v ?? '').trim()
  if (!s || s === '-') return ''
  const num = Number(s)
  if (Number.isFinite(num) && num > 20000 && num < 90000) {
    const dc = XLSX.SSF?.parse_date_code?.(num)
    if (dc && dc.y) return `${dc.y}-${String(dc.m).padStart(2, '0')}-${String(dc.d).padStart(2, '0')}`
  }
  return s
}

/** Parse the per-yard Vin List Inventory workbook → Pre Gate-in rows. */
export function parseVinListInventory(XLSX: any, wb: any): ParseResult {
  const byVin = new Map<string, TrackRow>()
  const optSets: Record<string, Set<string>> = {}
  const headerSet = new Set<string>(['Vin', 'Location yard', 'Model', 'Color', 'Gate In Date', 'Car Status'])
  let total = 0

  for (const sheetName of wb.SheetNames) {
    const yard = vinListYard(sheetName)
    if (!yard) continue
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true, blankrows: false }) as any[][]

    // header row position varies per sheet (title rows above) — find the row
    // that has a Vin column (+ "Gate In Date" when possible)
    let hIdx = -1
    for (let i = 0; i < Math.min(aoa.length, 8); i++) {
      const row = aoa[i] || []
      const hasVin = row.some((c) => { const n = norm(String(c)); return n === 'vinno' || n === 'vin' })
      if (hasVin && row.some((c) => norm(String(c)) === 'gateindate')) { hIdx = i; break }
      if (hIdx < 0 && hasVin) hIdx = i // fallback: first row carrying a Vin column
    }
    if (hIdx < 0) continue

    // clean header whitespace (these sheets embed "Model\r\nYear" line breaks) so
    // the cell key / added column reads "Model Year" and "Model Code" lines up with
    // the canonical column instead of becoming a stray duplicate
    const headers = (aoa[hIdx] as any[]).map((h) => String(h).replace(/\s+/g, ' ').trim())
    const nh = headers.map((h) => norm(h))
    const vinCols = nh.map((h, i) => (h === 'vinno' || h === 'vin' ? i : -1)).filter((i) => i >= 0)
    const gateInIdx = nh.indexOf('gateindate')
    const gateOutIdx = nh.indexOf('gateoutdate')
    for (const h of headers) if (h) headerSet.add(h)

    for (let r = hIdx + 1; r < aoa.length; r++) {
      const row = aoa[r] as any[]
      if (!row) continue
      let vin = ''
      for (const ci of vinCols) { const v = String(row[ci] ?? '').trim().toUpperCase(); if (isVin(v)) { vin = v; break } }
      if (!vin) continue
      total++

      const cells: Record<string, string> = {}
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c]; if (!key) continue
        cells[key] = row[c] == null ? '' : String(row[c]).trim()
      }
      cells['Vin'] = vin
      cells['Location yard'] = yard
      cells['Gate In Date'] = gateInIdx >= 0 ? excelDateToStr(XLSX, row[gateInIdx]) : ''
      // a filled "Gate Out Date" means the car already LEFT → Gate-out, not Pre
      // Gate-in. Map it to the canonical "Gate Out time stamp" (what the app's
      // gate-out logic reads) so status/date line up everywhere.
      const goRaw = gateOutIdx >= 0 ? String(row[gateOutIdx] ?? '').trim() : ''
      if (isGateOutStamp(goRaw)) {
        const goStr = excelDateToStr(XLSX, goRaw) || goRaw
        cells['Gate Out Date'] = goStr
        cells['Gate Out time stamp'] = goStr
        cells['Car Status'] = 'Gate-out'
      } else {
        cells['Car Status'] = 'Pre Gate-in'
      }

      for (const k of Object.keys(cells)) {
        if (cells[k] && SELECT_DATA_KEYS.has(k)) (optSets[k] ??= new Set()).add(cells[k])
      }
      byVin.set(vin, { vin, cells }) // last sheet wins if a VIN appears in two yards
    }
  }

  const options: Record<string, string[]> = {}
  for (const k of Object.keys(optSets)) options[k] = [...optSets[k]].sort()

  return {
    rows: [...byVin.values()],
    headers: [...headerSet],
    total,
    inYard: byVin.size,
    gatedOut: 0,
    gateOutRows: [],
    options,
    defects: [],
    defectSheets: [],
  }
}

/** Main import entry: auto-detect the per-yard Vin List Inventory (Pre Gate-in)
 *  workbook, else fall back to the "Tracking Status" / transfer parser. */
export async function parseImportWorkbook(file: File): Promise<ParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  if (wb.SheetNames.some((n: string) => vinListYard(n))) return parseVinListInventory(XLSX, wb)
  return parseTrackingWorkbook(file)
}

/** Export the current grid (visible columns) to CSV. */
export function rowsToCsv(filename: string, columns: { key: string; label: string }[], rows: TrackRow[]) {
  const esc = (v: any) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = columns.map((c) => esc(c.label)).join(',')
  const body = rows.map((r) => columns.map((c) => esc(r.cells[c.key] ?? '')).join(',')).join('\n')
  const blob = new Blob(['﻿' + head + '\n' + body], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
