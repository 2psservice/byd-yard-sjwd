/** A defect's repair status and whether it is a body defect at all. Pure on purpose: no store and no
 *  cloud client behind it, so the nightly Unit backup (scripts/daily-unit-csv.ts) can share it. */
import { FINAL_CHECK_TABS } from './finalCheckList'
import type { Damage } from '../types'

/** The repair-status options offered on every Defect picker (admin + ops-scan).
 *  One source of truth — the ladder used to be duplicated per page. */
export const REPAIR_STATUSES = ['Waiting Repair', 'ACC BYD', 'ACC SJWD', 'ACC REVER', 'Repaired'] as const

/** Older spellings → the current option, so a record saved before the list was
 *  reworked shows as its modern equivalent instead of an unknown extra choice.
 *  Only unambiguous renames are mapped; anything else is displayed verbatim. */
const LEGACY_STATUS: Record<string, string> = {
  'acc byd': 'ACC BYD',
  'ok repaired': 'Repaired',
}

/** Normalise a stored status to a current option where possible ('Acc byd' →
 *  'ACC BYD', 'OK-Repaired' → 'Repaired'); unknown values pass through. */
export function canonRepairStatus(raw?: string): string {
  const v = (raw ?? '').trim()
  if (!v) return 'Waiting Repair'
  const key = v.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
  const exact = REPAIR_STATUSES.find((s) => s.toLowerCase() === key)
  return exact ?? LEGACY_STATUS[key] ?? v
}

/** A defect still waiting for repair (blank status counts as waiting). */
export const isOpenDefect = (d: Damage) => !d.statusRepair || canonRepairStatus(d.statusRepair) === 'Waiting Repair'

/**
 * รายการ NG จาก Control Stock Sheet / Additional Accessories (ของหาย · ของไม่ครบ)
 * — เก็บเป็นรายการเดียวกับ Defect เพื่อให้ขึ้นใน Event และใบตรวจของรถ แต่ "ไม่ใช่
 * รอยบนตัวรถ" รถที่มีแค่ของไม่ครบไม่ถือว่าติด NG: การ์ด Damage · สถานะ NG ·
 * การปลด NG ต้องดูเฉพาะ Defect ตัวถัง (ประตูบุบ · สีถลอก …) แยกส่วนกัน
 * รู้จากต้นทาง: อัปโหลดไฟล์ accessory หรือรายการที่หน้าเช็คลิสต์เขียน
 * (item = "<ชื่อแท็บ> · <กลุ่ม>")
 */
const NON_BODY_TABS = FINAL_CHECK_TABS.filter((t) => t.key === 'stock' || t.key === 'accessories').map((t) => `${t.label} · `)
export const isStockOrAccessoryItem = (d: Pick<Damage, 'source' | 'item'>): boolean =>
  d.source === 'accessoryImport' || NON_BODY_TABS.some((prefix) => (d.item ?? '').startsWith(prefix))
/** Defect ตัวถังจริง (ไม่ใช่ของหาย/ของไม่ครบ) */
export const isBodyDefect = (d: Damage): boolean => !isStockOrAccessoryItem(d)
/** รถคันนี้ "ติด NG" ไหม = มี Defect ตัวถังที่ยังไม่ปิด */
export const hasOpenBodyDefect = (damages: Damage[] | undefined): boolean =>
  !!damages && damages.some((d) => isBodyDefect(d) && isOpenDefect(d))

/** Unrepaired defects always FIRST — resolved ones sink below. Stable, so the
 *  original order (usually record time) is kept within each group. */
export const openDefectsFirst = <T extends Damage>(list: T[]): T[] =>
  [...list].sort((a, b) => Number(isOpenDefect(b)) - Number(isOpenDefect(a)))
