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
import { PM_KEYS, PDI_KEYS, defaultColumns, type Column } from './trackingColumns'
import type { RowEvent } from './excelTracking'

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
 * Cells that describe ONE visit and must not leak into the next one — they
 * are lifted OFF the live row when the round closes (แยกข้อมูลยาร์ดใครยาร์ดมัน:
 * ย้ายไปยาร์ดใหม่ = เริ่มบันทึกใหม่ทั้งหมด ไม่เอาของยาร์ดเดิมมาใช้).
 *
 * Deliberately NOT here — these belong to the vehicle, not to a visit, and
 * survive every round: Model / Color / company / Model Code (identity),
 * Factory-Installed / Accessories (what it shipped with), Vin Photo, Status
 * Tax, Remark / หมายเหตุ (notes someone wrote by hand) — and the shared
 * inspection work listed in ROUND_COPIED_KEYS below.
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
  // ช่องจอดสุดท้ายในยาร์ดเดิม (ใบ Grouping พิมพ์ซ้ำใช้) — ยาร์ดใหม่ต้องไม่เห็นเป็นตำแหน่งรถ
  'Last Yard Location',
  // 'Car Status Set At' — เวลาที่มีคนยืนยันสถานะรอบนี้ ต้องไม่ค้างข้ามรอบ
  'Car Status Set At', 'Car Status Set Site',
]

/**
 * งานตรวจสภาพที่ "ใช้ร่วมกันทุกยาร์ด" — PDI / PM นับว่าทำแล้วและนับต่อเนื่อง
 * (PDI ที่ยาร์ดใหม่ลงช่อง RE-PDI ถัดไป, PM5 → PM6) · Final / Vin Of Status
 * ตามรถไป · ค่าที่วัดได้ (% SOC, ลมยาง) เป็นของตัวรถ
 *
 * ช่องเหล่านี้ไม่ถูกล้างตอนปิดรอบ แต่ถูก "คัดลอก" ลงก้อนรอบด้วย — แถวรอบของ
 * ยาร์ดเดิมจึงยังแสดงงานตรวจ ณ วันที่รถออก ไม่ขยับตามงานที่ยาร์ดใหม่ทำต่อ
 */
export const ROUND_COPIED_KEYS: string[] = [
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

/** When the CURRENT round began = the moment the previous round was closed
 *  (0 = the car's first round, nothing before it). */
export function roundStartAt(cells: Record<string, string>): number {
  const t = tripsOf(cells)
  return t.length ? t[t.length - 1].closedAt || 0 : 0
}

// history lines are logged under the column LABEL (fallback: raw key), so the
// shared-work test has to accept both spellings; the built-in labels are known
// here, a renamed column is covered when the caller passes its live columns
let sharedFieldNames: Set<string> | null = null
function sharedFields(columns?: Column[]): Set<string> {
  if (!sharedFieldNames) {
    sharedFieldNames = new Set(ROUND_COPIED_KEYS)
    for (const c of defaultColumns()) if (sharedFieldNames.has(c.key) && c.label) sharedFieldNames.add(c.label)
  }
  if (!columns) return sharedFieldNames
  const out = new Set(sharedFieldNames)
  for (const c of columns) if (out.has(c.key) && c.label) out.add(c.label)
  return out
}

/** Does this history line belong to the CAR (shared inspection work / defects)
 *  rather than to one yard's round? */
export function isSharedRoundEvent(e: RowEvent, columns?: Column[]): boolean {
  return e.field === '__damage' || sharedFields(columns).has(e.field)
}

/**
 * ประวัติ "เฉพาะรอบนี้" — แยกข้อมูลยาร์ดใครยาร์ดมัน: การย้าย/ยิง Gate-in/
 * Gate-out/แก้ช่องของรอบก่อน (ยาร์ดเดิม) ซ่อนหมด เห็นเฉพาะที่เกิดในรอบของยาร์ด
 * นี้ (ตั้งแต่วินาทีที่รอบก่อนถูกปิด) · ยกเว้นงานที่ใช้ร่วมกัน (defect / PDI / PM /
 * Final / ค่าที่วัด — ดู ROUND_COPIED_KEYS) ซึ่งเป็นของตัวรถ จึงตามรถไปทุกรอบ
 *
 * แถวรอบที่ปิดแล้ว (visit) ไม่มีก้อน __trips → คืนประวัติทั้งแถวตามเดิม
 */
export function roundHistory(row: { cells: Record<string, string>; history?: RowEvent[] }, columns?: Column[]): RowEvent[] {
  const h = row.history ?? []
  if (!h.length) return h
  const since = roundStartAt(row.cells)
  if (!since) return h
  return h.filter((e) => e.at >= since || isSharedRoundEvent(e, columns))
}
