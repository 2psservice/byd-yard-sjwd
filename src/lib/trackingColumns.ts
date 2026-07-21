/**
 * Canonical column model for the "Tracking Status" sheet (the Yard master list).
 * `key` is the EXACT header text from the sheet (trimmed) so imported cells map
 * 1:1. Users can hide / reorder / add / remove columns on top of these defaults.
 */
export type ColType = 'text' | 'number' | 'select'

export interface Column {
  key: string          // exact (trimmed) sheet header — also the cell key
  label: string        // display header
  group: ColGroup
  type: ColType
  width: number
  visible: boolean
  editable: boolean
  options?: string[]   // for type === 'select' (merged with live distinct values)
  custom?: boolean     // user-added column (removable)
}

export type ColGroup = 'vehicle' | 'status' | 'location' | 'movement' | 'pm'

export const GROUP_LABEL: Record<ColGroup, { th: string; en: string }> = {
  vehicle: { th: 'ข้อมูลรถ', en: 'Vehicle' },
  status: { th: 'สถานะ / PDI', en: 'Status / PDI' },
  location: { th: 'ที่ตั้ง / โลจิสติกส์', en: 'Location / Logistics' },
  movement: { th: 'การย้าย', en: 'Movement' },
  pm: { th: 'PM / อุปกรณ์', en: 'PM / Accessories' },
}

// car lifecycle status (Pre Gate-in → Gate-in → In Yard → PDI → Ready → Gate-out)
// + Total loss: a written-off vehicle (insurance total loss) — a terminal state
export const CAR_STATUS_VALUES = ['Pre Gate-in', 'Gate-in', 'In Yard', 'Moving', 'PDI', 'Ready', 'Preload', 'Pre Gate-out', 'Gate-out', 'Total loss'] as const

// columns shown by default (a focused TOS-style working set)
const DEFAULT_VISIBLE = new Set([
  'No', 'Lot transfer', 'moving date', 'Vin', 'Car Status', 'Model', 'Color', 'company', 'Status', 'Final Status',
  '__location', 'Location yard', 'storage Yard', 'Grouping  Number', 'Gate In (Rayong yard)',
  'Status Tax', 'PIC (PDI)', 'หมายเหตุ',
])

/** Synthetic column key for the computed yard-location code (prefix-block+row+slot,
 *  e.g. "N-R0905"). Not a sheet cell — resolved from the car's placement. */
export const LOCATION_KEY = '__location'

/** The 15 PM date columns, in order (PM1 … PM15). */
export const PM_KEYS = Array.from({ length: 15 }, (_, i) => `PM${i + 1}`)

const _MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** A cell that may hold an Excel serial (1900 system) OR a date-ish string →
 *  a JS timestamp (ms, at local midnight), or null when it isn't a date. */
export function parseCellDate(raw: string | undefined): number | null {
  const s = String(raw ?? '').trim()
  if (!s || s === '-') return null
  const num = Number(s)
  // Excel 1900 serial: 25569 = 1970-01-01. Guard to a sane calendar window.
  if (Number.isFinite(num) && String(num) === s && num > 20000 && num < 90000) {
    return Math.round((num - 25569) * 86_400_000)
  }
  // ISO: yyyy-mm-dd
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]).getTime()
  // dd-Mon-yy(yy) e.g. "5-Jul-25", "05 Jul 2025"
  const m = s.match(/(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})/)
  if (m) {
    const mon = _MONTHS[m[2].slice(0, 3).toLowerCase()]
    if (mon) { const y = +m[3]; return new Date(y < 100 ? 2000 + y : y, mon - 1, +m[1]).getTime() }
  }
  // dd/mm/yyyy or dd-mm-yyyy (all-numeric)
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
  if (dmy) { const y = +dmy[3]; return new Date(y < 100 ? 2000 + y : y, +dmy[2] - 1, +dmy[1]).getTime() }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** The most recent PM date (ms) among PM1…PM15, or null when never PM'd. */
export function lastPmDate(cells: Record<string, string>): number | null {
  let latest: number | null = null
  for (const k of PM_KEYS) {
    const t = parseCellDate(cells[k])
    if (t != null && (latest == null || t > latest)) latest = t
  }
  return latest
}

/** Aging PM = whole days since the most recent PM (PM1…PM15). '' when the car
 *  has never had a PM recorded. Replaces the raw imported cell (which held an
 *  Excel serial like "46223" = the formula's =TODAY() with no PM date). */
export function agingPmDays(cells: Record<string, string>, now: number = Date.now()): string {
  const last = lastPmDate(cells)
  if (last == null) return ''
  return String(Math.max(0, Math.floor((now - last) / 86_400_000)))
}

/** A "storage Yard" cell should be a location; when the master imports a stray
 *  Excel date-serial there (e.g. "46224" from a =TODAY() formula) it's junk, so
 *  hide it. A real storage code / name passes through untouched. */
export function cleanStorage(v: string | undefined): string {
  const s = String(v ?? '').trim()
  const num = Number(s)
  if (Number.isFinite(num) && String(num) === s && num > 20000 && num < 90000) return ''
  return s
}

/** Configurable-filter model (shared by the Unit List filter bar + the store). */
export const MAX_FILTERS = 6
export const DEFAULT_FILTER_COLS = ['Car Status', 'Location yard', 'Model', 'Final Status', 'company']

// curated select columns (options also augmented from live data at import)
const SELECT_OPTIONS: Record<string, string[]> = {
  'Car Status': [...CAR_STATUS_VALUES],
  company: ['Auto', 'ComV', 'Denza'],
  Color: ['BLACK', 'GREY', 'WHITE', 'WHITE(CREAM)', 'BLUE', 'GREEN'],
  'Final Status': ['OK-Accept', 'OK-Repaired', 'Waiting', 'Waiting Repair'],
  'Status Tax': ['Already Tax payment', 'Waiting', 'Waiting Tax payment'],
  Status: ['Heavy NG', 'NG', 'OK-Accept'],
}
// columns that become 'select' with options derived from live distinct values
const SELECT_FROM_DATA = new Set(['Model', 'Location yard', 'PIC (PDI)', 'Stock of Status', 'Vin Of Status'])

const NON_EDITABLE = new Set(['No', 'Vin', '__location'])

interface Spec { key: string; label?: string; group: ColGroup; width?: number }

// the 65 sheet columns, in sheet order, grouped
const SPECS: Spec[] = [
  { key: 'No', label: 'Last update', group: 'vehicle', width: 150 }, // shows the row's last-update date/time
  // Yard-to-Yard transfer (Vin list transfer) columns
  { key: 'Lot transfer', group: 'movement', width: 150 },
  { key: 'moving date', label: 'Moving date', group: 'movement', width: 110 },
  { key: 'From', group: 'movement', width: 92 },
  { key: 'To', group: 'movement', width: 92 },
  { key: 'Match Tax/Shuttle', group: 'location', width: 116 },
  { key: 'Vin', group: 'vehicle', width: 168 },
  { key: 'Model name', group: 'vehicle', width: 210 },
  { key: 'Front Motor no.', group: 'vehicle', width: 150 },
  { key: 'Rear Motor no.', group: 'vehicle', width: 150 },
  { key: 'Engine No.', group: 'vehicle', width: 150 },
  { key: 'Model Code', group: 'vehicle', width: 110 },
  { key: 'Model', group: 'vehicle', width: 110 },
  { key: 'Color', group: 'vehicle', width: 120 },
  { key: 'battery', group: 'vehicle', width: 200 },
  { key: 'company', label: 'Transport Company', group: 'vehicle', width: 150 },
  { key: 'Car Status', group: 'status', width: 124 },
  { key: 'Status', group: 'status', width: 110 },
  { key: 'PDI', group: 'status', width: 100 },
  { key: 'RE PDI  Date #1', label: 'RE PDI #1', group: 'status', width: 100 },
  { key: 'RE PDI  Date #2', label: 'RE PDI #2', group: 'status', width: 100 },
  { key: 'RE PDI  Date #3', label: 'RE PDI #3', group: 'status', width: 100 },
  { key: 'RE PDI  Date #4', label: 'RE PDI #4', group: 'status', width: 100 },
  { key: 'RE PDI  Date #5', label: 'RE PDI #5', group: 'status', width: 100 },
  { key: 'RE PDI  Date #6', label: 'RE PDI #6', group: 'status', width: 100 },
  { key: 'RE PDI  Date #7', label: 'RE PDI #7', group: 'status', width: 100 },
  { key: 'RE PDI  Date #8', label: 'RE PDI #8', group: 'status', width: 100 },
  { key: 'OK date', group: 'status', width: 100 },
  { key: 'PIC (PDI)', group: 'status', width: 100 },
  { key: 'Vin Of Status', group: 'status', width: 140 },
  { key: 'Gate In (Rayong yard)', label: 'Gate In', group: 'location', width: 110 },
  { key: 'Final check date', group: 'status', width: 110 },
  { key: 'Final Status', group: 'status', width: 120 },
  { key: '__location', label: 'Location', group: 'location', width: 110 }, // computed: prefix-block+row+slot
  { key: 'Location yard', group: 'location', width: 130 },
  { key: 'Status Tax', group: 'location', width: 150 },
  { key: 'Stock of Status', group: 'location', width: 170 },
  { key: 'Gate Out time stamp', group: 'location', width: 130 },
  { key: 'Grouping  Number', label: 'Grouping', group: 'location', width: 130 },
  { key: 'Allocation Date', group: 'location', width: 110 },
  { key: 'Dealer Code', group: 'location', width: 100 },
  { key: 'Dealer Location', group: 'location', width: 220 },
  { key: 'Remark', group: 'location', width: 180 },
  { key: 'Tailer Company', label: 'Trailer Co.', group: 'location', width: 110 },
  { key: 'storage Yard', label: 'Storage', group: 'location', width: 90 },
  { key: 'Move from  1', label: 'Move from 1', group: 'movement', width: 110 },
  { key: 'Transfer 1', group: 'movement', width: 100 },
  { key: 'Move from  2', label: 'Move from 2', group: 'movement', width: 110 },
  { key: 'Transfer 2', group: 'movement', width: 100 },
  { key: 'Move from  3', label: 'Move from 3', group: 'movement', width: 110 },
  { key: 'Transfer 3', group: 'movement', width: 100 },
  { key: 'Move from  4', label: 'Move from 4', group: 'movement', width: 110 },
  { key: 'Transfer 4', group: 'movement', width: 100 },
  { key: 'Factory-Installed', group: 'pm', width: 130 },
  { key: 'Accessories', group: 'pm', width: 130 },
  { key: 'Aging PM', group: 'pm', width: 100 },
  ...Array.from({ length: 15 }, (_, i) => ({ key: `PM${i + 1}`, group: 'pm' as ColGroup, width: 92 })),
  { key: 'หมายเหตุ', label: 'หมายเหตุ', group: 'pm', width: 180 },
]

export function defaultColumns(): Column[] {
  return SPECS.map((s) => {
    const isSelect = s.key in SELECT_OPTIONS || SELECT_FROM_DATA.has(s.key)
    return {
      key: s.key,
      label: s.label ?? s.key,
      group: s.group,
      type: isSelect ? 'select' : 'text',
      width: s.width ?? 120,
      visible: DEFAULT_VISIBLE.has(s.key),
      editable: !NON_EDITABLE.has(s.key),
      options: SELECT_OPTIONS[s.key],
    }
  })
}

/** keys that should gather their option list from the live imported data */
export const SELECT_DATA_KEYS = SELECT_FROM_DATA

/**
 * Merge persisted user columns with the canonical defaults so that:
 *  - newly added default columns appear,
 *  - user ordering / visibility / custom columns survive,
 *  - stale defaults are dropped.
 */
export function reconcileColumns(saved: Column[] | undefined): Column[] {
  const defs = defaultColumns()
  if (!saved || !saved.length) return defs
  const defByKey = new Map(defs.map((c) => [c.key, c]))
  const out: Column[] = []
  const seen = new Set<string>()
  for (const s of saved) {
    if (s.custom) { out.push(s); seen.add(s.key); continue }
    const d = defByKey.get(s.key)
    if (!d) continue // dropped default
    // 'No' → "Last update" and 'company' → "Transport Company" got wider labels.
    // 'No': force its default width. 'company': never shrink below the new default
    // (but keep a wider custom width if the user set one).
    const width = s.key === 'No' ? d.width
      : s.key === 'company' ? Math.max(s.width || 0, d.width)
      : (s.width || d.width)
    out.push({ ...d, visible: s.visible, width, options: d.options })
    seen.add(s.key)
  }
  // insert any new default columns at their canonical position (right after the
  // nearest preceding default that already exists), so they don't pile up at the end
  const defOrder = defs.map((d) => d.key)
  for (const d of defs) {
    if (seen.has(d.key)) continue
    const di = defOrder.indexOf(d.key)
    let insertAt = out.length
    for (let j = di - 1; j >= 0; j--) {
      const idx = out.findIndex((c) => c.key === defOrder[j])
      if (idx >= 0) { insertAt = idx + 1; break }
    }
    out.splice(insertAt, 0, d)
    seen.add(d.key)
  }
  return out
}
