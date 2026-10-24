/**
 * "พิมพ์แล้ว" — จดว่ารถคันไหนพิมพ์ใบ DN / IR ไปแล้ว ในรอบ Grouping ไหน
 *
 * เก็บเป็นช่องระบบในแถวชีตของรถ (ไม่ใช่คอลัมน์ในตาราง Units) ทุกเครื่องจึงเห็นตรงกัน
 * และหน้ารายละเอียดรถมีประวัติว่าใครพิมพ์เมื่อไร · ค่า = "<Grouping> · <dd/mm/yy HH:MM>"
 * รถที่ถูกย้ายไป Grouping อื่น เครื่องหมายเดิมไม่นับ (ใบเดิมเป็นของรอบเก่า ต้องพิมพ์ใหม่)
 * จดตอนกดพิมพ์ — เบราว์เซอร์ไม่บอกว่าผู้ใช้กดยกเลิกหน้าต่างพิมพ์หรือไม่
 */
import type { TrackRow } from './excelTracking'
import { useTracking } from '../store/useTracking'

export const PRINTED_KEYS = { dn: 'DN Printed', ir: 'IR Printed' } as const
export type PrintKind = keyof typeof PRINTED_KEYS

const NO_GROUP = '—'
const SEP = ' · '
const p2 = (n: number) => String(n).padStart(2, '0')
const stamp = (ts: number) => {
  const d = new Date(ts)
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const groupKey = (g: string | undefined) => (g ?? '').trim() || NO_GROUP

/** ค่าที่จดลงช่อง */
export const printedValue = (grouping: string, at = Date.now()): string => `${groupKey(grouping)}${SEP}${stamp(at)}`

/** เวลาที่พิมพ์ใบนี้ให้รถคันนี้ ในรอบ Grouping นี้ — null = ยังไม่พิมพ์ (หรือพิมพ์ไว้ตอนอยู่รอบอื่น) */
export function printedAt(cells: Record<string, string> | undefined, kind: PrintKind, grouping: string): string | null {
  const v = cells?.[PRINTED_KEYS[kind]]
  if (!v) return null
  const i = v.indexOf(SEP)
  const g = i < 0 ? v : v.slice(0, i)
  return g === groupKey(grouping) ? (i < 0 ? '' : v.slice(i + SEP.length)) : null
}

/** จดว่ารถชุดนี้พิมพ์ใบ kind แล้ว — groupOf = Grouping ที่หน้านั้นแสดง (ไม่มีก็ใช้ช่องของรถ) */
export function markPrinted(rows: TrackRow[], kind: PrintKind, groupOf?: (vin: string) => string): void {
  const byGroup = new Map<string, string[]>()
  for (const r of rows) {
    const g = groupKey((groupOf?.(r.vin) || '').trim() || r.cells['Grouping  Number'])
    const list = byGroup.get(g)
    if (list) list.push(r.vin); else byGroup.set(g, [r.vin])
  }
  const at = Date.now()
  for (const [g, vins] of byGroup) useTracking.getState().bulkUpdate(vins, PRINTED_KEYS[kind], printedValue(g === NO_GROUP ? '' : g, at))
}
