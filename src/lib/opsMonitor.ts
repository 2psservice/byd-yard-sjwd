/**
 * มอนิเตอร์หน้างาน (หน้า Operation) — แบบหน้าต่าง Point of Work กับ Pool & Equipment ของ SPARCS
 * อ่านจากสิ่งที่หน้างานกดบันทึกในคิวงานของสถานี (PM / PDI / FINAL CHECK / ช่าง / งานพิเศษ) อย่างเดียว
 * ไม่เพิ่มขั้นตอนให้หน้างาน:
 *   คนขับสแกนรับรถ (setDriving) → ส่งถึงสถานี (deliverToStation) → สถานีบันทึก OK/NG (recordCheck)
 *   → คนขับสแกนพากลับ (setDriving) → จอดลงช่อง (returnToSlot)
 */
import { drivingNow, isSequenceQueue, isPreGateInQueue, queueTypeOf, stageOf, type QueueItem, type QueueType, type WorkQueue } from '../store/useOps'

export type JobStatus = 'driving-in' | 'driving-back' | 'at-station' | 'checked' | 'queued' | 'done'

/** สถานะของงาน · active = กำลังอยู่ระหว่างขั้นตอน (นับค้างได้) · ลำดับ = ลำดับในตาราง */
export const JOB_STATUS_META: Record<JobStatus, { th: string; color: string; bg: string; active: boolean; order: number }> = {
  'driving-in':   { th: 'กำลังขับไปสถานี', color: '#b45309', bg: 'rgba(217,119,6,0.12)', active: true, order: 0 },
  'driving-back': { th: 'กำลังขับกลับ', color: '#b45309', bg: 'rgba(217,119,6,0.12)', active: true, order: 1 },
  'at-station':   { th: 'ถึงสถานี รอตรวจ', color: '#0369a1', bg: 'rgba(14,165,233,0.12)', active: true, order: 2 },
  checked:        { th: 'ตรวจแล้ว รอขับกลับ', color: '#15803d', bg: 'rgba(22,163,74,0.12)', active: true, order: 3 },
  queued:         { th: 'รอย้าย', color: '#64748b', bg: 'rgba(100,116,139,0.12)', active: false, order: 4 },
  done:           { th: 'เสร็จ จอดกลับแล้ว', color: '#334155', bg: 'rgba(51,65,85,0.08)', active: false, order: 5 },
}

/** ค้างนานเกินนี้ขึ้นสีแดง (แอดมินกำหนด 4 ชั่วโมง) — นับเฉพาะงานที่อยู่ระหว่างขั้นตอน ไม่นับรถที่ยังรอย้ายตามแผน */
export const STUCK_MS = 4 * 60 * 60 * 1000

/** ป้ายประเภทคิว — ใช้ร่วมกับตารางคิวงานในหน้า Operation */
export const TYPE_BADGE: Record<QueueType, { th: string; color: string; bg: string }> = {
  PM: { th: 'PM', color: '#c2680b', bg: 'rgba(194,104,11,0.12)' },
  PDI: { th: 'PDI', color: '#7c3aed', bg: 'rgba(124,58,237,0.12)' },
  FINAL: { th: 'FINAL CHECK', color: '#0891b2', bg: 'rgba(8,145,178,0.12)' },
  REPAIR: { th: 'ช่าง (ซ่อม)', color: '#c2680b', bg: 'rgba(194,104,11,0.12)' },
  WASH: { th: 'Wash', color: '#2563eb', bg: 'rgba(37,99,235,0.12)' },
  SPECIAL: { th: 'งานพิเศษ', color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
  // arrival lots never reach the Operation board (filtered out) — mapped so the record stays total
  GATEIN: { th: 'Pre Gate-in', color: '#1e40af', bg: 'rgba(37,99,235,0.12)' },
}

export function jobStatus(i: QueueItem): JobStatus {
  if (i.done) return 'done'
  const driving = !!drivingNow(i) // ขับค้างเกิน 4 ชม. ถือว่าลืมกด ไม่นับว่ากำลังขับ (กติกาเดิมของ drivingNow)
  const st = stageOf(i)
  if (st === 'checked') return driving ? 'driving-back' : 'checked'
  if (st === 'at-station') return 'at-station'
  return driving ? 'driving-in' : 'queued'
}

/** เวลาที่งานเข้าสถานะนี้ — ตั้งต้นนับ "นาน" */
export function jobSince(i: QueueItem, s: JobStatus): number {
  switch (s) {
    case 'driving-in': case 'driving-back': return i.drivingAt ?? 0
    case 'at-station': return i.deliveredAt ?? 0
    case 'checked': return i.checkedAt ?? 0
    case 'done': return i.returnedAt ?? i.doneAt ?? 0
    default: return i.addedAt ?? 0
  }
}

/** คนที่ทำขั้นนี้ */
export function jobBy(i: QueueItem, s: JobStatus): string {
  switch (s) {
    case 'driving-in': case 'driving-back': return i.drivingBy ?? ''
    case 'at-station': return i.deliveredBy ?? ''
    case 'checked': return i.checkedBy ?? ''
    case 'done': return i.returnedBy ?? i.doneBy ?? ''
    default: return ''
  }
}

export const isStuck = (s: JobStatus, since: number, now = Date.now()) =>
  JOB_STATUS_META[s].active && since > 0 && now - since > STUCK_MS

export interface MonitorJob {
  key: string
  queue: WorkQueue
  type: QueueType
  item: QueueItem
  status: JobStatus
  since: number
  by: string
  stuck: boolean
}

/** คิวของสถานีในยาร์ดนี้ (ไม่ใช่คิวส่งรถ / ล็อตรับรถ) — กติกาเดียวกับตารางคิวงานในหน้า Operation */
export const isStationQueue = (q: WorkQueue, site: string | null) =>
  !isSequenceQueue(q) && !isPreGateInQueue(q) && (!site || !q.site || q.site === site)

/**
 * งานทั้งหมดที่ต้องดู: รถที่ยังไม่เสร็จในคิวที่ยังเปิด + รถที่เสร็จวันนี้ (ทุกคิว รวมคิวที่ปิดงานไปแล้ววันนี้)
 * เรียง: กำลังทำ (ค้างนานสุดก่อน) · รอย้าย · เสร็จวันนี้ (ล่าสุดก่อน)
 */
export function monitorJobs(queues: WorkQueue[], closed: Record<string, unknown>, dayStart: number, now = Date.now()): MonitorJob[] {
  const out: MonitorJob[] = []
  for (const q of queues) {
    const type = queueTypeOf(q)
    for (const item of q.items) {
      const status = jobStatus(item)
      const since = jobSince(item, status)
      if (status === 'done' ? since < dayStart : !!closed[q.id]) continue
      out.push({ key: `${q.id}|${item.vin}`, queue: q, type, item, status, since, by: jobBy(item, status), stuck: isStuck(status, since, now) })
    }
  }
  return out.sort((a, b) => {
    const oa = JOB_STATUS_META[a.status].order, ob = JOB_STATUS_META[b.status].order
    const ga = JOB_STATUS_META[a.status].active ? 0 : oa, gb = JOB_STATUS_META[b.status].active ? 0 : ob
    if (ga !== gb) return ga - gb
    if (a.status === 'done') return b.since - a.since
    if (a.status === 'queued') return (a.queue.createdAt - b.queue.createdAt) || a.since - b.since
    return a.since - b.since // กำลังทำ: ค้างนานสุดขึ้นก่อน
  })
}

export interface StaffEvent { at: number; vin: string; type: QueueType; text: string }
export interface StaffCard {
  name: string
  /** งานที่กำลังขับอยู่ตอนนี้ */
  driving?: MonitorJob
  events: StaffEvent[]
  lastAt: number
}

/**
 * พนักงานหน้างาน: ใครทำอะไรไปแล้ววันนี้ และใครกำลังขับคันไหนอยู่
 * อ่านจากชื่อที่แต่ละขั้นบันทึกไว้ (ส่งถึงสถานี · บันทึก OK/NG · จอดกลับ) — การติ๊กเสร็จจากหน้าแอดมินไม่นับเป็นงานหน้างาน
 */
export function staffCards(queues: WorkQueue[], jobs: MonitorJob[], dayStart: number): StaffCard[] {
  const by = new Map<string, StaffCard>()
  const card = (name: string) => {
    let c = by.get(name)
    if (!c) by.set(name, (c = { name, events: [], lastAt: 0 }))
    return c
  }
  for (const q of queues) {
    const type = queueTypeOf(q)
    const st = TYPE_BADGE[type].th
    for (const i of q.items) {
      const add = (name: string | undefined, at: number | undefined, text: string) => {
        if (!name || !at || at < dayStart) return
        const c = card(name)
        c.events.push({ at, vin: i.vin, type, text })
        if (at > c.lastAt) c.lastAt = at
      }
      add(i.deliveredBy, i.deliveredAt, `ส่งเข้า ${st}${i.fromSlot ? ` จาก ${i.fromSlot}` : ''}`)
      add(i.checkedBy, i.checkedAt, `ตรวจ ${st} ${i.result ?? ''}`.trim())
      add(i.returnedBy, i.returnedAt, `จอดกลับหลัง ${st}`)
    }
  }
  for (const j of jobs) {
    if ((j.status !== 'driving-in' && j.status !== 'driving-back') || !j.by) continue
    const c = card(j.by)
    if (!c.driving || j.since > c.driving.since) c.driving = j
    if (j.since > c.lastAt) c.lastAt = j.since
  }
  for (const c of by.values()) c.events.sort((a, b) => b.at - a.at)
  return [...by.values()].sort((a, b) => Number(!!b.driving) - Number(!!a.driving) || b.lastAt - a.lastAt)
}

/** ms → "1:05 ชม." / "12 นาที" */
export function fmtElapsed(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  if (mins < 60) return `${mins} นาที`
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')} ชม.`
}
