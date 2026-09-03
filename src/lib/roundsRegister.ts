/**
 * Rounds register — the per-VIN table the office keeps of every inspection
 * round's measurements (%SOC · ODO · 12V · tire pressure ×4), one column
 * group per round. PDI's "Report PDI" tab and PM Plan's "PM STATUS" tab are
 * both this same shape (PDI_KEYS vs PM_KEYS), so the reading + Excel export
 * logic lives here once instead of twice.
 *
 * The live cells only ever hold the LATEST round's numbers — every save also
 * left a history line stamped with when it happened, so an earlier round's
 * values are read back from the history entries written on that round's own
 * date. A row with no history at all (an imported car) falls back to its
 * live cells for the most recent round.
 */
import type { TrackRow } from './excelTracking'
import type { Column } from './trackingColumns'
import { parseCellDate } from './trackingColumns'

/** The four measurement fields every round carries, exactly as the sheet
 *  lays them out. These are written directly to `cells` by the station form
 *  (StationSheet.tsx) and were never added as their own tracking columns, so
 *  a column lookup below almost always falls back to the key itself — kept
 *  anyway for the rare case a device's sheet does carry a matching column
 *  with a different label. */
export const MEAS = [
  { key: '% SOC', head: '%SOC' },
  { key: 'Mileage', head: 'ODO' },
  { key: 'Voltage of 12V', head: '12V' },
  { key: 'Tire Pressure FR', head: 'FR' },
  { key: 'Tire Pressure FL', head: 'FL' },
  { key: 'Tire Pressure RL', head: 'RL' },
  { key: 'Tire Pressure RR', head: 'RR' },
] as const

export interface RegisterRound { date: string; vals: string[] }
export interface RegisterRow {
  vin: string
  modelName: string
  model: string
  color: string
  gateIn: string
  rounds: RegisterRound[]
}

const sameDay = (a: number, b: number) => {
  const x = new Date(a), y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** How many rounds actually carry a date across `rows` — at least 1, like
 *  the sheet always shows a first round column even with nothing in it yet. */
export function maxRoundCount(rows: TrackRow[], keys: string[]): number {
  let max = 1
  for (const r of rows) {
    for (let i = keys.length - 1; i >= max; i--) {
      if ((r.cells[keys[i]] || '').trim()) { max = i + 1; break }
    }
  }
  return max
}

const modelOf = (c: Record<string, string>) => (c['Model'] || c['Model name'] || '').trim() || '—'

function roundVals(r: TrackRow, keys: string[], count: number, aliases: Map<string, Set<string>>): RegisterRound[] {
  const c = r.cells
  const hist = r.history ?? []
  let lastIdx = -1
  for (let i = 0; i < count; i++) if ((c[keys[i]] || '').trim()) lastIdx = i
  return Array.from({ length: count }, (_, i) => {
    const date = (c[keys[i]] || '').trim()
    if (!date) return { date: '', vals: MEAS.map(() => '') }
    const t = parseCellDate(c[keys[i]])
    const vals = MEAS.map((m) => {
      const names = aliases.get(m.key)!
      let v = ''
      if (t != null) for (const h of hist) if (names.has(h.field) && sameDay(h.at, t)) v = h.to
      if (!v && i === lastIdx) v = (c[m.key] || '').trim()
      return v
    })
    return { date, vals }
  })
}

/** Build the register: one row per car, sorted Model then Vin (matches the
 *  sheet), each carrying `count` rounds' worth of date + measurements. */
export function buildRegisterRows(rows: TrackRow[], keys: string[], count: number, columns: Column[]): RegisterRow[] {
  const aliases = new Map(MEAS.map((m) => {
    const label = columns.find((c) => c.key === m.key)?.label ?? m.key
    return [m.key, new Set([m.key, label])] as const
  }))
  return rows
    .slice()
    .sort((a, b) => modelOf(a.cells).localeCompare(modelOf(b.cells)) || a.vin.localeCompare(b.vin))
    .map((r) => ({
      vin: r.vin,
      modelName: r.cells['Model name'] || '—',
      model: modelOf(r.cells),
      color: r.cells['Color'] || '—',
      gateIn: r.cells['Gate In (Rayong yard)'] || r.cells['Gate In Date'] || '—',
      rounds: roundVals(r, keys, count, aliases),
    }))
}

/** Excel export: one sheet, a two-row header (round name spanning its 8
 *  sub-columns, exactly like the on-screen table) followed by one row per
 *  car — the same register the screen shows, not a re-derived summary. */
export async function exportRegister(
  rows: RegisterRow[],
  roundCount: number,
  roundLabel: (i: number) => string,
  opts: { filename: string; sheetName: string },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const ws = wb.addWorksheet(opts.sheetName.slice(0, 31))
  const border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
  const fill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
  const font = { name: 'Tahoma', size: 10 }
  const fixed = ['No.', 'Vin', 'Model name', 'Model', 'Color', 'Gate In']
  const subCols = ['วันที่', ...MEAS.map((m) => m.head)]

  ws.columns = [
    { width: 6 }, { width: 21 }, { width: 26 }, { width: 12 }, { width: 12 }, { width: 12 },
    ...Array.from({ length: roundCount * subCols.length }, () => ({ width: 11 })),
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r1 = ws.getRow(1), r2 = ws.getRow(2)
  fixed.forEach((h, i) => { r1.getCell(i + 1).value = h; ws.mergeCells(1, i + 1, 2, i + 1) })
  for (let gi = 0; gi < roundCount; gi++) {
    const startCol = fixed.length + 1 + gi * subCols.length
    r1.getCell(startCol).value = roundLabel(gi)
    ws.mergeCells(1, startCol, 1, startCol + subCols.length - 1)
    subCols.forEach((h, si) => { r2.getCell(startCol + si).value = h })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of [r1, r2]) row.eachCell({ includeEmpty: true }, (cell: any) => {
    cell.font = { ...font, bold: true }; cell.border = border; cell.fill = fill('FFD9D9D9')
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })

  rows.forEach((r, i) => {
    const values = [i + 1, r.vin, r.modelName, r.model, r.color, r.gateIn,
      ...r.rounds.flatMap((rd) => [rd.date || '', ...rd.vals])]
    const row = ws.addRow(values)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row.eachCell({ includeEmpty: true }, (cell: any) => { cell.font = font; cell.border = border })
  })

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = opts.filename
  a.click()
  URL.revokeObjectURL(url)
}
