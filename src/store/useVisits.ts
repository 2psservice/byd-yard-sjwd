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

async function push(visits: Visit[], set: (p: Partial<VisitsState>) => void): Promise<void> {
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
    const cloud = await db.fetchVisits()
    if (!cloud) { if (db.isConfigured()) set({ cloudMissing: true }); return }
    const merged = { ...get().visits }
    const fresher: Visit[] = []
    for (const v of cloud) {
      const cur = merged[v.id]
      if (!cur || (cur.updatedAt ?? 0) < (v.updatedAt ?? 0)) { merged[v.id] = v; fresher.push(v) }
    }
    set({ visits: merged, cloudMissing: false })
    if (fresher.length) idbPutVisits(fresher).catch(() => {})
    // แถวที่เครื่องนี้มีแต่คลาวด์ยังไม่มี (สร้างตอนออฟไลน์ / ตอนตารางยังไม่ถูกสร้าง)
    const cloudIds = new Set(cloud.map((v) => v.id))
    const retry = Object.values(merged).filter((v) => !cloudIds.has(v.id) || pending.has(v.id))
    if (retry.length) void push(retry, set)
  },

  add: (incoming) => {
    if (!incoming.length) return
    const visits = { ...get().visits }
    const changed: Visit[] = []
    for (const v of incoming) {
      const cur = visits[v.id]
      if (cur && (cur.updatedAt ?? 0) >= (v.updatedAt ?? 0)) continue
      visits[v.id] = v; changed.push(v)
    }
    if (!changed.length) return
    set({ visits })
    idbPutVisits(changed).catch(() => {})
    void push(changed, set)
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
    void push(changed, set)
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
