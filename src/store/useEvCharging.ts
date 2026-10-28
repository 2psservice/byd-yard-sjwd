/**
 * รอบชาร์จแบต EV — ดู lib/evCharging.ts
 *
 * แหล่งจริงคือตาราง ev_charges ในคลาวด์ (ทุกเครื่องเห็นตรงกัน) · รอบที่บันทึกขึ้น
 * คลาวด์ไม่สำเร็จ (ยังไม่ได้รัน supabase-ev-charging.sql / เน็ตหลุด) เก็บไว้ในเครื่อง
 * แล้วส่งใหม่ตอนโหลดครั้งถัดไป — พนักงานไม่ต้องถ่ายรูปซ้ำ
 */
import { create } from 'zustand'
import * as db from '../lib/db'
import { onSync, sendSync } from '../lib/syncBus'
import type { EvCharge } from '../lib/evCharging'

const PENDING_KEY = 'sjwd-ev-pending'

function readPending(): Record<string, EvCharge> {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}') as Record<string, EvCharge> } catch { return {} }
}
function writePending(p: Record<string, EvCharge>): void {
  try {
    if (Object.keys(p).length) localStorage.setItem(PENDING_KEY, JSON.stringify(p))
    else localStorage.removeItem(PENDING_KEY)
  } catch { /* quota / private mode — the in-memory copy still retries this session */ }
}

interface EvState {
  charges: Record<string, EvCharge>
  /** รอบที่ยังไม่ขึ้นคลาวด์ */
  pending: Record<string, EvCharge>
  loaded: boolean
  /** ตาราง ev_charges ยังไม่มี / เขียนไม่ได้ */
  cloudMissing: boolean
  /** ตารางยังไม่มีคอลัมน์ pauses — รอบที่มีการหยุดพักขึ้นคลาวด์ได้ทุกช่องยกเว้นช่วงพัก (เก็บไว้ในเครื่องรอส่ง) */
  pausesMissing: boolean
  /** ดึงรอบของยาร์ดนี้ที่เริ่มตั้งแต่ sinceMs (+ รอบที่ยังชาร์จอยู่) — ใหม่กว่าชนะ */
  load: (siteId: string | null, sinceMs: number) => Promise<void>
  /** บันทึกรอบ (เริ่ม / หยุดพัก / ชาร์จต่อ / จบ) — true = ขึ้นคลาวด์แล้ว */
  save: (c: EvCharge) => Promise<boolean>
}

let lastQuery: { siteId: string | null; sinceMs: number } | null = null

export const useEvCharging = create<EvState>()((set, get) => ({
  charges: {},
  pending: readPending(),
  loaded: false,
  cloudMissing: false,
  pausesMissing: false,

  load: async (siteId, sinceMs) => {
    // a wider earlier query stays in force — the admin page asks for a month, the station for two days
    if (!lastQuery || lastQuery.siteId !== siteId || sinceMs < lastQuery.sinceMs) lastQuery = { siteId, sinceMs }
    const pending = get().pending
    const charges = { ...get().charges }
    for (const c of Object.values(pending)) charges[c.id] = c
    set({ charges })
    const cloud = await db.fetchEvCharges(lastQuery.siteId, lastQuery.sinceMs)
    if (!cloud) { set({ loaded: true, cloudMissing: db.isConfigured() }); return }
    const merged = { ...get().charges }
    const waiting = get().pending
    for (const c of cloud) {
      // an edit still waiting on this device outranks the cloud copy of the same moment — the cloud may
      // hold that very round minus its pauses (column not added yet)
      const mine = waiting[c.id]
      if (mine && (mine.updatedAt ?? 0) >= (c.updatedAt ?? 0)) continue
      const cur = merged[c.id]
      if (!cur || (cur.updatedAt ?? 0) <= (c.updatedAt ?? 0)) merged[c.id] = c
    }
    // rows came back without the pauses column → say so on every device, not only the one that paused
    set({ charges: merged, loaded: true, cloudMissing: false, ...(cloud.length ? { pausesMissing: !db.evPausesReady() } : {}) })
    for (const c of Object.values(get().pending)) void get().save(c)
  },

  save: async (c) => {
    const pending = { ...get().pending, [c.id]: c }
    set({ charges: { ...get().charges, [c.id]: c }, pending })
    writePending(pending)
    const res = await db.upsertEvCharge(c)
    if (res === 'fail') { set({ cloudMissing: true }); return false }
    if (res === 'no-pauses') {
      // everything but the pauses is up: other devices see the round, and this device keeps it queued so
      // the pauses go up by themselves once the column exists
      set({ cloudMissing: false, pausesMissing: true })
      sendSync('ev')
      return true
    }
    const rest = { ...get().pending }
    // a newer local edit of the same round may have arrived while this one was in flight
    if (rest[c.id] && rest[c.id].updatedAt <= c.updatedAt) delete rest[c.id]
    set({ pending: rest, cloudMissing: false, pausesMissing: c.pauses?.length ? false : get().pausesMissing })
    writePending(rest)
    sendSync('ev')
    return true
  },
}))

// เครื่องอื่นบันทึกรอบชาร์จ → ดึงใหม่ด้วยเงื่อนไขเดิม
onSync('ev', () => {
  if (lastQuery) useEvCharging.getState().load(lastQuery.siteId, lastQuery.sinceMs).catch((e) => console.error('[ev] sync pull', e))
})

if (import.meta.env.DEV && typeof window !== 'undefined') (window as any).__ev = useEvCharging
