/**
 * A car's ROUNDS through the yard ("รอบที่").
 *
 * A car that gates out and later comes back is the SAME vehicle — one VIN, and
 * the VIN is the primary key of every store, of IndexedDB and of both cloud
 * tables, so it can only ever hold one live row. What must not be shared
 * between the two visits is the DATA: the first round's gate-out date, lot,
 * grouping, PDI/PM dates and inspection results have nothing to do with the
 * second round, and leaving them on the row is what made the two visits read
 * as one confusing mess.
 *
 * So a returning car CLOSES its round: every cell below is lifted off the row
 * into a snapshot kept under TRIPS_CELL, and the row starts the next round
 * empty — a clean sheet, exactly like a car arriving for the first time. The
 * old round is not lost, it is just filed: the car card shows "รอบที่ 2" and
 * lists the closed rounds underneath.
 */
import { PM_KEYS, PDI_KEYS } from './trackingColumns'

/** Hidden cell holding the closed rounds as JSON. Like Vin Photo it lives only
 *  in the cells blob — no table column, no DB migration. */
export const TRIPS_CELL = '__trips'

export interface TripSnapshot {
  /** which round this was (1 = the car's first visit) */
  round: number
  gateIn: string
  gateOut: string
  yard: string
  lot: string
  grouping: string
  /** when the round was closed (the moment the car was re-announced) */
  closedAt: number
  /** every cell the new round cleared — nothing from the old round is lost */
  cells: Record<string, string>
}

/**
 * Cells that describe ONE visit and must not leak into the next one.
 *
 * Deliberately NOT here — these belong to the vehicle, not to a visit, and
 * survive every round: Model / Color / company / Model Code (identity),
 * Factory-Installed / Accessories (what it shipped with), Vin Photo, Status
 * Tax, Remark / หมายเหตุ (notes someone wrote by hand).
 */
export const TRIP_SCOPED_KEYS: string[] = [
  // this visit's arrival + departure
  'Gate In (Rayong yard)', 'Gate In Date', 'Gate In Time', 'Gate In Inspector',
  'Gate Out time stamp', 'Gate Out Date', 'Gate Out Time',
  // this visit's logistics
  'Lot transfer', 'moving date', 'Grouping  Number', 'Allocation Date',
  'Dealer Code', 'Dealer Location', 'Tailer Company', 'storage Yard', 'Stock of Status',
  'Move from  1', 'Transfer 1', 'Move from  2', 'Transfer 2',
  'Move from  3', 'Transfer 3', 'Move from  4', 'Transfer 4',
  // this visit's inspection work
  // 'Car Status Set At' — เวลาที่มีคนยืนยันสถานะรอบนี้ ต้องไม่ค้างข้ามรอบ
  'Car Status Set At', 'Car Status Set Site',
  'Status', 'Vin Of Status', 'Final Status', 'Final check date', 'OK date', 'PIC (PDI)',
  '% SOC', 'Tire Pressure', 'Aging PM',
  ...PDI_KEYS, ...PM_KEYS,
]

export function tripsOf(cells: Record<string, string>): TripSnapshot[] {
  try {
    const a = JSON.parse(cells[TRIPS_CELL] || '[]')
    return Array.isArray(a) ? (a as TripSnapshot[]) : []
  } catch { return [] }
}

/** Which round the car is in right now — 1 until it has come back once. */
export const roundOf = (cells: Record<string, string>): number => tripsOf(cells).length + 1
