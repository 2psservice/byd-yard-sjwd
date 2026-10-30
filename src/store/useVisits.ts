/**
 * แถวรอบที่ปิดแล้ว (visits) — ดู lib/visits.ts
 *
 * เก็บใน IndexedDB (เปิดแอปแล้วเห็นทันที) + ตาราง visits ในคลาวด์ (ทุกเครื่อง
 * เห็นตรงกัน) ถ้าตารางยังไม่ถูกสร้าง (supabase-visits.sql) แอปยังทำงานได้ แต่แถว
 * รอบจะเห็นเฉพาะบนเครื่องที่สร้าง — cloudMissing บอกหน้าจอให้เตือน
 */
import { create } from 'zustand'
import type { Site } from '../types'
import type { TrackRow, RowEvent } from '../lib/excelTracking'
import { idbGetAllVisits, idbPutVisits, idbDeleteVisits } from '../lib/idb'
import * as db from '../lib/db'
import { onSync, sendSync } from '../lib/syncBus'
import { useYard } from './useYard'
import { missingVisitsOf, type Visit } from '../lib/visits'

const MAX_HISTORY = 100

interface VisitsState {
  visits: Record<string, Visit>
  loaded: boolean
  /** ตาราง visits ในคลาวด์ยังไม่มี / เขียนไม่ได้ — รอบที่ปิดเห็นเฉพาะเครื่องนี้ */
  cloudMissing: boolean
  /** โหลดจากเครื่อง แล้วดึงจากคลาวด์ทับ (ใหม่กว่าชนะ) */
  load: () => Promise<void>
  /** รับแถวรอบใหม่ (จากการปิดรอบ / ตัวแปลง) — ใหม่กว่าชนะ, push ขึ้นคลาวด์ */
  add: (visits: Visit[]) => void
  /** แอดมินของยาร์ดต้นทางแก้ช่องของรอบ */
  bulkUpdate: (ids: string[], key: string, value: string) => void
  /** แปลงย้อนหลัง: ทุกรอบที่ปิดใน __trips ของแถวสดที่ยังไม่มีแถวรอบ → สร้าง (ทำซ้ำได้) */
  migrateFromTrips: (rows: TrackRow[], sites: Site[]) => number
  /** ลบแถวรอบ (แอดมินยืนยันว่ารถไม่เคยอยู่ยาร์ดนั้น — ดู useTracking.reassignToYard) */
  remove: (ids: string[]) => void
}

/** VIN ที่ push ขึ้นคลาวด์ไม่สำเร็จ — ลองใหม่ตอนโหลดครั้งถัดไป */
const pending = new Set<string>()
/** ส่วนหนึ่งของ pending: แถวรอบที่เครื่องนี้สร้าง (ไม่ใช่การแก้) — ลองใหม่แบบเพิ่มเฉพาะที่คลาวด์ยังไม่มี */
const pendingNew = new Set<string>()

/** ดึงแถวรอบแบบส่วนต่าง (ดู load) — ทั้งตารางรอบแรกหลังเปิดแอป และทุกเท่านี้ · ทับซ้อนเผื่อนาฬิกาเครื่องที่เขียน updated_at คลาด */
export const VISITS_FULL_EVERY_MS = 30 * 60_000
export const VISITS_DELTA_OVERLAP_MS = 10 * 60_000
const visitsPull = { lastFull: 0, lastPull: 0 }

type Set_ = (p: Partial<VisitsState>) => void
type Get_ = () => VisitsState

/** การแก้ของแอดมิน (bulkUpdate) — เขียนทับแถวในคลาวด์ */
async function push(visits: Visit[], set: Set_): Promise<void> {
  if (!visits.length) return
  const ok = await db.upsertVisits(visits)
  if (ok) {
    for (const v of visits) pending.delete(v.id)
    set({ cloudMissing: false })
    sendSync('visits')
  } else {
    for (const v of visits) pending.add(v.id)
    set({ cloudMissing: true })
  }
}

/**
 * แถวรอบที่เครื่องนี้สร้าง — เพิ่มเฉพาะที่คลาวด์ยังไม่มี · id ที่คลาวด์มีแล้ว = รับฉบับคลาวด์มาแทนฉบับในเครื่อง
 * (ไม่งั้นฉบับในเครื่องที่ updatedAt ใหม่กว่าจะค้าง แล้วการแก้ครั้งถัดไปส่งขึ้นไปทับ)
 */
async function pushNew(visits: Visit[], set: Set_, get: Get_): Promise<void> {
  if (!visits.length) return
  const inserted = await db.insertVisitsIfAbsent(visits)
  if (!inserted) {
    for (const v of visits) { pending.add(v.id); pendingNew.add(v.id) }
    set({ cloudMissing: true })
    return
  }
  for (const v of visits) { pending.delete(v.id); pendingNew.delete(v.id) }
  set({ cloudMissing: false })
  if (inserted.size) sendSync('visits')
  const skipped = visits.filter((v) => !inserted.has(v.id)).map((v) => v.id)
  if (!skipped.length) return
  const cloud: Visit[] = []
  for (let i = 0; i < skipped.length; i += 200) {
    const got = await db.fetchVisits({ ids: skipped.slice(i, i + 200) })
    if (!got) return // offline — การดึงทั้งตารางรอบถัดไปไม่ได้แก้ให้ (ฉบับในเครื่องใหม่กว่า) แต่ไม่มีอะไรถูกส่งทับ
    cloud.push(...got)
  }
  if (!cloud.length) return
  const merged = { ...get().visits }
  for (const v of cloud) merged[v.id] = v
  set({ visits: merged })
  idbPutVisits(cloud).catch(() => {})
}

export const useVisits = create<VisitsState>()((set, get) => ({
  visits: {},
  loaded: false,
  cloudMissing: false,

  load: async () => {
    let local: Visit[] = []
    try { local = await idbGetAllVisits() } catch { /* fresh device */ }
    const visits: Record<string, Visit> = { ...get().visits }
    for (const v of local) if (!visits[v.id] || (visits[v.id].updatedAt ?? 0) < (v.updatedAt ?? 0)) visits[v.id] = v
    set({ visits, loaded: true })
    // ส่วนต่าง: สัญญาณ 'visits' (ทุก gate-out/ย้ายยาร์ด) เคยดึงทั้งตาราง (~1 MB) ทุกเครื่อง — ตอนนี้ดึงเฉพาะแถวที่แก้หลังรอบก่อน
    // + แถวที่เครื่องนี้ยังไม่มี (รายการ id เบา ๆ ใช้หาแถวที่ถูกลบด้วย) · ทั้งตารางรอบแรกและทุก VISITS_FULL_EVERY_MS
    const startedAt = Date.now()
    let cloud: Visit[] | null
    let cloudIds: Set<string>
    if (visitsPull.lastFull && startedAt - visitsPull.lastFull < VISITS_FULL_EVERY_MS) {
      const sinceIso = new Date(visitsPull.lastPull - VISITS_DELTA_OVERLAP_MS).toISOString()
      const [changed, ids] = await Promise.all([db.fetchVisits({ sinceIso }), db.fetchVisitIds()])
      if (!changed || !ids) return // offline — keep local copy, try again next signal
      const have = get().visits
      const got = new Set(changed.map((v) => v.id))
      const unseen = ids.filter((id) => !have[id] && !got.has(id))
      const extra = unseen.length ? await db.fetchVisits({ ids: unseen }) : []
      if (!extra) return
      cloud = [...changed, ...extra]
      cloudIds = new Set(ids)
    } else {
      cloud = await db.fetchVisits()
      if (!cloud) { if (db.isConfigured()) set({ cloudMissing: true }); return }
      cloudIds = new Set(cloud.map((v) => v.id))
      visitsPull.lastFull = startedAt
    }
    visitsPull.lastPull = startedAt
    const merged = { ...get().visits }
    const fresher: Visit[] = []
    for (const v of cloud) {
      const cur = merged[v.id]
      if (!cur || (cur.updatedAt ?? 0) < (v.updatedAt ?? 0)) { merged[v.id] = v; fresher.push(v) }
    }
    // คลาวด์เป็นตัวตัดสินว่าแถวรอบไหน "ยังมีอยู่": แถวที่เครื่องนี้มีแต่คลาวด์ไม่มี
    // และไม่ได้เป็นของที่เครื่องนี้เพิ่งสร้างแล้วส่งไม่สำเร็จ (pending) = ถูกลบจาก
    // เครื่องอื่น (แอดมินยืนยันว่ารถไม่เคยอยู่ยาร์ดนั้น) → ทิ้งตาม ห้ามส่งกลับขึ้นไป
    // ไม่งั้นเครื่องที่ยังถือสำเนาเก่าจะปลุกแถวที่ลบไปแล้วขึ้นมาใหม่ · ของที่เพิ่งสร้าง
    // ตอนออฟไลน์แล้วเปิดแอปใหม่ (pending หาย) ตัวแปลงย้อนหลังสร้างให้ใหม่จาก
    // ก้อน __trips ที่ยังอยู่ในแถวสด จึงไม่หาย
    const dropped: string[] = []
    for (const id of Object.keys(merged)) if (!cloudIds.has(id) && !pending.has(id)) { delete merged[id]; dropped.push(id) }
    set({ visits: merged, cloudMissing: false })
    if (fresher.length) idbPutVisits(fresher).catch(() => {})
    if (dropped.length) idbDeleteVisits(dropped).catch(() => {})
    const retry = Object.values(merged).filter((v) => pending.has(v.id))
    if (retry.length) {
      void pushNew(retry.filter((v) => pendingNew.has(v.id)), set, get)
      void push(retry.filter((v) => !pendingNew.has(v.id)), set)
    }
  },

  add: (incoming) => {
    if (!incoming.length) return
    const visits = { ...get().visits }
    const changed: Visit[] = []
    for (const v of incoming) {
      // รอบหนึ่งปิดได้ครั้งเดียว: แถวรอบที่มีอยู่แล้วคือบันทึกจริงของครั้งที่รถออก
      // ห้ามถูกทับด้วยการ "ปิดรอบซ้ำ" — เกิดเมื่อสำเนาเก่าของแถวสด (ที่ยังไม่รู้ว่ารถ
      // ออกไปแล้ว) ถูกเครื่องอื่นส่งกลับขึ้นคลาวด์ แล้วปลายทางต้องยิงรับซ้ำเพื่อแก้
      // การยิงซ้ำนั้นปิดรอบเดิมอีกรอบด้วยวันออก "วันนี้" ซึ่งผิด วันออกจริงอยู่ในแถว
      // รอบที่มีอยู่แล้ว (ตัวแปลงย้อนหลังก็ผ่านทางนี้ และเช็คซ้ำก่อนอยู่แล้ว)
      if (visits[v.id]) continue
      visits[v.id] = v; changed.push(v)
    }
    if (!changed.length) return
    set({ visits })
    idbPutVisits(changed).catch(() => {})
    void pushNew(changed, set, get)
  },

  bulkUpdate: (ids, key, value) => {
    const by = useYard.getState().currentUser
    const now = Date.now()
    const visits = { ...get().visits }
    const changed: Visit[] = []
    for (const id of ids) {
      const v = visits[id]
      if (!v) continue
      const from = v.cells[key] ?? ''
      if (from === value) continue
      const entry: RowEvent = { at: now, by, field: key, from, to: value }
      const next: Visit = { ...v, cells: { ...v.cells, [key]: value }, history: [...(v.history ?? []), entry].slice(-MAX_HISTORY), updatedAt: now }
      visits[id] = next; changed.push(next)
    }
    if (!changed.length) return
    set({ visits })
    idbPutVisits(changed).catch(() => {})
    // แถวที่ยังส่งขึ้นไม่สำเร็จตั้งแต่ตอนสร้าง → ยังต้องเพิ่มแบบไม่ทับ (ถ้าคลาวด์มีแล้ว ฉบับคลาวด์ชนะ)
    void pushNew(changed.filter((v) => pendingNew.has(v.id)), set, get)
    void push(changed.filter((v) => !pendingNew.has(v.id)), set)
  },

  remove: (ids) => {
    const visits = { ...get().visits }
    const gone = ids.filter((id) => !!visits[id])
    if (!gone.length) return
    for (const id of gone) delete visits[id]
    set({ visits })
    idbDeleteVisits(gone).catch(() => {})
    db.deleteVisits(gone).then((ok) => { if (ok) sendSync('visits') }).catch(() => {})
  },

  migrateFromTrips: (rows, sites) => {
    const have = (id: string) => !!get().visits[id]
    const created: Visit[] = []
    for (const r of rows) for (const v of missingVisitsOf(r, have, sites)) created.push(v)
    if (created.length) get().add(created)
    return created.length
  },
}))

// เครื่องอื่นปิดรอบ/แก้แถวรอบ → ดึงจากคลาวด์มาทับ
onSync('visits', () => { useVisits.getState().load().catch((e) => console.error('[visits] sync pull', e)) })

if (import.meta.env.DEV) (window as any).__visits = useVisits
