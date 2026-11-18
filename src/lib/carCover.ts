/**
 * รถคลุมผ้า — หน้างาน Gate-in ต้องติ๊กทุกคันว่ารถมาถึงแบบคลุมผ้าหรือไม่ (ก่อน Confirm Gate in)
 * เก็บในแถวรถที่ช่อง 'Car Cover' และแสดงในหน้า Unit คอลัมน์ "รถคลุมผ้า"
 * (เป็นข้อมูลของการมาถึงรอบนี้ — ปิดรอบแล้วไม่ค้างไปรอบหน้า ดู TRIP_SCOPED_KEYS)
 */
export const CAR_COVER_KEY = 'Car Cover'
export const COVERED = 'คลุม'
export const UNCOVERED = 'ไม่คลุม'
export const CAR_COVER_VALUES = [COVERED, UNCOVERED] as const
export type CarCover = typeof CAR_COVER_VALUES[number]

/** คลุม = เขียว · ไม่คลุม = แดง (ค่าอื่นไม่มีสี) */
export function carCoverColor(value: string): { color: string; bg: string } | null {
  const v = (value ?? '').trim()
  if (v === COVERED) return { color: '#15803d', bg: 'rgba(22,163,74,0.13)' }
  if (v === UNCOVERED) return { color: '#b91c1c', bg: 'rgba(220,38,38,0.12)' }
  return null
}
