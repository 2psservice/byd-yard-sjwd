/**
 * Operation report (รายงานส่งทุกเบรค) — the 14-menu report the admin used to
 * key into Excel by hand. Every menu derives LIVE from what the field records:
 * gate scans, queue checks (PDI / FINAL / PM / Wash), defects. The Excel
 * export mirrors the office's Report_operation workbook sheet-for-sheet.
 */
import type { TrackRow } from './excelTracking'
import type { Unit } from '../types'
import { isSequenceQueue, queueTypeOf, type WorkQueue, type QueueItem } from '../store/useOps'
import { PM_KEYS } from './trackingColumns'
import { FINAL_CHECK_TABS } from './finalCheckList'

/**
 * A "Control Stock Sheet" tick is a STOCK COUNT, not a body defect.
 *
 * The station sheet writes every checklist NG as a damage so the record is
 * kept, and the Control Stock Sheet tab counts what shipped WITH the car —
 * the owner's manual, the plate frame, the boot tray. A missing manual is
 * something to chase, but it is not a defect on the car, and listing those
 * ticks alongside รอยขีด / บุบ / สีพอง drowned the real findings: 36 rows on
 * the board where the yard could see only a handful of actual defects.
 *
 * The records are NOT deleted — they stay on the car as PDI history (Unit
 * List → "NG ที่บันทึกจากสถานี"), they simply stop counting as defects. The
 * tab label is read from the sheet definition so renaming the tab there can
 * never silently un-filter them.
 */
const STOCK_SHEET_LABEL = FINAL_CHECK_TABS.find((t) => t.key === 'stock')?.label ?? 'Control Stock Sheet'
export const isStockSheetEntry = (d: { item?: string }): boolean =>
  (d.item ?? '').trim().startsWith(STOCK_SHEET_LABEL)

export type MenuKind = 'stock' | 'list' | 'defect' | 'time'
export interface ReportMenu { id: string; label: string; kind: MenuKind }

export const REPORT_MENUS: ReportMenu[] = [
  { id: 'stock',    label: 'Daily report stock', kind: 'stock' },
  { id: 'gatein',   label: 'Gate-IN',            kind: 'list' },
  { id: 'gateout',  label: 'Gate-OUT',           kind: 'list' },
  { id: 'pdiout',   label: 'PDI-OUT',            kind: 'list' },
  { id: 'washsale', label: 'Wash for Sales',     kind: 'list' },
  { id: 'hold',     label: 'Hold',               kind: 'list' },
  { id: 'pdi',      label: 'PDI',                kind: 'list' },
  { id: 'fc',       label: 'Final Check NYB',    kind: 'list' },
  { id: 'fcdefect', label: 'FC (Defect)',        kind: 'defect' },
  { id: 'fctime',   label: 'เช็คเวลา FC',          kind: 'time' },
  { id: 'washpm',   label: 'Wash for PM',        kind: 'list' },
  { id: 'pm',       label: 'PM',                 kind: 'list' },
  { id: 'pmdefect', label: 'PM (Defect)',        kind: 'defect' },
  { id: 'pmtime',   label: 'เช็คเวลา PM',          kind: 'time' },
]

export interface ListRow {
  no: number; vin: string; modelName: string; model: string; color: string
  date: string; lot: string; remark: string
}
export interface DefectRowOut {
  no: number; vin: string; position: string; defect: string; date: string
  status: string; lot: string; remark: string
  // The office's defect sheet carries more than the 8 columns the Excel export
  // mirrors — the PDI board shows the full set. Every one of these is already
  // recorded by the field (the Defect picker) or the tracking sheet; nothing
  // here is a new thing anyone has to type twice.
  model: string          // "DOLPHIN"
  from: string           // tracking 'From' — where the car came in from
  stockStatus: string    // tracking 'Stock of Status'
  categoryNG: string     // NG / HEAVY NG
  categoryRepair: string // Re paint / Re Dent / Part …
  incharge: string       // SJWD / BYD
  repairDate: string     // when it was actually repaired ('' while open)
}
export interface TimeMatrix {
  title: string
  plan: number
  models: { name: string; total: number; p: number[] }[]
  ok: number[]; okTotal: number
  ng: number[]; ngTotal: number
  total: number
}

export const TIME_PERIODS = ['08:30 - 10:00', '10:10 - 12:00', '13:00 - 15:00', '15:10 - 17:30', '18:00 - 20:00']
const MODEL_ROWS = ['ATTO 1', 'ATTO 2', 'ATTO 3', 'D9', 'DOLPHIN', 'M6', 'SEAL', 'SEAL 5', 'SEALION 5', 'SEALION 6', 'SEALION 7']

const PDI_KEYS = ['PDI', ...Array.from({ length: 8 }, (_, i) => `RE PDI  Date #${i + 1}`)]

/** "2026-08-12" for a timestamp, device-local. */
export const dayKeyOfTs = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fmtDay = (k: string) => k.split('-').reverse().join('/')

/** Parse a station date cell ("29/07/2026", "2026-07-29", "29-Jul-26", epoch ms). */
function parseDayCell(s?: string): number | undefined {
  const t = (s ?? '').trim()
  if (!t) return undefined
  if (/^\d{12,}$/.test(t)) return parseInt(t, 10) // epoch ms cell (Gate In Time)
  let m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]).getTime() }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  m = t.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})$/)
  if (m) {
    const mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase())
    if (mo >= 0) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, mo, +m[1]).getTime() }
  }
  return undefined
}
const cellOnDay = (s: string | undefined, day: string) => {
  const ts = parseDayCell(s)
  return ts !== undefined && dayKeyOfTs(ts) === day
}

/** P1..P5 bucket for a timestamp (index 0..4) by the yard's break schedule. */
export function periodOf(ts: number): number {
  const d = new Date(ts)
  const min = d.getHours() * 60 + d.getMinutes()
  if (min <= 10 * 60 + 5) return 0   // …–10:05 → P1
  if (min <= 12 * 60 + 30) return 1  // …–12:30 → P2
  if (min <= 15 * 60 + 5) return 2   // …–15:05 → P3
  if (min <= 17 * 60 + 45) return 3  // …–17:45 → P4
  return 4
}

export interface ReportCtx {
  rows: TrackRow[]           // site-scoped tracking rows
  units: Unit[]              // site-scoped units (damages live here)
  queues: WorkQueue[]        // site-scoped work queues
  day: string                // 'YYYY-MM-DD'
  siteLabel: string
}

function rowMap(ctx: ReportCtx) { return new Map(ctx.rows.map((r) => [r.vin, r])) }

/** The "(M-D-N)" gate-in batch a car arrived in — the report's LOT column. */
function lotMap(ctx: ReportCtx): Map<string, string> {
  const m = new Map<string, string>()
  for (const q of ctx.queues) {
    if (!(q.name ?? '').trim().startsWith('(')) continue
    for (const i of q.items) if (!m.has(i.vin)) m.set(i.vin, q.name.trim())
  }
  return m
}

function toListRow(no: number, vin: string, ctx: ReportCtx, lots: Map<string, string>, opts?: { date?: string; lot?: string; remark?: string }): ListRow {
  const c = rowMap(ctx).get(vin)?.cells ?? {}
  return {
    no, vin,
    modelName: c['Model name'] || c['Model'] || '',
    model: c['Model'] || c['Model name'] || '',
    color: c['Color'] || '',
    date: opts?.date ?? fmtDay(ctx.day),
    lot: opts?.lot ?? (c['LOT'] || lots.get(vin) || ''),
    remark: opts?.remark ?? '',
  }
}

const itemTs = (i: QueueItem) => i.checkedAt ?? i.doneAt
const itemOnDay = (i: QueueItem, day: string) => { const t = itemTs(i); return t != null && dayKeyOfTs(t) === day }

/** Type-scoped station queues (never sequences / pre-gate-in batches). */
function typeQueues(ctx: ReportCtx, type: 'PDI' | 'FINAL' | 'PM' | 'WASH'): WorkQueue[] {
  return ctx.queues.filter((q) =>
    !isSequenceQueue(q) && !(q.name ?? '').trim().startsWith('(') && queueTypeOf(q) === type)
}

/** Checked/done items of a queue type on the day, deduped by vin (latest wins). */
function checkedItems(ctx: ReportCtx, type: 'PDI' | 'FINAL' | 'PM' | 'WASH', nameFilter?: (n: string) => boolean) {
  const out = new Map<string, QueueItem>()
  for (const q of typeQueues(ctx, type)) {
    if (nameFilter && !nameFilter(q.name ?? '')) continue
    for (const i of q.items) if (itemOnDay(i, ctx.day)) {
      const prev = out.get(i.vin)
      if (!prev || (itemTs(i) ?? 0) > (itemTs(prev) ?? 0)) out.set(i.vin, i)
    }
  }
  return [...out.values()].sort((a, b) => (itemTs(a) ?? 0) - (itemTs(b) ?? 0))
}

const fmtTime = (ts?: number) => ts ? `${fmtDay(dayKeyOfTs(ts))} ${new Date(ts).toTimeString().slice(0, 5)}` : ''

/**
 * Every car a station recorded on the day — the ONE list the PDI table and the
 * PDI shift matrix both count from, so the two can never disagree again (the
 * table read 103 while the matrix read 39).
 *
 * `clock` is the time the FIELD actually recorded, and only that: recordCheck
 * stamps `checkedAt` when an operator saves OK/NG at the station. `doneAt` is
 * not a clock — the reconciler back-fills it from a date cell on the sheet, at
 * local midnight, which printed as a real-looking "00:00" and dropped every
 * such car into P1. A car known only from a sheet date has no time, and says so.
 */
interface StationDone { vin: string; clock?: number; result?: 'OK' | 'NG' }
function stationDone(ctx: ReportCtx, type: 'PDI' | 'FINAL' | 'PM'): StationDone[] {
  const out = new Map<string, StationDone>()
  for (const i of checkedItems(ctx, type))
    out.set(i.vin, { vin: i.vin, clock: i.checkedAt, result: i.result })
  // …plus every car the SHEET says was done today that no queue item covers
  // (scanned straight at the station, or its queue archived after the work).
  if (type === 'PDI') {
    for (const r of ctx.rows) {
      if (out.has(r.vin)) continue
      if (PDI_KEYS.some((k) => cellOnDay(r.cells[k], ctx.day))) out.set(r.vin, { vin: r.vin })
    }
  }
  return [...out.values()]
}

// ── list builders ───────────────────────────────────────────────────────────

export function buildList(ctx: ReportCtx, id: string): ListRow[] {
  const lots = lotMap(ctx)
  const out: ListRow[] = []
  const push = (vin: string, opts?: { date?: string; lot?: string; remark?: string }) =>
    out.push(toListRow(out.length + 1, vin, ctx, lots, opts))

  if (id === 'gatein') {
    for (const r of ctx.rows) {
      const ts = parseDayCell(r.cells['Gate In Time'])
      if (ts !== undefined && dayKeyOfTs(ts) === ctx.day) { push(r.vin, { date: fmtTime(ts), remark: r.cells['Gate In Inspector'] || '' }); continue }
      if (ts === undefined && cellOnDay(r.cells['Gate In (Rayong yard)'], ctx.day)) push(r.vin)
    }
  } else if (id === 'gateout') {
    for (const r of ctx.rows) {
      const ts = parseDayCell(r.cells['Gate Out Time'])
      if (ts !== undefined && dayKeyOfTs(ts) === ctx.day) { push(r.vin, { date: fmtTime(ts) }); continue }
      if (ts === undefined && cellOnDay(r.cells['Gate Out time stamp'], ctx.day)) push(r.vin)
    }
  } else if (id === 'pdiout') {
    // passed PDI on the day AND already assigned a delivery group → released
    for (const r of ctx.rows) {
      if (!PDI_KEYS.some((k) => cellOnDay(r.cells[k], ctx.day))) continue
      const g = (r.cells['Grouping  Number'] || '').trim()
      if (g) push(r.vin, { lot: g })
    }
  } else if (id === 'washsale') {
    // driver's delivery flow: scan #1 moves the car into Wash for sale
    const seen = new Set<string>()
    for (const q of ctx.queues) {
      if (!isSequenceQueue(q)) continue
      for (const i of q.items) if (i.atWashAt && dayKeyOfTs(i.atWashAt) === ctx.day && !seen.has(i.vin)) {
        seen.add(i.vin); push(i.vin, { date: fmtTime(i.atWashAt) })
      }
    }
    for (const i of checkedItems(ctx, 'WASH', (n) => !/pm/i.test(n)))
      if (!seen.has(i.vin)) { seen.add(i.vin); push(i.vin, { date: fmtTime(itemTs(i)) }) }
  } else if (id === 'hold') {
    for (const r of ctx.rows) {
      const s = `${r.cells['Final Status'] ?? ''} ${r.cells['Status'] ?? ''} ${r.cells['Car Status'] ?? ''}`.toLowerCase()
      if (s.includes('hold')) push(r.vin, { date: '', lot: (r.cells['Grouping  Number'] || '').trim() || undefined })
    }
  } else if (id === 'pdi' || id === 'fc' || id === 'pm') {
    const type = id === 'pdi' ? 'PDI' : id === 'fc' ? 'FINAL' : 'PM'
    // date + time when the field recorded one; date alone when it did not —
    // never a fabricated 00:00
    for (const d of stationDone(ctx, type))
      push(d.vin, { date: d.clock ? fmtTime(d.clock) : fmtDay(ctx.day), remark: d.result === 'NG' ? 'NG' : '' })
  } else if (id === 'washpm') {
    for (const i of checkedItems(ctx, 'WASH', (n) => /pm/i.test(n)))
      push(i.vin, { date: fmtTime(itemTs(i)) })
  }
  return out
}

// ── defect builders — defects the stations recorded on the day, scoped to the
//    cars that went through that station's queues (FC vs PM) ─────────────────

export function buildDefects(ctx: ReportCtx, id: 'fcdefect' | 'pmdefect' | 'pdidefect'): DefectRowOut[] {
  const type = id === 'fcdefect' ? 'FINAL' : id === 'pdidefect' ? 'PDI' : 'PM'
  const stationVins = new Set<string>()
  for (const q of typeQueues(ctx, type)) for (const i of q.items) stationVins.add(i.vin)
  const lots = lotMap(ctx)
  const rows = rowMap(ctx)
  const out: DefectRowOut[] = []
  for (const u of ctx.units) {
    if (!stationVins.has(u.vin)) continue
    for (const d of u.damages) {
      if (dayKeyOfTs(d.at) !== ctx.day) continue
      if (isStockSheetEntry(d)) continue // stock count, not a defect — see above
      const c = rows.get(u.vin)?.cells ?? {}
      out.push({
        no: out.length + 1, vin: u.vin,
        position: d.areaTh || d.area || '',
        defect: d.itemTh || d.item || d.type || '',
        date: fmtDay(ctx.day),
        status: d.statusRepair || 'Waiting Repair',
        lot: c['LOT'] || lots.get(u.vin) || '',
        remark: d.note || d.remark || '',
        model: u.modelName || c['Model name'] || c['Model'] || '',
        from: c['From'] || '',
        stockStatus: c['Stock of Status'] || '',
        categoryNG: String(d.categoryNG ?? ''),
        categoryRepair: d.categoryRepair ?? '',
        incharge: d.incharge ?? '',
        repairDate: d.repairDate ? fmtDay(dayKeyOfTs(d.repairDate)) : '',
      })
    }
  }
  return out
}

// ── เช็คเวลา matrix — realtime counts per break period ──────────────────────

export function buildTimeMatrix(ctx: ReportCtx, id: 'fctime' | 'pmtime' | 'pditime'): TimeMatrix {
  const type = id === 'fctime' ? 'FINAL' : id === 'pditime' ? 'PDI' : 'PM'
  const title = id === 'fctime' ? `Final check (FC) ${ctx.siteLabel}`
    : id === 'pditime' ? `PDI ${ctx.siteLabel}`
    : `Preventive Maintenance (PM) ${ctx.siteLabel}`
  const rows = rowMap(ctx)
  // Plan = every car in the day's queues of this type (checked or not); when a
  // queue spans days, count queues created that day, else any queue with a
  // check recorded that day
  const qs = typeQueues(ctx, type)
  let planQs = qs.filter((q) => dayKeyOfTs(q.createdAt || 0) === ctx.day)
  if (!planQs.length) planQs = qs.filter((q) => q.items.some((i) => itemOnDay(i, ctx.day)))
  const plan = planQs.reduce((a, q) => a + q.items.length, 0)

  const byModel = new Map<string, { total: number; p: number[] }>()
  for (const m of MODEL_ROWS) byModel.set(m, { total: 0, p: [0, 0, 0, 0, 0] })
  const ok = [0, 0, 0, 0, 0]; const ng = [0, 0, 0, 0, 0]
  let okTotal = 0, ngTotal = 0, total = 0
  for (const i of stationDone(ctx, type)) {
    // a car with no recorded time is still work that was done — it counts in
    // Volume and Total, it just has no shift to sit in
    const p = i.clock !== undefined ? periodOf(i.clock) : null
    const c = rows.get(i.vin)?.cells ?? {}
    const label = (c['Model'] || c['Model name'] || '').toUpperCase().replace(/^BYD\s*/, '').replace(/^DENZA\s*/, '').trim()
    // spacing in the sheet is not consistent ("ATTO3" vs "ATTO 3") and used to
    // split one model across two rows of this table
    const flat = label.replace(/\s+/g, '')
    const squash = (m: string) => m.replace(/\s+/g, '')
    // longest match wins — "SEAL 5" must land on SEAL 5, not SEAL
    const key = MODEL_ROWS.filter((m) => flat.startsWith(squash(m))).sort((a, b) => b.length - a.length)[0]
      ?? MODEL_ROWS.filter((m) => flat.includes(squash(m))).sort((a, b) => b.length - a.length)[0]
      ?? (label || '—')
    if (!byModel.has(key)) byModel.set(key, { total: 0, p: [0, 0, 0, 0, 0] })
    const slot = byModel.get(key)!
    slot.total++; total++
    if (p !== null) slot.p[p]++
    if (i.result === 'NG') { ngTotal++; if (p !== null) ng[p]++ } else { okTotal++; if (p !== null) ok[p]++ }
  }
  return {
    title, plan,
    models: [...byModel.entries()].map(([name, v]) => ({ name, ...v })),
    ok, okTotal, ng, ngTotal, total,
  }
}

// ── Excel export — mirrors the office's Report_operation workbook ───────────

const LIST_SHEETS: { id: string; sheet: string }[] = [
  { id: 'gatein', sheet: 'Gate-IN' }, { id: 'gateout', sheet: 'Gate-OUT' },
  { id: 'pdiout', sheet: 'PDI-OUT' }, { id: 'washsale', sheet: 'Wash for Sales' },
  { id: 'hold', sheet: 'Hold' }, { id: 'pdi', sheet: 'PDI' },
  { id: 'fc', sheet: 'Final Check' }, { id: 'washpm', sheet: 'Wash for PM' },
  { id: 'pm', sheet: 'PM' },
]

export async function exportOpsReport(ctx: ReportCtx) {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
  const fill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
  const font = { name: 'Tahoma', size: 10 }

  const addListSheet = (name: string, rows: ListRow[], lotHeader = 'LOT\nM-D-lot') => {
    const ws = wb.addWorksheet(name)
    ws.columns = [{ width: 6 }, { width: 21 }, { width: 30 }, { width: 13 }, { width: 12 }, { width: 17 }, { width: 15 }, { width: 16 }]
    const r1 = ws.addRow(['Total', rows.length])
    r1.font = { ...font, bold: true }
    const hr = ws.addRow(['No.', 'Vin', 'Model Name', 'Model', 'Color', 'Date', lotHeader, 'Remark'])
    hr.eachCell((cell: any) => { cell.font = { ...font, bold: true }; cell.border = border; cell.fill = fill('FFD9D9D9'); cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true } })
    for (const r of rows) {
      const row = ws.addRow([r.no, r.vin, r.modelName, r.model, r.color, r.date, r.lot, r.remark])
      row.eachCell({ includeEmpty: true }, (cell: any, col: number) => { if (col <= 8) { cell.font = font; cell.border = border } })
    }
  }
  const addDefectSheet = (name: string, rows: DefectRowOut[]) => {
    const ws = wb.addWorksheet(name)
    ws.columns = [{ width: 6 }, { width: 21 }, { width: 22 }, { width: 20 }, { width: 12 }, { width: 15 }, { width: 15 }, { width: 16 }]
    const hr = ws.addRow(['No.', 'Vin', 'Postion', 'Defect/NG', 'Date', 'Status', 'LOT\nM-D-lot', 'Remark'])
    hr.eachCell((cell: any) => { cell.font = { ...font, bold: true }; cell.border = border; cell.fill = fill('FFD9D9D9'); cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true } })
    for (const r of rows) {
      const row = ws.addRow([r.no, r.vin, r.position, r.defect, r.date, r.status, r.lot, r.remark])
      row.eachCell({ includeEmpty: true }, (cell: any, col: number) => { if (col <= 8) { cell.font = font; cell.border = border } })
    }
  }
  const addTimeSheet = (name: string, m: TimeMatrix) => {
    const ws = wb.addWorksheet(name)
    ws.columns = [{ width: 16 }, { width: 11 }, ...TIME_PERIODS.map(() => ({ width: 15 }))]
    const bAll = (row: any, opts?: { fillC?: string; bold?: boolean; color?: string }) =>
      row.eachCell({ includeEmpty: true }, (cell: any, col: number) => {
        if (col > 7) return
        cell.font = { ...font, bold: opts?.bold, color: opts?.color ? { argb: opts.color } : undefined }
        cell.border = border
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        if (opts?.fillC) cell.fill = fill(opts.fillC)
      })
    const t = ws.addRow([m.title]); ws.mergeCells(1, 1, 1, 7); bAll(t, { bold: true })
    const h1 = ws.addRow(['Task', 'Volume', 'P1', 'P2', 'P3', 'P4', 'P5']); bAll(h1, { bold: true, fillC: 'FFD9D9D9' })
    h1.getCell(3).font = { ...font, bold: true, color: { argb: 'FF0000FF' } }
    for (let c = 3; c <= 7; c++) h1.getCell(c).font = { ...font, bold: true, color: { argb: 'FF0000FF' } }
    const h2 = ws.addRow(['', '', ...TIME_PERIODS]); bAll(h2)
    ws.mergeCells(2, 1, 3, 1); ws.mergeCells(2, 2, 3, 2)
    const planRow = ws.addRow(['Plan', m.plan, ...TIME_PERIODS.map(() => m.plan ? Math.round((m.plan / 5) * 10) / 10 : '')]); bAll(planRow)
    for (const mr of m.models) { const row = ws.addRow([mr.name, mr.total, ...mr.p.map((n) => n || '')]); bAll(row) }
    const okRow = ws.addRow(['OK', m.okTotal, ...m.ok]); bAll(okRow, { fillC: 'FFD8E4BC' })
    const okR = ws.addRow(['Ratio(OK)', pctStr(m.okTotal, m.total), ...m.ok.map((n) => pctStr(n, m.total))]); bAll(okR, { fillC: 'FFD8E4BC' })
    const ngRow = ws.addRow(['NG', m.ngTotal, ...m.ng]); bAll(ngRow, { fillC: 'FFFCD5B4', color: 'FFFF0000' })
    const ngR = ws.addRow(['Ratio(NG)', pctStr(m.ngTotal, m.total), ...m.ng.map((n) => pctStr(n, m.total))]); bAll(ngR, { fillC: 'FFFCD5B4', color: 'FFFF0000' })
    const totRow = ws.addRow(['Total', m.total]); bAll(totRow, { bold: true, fillC: 'FFFFFF00' })
  }

  for (const s of LIST_SHEETS) {
    const rows = buildList(ctx, s.id)
    addListSheet(`${s.sheet}(${ctx.siteLabel})`.slice(0, 31), rows, s.id === 'pdiout' || s.id === 'hold' ? 'Group No' : 'LOT\nM-D-lot')
    if (s.id === 'fc') { addDefectSheet('FC(Defect)', buildDefects(ctx, 'fcdefect')); addTimeSheet('เช็คเวลาFC', buildTimeMatrix(ctx, 'fctime')) }
    if (s.id === 'pm') { addDefectSheet('PM(Defect)', buildDefects(ctx, 'pmdefect')); addTimeSheet('เช็คเวลาPM', buildTimeMatrix(ctx, 'pmtime')) }
  }

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Report_operation_${ctx.siteLabel.replace(/[^\w]+/g, '')}_${ctx.day}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

const pctStr = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : '0%')

// re-export for the page's day marking
export const pmLadderKeys = PM_KEYS
