/**
 * รวมแถวของเครื่องกับฉบับคลาวด์ก่อนส่ง — การส่งแถวเป็นการเขียน "ทั้งแถว" (cells + history)
 * เครื่องที่ถือแถวเก่าจึงลบทุกอย่างที่คนอื่นเขียนหลังจากนั้น:
 * 14 พ.ย. 20:29 เครื่องที่ข้อมูลเก่า 33 ชม. ยิง Gate-out …039603 ก่อนซิงก์เสร็จ → เลข Grouping / Dealer /
 * DN Printed ที่ใส่ตอน 12:49–13:24 หายพร้อมบรรทัดประวัติ (DN 7 คัน จอ Gate-out ขึ้น 6) · 16 พ.ย. 60 RAI ซ้ำ 12 คัน
 *
 * กติกา: ประวัติ = รวมสองฝั่ง · ช่องที่คลาวด์มีบรรทัดประวัติที่เครื่องนี้ไม่รู้ และใหม่กว่าบรรทัดล่าสุด
 * ของช่องนั้นในเครื่อง → ใช้ค่าคลาวด์ · นอกนั้นใช้ค่าของเครื่อง (การแก้ของเครื่องนี้)
 */
import type { RowEvent, TrackRow } from './excelTracking'

const idOf = (e: RowEvent) => `${e.at}|${e.field}|${e.to}|${e.by}`

/**
 * @param keyOf ชื่อในบรรทัดประวัติ (label ของคอลัมน์ หรือ key) → key ของช่อง
 * @param maxHistory เก็บประวัติล่าสุดกี่บรรทัด (เท่ากับที่แอปเก็บ)
 * คืนแถวเดิม (อ้างอิงเดิม) ถ้าคลาวด์ไม่มีอะไรที่เครื่องนี้ไม่รู้
 */
export function mergeWithCloud(
  local: TrackRow,
  cloud: TrackRow | undefined,
  keyOf: (field: string) => string,
  maxHistory = 100,
): TrackRow {
  if (!cloud || cloud.deletedAt || cloud.vin !== local.vin) return local
  const localHist = local.history ?? []
  const known = new Set(localHist.map(idOf))
  const unknown = (cloud.history ?? []).filter((e) => !known.has(idOf(e)))
  if (!unknown.length) return local

  // บรรทัดล่าสุดของแต่ละช่องในเครื่อง
  const localLast = new Map<string, number>()
  for (const e of localHist) {
    const k = keyOf(e.field)
    if ((localLast.get(k) ?? -Infinity) < e.at) localLast.set(k, e.at)
  }
  // ช่องที่คลาวด์ใหม่กว่า → ค่าคลาวด์
  const cells = { ...local.cells }
  const taken = new Set<string>()
  for (const e of unknown) {
    const k = keyOf(e.field)
    if (taken.has(k)) continue
    if (e.at > (localLast.get(k) ?? -Infinity)) {
      taken.add(k)
      const v = cloud.cells?.[k]
      if (v !== undefined) cells[k] = v
      else if (e.to === '') delete cells[k] // คลาวด์ล้างช่องนี้จริง · ชื่อในประวัติที่ไม่ใช่ช่อง (เช่น Location) ไม่แตะ
    }
  }
  const history = [...localHist, ...unknown].sort((a, b) => a.at - b.at).slice(-maxHistory)
  // ต้องใหม่กว่าฉบับคลาวด์ ไม่งั้นเครื่องอื่นที่มีฉบับคลาวด์อยู่แล้วจะไม่รับฉบับรวม
  const updatedAt = Math.max(local.updatedAt ?? 0, (cloud.updatedAt ?? 0) + 1)
  return { ...local, cells, history, updatedAt }
}
