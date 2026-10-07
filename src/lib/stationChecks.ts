/**
 * ช่องที่ "ใช้ร่วมกันต่อคัน" ข้ามยาร์ด — ผลตรวจ PDI/PM/FINAL และค่าวัด
 *
 * แยกข้อมูลรายยาร์ด ขั้นที่ 1 (docs/site-separation-design.md §3.4): ช่องเหล่านี้เป็นของ
 * "รถ" ไม่ใช่ของ "ยาร์ด" แต่ตอนนี้ยังอยู่ในแถวชีต (tracking_rows.cells) ซึ่งขั้นที่ 3 จะแยก
 * เป็นแถวต่อยาร์ด ตาราง station_checks (vin, key) เก็บค่าล่าสุดให้ทุกยาร์ดเห็นตรงกัน
 *
 * ขั้นนี้แอป "เขียนสองทาง": ทุกแถวที่ถูกส่งขึ้นคลาวด์ (pushRows — ทางเดียวที่ทุกการแก้/
 * นำเข้าไฟล์ผ่าน) จะถูกเทียบกับค่าที่เครื่องนี้รู้ครั้งก่อน แล้วส่งเฉพาะช่องร่วมที่เปลี่ยน
 * ไปตารางด้วย การอ่านยังมาจากชีตเหมือนเดิม — เครื่องมือตรวจใน Settings ใช้ดูว่าตารางตรงกับ
 * ชีตแล้วก่อนสลับการอ่านในขั้นถัดไป
 */
import { PDI_KEYS, PM_KEYS } from './trackingColumns'
import type { TrackRow, RowEvent } from './excelTracking'

/** ช่องร่วมต่อคัน — ต้องตรงกับรายการใน supabase-station-checks.sql (backfill) */
export const SHARED_VIN_KEYS: readonly string[] = [
  'Status', 'Vin Of Status', 'Final Status', 'Final check date', 'OK date', 'PIC (PDI)',
  '% SOC', 'Tire Pressure', 'Aging PM',
  'Tire Pressure FL', 'Tire Pressure FR', 'Tire Pressure RL', 'Tire Pressure RR',
  'Mileage', 'Voltage of 12V',
  ...PDI_KEYS, ...PM_KEYS,
]
const SHARED = new Set(SHARED_VIN_KEYS)
export const isSharedVinKey = (key: string): boolean => SHARED.has(key)

export interface StationCheck {
  vin: string
  key: string
  value: string
  at?: number
  by?: string
  src?: string
  site?: string
}

/** ค่าช่องร่วมของแถว (เฉพาะที่มีค่า) — ใช้เป็น "ลายเซ็น" เทียบว่าอะไรเปลี่ยน */
export function sharedCellsOf(row: TrackRow): Record<string, string> {
  const out: Record<string, string> = {}
  const cells = row.cells ?? {}
  for (const k of SHARED_VIN_KEYS) {
    const v = (cells[k] ?? '').trim()
    if (v) out[k] = v
  }
  return out
}

/** บรรทัดประวัติล่าสุดของช่องนั้น — บอกว่าใคร/เมื่อไร/จากสถานีหรือแอดมิน */
function lastEvent(row: TrackRow, key: string): RowEvent | undefined {
  const h = row.history
  if (!h?.length) return undefined
  for (let i = h.length - 1; i >= 0; i--) if (h[i].field === key) return h[i]
  return undefined
}

/**
 * ช่องร่วมที่เปลี่ยนไปจากครั้งก่อน (prev = ลายเซ็นที่เครื่องนี้รู้ · ไม่มี = ถือว่าทุกช่องที่มีค่า
 * เป็นของใหม่) · ช่องที่ถูกล้างเป็นว่างส่งเป็น value '' เพื่อให้ตารางตามชีต
 */
export function sharedDelta(prev: Record<string, string> | undefined, row: TrackRow, fallbackBy: string, site?: string): StationCheck[] {
  const now = sharedCellsOf(row)
  const out: StationCheck[] = []
  const keys = new Set<string>([...Object.keys(now), ...Object.keys(prev ?? {})])
  for (const key of keys) {
    const v = now[key] ?? ''
    if (prev && (prev[key] ?? '') === v) continue
    if (!prev && !v) continue
    const ev = lastEvent(row, key)
    out.push({ vin: row.vin, key, value: v, at: ev?.at ?? row.updatedAt ?? Date.now(), by: ev?.by ?? fallbackBy,
      src: ev?.src === 'scan' ? 'scan' : ev ? 'admin' : 'import', site: row.site ?? site })
  }
  return out
}

/** ผลตรวจความตรงกัน ชีต vs ตาราง (เครื่องมือใน Settings) */
export interface StationChecksAudit {
  rows: number          // แถวชีตของยาร์ดที่ตรวจ
  sheetCells: number    // ช่องร่วมที่มีค่าในชีต
  equal: number
  missingInTable: number
  differ: number
  onlyInTable: number
  samples: { vin: string; key: string; sheet: string; table: string }[]
}

export function auditStationChecks(rows: TrackRow[], table: StationCheck[]): StationChecksAudit {
  const byVin = new Map<string, Map<string, string>>()
  for (const t of table) {
    let m = byVin.get(t.vin); if (!m) { m = new Map(); byVin.set(t.vin, m) }
    m.set(t.key, (t.value ?? '').trim())
  }
  const a: StationChecksAudit = { rows: rows.length, sheetCells: 0, equal: 0, missingInTable: 0, differ: 0, onlyInTable: 0, samples: [] }
  const push = (s: StationChecksAudit['samples'][number]) => { if (a.samples.length < 30) a.samples.push(s) }
  for (const r of rows) {
    const sheet = sharedCellsOf(r)
    const tbl = byVin.get(r.vin) ?? new Map<string, string>()
    for (const [key, v] of Object.entries(sheet)) {
      a.sheetCells++
      if (!tbl.has(key) || !tbl.get(key)) { a.missingInTable++; push({ vin: r.vin, key, sheet: v, table: '' }); continue }
      if (tbl.get(key) === v) a.equal++
      else { a.differ++; push({ vin: r.vin, key, sheet: v, table: tbl.get(key)! }) }
    }
    for (const [key, v] of tbl) if (v && !sheet[key]) { a.onlyInTable++; push({ vin: r.vin, key, sheet: '', table: v }) }
  }
  return a
}
