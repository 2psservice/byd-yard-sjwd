/**
 * Final Status / Vin Of Status "ตามความจริงหน้างาน" — คำนวณตอนอ่าน ไม่เขียนลงแถว
 *
 * ไฟล์ Co บอกสถานะตามที่ BYD รู้ ณ วันที่ออกไฟล์ แต่คนที่ยืนอยู่หน้ารถรู้ดีกว่า:
 * รถที่มี Defect ตัวถังค้างอยู่ (ประตูบุบ · สีแตก …) คือรถติด NG ไม่ว่าไฟล์จะว่า
 * OK-Accept ก็ตาม และจะเป็น OK-Repaired / OK-Accept ได้ก็ต่อเมื่อ Defect ปิดครบ
 * รถที่ยังไม่เคยทำ PDI ก็ยังรอ PDI อยู่ ไม่ว่าไฟล์จะว่าอะไร
 *
 * กติกา (เฉพาะรถที่ยังอยู่ในลาน — Pre Gate-in / ออกแล้ว / Total loss แสดงตามช่องเดิม):
 *   Vin Of Status
 *     ยังไม่เคยทำ PDI (ไม่มีวันที่ PDI / RE-PDI ทั้งจากสถานีและจากไฟล์) → Waiting PDI
 *       แม้เดินตรวจเจอ Defect ไปแล้วก็ยัง Waiting PDI — ส่วน Final Status ว่าไปตามแผล
 *     PDI แล้ว + Defect ตัวถังค้าง → NG (ช่องที่เป็น NG แบบอื่นอยู่แล้ว เช่น NG(Allocated) คงไว้)
 *     PDI แล้ว + Defect ปิดครบ    → NG ทุกแบบหรือว่าง → FIS Waiting Allocation ค่าอื่นที่
 *                                    ไปไกลกว่านั้นแล้วคงไว้
 *     PDI แล้ว ไม่มี Defect       → ตามช่องเดิม
 *   Final Status
 *     Defect ตัวถังค้าง   → Waiting Repair
 *     Defect ปิดครบ       → ช่องเป็น OK-* อยู่แล้วคงไว้ ไม่งั้น OK-Accept เมื่อมีรับสภาพ (ACC)
 *                           / OK-Repaired เมื่อซ่อมทั้งหมด
 *     ไม่มี Defect        → ยังไม่ PDI → Waiting (รอ PDI) ไม่ว่าช่องจะว่าอะไร · PDI แล้ว → ตามช่องเดิม
 *   ของหาย/ของไม่ครบ (Control Stock Sheet / Additional Accessories) ไม่ใช่ Defect
 *   ตัวถัง ไม่ทำให้สองช่องนี้เปลี่ยน (ดู isBodyDefect)
 *
 * ทำไมไม่เขียนลงแถว: การเขียนทั้งแถวจากหลายเครื่องพร้อมกัน (#518) ทำให้สำเนาเก่า
 * ทับข้อมูลจริงจนรถสลับยาร์ด ค่าที่คำนวณตอนอ่านไม่มีทางทำแบบนั้น และเปลี่ยนทันที
 * ที่มีคนบันทึก/ปิด Defect หรือสถานี PDI บันทึก โดยไม่ต้องรอใครเขียน
 */
import type { Damage } from '../types'
import type { TrackRow } from './excelTracking'
import { deriveCarStatus } from './carStatus'
import { PDI_KEYS } from './trackingColumns'
import { isBodyDefect, isOpenDefect, canonRepairStatus } from './damageLabel'

export const FINAL_STATUS_KEY = 'Final Status'
export const VIN_OF_STATUS_KEY = 'Vin Of Status'
export const OK_FINAL_STATUSES = new Set(['ok-repaired', 'ok-accept'])
export const NG_VIN_STATUSES = new Set(['ng', 'ng(allocated)', 'heavy ng', 'heavy ng(allocated)', 'heavy ng(accident)'])
/** ขั้นที่รถอยู่ในลานและอยู่ในกระบวนการตรวจ — Pre Gate-in / ออกแล้ว / Total loss ไม่เกี่ยว */
const LIVE_STAGES = new Set(['In Yard', 'Moving', 'PDI', 'Ready'])
/** แผลที่ปิดโดย "รับสภาพ" (ACC BYD / ACC SJWD / ACC REVER / Accept…) ไม่ใช่ซ่อม */
const isAcceptedDefect = (d: Damage) => !isOpenDefect(d) && canonRepairStatus(d.statusRepair) !== 'Repaired'

export function effectiveInspection(cells: Record<string, string>, damages: Damage[] | undefined): { final: string; vos: string } {
  const final = (cells[FINAL_STATUS_KEY] ?? '').trim()
  const vos = (cells[VIN_OF_STATUS_KEY] ?? '').trim()
  if (!LIVE_STAGES.has(deriveCarStatus(cells))) return { final, vos }
  const pdiDone = PDI_KEYS.some((k) => (cells[k] ?? '').trim() !== '')
  const body = (damages ?? []).filter(isBodyDefect)
  const open = body.some(isOpenDefect)
  const outFinal = open
    ? 'Waiting Repair'
    : body.length
      ? OK_FINAL_STATUSES.has(final.toLowerCase()) ? final : body.some(isAcceptedDefect) ? 'OK-Accept' : 'OK-Repaired'
      : !pdiDone ? 'Waiting' : final
  const outVos = !pdiDone
    ? 'Waiting PDI'
    : open
      ? NG_VIN_STATUSES.has(vos.toLowerCase()) ? vos : 'NG'
      : body.length
        ? vos === '' || NG_VIN_STATUSES.has(vos.toLowerCase()) ? 'FIS Waiting Allocation' : vos
        : vos
  return { final: outFinal, vos: outVos }
}

// แถวเดิม + แผลชุดเดิม → คืนผลเดิม (identity คงที่ ให้ memo ปลายทางไม่ทำงานซ้ำ)
const cache = new WeakMap<TrackRow, { damages: Damage[] | undefined; out: TrackRow }>()

/** แถวสำหรับแสดงผล: ช่อง Final Status / Vin Of Status เป็นค่าตามความจริงหน้างาน
 *  คืนแถวเดิม (object เดิม) เมื่อไม่ต้องเปลี่ยนอะไร */
export function overlayInspection(row: TrackRow, unit: { damages: Damage[] } | undefined): TrackRow {
  const damages = unit?.damages
  const hit = cache.get(row)
  if (hit && hit.damages === damages) return hit.out
  const { final, vos } = effectiveInspection(row.cells, damages)
  const curFinal = (row.cells[FINAL_STATUS_KEY] ?? '').trim()
  const curVos = (row.cells[VIN_OF_STATUS_KEY] ?? '').trim()
  const out = final === curFinal && vos === curVos
    ? row
    : { ...row, cells: { ...row.cells, [FINAL_STATUS_KEY]: final, [VIN_OF_STATUS_KEY]: vos } }
  cache.set(row, { damages, out })
  return out
}
