/**
 * "รอบที่รถมาเยือนยาร์ด" ที่ปิดแล้ว = แถวจริงของยาร์ดต้นทาง
 *
 * แยกยาร์ด แยกงาน — ขั้นที่ 1. รถหนึ่งคันยังมีแถวสดแถวเดียว (ของยาร์ดที่รถอยู่
 * ตอนนี้) แต่ทุกรอบที่จบไปแล้วมีแถวของตัวเอง เป็นของยาร์ดที่รอบนั้นเกิดขึ้น:
 * ยาร์ดต้นทางอ่านและแก้แถวรอบของตัวเองได้ตรง ๆ ไม่ต้องประกอบภาพย้อนหลังจาก
 * ก้อน __trips ที่ซ่อนอยู่ในแถวสดอีก และไม่มีอะไรที่ปลายทางเขียนจะขยับแถวนี้ได้
 *
 * แหล่งของแถวรอบ: (ก) ตอนปิดรอบ (closeRoundRow) สร้างพร้อมกันทันที
 * (ข) ตัวแปลงย้อนหลัง (migrateFromTrips) อ่านก้อน __trips ของแถวสดทุกแถวแล้ว
 * สร้างแถวรอบที่ยังไม่มี — ทำซ้ำได้ ไม่สร้างซ้ำ (คีย์ = เลขวิน#รอบ)
 */
import type { Site } from '../types'
import type { TrackRow, RowEvent } from './excelTracking'
import { tripsOf, TRIPS_CELL, TRIP_SCOPED_KEYS, type TripSnapshot } from './tripHistory'
import { fmtGateOutStamp, gateOutScanMs } from './carStatus'

export interface Visit {
  /** "<vin>#<round>" */
  id: string
  vin: string
  round: number
  /** ยาร์ดที่รอบนี้เกิดขึ้น (Site.id) — ไม่รู้ = undefined (ยาร์ดที่ไม่มีในระบบ) */
  site?: string
  cells: Record<string, string>
  history: RowEvent[]
  closedAt: number
  gateOutAt: number
  updatedAt: number
}

export const visitId = (vin: string, round: number) => `${vin}#${round}`

/** ช่องที่เป็นของ "ตัวรถ" ไม่ใช่ของรอบ — คัดลอกลงแถวรอบให้ครบ แถวรอบจะได้อ่านได้
 *  ด้วยตัวเอง (รายการรถ/ใบพิมพ์ต้องการรุ่น สี ฯลฯ) */
const IDENTITY_KEYS = ['Vin', 'Model name', 'Model', 'Model Code', 'Color', 'company', 'battery',
  'Front Motor no.', 'Rear Motor no.', 'Engine No.', 'Factory-Installed', 'Accessories',
  'Status Tax', 'Remark', 'หมายเหตุ', 'Match Tax/Shuttle']

const norm = (s?: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
function siteIdByName(name: string, sites: Site[]): string | undefined {
  const n = norm(name)
  if (!n) return undefined
  return sites.find((s) => [s.name, s.code].filter(Boolean).some((k) => norm(k as string) === n))?.id
}

/** เวลา "ออก" ของรอบนี้ — รอยยิงออกในรอบ ไม่มีก็ใช้เวลาที่ปิดรอบ */
export function tripGateOutAt(t: TripSnapshot): number {
  return gateOutScanMs(t.cells) || t.closedAt || 0
}

/**
 * สร้างแถวรอบจากก้อนรอบที่ปิด (ใช้ทั้งตอนปิดรอบสด และตอนแปลงย้อนหลัง)
 *  liveCells = ช่องของแถวสด ณ ตอนนั้น (เอาช่องของตัวรถมา) · history = ประวัติของ
 *  แถวสด ตัดที่เวลาที่รถออก (เผื่อ 1 นาทีให้รายการที่การยิงออกครั้งนั้นเองเขียน)
 */
export function visitFromTrip(
  vin: string, t: TripSnapshot, liveCells: Record<string, string>, history: RowEvent[] | undefined,
  sites: Site[], siteId?: string,
): Visit {
  const gateOutAt = tripGateOutAt(t)
  const cells: Record<string, string> = {}
  for (const k of IDENTITY_KEYS) { const v = liveCells[k]; if (v) cells[k] = v }
  Object.assign(cells, t.cells)
  cells['Vin'] = vin
  cells['Car Status'] = 'Gate-out'
  if (t.yard) cells['Location yard'] = t.yard
  if (gateOutAt > 0) {
    if (!cells['Gate Out Time']) cells['Gate Out Time'] = String(gateOutAt)
    if (!cells['Gate Out time stamp']) cells['Gate Out time stamp'] = fmtGateOutStamp(gateOutAt)
  }
  const cutoff = gateOutAt > 0 ? gateOutAt + 60_000 : t.closedAt + 60_000
  return {
    id: visitId(vin, t.round),
    vin, round: t.round,
    site: siteId ?? siteIdByName(t.yard, sites),
    cells,
    history: (history ?? []).filter((h) => h.at <= cutoff),
    closedAt: t.closedAt,
    gateOutAt,
    updatedAt: Date.now(),
  }
}

/** ทุกรอบที่ปิดแล้วของแถวสดแถวนี้ ที่ยังไม่มีแถวรอบ (สำหรับตัวแปลงย้อนหลัง) */
export function missingVisitsOf(r: TrackRow, have: (id: string) => boolean, sites: Site[]): Visit[] {
  const out: Visit[] = []
  for (const t of tripsOf(r.cells)) {
    if (have(visitId(r.vin, t.round))) continue
    out.push(visitFromTrip(r.vin, t, r.cells, r.history, sites))
  }
  return out
}

/** แถวรอบ → รูปแบบ TrackRow ให้ตาราง/หน้ารายละเอียด/การ์ดใช้ได้เหมือนแถวปกติ
 *  (`visitId` บอกให้การแก้ไขวิ่งไปที่แถวรอบ ไม่ใช่แถวสดของยาร์ดปลายทาง) */
export function visitToTrackRow(v: Visit): TrackRow {
  const cells = { ...v.cells }
  delete cells[TRIPS_CELL]
  return { vin: v.vin, site: v.site, cells, history: v.history, updatedAt: v.updatedAt, visitId: v.id }
}

/** ช่องของรอบที่ยาร์ดต้นทางแก้ได้ (ช่องของตัวรถแก้ที่แถวสด) */
export const isVisitEditableKey = (key: string) => TRIP_SCOPED_KEYS.includes(key) || key === 'Car Status'
