/**
 * One car's history, computed once and shown in TWO places: the admin Unit
 * detail (RowDetail) and the field Check station — both render the same Work
 * checklist and the same Event log, so หน้างาน sees exactly what admin sees.
 */
import type { TrackRow, RowEvent } from './excelTracking'
import type { Column } from './trackingColumns'
import { LOCATION_KEY } from './trackingColumns'
import { yardLocFull } from './groupingImport'
import type { Unit, Damage } from '../types'
import type { WorkQueue } from '../store/useOps'

export const fmtHistAt = (t: number) =>
  new Date(t).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })

// history entries are logged under the COLUMN LABEL (fallback: raw key), so a
// lookup must accept both spellings of every field it cares about
const labelOf = (columns: Column[], key: string) => columns.find((cc) => cc.key === key)?.label ?? key
export function histOf(row: TrackRow, columns: Column[], ...keys: string[]): RowEvent[] {
  const names = new Set(keys.flatMap((k) => [k, labelOf(columns, k)]))
  return (row.history ?? []).filter((h) => names.has(h.field))
}
export function lastHist(row: TrackRow, columns: Column[], ...keys: string[]): RowEvent | null {
  const a = histOf(row, columns, ...keys)
  return a.length ? a[a.length - 1] : null
}

/** Every value a measurement cell has held — one line per save (SOC / tire). */
export function readingsHist(row: TrackRow, columns: Column[], key: string): { value: string; at?: number; by?: string }[] {
  const out: { value: string; at?: number; by?: string }[] =
    histOf(row, columns, key).filter((h) => (h.to ?? '').trim()).map((h) => ({ value: h.to, at: h.at, by: h.by }))
  const cur = (row.cells[key] ?? '').trim()
  if (cur && out[out.length - 1]?.value !== cur) out.push({ value: cur }) // imported value — no log entry
  return out
}

// station date ladders (stamped by stampStationDate on every sheet save)
export const PDI_DATE_KEYS = ['PDI', ...Array.from({ length: 8 }, (_, i) => `RE PDI  Date #${i + 1}`)]
export const PM_DATE_KEYS = Array.from({ length: 15 }, (_, i) => `PM${i + 1}`)
export const filledDates = (cells: Record<string, string>, keys: string[]) =>
  keys.map((k) => ({ k, v: (cells[k] || '').trim() })).filter((x) => x.v)

export interface WorkRowData {
  code: string; name: string; done: boolean
  date?: string; user?: string; note?: string; value?: string
  sub?: { value: string; at?: number; by?: string }[]
}

/** The car's whole workflow as checklist rows (Gate In … Gate Out). */
export function buildWorkRows(row: TrackRow, unit: Unit | undefined, columns: Column[]): { rows: WorkRowData[]; done: number } {
  const c = row.cells
  const socHist = readingsHist(row, columns, '% SOC')
  const tireHist = readingsHist(row, columns, 'Tire Pressure')
  const pdiDates = filledDates(c, PDI_DATE_KEYS)
  const pmDates = filledDates(c, PM_DATE_KEYS)
  const fcDate = (c['Final check date'] || '').trim()
  const locHist = lastHist(row, columns, LOCATION_KEY, 'Location')
  const grpHist = lastHist(row, columns, 'Grouping  Number')
  const rows: WorkRowData[] = [
    { code: 'GAI', name: 'Gate In', done: !!((c['Gate In (Rayong yard)'] || '').trim() || unit?.gateInAt),
      date: (c['Gate In (Rayong yard)'] || '').trim() || (unit?.gateInAt ? fmtHistAt(unit.gateInAt) : ''),
      user: c['Gate In Inspector'] || unit?.gateInBy },
    { code: 'CNL', name: 'Confirm Location', done: !!(unit?.block && unit.row && unit.slot) || !!locHist,
      date: locHist ? fmtHistAt(locHist.at) : unit?.parkedAt ? fmtHistAt(unit.parkedAt) : '',
      user: locHist?.by, note: yardLocFull(unit) || undefined },
    { code: 'PDI', name: 'PDI', done: pdiDates.length > 0, date: pdiDates[pdiDates.length - 1]?.v, user: lastHist(row, columns, ...PDI_DATE_KEYS)?.by },
    { code: 'FNC', name: 'Final Check', done: !!fcDate, date: fcDate, user: lastHist(row, columns, 'Final check date')?.by },
    { code: 'PM',  name: 'PM', done: pmDates.length > 0, date: pmDates[pmDates.length - 1]?.v, user: lastHist(row, columns, ...PM_DATE_KEYS)?.by },
    // the CURRENT value sits on the main row — the sub-rows underneath are the
    // full save history (every station that recorded one: PDI / Final Check / PM)
    { code: 'SOC', name: '% SOC', done: socHist.length > 0, sub: socHist,
      value: socHist[socHist.length - 1]?.value,
      date: socHist[socHist.length - 1]?.at ? fmtHistAt(socHist[socHist.length - 1].at!) : '',
      user: socHist[socHist.length - 1]?.by },
    { code: 'TPS', name: 'Tire Pressure', done: tireHist.length > 0, sub: tireHist,
      value: tireHist[tireHist.length - 1]?.value,
      date: tireHist[tireHist.length - 1]?.at ? fmtHistAt(tireHist[tireHist.length - 1].at!) : '',
      user: tireHist[tireHist.length - 1]?.by },
    { code: 'ORD', name: 'Allocate', done: !!(c['Allocation Date'] || '').trim(), date: (c['Allocation Date'] || '').trim(), user: lastHist(row, columns, 'Allocation Date')?.by },
    { code: 'ACS', name: 'Addition Accessories', done: pdiDates.length > 0 || !!fcDate,
      date: fcDate || pdiDates[pdiDates.length - 1]?.v, note: 'บันทึกพร้อมใบตรวจ PDI / Final Check' },
    { code: 'GOD', name: 'Grouping Order', done: !!(c['Grouping  Number'] || '').trim(),
      date: grpHist ? fmtHistAt(grpHist.at) : '', user: grpHist?.by, note: (c['Grouping  Number'] || '').trim() || undefined },
    { code: 'GOT', name: 'Gate Out', done: !!(c['Gate Out time stamp'] || '').trim() || /gate-?out/i.test(c['Car Status'] || ''),
      date: (c['Gate Out time stamp'] || '').trim(), user: lastHist(row, columns, 'Gate Out time stamp')?.by },
  ]
  return { rows, done: rows.filter((w) => w.done).length }
}

export interface CarEvent { at: number; by: string; station?: string; text: string; accent?: string }

const DAMAGE_STATION_FALLBACK: Record<string, string> = {
  walkaround: 'Gate-in', pdi: 'PDI', mechanic: 'ช่าง (Mechanic)', update: 'Update Damage', walkcheck: 'Walk Around Check',
  yardDefect: 'Co-Inspection (Yard)', factoryDefect: 'Co-Inspection (Factory)', whaleDefect: 'Co-Inspection (Whale)',
  manual: 'เพิ่มเอง (Manual)',
}
/** Which station recorded a damage — the stamped `station` name, else a
 *  fallback derived from the legacy `source` tag (predates the `station`
 *  field). Shared by the event log above and any report that lists defects
 *  per station (e.g. Report 2PS). */
export const stationLabelOf = (d: Pick<Damage, 'station' | 'source'>) =>
  d.station || DAMAGE_STATION_FALLBACK[d.source ?? ''] || 'Gate-in'

/** Unified event log — cell edits + damage records + queue station steps,
 *  newest first. `areaLabel` maps a damage area to its display name (zoneLabel). */
export function buildEventLog(
  row: TrackRow, damages: Damage[], queues: WorkQueue[], vin: string,
  areaLabel: (a: string) => string,
): CarEvent[] {
  const c = row.cells
  const log: CarEvent[] = []
  for (const h of row.history ?? []) {
    if (h.field === '__damage') { log.push({ at: h.at, by: h.by, station: 'Damage', text: h.to, accent: '#dc2626' }); continue }
    log.push({ at: h.at, by: h.by, text: `แก้ไข ${h.field}: ${h.from || '(ว่าง)'} → ${h.to}` })
  }
  for (const d of damages) {
    const station = stationLabelOf(d)
    log.push({
      at: d.at, by: d.by, station,
      text: `บันทึก Defect ${areaLabel(d.area)} · ${d.item ?? d.type}${d.severity === 'major' ? ' (Heavy NG)' : ''}`,
      accent: '#dc2626',
    })
    for (const h of d.repairHistory ?? []) {
      log.push({
        at: h.at, by: h.by, station: 'ซ่อม (Repair)',
        text: `เปลี่ยนสถานะซ่อม ${areaLabel(d.area)}: ${h.from ? `${h.from} → ` : ''}${h.status}`,
        accent: '#16a34a',
      })
    }
  }
  for (const q of queues) {
    const item = q.items.find((i) => i.vin === vin)
    if (!item) continue
    if (item.deliveredAt) log.push({ at: item.deliveredAt, by: item.deliveredBy || '—', station: q.name, text: `นำรถเข้าสถานี ${q.name}${item.fromSlot ? ` (จาก ${item.fromSlot})` : ''}` })
    if (item.checkedAt) log.push({ at: item.checkedAt, by: item.checkedBy || '—', station: q.name, text: `ตรวจสอบที่ ${q.name} · ผล ${item.result ?? '—'}`, accent: item.result === 'NG' ? '#dc2626' : '#16a34a' })
    if (item.returnedAt) log.push({ at: item.returnedAt, by: item.returnedBy || '—', station: q.name, text: 'นำรถกลับเข้าจอด' })
    else if (item.doneAt && !item.checkedAt) {
      // Pre Gate-in queues rarely carry the item's doneBy (auto-reconciled) —
      // fall back to the Gate In Inspector stamped on the tracking row.
      const isGateIn = q.name.trim().startsWith('(')
      const by = item.doneBy || (isGateIn ? c['Gate In Inspector'] : '') || '—'
      log.push({ at: item.doneAt, by, station: q.name, text: isGateIn ? `Gate-in เสร็จ · ${q.name}` : `ทำรายการเสร็จที่ ${q.name}` })
    }
  }
  return log.sort((a, b) => b.at - a.at)
}
