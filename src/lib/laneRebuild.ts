/**
 * ยิงตามแถว (Re-location lane scan): สร้าง "ชุดคำสั่งวางรถ" ของทั้งเลนจากลำดับที่ยิง + รายการประวัติ (draft) ของรถทุกคันที่ถูกย้ายจริง
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อให้ทดสอบได้ และเพื่อให้หน้าจอ "เขียนประวัติหลังคลาวด์ตอบแล้ว" ได้ — เดิม onLaneScan เขียนประวัติ
 * การย้าย + แจ้งสำเร็จทันทีที่ยิง ก่อนเขียนคลาวด์ ถ้าเขียนไม่สำเร็จ/ถูกข้าม ประวัติก็ยังบอกว่าย้ายแล้ว (ประวัติไม่ตรงตำแหน่ง, ยิง 5 เห็น 4)
 */
import type { Unit } from '../types'
import type { TrackRow } from './excelTracking'

export interface LaneUpdate {
  vin: string; block: string; row: number; slot: number; modelName?: string; color?: string
  /** compare-and-set: ใส่เฉพาะรถที่ "ไม่ได้ยิง" (เลื่อนลงตามหลัง) — รถที่ยิงเขียนตามที่คนยืนยันเสมอ */
  from?: { block?: string; row?: number; slot?: number }
}
export interface LaneDraft { vin: string; from: string; to: string }
export interface SettledResult { vin: string; status: 'ok' | 'queued' | 'lost' }

export interface PlanLaneInput {
  /** ลำดับรถที่ยิงในเลนนี้ (คันที่ 1 อยู่หน้าสุด) */
  seq: string[]
  /** รถที่ยังอยู่ในเลนแต่ไม่ได้ยิง (ตามคลาวด์) — เลื่อนไปต่อท้ายตามลำดับเดิม */
  inc: Unit[]
  blockId: string
  slot: number
  /** ตำแหน่งปัจจุบันตามเครื่องนี้ */
  unitOf: (vin: string) => Unit | undefined
  rowOf: (vin: string) => TrackRow | undefined
  codeOf: (blockId: string, slot: number, row: number) => string
  /** รหัสตำแหน่งเต็มของรถ ('' ถ้ายังไม่มีตำแหน่ง) */
  locOf: (u: Unit | undefined) => string
}

export function planLaneUpdates(p: PlanLaneInput): { updates: LaneUpdate[]; drafts: LaneDraft[] } {
  const updates: LaneUpdate[] = []
  const drafts: LaneDraft[] = []
  p.seq.forEach((vin, i) => {
    const cu = p.unitOf(vin)
    const row = i + 1
    if (cu && cu.block === p.blockId && cu.slot === p.slot && cu.row === row) return // already right — ไม่ต้องเขียน ไม่มีการย้าย
    const tr = p.rowOf(vin)
    updates.push({
      vin, block: p.blockId, row, slot: p.slot,
      modelName: cu?.modelName || tr?.cells['Model name'] || tr?.cells['Model'] || undefined,
      color: cu?.color || tr?.cells['Color'] || undefined,
    })
    drafts.push({ vin, from: p.locOf(cu), to: p.codeOf(p.blockId, p.slot, row) })
  })
  p.inc.forEach((cu, i) => {
    const row = p.seq.length + 1 + i
    if (cu.block === p.blockId && cu.slot === p.slot && cu.row === row) return
    updates.push({
      vin: cu.vin, block: p.blockId, row, slot: p.slot, modelName: cu.modelName, color: cu.color,
      from: { block: cu.block, row: cu.row, slot: cu.slot },
    })
    // ประวัติของรถที่ถูกเลื่อนใช้ "ตำแหน่งตามเครื่องนี้" เป็นต้นทาง (เหมือนเดิม) ไม่ใช่ตำแหน่งจากคลาวด์
    drafts.push({ vin: cu.vin, from: p.locOf(p.unitOf(cu.vin)), to: p.codeOf(p.blockId, p.slot, row) })
  })
  return { updates, drafts }
}

/** ประวัติที่ควรเขียน หลังคลาวด์ตอบแล้ว: ย้ายสำเร็จ (ok) หรือบันทึกในเครื่อง/รอส่ง (queued) — ตัดคันที่ถูกเครื่องอื่นย้ายไปก่อน (lost) และคันที่ไม่มีผล */
export function recordableDrafts(drafts: LaneDraft[], results: SettledResult[]): LaneDraft[] {
  const status = new Map(results.map((r) => [r.vin, r.status] as const))
  return drafts.filter((d) => { const s = status.get(d.vin); return s === 'ok' || s === 'queued' })
}
