/**
 * EV Charging — งานชาร์จแบตรถไฟฟ้าในลาน (สถานี EV Charging + เมนูแอดมิน)
 *
 * 1 รอบชาร์จ = 1 แถว (ตาราง ev_charges, supabase-ev-charging.sql):
 *   เริ่ม: รูปเลขวิน + รูปหน้าจอก่อนชาร์จ + % ก่อนชาร์จ (พนักงานพิมพ์ตามหน้าจอ) → บันทึก
 *   จบ:   รูปหน้าจอหลังชาร์จ + % หลังชาร์จ → บันทึก · เวลาชาร์จ = เวลาบันทึกหลัง − เวลาบันทึกก่อน
 * รถคันเดียวมีได้ทีละ 1 รอบที่ยังไม่จบ — ยิงวินซ้ำระหว่างชาร์จจะเข้าขั้น "หลังชาร์จ" ของรอบเดิม
 */
import { dateKey } from './dayKey'
import { EV_CHARGING_KEY } from './trackingColumns'

export interface EvCharge {
  /** "<vin>#<เวลาเริ่ม base36>" */
  id: string
  site?: string
  vin: string
  model: string
  color: string
  /** ช่อง From ของรถ (คอลัมน์ From ในไฟล์ Excel ที่ใช้อยู่) */
  from: string
  remark: string
  vinPhoto: string
  beforePhoto: string
  beforePct: number | null
  beforeAt: number
  beforeBy: string
  afterPhoto: string
  afterPct: number | null
  /** 0 = ยังชาร์จอยู่ */
  afterAt: number
  afterBy: string
  updatedAt: number
}

/** ช่องในชีต (Units / Units Mylist) ที่สรุปรอบชาร์จล่าสุดของรถ */
export const EV_CELL = EV_CHARGING_KEY
/** ค่าที่วัดในชีต (เดียวกับที่สถานี PDI/PM ลง) — สถานีเขียน % ล่าสุดที่บันทึกลงช่องนี้ด้วย */
export const SOC_CELL = '% SOC'

export const evChargeId = (vin: string, at: number) => `${vin}#${at.toString(36)}`
export const isCharging = (c: EvCharge) => !c.afterAt

/** เวลาชาร์จ (ms) — รอบที่ยังไม่จบนับถึง `now` */
/** เวลาเริ่ม/จบของรอบ — พอสำหรับสรุปเวลา (สรุปรายเดือนดึงมาแค่ช่องเหล่านี้ ไม่ดึงรูป) */
export type EvTimes = Pick<EvCharge, 'beforeAt' | 'afterAt'>

export const chargeMs = (c: EvTimes, now = Date.now()) => Math.max(0, (c.afterAt || now) - c.beforeAt)
/** ms → ชั่วโมงทศนิยม 2 ตำแหน่ง (ช่องตัวเลขใน Excel) */
export const hoursOf = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100

const p2 = (n: number) => String(n).padStart(2, '0')
/** ms → "3:45 ชม." */
export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  return `${Math.floor(mins / 60)}:${p2(mins % 60)} ชม.`
}
/** "01/10/26" — รูปวันที่เดียวกับไฟล์ Excel ที่หน้างานใช้ */
export function fmtEvDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`
}
export function fmtEvTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}
/** "2026-10-01" → "01/10/26" */
export const fmtDayKey = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(2, 4)}`
export const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`)

/** รอบที่ยังไม่จบของรถคันนี้ (ใหม่สุด) */
export function openChargeOf(list: Iterable<EvCharge>, vin: string): EvCharge | undefined {
  let hit: EvCharge | undefined
  for (const c of list) if (c.vin === vin && isCharging(c) && (!hit || c.beforeAt > hit.beforeAt)) hit = c
  return hit
}

/** ข้อความในช่อง EV Charging ของชีต */
export function evCellText(c: EvCharge): string {
  if (isCharging(c)) return `กำลังชาร์จ ${fmtPct(c.beforePct)} · ${fmtEvDate(c.beforeAt)} ${fmtEvTime(c.beforeAt)}`
  return `${fmtPct(c.beforePct)} → ${fmtPct(c.afterPct)} · ${fmtDuration(chargeMs(c))} · ${fmtEvDate(c.afterAt)}`
}

export interface EvDaySummary {
  /** "YYYY-MM-DD" */
  day: string
  /** รถที่ชาร์จเสร็จวันนั้น (นับตามเวลาบันทึกหลังชาร์จ) */
  finished: number
  /** รถที่เริ่มชาร์จวันนั้น */
  started: number
  /** เวลาชาร์จรวม / เฉลี่ยต่อคัน ของรถที่เสร็จวันนั้น */
  totalMs: number
  avgMs: number
}

/** สรุปรายวัน: วันละกี่คัน + คันละกี่ชั่วโมง (ใหม่สุดก่อน) */
export function dailySummary(list: Iterable<EvTimes>): EvDaySummary[] {
  const by = new Map<string, EvDaySummary>()
  const get = (day: string) => {
    let s = by.get(day)
    if (!s) { s = { day, finished: 0, started: 0, totalMs: 0, avgMs: 0 }; by.set(day, s) }
    return s
  }
  for (const c of list) {
    if (c.beforeAt) get(dateKey(new Date(c.beforeAt))).started++
    if (c.afterAt) {
      const s = get(dateKey(new Date(c.afterAt)))
      s.finished++
      s.totalMs += chargeMs(c)
    }
  }
  const out = [...by.values()]
  for (const s of out) s.avgMs = s.finished ? s.totalMs / s.finished : 0
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
/** "YYYY-MM" ของเวลานี้ (เวลาท้องถิ่น) */
export const monthKey = (ts = Date.now()) => dateKey(new Date(ts)).slice(0, 7)
/** "2026-10" → "ต.ค. 2026" (ปี ค.ศ. เหมือนวันที่อื่นในแอป) */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${TH_MONTHS[m - 1]} ${y}`
}
/** เลื่อนเดือน: shiftMonth('2026-01', -1) = '2025-12' */
export function shiftMonth(ym: string, by: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + by, 1)
  return dateKey(d).slice(0, 7)
}
/** [ต้นเดือน, ต้นเดือนถัดไป) เป็น ms ตามเวลาท้องถิ่น */
export function monthRange(ym: string): [number, number] {
  const [y, m] = ym.split('-').map(Number)
  return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()]
}

export interface EvMonthSummary {
  ym: string
  /** รถที่ชาร์จเสร็จในเดือนนี้ (ตามวันที่บันทึกหลังชาร์จ) */
  finished: number
  started: number
  totalMs: number
  avgMs: number
  /** รายวันของเดือนนี้ ใหม่สุดก่อน */
  days: EvDaySummary[]
}

/** ยอดเดือน — นับแบบเดียวกับสรุปรายวัน แล้วรวมเฉพาะวันในเดือนนั้น */
export function monthSummary(list: Iterable<EvTimes>, ym: string): EvMonthSummary {
  const days = dailySummary(list).filter((d) => d.day.startsWith(ym + '-'))
  const finished = days.reduce((n, d) => n + d.finished, 0)
  const totalMs = days.reduce((n, d) => n + d.totalMs, 0)
  return { ym, finished, started: days.reduce((n, d) => n + d.started, 0), totalMs, avgMs: finished ? totalMs / finished : 0, days }
}

/** ช่องกรอก % → ตัวเลข 0–100 หรือ null */
export function parsePct(s: string): number | null {
  const t = s.trim().replace('%', '')
  if (!/^\d{1,3}(\.\d+)?$/.test(t)) return null
  const n = Math.round(Number(t))
  return n >= 0 && n <= 100 ? n : null
}
