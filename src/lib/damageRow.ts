/** A damages row from the database as the app's Damage — pure, so a script outside the browser
 *  (the nightly Unit backup) reads defects exactly the way the app does. */
import type { Damage } from '../types'
import type { DbDamage } from './database.types'

/**
 * Defect columns WITHOUT the photos — the default shape for every bulk read.
 *
 * ไม่โหลดรูปลงเครื่องล่วงหน้า: รูปแผลเป็น base64 ใบละ 100-200 KB ยาร์ดที่มีรถติด NG
 * หลายร้อยคันคือหลายสิบถึงร้อย MB ต่อเครื่องต่อการเข้ายาร์ด บนมือถือ RAM 2-3 GB
 * นี่คือสิ่งที่ทำให้กล้องดับ/แท็บถูกฆ่า รูปจะถูกดึง "เฉพาะคันที่คนกดเปิดดู"
 * (useYard.loadPhotosFor) · คอลัมน์ remark/area_th/item_th อาจยังไม่ถูก migrate
 * บนบางฐาน จึงมีชุดสำรองที่ไม่มีคอลัมน์เหล่านั้น
 */
export const DAMAGE_LIGHT_COLS = 'id, vin, area, type, severity, note, remark, area_th, item_th, recorded_at, recorded_by, source, station, item, category_ng, category_repair, incharge, status_repair, repair_date, repaired_by, repair_history'
export const DAMAGE_LIGHT_COLS_BASIC = 'id, vin, area, type, severity, note, recorded_at, recorded_by, source, station, item, category_ng, category_repair, incharge, status_repair, repair_date, repaired_by, repair_history'

export function rowToDamage(r: DbDamage): Damage {
  return {
    id:             r.id,
    area:           r.area           ?? '',
    type:           r.type           ?? '',
    severity:       (r.severity      as Damage['severity']) ?? 'minor',
    note:           r.note           ?? undefined,
    remark:         r.remark         ?? undefined,
    areaTh:         r.area_th         ?? undefined,
    itemTh:         r.item_th         ?? undefined,
    photo:          r.photo_url      ?? r.photo_urls?.[0] ?? undefined,
    photos:         r.photo_urls     ?? undefined,
    at:             r.recorded_at    ? new Date(r.recorded_at).getTime() : 0,
    by:             r.recorded_by    ?? '',
    source:         r.source         as Damage['source'],
    station:        r.station        ?? undefined,
    item:           r.item           ?? undefined,
    categoryNG:     r.category_ng    as Damage['categoryNG']    ?? undefined,
    categoryRepair: r.category_repair as Damage['categoryRepair'] ?? undefined,
    incharge:       r.incharge       as Damage['incharge']      ?? undefined,
    statusRepair:   r.status_repair  as Damage['statusRepair']  ?? undefined,
    repairDate:     r.repair_date    ? new Date(r.repair_date).getTime() : undefined,
    repairedBy:     r.repaired_by    ?? undefined,
    repairHistory:  (r.repair_history as Damage['repairHistory']) ?? undefined,
  }
}
