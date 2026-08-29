/**
 * useOps — admin "Operation" work queues (PM / Wash for sale / PDI / FINAL CHECK
 * or any custom name). Each queue holds a list of VINs; operators mark each VIN
 * done, and the queue shows a live countdown of remaining vehicles.
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as db from '../lib/db'
import { onSync, sendSync } from '../lib/syncBus'
import { useYard } from './useYard'
import { useTracking } from './useTracking' // one-way: tracking never imports ops
import { hasLeftGate, deriveCarStatus, isGateOutStamp, gateOutScanMs } from '../lib/carStatus'
import { PM_KEYS } from '../lib/trackingColumns'
import type { TrackRow } from '../lib/excelTracking'
import { quotaSafeStorage } from '../lib/persistStorage'

/** Process stage of one vehicle within a station queue (PDI / PM / Wash …).
 *  queued → (driver delivers) at-station → (staff records) checked → (driver returns) done. */
export type QueueStage = 'queued' | 'at-station' | 'checked'

/** Work category of a queue — drives the icon and, more importantly, WHERE a
 *  completed car's date is stamped back into the tracking sheet (its Overview):
 *   PM → the next empty PM1…PM15 slot · PDI → the "PDI" date ·
 *   FINAL → "Final check date" (+ Final Status) · WASH / SPECIAL → no cell,
 *   the completion is only recorded in the car's Event log. */
export type QueueType = 'PDI' | 'PM' | 'FINAL' | 'REPAIR' | 'WASH' | 'SPECIAL' | 'GATEIN'

/** Preset work types offered on the Operation page (order = button order). */
export const QUEUE_TYPES: { type: QueueType; name: string; th: string }[] = [
  { type: 'PM', name: 'PM', th: 'PM' },
  { type: 'PDI', name: 'PDI', th: 'PDI' },
  { type: 'FINAL', name: 'FINAL CHECK', th: 'FINAL CHECK' },
  { type: 'REPAIR', name: 'ช่าง (ซ่อม)', th: 'ช่าง (ซ่อม)' },
  // 'WASH' stays in the QueueType union for legacy queues, but is no longer
  // offered when creating a new one.
  { type: 'SPECIAL', name: 'งานพิเศษ', th: 'งานพิเศษ' },
]

export interface QueueItem {
  vin: string
  addedAt: number
  done: boolean            // fully complete: checked + returned to a parking slot
  doneAt?: number
  doneBy?: string
  stage?: QueueStage       // undefined === 'queued'
  result?: 'OK' | 'NG'     // station inspection outcome
  stamped?: boolean        // overview write-back already applied (stamp once per item)
  fromSlot?: string        // slot the car was at before going to the station (e.g. "A1.1")
  // per-station people history
  drivingBy?: string       // driver CURRENTLY behind the wheel (cleared on arrival)
  drivingAt?: number
  deliveredBy?: string     // driver who drove the car TO the station
  deliveredAt?: number
  checkedBy?: string       // staff who recorded OK / NG at the station
  checkedAt?: number
  returnedBy?: string      // driver who drove the car back to a parking slot
  returnedAt?: number
  // ── delivery sequence (Grouping to Dealer) ──
  laneLoad?: string        // loading-lane target, from the grouping Lane load (e.g. "O1")
  dest?: string            // delivery / dealer location
  /** Grouping code this car was imported under ("ATL260803-071"). Records which
   *  codes the run covers, so a car re-stamped with one joins it even after the
   *  last car of that group was taken out. Absent on pre-existing queues. */
  group?: string
  atWashAt?: number        // driver scan #1: car moved to Wash for sale
  atLaneAt?: number        // driver scan #2: car moved from Wash for sale to its loading lane
  gatedOut?: boolean       // gate-out confirmed → Car Status set to Gate-out
  /** A human UN-ticked this item — the sheet-date reconciler must not re-tick
   *  it (the manual decision outranks the Co-Inspection file's date). */
  manualUndoneAt?: number
}

export interface WorkQueue {
  id: string
  name: string
  createdAt: number
  createdBy?: string
  items: QueueItem[]
  site?: string // Site.id the queue was created under (queues are scoped per yard)
  type?: QueueType  // work category (PM / PDI / FINAL / WASH / SPECIAL) — drives write-back
  kind?: 'sequence' // 'sequence' = a Grouping-to-Dealer delivery run (drives Wash → lane → gate-out)
}

export const PRESET_QUEUES = ['PM', 'Wash for sale', 'PDI', 'FINAL CHECK'] as const

/** Resolve a queue's work category — explicit `type` on new queues, else inferred
 *  from the name so legacy queues (created before `type` existed) still classify. */
export function queueTypeOf(q: WorkQueue): QueueType {
  if (q.type) return q.type
  // arrival lots are named "(yard · date · N)" by the importer
  if ((q.name ?? '').trim().startsWith('(')) return 'GATEIN'
  const n = (q.name ?? '').toLowerCase()
  if (n.includes('pdi')) return 'PDI'
  // PM before FINAL: a legacy queue named "FINAL PM" is a PM run — classifying
  // it FINAL stamped "Final check date" instead of the next PM1..15 slot.
  if (/\bpm\b|^pm|pm[\s·-]/.test(n) || n.startsWith('pm')) return 'PM'
  if (n.includes('final')) return 'FINAL'
  if (n.includes('ช่าง') || n.includes('ซ่อม') || n.includes('repair')) return 'REPAIR'
  if (n.includes('wash')) return 'WASH'
  return 'SPECIAL'
}

/** Today as "DD/MM/YYYY" — the date format the yard stations write into the sheet. */
function todayCell(): string {
  const n = new Date()
  return `${String(n.getDate()).padStart(2, '0')}/${String(n.getMonth() + 1).padStart(2, '0')}/${n.getFullYear()}`
}

/** PDI ladder: the 1st PDI fills "PDI", the 2nd fills the first RE-PDI slot, and
 *  so on down the eight re-PDI columns (header spelling has two spaces). */
const PDI_KEYS = ['PDI', ...Array.from({ length: 8 }, (_, i) => `RE PDI  Date #${i + 1}`)]

/**
 * Stamp a finished queue car's date back into the tracking sheet (its Overview),
 * so a PM/PDI/FINAL recorded on the field shows up on the master row. Side-effect
 * only (writes through useTracking.updateCell → syncs + logs history). Returns
 * true if it wrote a cell, so the caller can flip the item's `stamped` flag and
 * never double-write (which would eat a second PM slot on a re-toggle).
 */
/**
 * Stamp today's date into the tracking sheet for a station check, using the
 * per-type ladder — PM → next empty PM1…PM15, PDI → PDI then RE-PDI 1…8, FINAL
 * → "Final check date" (single). Queue-independent so field stations can stamp
 * even when the car isn't part of a work queue. Returns true if a cell was
 * written. WASH / SPECIAL have no date cell.
 */
export function stampStationDate(vin: string, type: QueueType): boolean {
  // REPAIR/WASH/SPECIAL have no date column on the master sheet — event log only.
  // GATEIN neither: arrival is stamped by the gate station's own write (Gate In
  // Time / Inspector), and falling through here would date 'Final check date'.
  if (type === 'REPAIR' || type === 'WASH' || type === 'SPECIAL' || type === 'GATEIN') return false
  const tr = useTracking.getState()
  const row = tr.rows[vin]
  if (!row) return false
  const d = todayCell()
  // idempotent per day: walk the ladder to the first empty slot, but if the
  // LAST filled slot already carries today's date this is a re-save of the same
  // inspection (double-tap / corrected entry) — don't burn another slot.
  const ladder = (keys: readonly string[]): boolean => {
    let slot: string | null = null
    for (let i = 0; i < keys.length; i++) {
      const val = (row.cells[keys[i]] || '').trim()
      if (!val) { slot = keys[i]; break }
      if (val === d && (i === keys.length - 1 || !(row.cells[keys[i + 1]] || '').trim()))
        return false // latest stamp is already today → same inspection re-saved
    }
    if (!slot) return false // all slots already used
    tr.updateCell(vin, slot, d)
    return true
  }
  if (type === 'PM') return ladder(PM_KEYS)
  if (type === 'PDI') return ladder(PDI_KEYS) // 1st PDI → "PDI"; each redo → next RE-PDI slot
  // FINAL — stamp the done-date into "Final check date"
  tr.updateCell(vin, 'Final check date', d)
  return true
}

function stampOverview(q: WorkQueue, vin: string, _result?: 'OK' | 'NG'): boolean {
  return stampStationDate(vin, queueTypeOf(q))
}

/** Coerce a queue from ANY source (old localStorage, cloud rows, another app
 *  version) into a safe shape. A queue with name:null / items:null crashed
 *  every screen that touched it — and swallowed the Grouping "Create Sequence"
 *  click with no feedback at all. */
function sanitizeQueue(q: unknown): WorkQueue | null {
  const r = q as Partial<WorkQueue> | null
  if (!r || typeof r !== 'object' || !r.id) return null
  return {
    ...r,
    id: String(r.id),
    name: typeof r.name === 'string' ? r.name : '',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    items: Array.isArray(r.items) ? r.items.filter((i) => i && typeof i.vin === 'string') : [],
  } as WorkQueue
}
const sanitizeQueues = (list: unknown): WorkQueue[] =>
  (Array.isArray(list) ? list : []).map(sanitizeQueue).filter((q): q is WorkQueue => q !== null)

let qid = 0

interface OpsState {
  queues: WorkQueue[]
  /** Admin-closed queues — id → when/who. A closed queue is archived to its
   *  day (calendar view) and stops occupying the daily board; an OPEN queue
   *  keeps showing every day until finished + closed. Synced via app_config
   *  ('ops_closed_queues') so no table migration is needed. */
  closed: Record<string, { at: number; by?: string }>
  /** Tombstones for DELETED queues — id → when. A deleted queue used to come
   *  straight back: the cloud row delete could fail (or simply lose the race
   *  against a refetch), and every pull re-adopted the row. Worse, a phone that
   *  still had the queue in its own localStorage re-uploaded it the next time
   *  it booted to an empty cloud. A tombstone outlives all of that — the id is
   *  filtered out of every pull, never re-seeded, and the cloud row is deleted
   *  again if it turns out to still be there. Synced via app_config
   *  ('ops_deleted_queues'), same as `closed`, so no table migration is needed. */
  deleted: Record<string, number>
  /**
   * รถที่ถูก "เอาออกจากกระดานประตู" ด้วยมือ — vin → เวลาที่เอาออก
   *
   * การ์ด "(รอ Gate-in · ยังไม่มีคิวงาน)" ถูกสร้างสดจากชีท: รถทุกคันที่สถานะ
   * เป็น Pre Gate-in และไม่มีคิวงานไหนคุมอยู่ จะถูกรวบมาไว้ในการ์ดนี้เสมอ
   * ผลข้างเคียงคือ "เอารถออกจากคิวงาน" ไม่เคยได้ผลจริง — พอเอาออกจากล็อต
   * รถก็หลุดไปโผล่ที่การ์ดนี้แทน หน้างานจึงเห็นว่าเอารถออกไม่ได้สักที
   *
   * บันทึกนี้คือคำสั่งของหน้างานว่า "คันนี้ไม่ได้มา อย่าเอามาขึ้นประตูอีก"
   * ไม่แตะสถานะในชีทเลย และไม่ปิดกั้นอะไร — ถ้ารถโผล่มาจริง สแกนเลขวินที่
   * สถานี Gate-in ก็รับเข้าได้ตามปกติ (สถานีค้นจากชีท ไม่ได้ค้นจากคิวงาน)
   *
   * ล้างตัวเองเมื่อ: รถถูกใส่กลับเข้าคิวงานใด ๆ หรือสถานะไม่ใช่ Pre Gate-in
   * อีกต่อไป (เข้าลาน / ออกจากลาน) — รอบการมาถึงครั้งใหม่จึงเริ่มจากศูนย์เสมอ
   * ซิงค์ผ่าน app_config ('ops_dismissed_pregatein') เหมือน closed/deleted
   */
  dismissed: Record<string, number>
  /** เอารถออกจากกระดานประตู (ไม่แตะชีท) */
  dismissPreGateIn: (vins: string[]) => void
  /** ยกเลิกการเอาออก — เรียกเองอัตโนมัติเมื่อรถกลับเข้าคิวงาน */
  undismissPreGateIn: (vins: string[]) => void
  closeQueue: (id: string, by?: string) => void
  reopenQueue: (id: string) => void
  createQueue: (name: string, by?: string, site?: string) => string
  /** Find-or-create a Pre Gate-in queue by name and add these VINs in ONE atomic
   *  state update + ONE cloud push. Avoids the create(empty)+addVins(full) race
   *  that could leave the queue persisted with 0 items. */
  createGateInQueue: (name: string, vins: string[], by?: string, site?: string) => string
  /** Create a NEW typed queue (PM / PDI / FINAL / WASH / SPECIAL), auto-uniquing
   *  its display name within the site so the same type can be created many times
   *  (e.g. one PM queue per lot). Always makes a fresh queue — never dedups. */
  createTypedQueue: (type: QueueType, name: string, by?: string, site?: string) => string
  removeQueue: (id: string) => void
  renameQueue: (id: string, name: string) => void
  addVins: (id: string, vins: string[]) => { added: number; dup: number }
  removeVin: (id: string, vin: string) => void
  /** Move one VIN from one Gate-in lot to another, carrying its record (when it
   *  was gated in, by whom) with it. Returns false if the move can't be made. */
  moveVin: (fromId: string, toId: string, vin: string) => boolean
  /** Drop these VINs from EVERY queue — the car was deleted from the system, so
   *  no station should keep asking for it. Returns how many items were removed. */
  purgeVins: (vins: string[]) => number
  toggleDone: (id: string, vin: string, by?: string) => void
  setAllDone: (id: string, done: boolean, by?: string) => void
  clearQueues: () => void
  // process flow
  /** Driver picked the car up and is on the move — broadcast so every other
   *  phone sees who has it. Pass `by = undefined` to clear (drive cancelled). */
  setDriving: (id: string, vin: string, by?: string) => void
  deliverToStation: (id: string, vin: string, fromSlot?: string, by?: string) => void
  recordCheck: (id: string, vin: string, result: 'OK' | 'NG', by?: string) => void
  returnToSlot: (id: string, vin: string, by?: string) => void
  // ── delivery sequence (Grouping to Dealer) ──
  createSequence: (name: string, by: string, items: { vin: string; laneLoad?: string; dest?: string; group?: string }[]) => string
  markAtWash: (id: string, vin: string, by?: string) => void        // driver scan #1
  markAtLane: (id: string, vin: string, by?: string) => void        // driver scan #2
  confirmSeqGateOut: (id: string, vin: string, by?: string) => void // gate-out confirmed
  /** Close many cars of the same sequence at once (scan-DN bulk gate-out) —
   *  ONE state update + ONE cloud push for the whole run. */
  confirmSeqGateOutMany: (id: string, vins: string[], by?: string) => void
  /** Admin edited the Lane load per grouping code — apply to every sequence
   *  item carrying that code, so the field's queue cards show the new lane
   *  immediately. Returns how many queues changed. */
  setLaneLoads: (byGroup: Record<string, string>) => number
  /** Pull queues from the cloud. authoritative=true replaces local even when the cloud is empty
   *  (broadcast refetch); false = boot merge (cloud wins when non-empty, else seed local up). */
  loadFromCloud: (authoritative?: boolean) => Promise<void>
}

/**
 * Queues whose cloud write is still in flight (or has failed and is being
 * retried) — id → the exact copy this device is trying to save.
 *
 * Every 'ops' sync replaces the whole queue list with the cloud copy, and the
 * cloud does not have an unconfirmed write yet. Without this, a change made on
 * screen jumps back to its old value a second later: the operator moves a VIN
 * to another lot, some other device (or this one) broadcasts, the pull lands
 * before the upsert does, and the move is undone. Pulls now re-apply whatever
 * is in here on top of the cloud copy, so a pending change survives until the
 * write is actually confirmed — or until it is given up on and rolled back
 * with an error the operator can see.
 */
const pendingPush = new Map<string, WorkQueue>()

/** Tombstones stop being useful once the row is long gone everywhere — drop the
 *  old ones so the synced config blob can't grow without bound. */
const TOMBSTONE_TTL = 120 * 24 * 3600_000 // 120 days
function pruneTombstones(t: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - TOMBSTONE_TTL
  const out: Record<string, number> = {}
  for (const [id, at] of Object.entries(t)) if (at > cutoff) out[id] = at
  return out
}

/** Re-apply unconfirmed local writes over a freshly fetched cloud list. */
function applyPending(cloud: WorkQueue[]): WorkQueue[] {
  if (!pendingPush.size) return cloud
  const out = cloud.map((q) => pendingPush.get(q.id) ?? q)
  const have = new Set(out.map((q) => q.id))
  for (const [id, q] of pendingPush) if (!have.has(id)) out.push(q) // brand-new queue
  return out
}

/**
 * Push queues to the cloud, then tell every client to refetch — ONE broadcast,
 * after ALL of them land. Broadcasting per queue is what corrupted a move
 * between two lots: the first upsert's broadcast triggered a refetch while the
 * second queue was still only local, so everyone pulled a half-applied move.
 */
function pushQueues(get: () => OpsState, ids: string[]) {
  const qs = ids.map((id) => get().queues.find((x) => x.id === id)).filter((q): q is WorkQueue => !!q)
  if (!qs.length) return
  for (const q of qs) pendingPush.set(q.id, q)
  Promise.all(qs.map((q) => db.upsertOpsQueue(q))).then(
    () => {
      // only clear entries this push owns — a newer edit may have replaced them
      for (const q of qs) if (pendingPush.get(q.id) === q) pendingPush.delete(q.id)
      sendSync('ops')
    },
    (e) => {
      console.error('[db] pushQueues', e)
      for (const q of qs) if (pendingPush.get(q.id) === q) pendingPush.delete(q.id)
      // NOT just a log: with the write given up on, the next sync rolls the
      // change back on screen — the operator must know it didn't save.
      useYard.getState().toast('err', `บันทึกคิว "${qs[0].name ?? ''}" ขึ้น cloud ไม่สำเร็จ — กรุณาลองใหม่`)
    },
  )
}

/** Push one queue to the cloud + tell other clients to refetch (fire-and-forget). */
function pushQueue(get: () => OpsState, id: string) {
  pushQueues(get, [id])
}

export const useOps = create<OpsState>()(
  persist(
    (set, get) => ({
      queues: [],
      closed: {},
      deleted: {},
      dismissed: {},

      dismissPreGateIn: (vins) => {
        const next = { ...get().dismissed }
        const now = Date.now()
        let changed = false
        for (const raw of vins) {
          const v = (raw || '').trim().toUpperCase()
          if (!v || next[v]) continue
          next[v] = now
          changed = true
        }
        if (!changed) return
        set({ dismissed: next })
        db.saveAppConfig('ops_dismissed_pregatein', next).then(() => sendSync('ops')).catch(() => {})
      },

      undismissPreGateIn: (vins) => {
        const cur = get().dismissed
        const hit = vins.map((v) => (v || '').trim().toUpperCase()).filter((v) => v && cur[v])
        if (!hit.length) return
        const next = { ...cur }
        for (const v of hit) delete next[v]
        set({ dismissed: next })
        db.saveAppConfig('ops_dismissed_pregatein', next).then(() => sendSync('ops')).catch(() => {})
      },

      closeQueue: (id, by) => {
        const closed = { ...get().closed, [id]: { at: Date.now(), by } }
        set({ closed })
        db.saveAppConfig('ops_closed_queues', closed).then(() => sendSync('ops')).catch(() => {})
      },

      reopenQueue: (id) => {
        const closed = { ...get().closed }
        delete closed[id]
        set({ closed })
        db.saveAppConfig('ops_closed_queues', closed).then(() => sendSync('ops')).catch(() => {})
      },

      createQueue: (name, by, site) => {
        const n = name.trim()
        if (!n) return ''
        const existing = get().queues.find((q) => (q.name ?? '').toLowerCase() === n.toLowerCase())
        if (existing) return existing.id
        const id = `q${++qid}${Date.now()}`
        // caller may pin the queue to a specific yard (multi-yard import); else the active site
        const siteTag = site ?? useYard.getState().currentSite ?? undefined
        set((s) => ({ queues: [...s.queues, { id, name: n, createdAt: Date.now(), createdBy: by, items: [], site: siteTag }] }))
        pushQueue(get, id)
        return id
      },

      createGateInQueue: (name, vins, by, site) => {
        const n = name.trim()
        if (!n) return ''
        const siteTag = site ?? useYard.getState().currentSite ?? undefined
        const now = Date.now()
        let id = get().queues.find((q) => (q.name ?? '').toLowerCase() === n.toLowerCase())?.id ?? ''
        if (!id) id = `q${++qid}${now}`
        set((s) => {
          const base = s.queues.some((q) => q.id === id)
            ? s.queues
            : [...s.queues, { id, name: n, createdAt: now, createdBy: by, items: [] as QueueItem[], site: siteTag, type: 'GATEIN' as QueueType }]
          return {
            queues: base.map((q) => {
              if (q.id !== id) return q
              const have = new Set(q.items.map((i) => i.vin))
              const items = [...q.items]
              for (const raw of vins) {
                const v = raw.trim().toUpperCase()
                if (!v || have.has(v)) continue
                have.add(v)
                items.push({ vin: v, addedAt: now, done: false })
              }
              return { ...q, items }
            }),
          }
        })
        pushQueue(get, id) // single push, WITH items → no empty-then-full race
        // ไฟล์ชุดใหม่พารถกลับเข้าคิวงาน = รอบการมาถึงครั้งใหม่ ล้างที่เคยเอาออก
        get().undismissPreGateIn(vins)
        return id
      },

      createTypedQueue: (type, name, by, site) => {
        const siteTag = site ?? useYard.getState().currentSite ?? undefined
        // a leading "(" is reserved for auto-named Pre Gate-in queues — a custom
        // queue named "(รอบเช้า)…" would vanish from the Operation board and be
        // auto-completed by the gate-in reconciler
        const base = (name || '').trim().replace(/^\(+\s*/, '') || (QUEUE_TYPES.find((t) => t.type === type)?.name ?? type)
        // unique display name within this yard: "PM", "PM 2", "PM 3" …
        const taken = new Set(
          get().queues.filter((q) => (q.site ?? null) === (siteTag ?? null)).map((q) => (q.name ?? '').toLowerCase()),
        )
        let n = base
        for (let k = 2; taken.has(n.toLowerCase()); k++) n = `${base} ${k}`
        const id = `q${++qid}${Date.now()}`
        set((s) => ({ queues: [...s.queues, { id, name: n, type, createdAt: Date.now(), createdBy: by, items: [], site: siteTag }] }))
        pushQueue(get, id)
        return id
      },

      removeQueue: (id) => {
        pendingPush.delete(id) // deleted — never re-apply it over a later pull
        // tombstone FIRST, and keep it whether or not the cloud delete lands:
        // it is what stops the row coming back on the next pull (see `deleted`)
        const deleted = pruneTombstones({ ...get().deleted, [id]: Date.now() })
        set((s) => ({ deleted, queues: s.queues.filter((q) => q.id !== id) }))
        db.saveAppConfig('ops_deleted_queues', deleted).catch((e) => console.error('[db] tombstone', e))
        db.deleteOpsQueue(id).then(() => sendSync('ops')).catch((e) => {
          console.error('[db] removeQueue', e)
          useYard.getState().toast('err', 'ลบคิวงานขึ้น cloud ไม่สำเร็จ — คิวจะถูกลบซ้ำอัตโนมัติเมื่อเชื่อมต่อได้')
        })
      },

      renameQueue: (id, name) => {
        set((s) => ({
          queues: s.queues.map((q) => {
            if (q.id !== id) return q
            // Pin what the queue IS before renaming it, because for a lot that
            // predates the `type` field the old name is the only thing saying
            // so — rename it first and that fact is gone for good.
            const type = q.type ?? queueTypeOf(q)
            return { ...q, name: name.trim() || q.name, type }
          }),
        }))
        pushQueue(get, id)
      },

      addVins: (id, vins) => {
        let added = 0, dup = 0
        set((s) => ({
          queues: s.queues.map((q) => {
            if (q.id !== id) return q
            const have = new Set(q.items.map((i) => i.vin))
            const items = [...q.items]
            for (const raw of vins) {
              const v = raw.trim().toUpperCase()
              if (!v) continue
              if (have.has(v)) { dup++; continue }
              have.add(v)
              items.push({ vin: v, addedAt: Date.now(), done: false })
              added++
            }
            return { ...q, items }
          }),
        }))
        pushQueue(get, id)
        // ใส่กลับเข้าคิวงานแล้ว = ยกเลิก "เอาออกจากกระดานประตู" ของคันนั้น
        get().undismissPreGateIn(vins)
        return { added, dup }
      },

      removeVin: (id, vin) => {
        set((s) => ({ queues: s.queues.map((q) => (q.id === id ? { ...q, items: q.items.filter((i) => i.vin !== vin) } : q)) }))
        pushQueue(get, id)
      },

      // A car planned onto the wrong arrival lot (the truck it actually came on
      // differs from the one the import file said) used to need remove-then-add
      // by hand, which threw away when/who gated it in. This carries the whole
      // item across in ONE state update, then pushes BOTH queues — a half-push
      // would leave the VIN duplicated or lost on the other devices.
      moveVin: (fromId, toId, vin) => {
        if (fromId === toId) return false
        const s0 = get()
        const from = s0.queues.find((q) => q.id === fromId)
        const to = s0.queues.find((q) => q.id === toId)
        const item = from?.items.find((i) => i.vin === vin)
        if (!from || !to || !item) return false
        set((s) => ({
          queues: s.queues.map((q) => {
            if (q.id === fromId) return { ...q, items: q.items.filter((i) => i.vin !== vin) }
            if (q.id === toId) {
              // already listed there (a double-import overlap) → keep the target's
              // own copy rather than showing the VIN twice in one lot
              if (q.items.some((i) => i.vin === vin)) return q
              return { ...q, items: [...q.items, { ...item }] }
            }
            return q
          }),
        }))
        // ONE push for both lots: a per-queue broadcast let everyone refetch a
        // half-applied move, and the VIN bounced back to where it started
        pushQueues(get, [fromId, toId])
        return true
      },

      // A car deleted from the system (transport cancelled, never arrived) used
      // to stay in its work queue forever: the station kept counting it as
      // outstanding, and the line showed a bare VIN with no model, colour or
      // location because the row behind it was gone. Deleting a car now clears
      // it out of every queue it was planned into.
      purgeVins: (vins) => {
        if (!vins.length) return 0
        const kill = new Set(vins)
        const touched: string[] = []
        let removed = 0
        set((s) => ({
          queues: s.queues.map((q) => {
            const items = q.items.filter((i) => !kill.has(i.vin))
            if (items.length === q.items.length) return q
            removed += q.items.length - items.length
            touched.push(q.id)
            return { ...q, items }
          }),
        }))
        for (const id of touched) pushQueue(get, id)
        return removed
      },

      toggleDone: (id, vin, by) => {
        const q = get().queues.find((x) => x.id === id)
        const it = q?.items.find((i) => i.vin === vin)
        // becoming done for the first time → stamp its date into the Overview
        const wrote = q && it && !it.done && !it.stamped ? stampOverview(q, vin, it.result) : false
        set((s) => ({
          queues: s.queues.map((qq) =>
            qq.id === id
              ? { ...qq, items: qq.items.map((i) => (i.vin === vin ? { ...i, done: !i.done, doneAt: !i.done ? Date.now() : undefined, doneBy: !i.done ? by : undefined, stamped: i.stamped || wrote, manualUndoneAt: !i.done ? undefined : Date.now() } : i)) }
              : qq,
          ),
        }))
        pushQueue(get, id)
      },

      setAllDone: (id, done, by) => {
        const q = get().queues.find((x) => x.id === id)
        // stamp every car that is finishing now (and hasn't been stamped before)
        if (q && done) for (const i of q.items) if (!i.done && !i.stamped) { if (stampOverview(q, i.vin, i.result)) i.stamped = true }
        set((s) => ({
          queues: s.queues.map((qq) =>
            qq.id === id ? { ...qq, items: qq.items.map((i) => ({ ...i, done, doneAt: done ? Date.now() : undefined, doneBy: done ? by : undefined })) } : qq,
          ),
        }))
        pushQueue(get, id)
      },

      clearQueues: () => {
        // scoped to the ACTIVE yard — the old global clear deleted every yard's
        // queues (and the field phones' live work) from one site's button.
        const sid = useYard.getState().currentSite
        if (!sid) return
        const gone = get().queues.filter((q) => !q.site || q.site === sid).map((q) => q.id)
        for (const id of gone) pendingPush.delete(id) // deleted — don't re-apply
        const now = Date.now()
        const deleted = pruneTombstones({ ...get().deleted, ...Object.fromEntries(gone.map((id) => [id, now])) })
        set((s) => ({ deleted, queues: s.queues.filter((q) => q.site && q.site !== sid) }))
        db.saveAppConfig('ops_deleted_queues', deleted).catch((e) => console.error('[db] tombstone', e))
        Promise.all(gone.map((id) => db.deleteOpsQueue(id)))
          .then(() => sendSync('ops'))
          .catch((e) => console.error('[db] clearQueues', e))
      },

      // ── process flow ──────────────────────────────────────────────────────
      setDriving: (id, vin, by) => {
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id
              ? { ...q, items: q.items.map((i) => (i.vin === vin ? { ...i, drivingBy: by || undefined, drivingAt: by ? Date.now() : undefined } : i)) }
              : q,
          ),
        }))
        pushQueue(get, id)
      },

      deliverToStation: (id, vin, fromSlot, by) => {
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id
              ? { ...q, items: q.items.map((i) => (i.vin === vin ? { ...i, stage: 'at-station', fromSlot, deliveredBy: by, deliveredAt: Date.now(), drivingBy: undefined, drivingAt: undefined } : i)) }
              : q,
          ),
        }))
        pushQueue(get, id)
      },

      recordCheck: (id, vin, result, by) => {
        const q = get().queues.find((x) => x.id === id)
        const it = q?.items.find((i) => i.vin === vin)
        // The station's own save is what belongs on the master row, so stamp the
        // date ladder HERE (PM → next empty PM1…PM15, PDI → PDI/RE-PDI, FINAL →
        // Final check date). It used to wait for the driver's return trip, which
        // left the Overview blank for hours after the inspection was recorded.
        const wrote = q && it && !it.stamped ? stampOverview(q, vin, result) : false
        set((s) => ({
          queues: s.queues.map((qq) =>
            qq.id === id
              ? { ...qq, items: qq.items.map((i) => (i.vin === vin ? { ...i, stage: 'checked', result, checkedBy: by, checkedAt: Date.now(), doneBy: by, stamped: i.stamped || !!wrote, drivingBy: undefined, drivingAt: undefined } : i)) }
              : qq,
          ),
        }))
        pushQueue(get, id)
      },

      returnToSlot: (id, vin, by) => {
        const q = get().queues.find((x) => x.id === id)
        const it = q?.items.find((i) => i.vin === vin)
        const wrote = q && it && !it.stamped ? stampOverview(q, vin, it.result) : false
        set((s) => ({
          queues: s.queues.map((qq) =>
            qq.id === id
              ? { ...qq, items: qq.items.map((i) => (i.vin === vin ? { ...i, done: true, doneAt: Date.now(), doneBy: by ?? i.doneBy, returnedBy: by, returnedAt: Date.now(), stamped: i.stamped || wrote, drivingBy: undefined, drivingAt: undefined } : i)) }
              : qq,
          ),
        }))
        pushQueue(get, id)
      },

      // ── delivery sequence (Grouping to Dealer) ────────────────────────────
      createSequence: (name, by, items) => {
        const n = name.trim()
        if (!n) return ''
        const site = useYard.getState().currentSite ?? undefined
        const now = Date.now()
        const rows: QueueItem[] = items
          .map((it) => ({ vin: it.vin.trim().toUpperCase(), laneLoad: it.laneLoad, dest: it.dest, group: it.group?.trim().toUpperCase() || undefined }))
          .filter((it) => it.vin)
          .map((it) => ({ vin: it.vin, addedAt: now, done: false, laneLoad: it.laneLoad, dest: it.dest, group: it.group }))
        const existing = get().queues.find((q) => (q.name ?? '').toLowerCase() === n.toLowerCase())
        if (existing) {
          // re-uploading the same sequence: replace its items, keep the id
          set((s) => ({ queues: s.queues.map((q) => (q.id === existing.id ? { ...q, kind: 'sequence', items: rows, createdBy: by, createdAt: now } : q)) }))
          pushQueue(get, existing.id)
          return existing.id
        }
        const id = `q${++qid}${Date.now()}`
        set((s) => ({ queues: [...s.queues, { id, name: n, createdAt: now, createdBy: by, items: rows, site, kind: 'sequence' }] }))
        pushQueue(get, id)
        return id
      },
      // driver scan #1: slot → Wash for sale
      markAtWash: (id, vin, by) => {
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id ? { ...q, items: q.items.map((i) => (i.vin === vin ? { ...i, atWashAt: Date.now(), deliveredBy: by } : i)) } : q,
          ),
        }))
        pushQueue(get, id)
      },
      // driver scan #2: Wash for sale → loading lane (laneLoad)
      markAtLane: (id, vin, by) => {
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id ? { ...q, items: q.items.map((i) => (i.vin === vin ? { ...i, atLaneAt: Date.now(), returnedBy: by } : i)) } : q,
          ),
        }))
        pushQueue(get, id)
      },
      // gate-out confirmed → the item is fully done
      confirmSeqGateOut: (id, vin, by) => {
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id
              ? { ...q, items: q.items.map((i) => (i.vin === vin ? { ...i, gatedOut: true, done: true, doneAt: Date.now(), doneBy: by ?? i.doneBy } : i)) }
              : q,
          ),
        }))
        pushQueue(get, id)
      },

      confirmSeqGateOutMany: (id, vins, by) => {
        const want = new Set(vins)
        const at = Date.now()
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id
              ? { ...q, items: q.items.map((i) => (want.has(i.vin) ? { ...i, gatedOut: true, done: true, doneAt: at, doneBy: by ?? i.doneBy } : i)) }
              : q,
          ),
        }))
        pushQueue(get, id)
      },

      setLaneLoads: (byGroup) => {
        const dirty: string[] = []
        set((s) => ({
          queues: s.queues.map((q) => {
            if (q.kind !== 'sequence') return q
            let changed = false
            const items = q.items.map((i) => {
              const g = i.group
              if (g && byGroup[g] != null && i.laneLoad !== byGroup[g]) {
                changed = true
                return { ...i, laneLoad: byGroup[g] }
              }
              return i
            })
            if (!changed) return q
            dirty.push(q.id)
            return { ...q, items }
          }),
        }))
        for (const id of dirty) pushQueue(get, id)
        return dirty.length
      },

      loadFromCloud: async (authoritative = false) => {
        // closures ride along on every queue refetch — cloud copy wins
        db.fetchAppConfig<Record<string, { at: number; by?: string }>>('ops_closed_queues')
          .then((c) => { if (c && typeof c === 'object') set({ closed: c }) })
          .catch(() => {})
        // เช่นเดียวกัน: รถที่หน้างานเอาออกจากกระดานประตู — cloud เป็นตัวจริง
        db.fetchAppConfig<Record<string, number>>('ops_dismissed_pregatein')
          .then((d) => { if (d && typeof d === 'object') set({ dismissed: d }) })
          .catch(() => {})
        // tombstones must be in hand BEFORE adopting the cloud list, or a
        // deleted queue flashes back on screen for this whole round trip
        const remoteTombs = await db.fetchAppConfig<Record<string, number>>('ops_deleted_queues').catch(() => null)
        const tombs = pruneTombstones({ ...get().deleted, ...(remoteTombs && typeof remoteTombs === 'object' ? remoteTombs : {}) })
        set({ deleted: tombs })

        const fetched = await db.fetchOpsQueues()
        if (fetched === null) return // table missing / offline — keep local state
        // unconfirmed local writes win over the cloud copy — see pendingPush
        const all = applyPending(sanitizeQueues(fetched))
        const cloud = all.filter((q) => !tombs[q.id])
        // a tombstoned row still in the cloud means an earlier delete never
        // landed (timeout / offline) — finish the job instead of fighting it
        // every sync from here on
        for (const q of all) if (tombs[q.id]) db.deleteOpsQueue(q.id).catch((e) => console.error('[db] re-delete', e))

        if (cloud.length) set({ queues: cloud })
        else if (authoritative) set({ queues: [] }) // e.g. another device cleared all
        else {
          // first run: cloud empty → seed it from this device's local queues.
          // NEVER re-seed a tombstoned one: a phone that still had the deleted
          // queue in its localStorage used to upload it straight back.
          const local = get().queues.filter((q) => !tombs[q.id])
          // best-effort seed — upsertOpsQueue now throws, and one failed queue
          // must not abort the rest (or reject this pull)
          if (local.length) await Promise.all(local.map((q) => db.upsertOpsQueue(q).catch((e) => console.error('[db] seed queue', e))))
          if (local.length !== get().queues.length) set({ queues: local })
        }
      },
    }),
    {
      name: 'sjwd-ops',
      // quota-safe: a full localStorage must never break the action that
      // tried to persist — the cloud copy (pushQueue) is the real record
      storage: quotaSafeStorage(() =>
        useYard.getState().toast('err', 'พื้นที่จัดเก็บในเครื่องเต็ม — ข้อมูลยังถูกบันทึกขึ้น cloud ตามปกติ')),
      // heal corrupted queues left in localStorage by older app versions —
      // one name:null / items:null entry crashed every queue screen
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<OpsState>
        const deleted = p.deleted && typeof p.deleted === 'object' ? pruneTombstones(p.deleted) : {}
        return {
          ...current, ...p,
          // drop a deleted queue on boot too — the persisted copy is exactly
          // what used to bring it back before the cloud pull had a chance
          queues: sanitizeQueues(p.queues).filter((q) => !deleted[q.id]),
          closed: p.closed && typeof p.closed === 'object' ? p.closed : {},
          dismissed: p.dismissed && typeof p.dismissed === 'object' ? p.dismissed : {},
          deleted,
        }
      },
    },
  ),
)

// another client changed a queue → refetch (cloud is authoritative on broadcast)
onSync('ops', () => { useOps.getState().loadFromCloud(true).catch((e) => console.error('[ops] sync pull', e)) })

// ── keep queues honest about the live Car Status (data-level, one place) ─────
// Two reconciliations run debounced whenever tracking data changes, so a queue
// reflects reality no matter HOW a car moved (ops-scan, Gate In/Out page, import):
//  • Gate-out: a car whose LIVE Car Status is Gate-out is finished work in EVERY
//    queue → mark its items gatedOut+done.
//  • Gate-in: a car in a PRE GATE-IN queue "(yard·date·N)" whose status is no
//    longer 'Pre Gate-in' has entered the yard → mark that item done, so the
//    "0/117" progress updates as cars gate in (regardless of the scan path).
//  • Grouping: a delivery run's membership IS the Grouping Number on the
//    tracking rows. Clear a car's grouping and it leaves the run (124 → 123);
//    stamp a run's grouping onto another car and it joins (124 → 125).
const GROUPING_KEY = 'Grouping  Number' // header carries two spaces
/** The delivery group a car currently belongs to, '' when it belongs to none:
 *  the cell is blank (the number was taken off), or it holds a leftover note
 *  ("เศษรอ Mix") that the sheet writes in place of a real grouping code. A car
 *  with no group must drop out of its run — otherwise the run can never reach
 *  100% and sits "คา" on the Gate-out board forever. */
function groupOf(cells: Record<string, string>): string {
  const g = (cells[GROUPING_KEY] || '').trim()
  if (!g) return ''
  const l = g.toLowerCase()
  return l.includes('เศษ') || l.includes('mix') ? '' : g.toUpperCase()
}

/** Parse a station date cell ("29/07/2026", "2026-07-29", "29-Jul-26") →
 *  local-midnight epoch; undefined when unreadable. */
function parseDayCell(s?: string): number | undefined {
  const t = (s ?? '').trim()
  if (!t) return undefined
  let m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/) // 29/07/2026 (d/m/y)
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]).getTime() }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)                  // 2026-07-29
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  m = t.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})$/) // 29-Jul-26
  if (m) {
    const mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase())
    if (mo >= 0) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, mo, +m[1]).getTime() }
  }
  return undefined
}

/** The date ladder a queue type reads its "already recorded" signal from. */
const LADDER_OF: Partial<Record<QueueType, readonly string[]>> = {
  PM: PM_KEYS, PDI: PDI_KEYS, FINAL: ['Final check date'],
}

/** Local midnight of the day a car gated in, from the epoch "Gate In Time" the
 *  gate station stamps, else the "Gate In (Rayong yard)" day cell. */
function gateInDay(cells: Record<string, string>): number | undefined {
  const ms = parseInt(cells['Gate In Time'] || '')
  if (Number.isFinite(ms) && ms > 0) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
  return parseDayCell(cells['Gate In (Rayong yard)'])
}

/** Did this queue item ever see a real station action? recordCheck stamps
 *  stage/result/checkedBy/checkedAt and returnToSlot stamps returnedAt — a tick
 *  that carries none of those was never produced by the station itself. */
const hasStationRecord = (i: QueueItem): boolean =>
  !!i.checkedAt || !!i.result || !!i.returnedAt || i.stage === 'checked'

/**
 * A station queue (PDI / PM / FINAL …) whose item is only "done" because the
 * gate-in flow ticked it. Until this was fixed, saving a Gate In toggled every
 * queue holding that VIN done AND stamped today's date into the queue type's
 * ladder cell — so the sheet now carries fabricated PDI/PM dates that made the
 * reconciler below re-tick the item forever, and a PDI queue read 48/100 when
 * the station had really inspected 2. Gate-in and station work are separate
 * jobs: a station queue only counts what that station recorded.
 *
 * Fingerprint (all required): ticked, no station record of any kind, not a
 * gated-out closure (those are legitimate housekeeping), and the tick landed on
 * the very day the car gated in.
 */
function isGateInArtifact(i: QueueItem, cells: Record<string, string> | undefined): boolean {
  if (!i.done || i.gatedOut || hasStationRecord(i)) return false
  if (!cells) return false
  const gDay = gateInDay(cells)
  if (gDay === undefined) return false
  const at = i.doneAt
  if (!at) return false
  const d = new Date(at); d.setHours(0, 0, 0, 0)
  return d.getTime() === gDay
}

let reconcileTimer: ReturnType<typeof setTimeout> | null = null
function reconcileGateOuts() {
  const rows = useTracking.getState().rows
  const gone = new Set<string>()
  const gatedIn = new Set<string>() // no longer Pre Gate-in → has entered the yard
  // VINs whose CURRENT row is still Pre Gate-in (blank status counts too) — the
  // other half of the gate-in sync. A queue item marked done from a PRIOR cycle
  // (e.g. the yard's data was cleared and the same VINs re-imported, landing
  // back at Pre Gate-in for a fresh arrival) must un-tick, or the board reads
  // "309/309 เสร็จ" while most of the batch hasn't actually gated in this time.
  const stillWaiting = new Set<string>()
  const group = new Map<string, string>() // vin → delivery group ('' = none)
  for (const vin in rows) {
    const cs = (rows[vin].cells['Car Status'] || '').trim()
    if (hasLeftGate(rows[vin].cells)) gone.add(vin)
    else if (cs && cs.toLowerCase() !== 'pre gate-in') gatedIn.add(vin)
    else stillWaiting.add(vin)
    group.set(vin, groupOf(rows[vin].cells))
  }
  const queues = useOps.getState().queues
  // The grouping codes each run covers: what the import recorded on its items,
  // falling back to what its cars carry now (queues created before the code was
  // stored). One code belongs to ONE run — first wins — so a car stamped with it
  // joins exactly one sequence.
  const groupsOfRun = new Map<string, Set<string>>()
  const runOfGroup = new Map<string, string>()
  for (const q of queues) {
    if (!isSequenceQueue(q)) continue
    const gs = new Set<string>()
    for (const i of q.items) {
      const g = i.group || group.get(i.vin)
      if (!g) continue
      gs.add(g)
      if (!runOfGroup.has(g)) runOfGroup.set(g, q.id)
    }
    groupsOfRun.set(q.id, gs)
  }
  const dirty: string[] = []
  const next = queues.map((q) => {
    // Pre Gate-in must be resolved the SAME way every other screen resolves it
    // (queue type first, name only as the legacy fallback). Testing the name
    // alone broke the moment an admin renamed an arrival lot to something
    // readable ("CBU SEALION 7 100u"): the Gate In board still listed it as a
    // Pre Gate-in queue and gate-in still ticked it, but this reconciler saw a
    // station queue — so it un-ticked every car the gate had just scanned and
    // the lot read 0/100 while 177 cars had really come in.
    const isPreGateIn = isPreGateInQueue(q)
    // a PM/PDI/FINAL already recorded on the sheet (e.g. a Co-Inspection file
    // upload filled the date cell) counts as done for this queue too — but an
    // item the field/admin already ticked keeps ITS record (ระบบมาก่อนไฟล์).
    // Only a date on/after the queue's creation day counts: an older date is
    // last round's check, not this queue's work.
    // station queues (PDI / PM / FINAL / REPAIR / SPECIAL) — their progress is
    // the station's own work, never the gate's
    const isStationQueue = !isSequenceQueue(q) && !isPreGateIn
    const ladder = isStationQueue ? LADDER_OF[queueTypeOf(q)] : undefined
    const qd = new Date(q.createdAt || 0); qd.setHours(0, 0, 0, 0)
    const qDay = qd.getTime()
    let changed = false
    let items = q.items.map((i) => {
      if (gone.has(i.vin) && !(i.done && i.gatedOut)) {
        changed = true
        return { ...i, gatedOut: true, done: true, doneAt: i.doneAt ?? Date.now() }
      }
      if (isPreGateIn && gatedIn.has(i.vin) && !i.done) {
        changed = true
        return { ...i, done: true, doneAt: i.doneAt ?? Date.now() }
      }
      // reverse direction: the row is back to Pre Gate-in but this item still
      // reads done from before — un-tick and drop the stale scan record so the
      // card doesn't claim a Gate-in that hasn't happened this cycle.
      // EVERY device runs this reconciler off its OWN local rows copy, which
      // can briefly lag behind another device's just-written gate-in (this
      // device's realtime update for the row hasn't landed yet even though
      // the queue item was already marked done moments ago elsewhere). Only
      // trust "still Pre Gate-in" enough to un-tick when the row's own last
      // edit genuinely postdates the done mark — i.e. it was re-imported
      // AFTER, not merely a stale copy racing behind — or the count flaps
      // between two devices each reverting the other's correct write.
      if (isPreGateIn && stillWaiting.has(i.vin) && i.done && !i.gatedOut && (rows[i.vin]?.updatedAt ?? 0) > (i.doneAt ?? 0)) {
        changed = true
        return { ...i, done: false, doneAt: undefined, doneBy: undefined, stamped: undefined }
      }
      // repair: drop a tick this station never made (see isGateInArtifact) — the
      // fabricated ladder date is ignored below too, so it stays un-ticked
      if (isStationQueue && isGateInArtifact(i, rows[i.vin]?.cells)) {
        changed = true
        return { ...i, done: false, doneAt: undefined, doneBy: undefined, stamped: undefined, stage: undefined }
      }
      if (ladder && !i.done && !i.manualUndoneAt) {
        const r = rows[i.vin]
        if (r) {
          // a ladder date written on the car's gate-in day, with no station
          // record behind it, is the gate-in artifact described above — never
          // let it re-tick this queue
          const gDay = gateInDay(r.cells)
          const trustworthy = (v: number) => hasStationRecord(i) || gDay === undefined || v !== gDay
          let ts: number | undefined
          for (const k of ladder) { // latest recorded date on the ladder (hole-safe)
            const v = parseDayCell(r.cells[k])
            if (v !== undefined && trustworthy(v) && (ts === undefined || v > ts)) ts = v
          }
          if (ts !== undefined && ts >= qDay) {
            changed = true
            // stamped: the date already sits on the sheet — never burn another slot
            return { ...i, done: true, doneAt: ts, doneBy: i.doneBy ?? 'ไฟล์ Co-Inspection', stamped: true }
          }
        }
      }
      return i
    })
    // delivery runs only: the run's membership IS the grouping numbers, followed
    // both ways so the counter tracks what the sheet actually says today.
    if (isSequenceQueue(q)) {
      const runGroups = groupsOfRun.get(q.id) ?? new Set<string>()
      // OUT — the car's grouping was taken off (or moved to another run). Keep a
      // car that has already gated out: it really was delivered on this run, and
      // the sequence deliberately keeps gated-out cars so progress reads 17/17
      // instead of the total shrinking. A car with no tracking row at all is left
      // alone — there is nothing to read its grouping from.
      //
      // CRITICAL removal rules — every device runs this reconciler, so removal
      // must key on EXPLICIT evidence that travels with the row, never on the
      // absence of data. A device whose rows were stale (or whose grouping cell
      // was silently reverted by another device's whole-row write) read "no
      // grouping" on every fresh car, emptied the run, and pushed 0/0 to the
      // cloud — twice. A car leaves the run only when:
      //  (a) its row, updated after the car joined, carries a DIFFERENT real
      //      grouping (re-import moved it to another run), or
      //  (b) the row's own edit history records the number being cleared /
      //      replaced with an เศษ-Mix note AFTER the car joined — the log entry
      //      is written by the actual edit and syncs with the row, so a machine
      //      that merely lacks data can never fake it.
      const clearedInHistory = (r: (typeof rows)[string], after: number) =>
        (r.history ?? []).some((h) =>
          (h.field === GROUPING_KEY || h.field === 'Grouping') &&
          h.at > after && !groupOf({ [GROUPING_KEY]: h.to ?? '' }))
      const kept = items.filter((i) => {
        if (i.gatedOut || i.done) return true
        const r = rows[i.vin]
        if (!r) return true
        const g = group.get(i.vin)
        if (g && runGroups.has(g)) return true // still carries one of this run's codes
        if (g && (r.updatedAt ?? 0) > (i.addedAt ?? 0)) return false // moved to another run
        return !clearedInHistory(r, i.addedAt ?? 0)
      })
      // circuit breaker: no single reconciliation may wipe a run to zero — a
      // whole Note losing every car at once is corruption, not planning
      if (kept.length !== items.length && !(kept.length === 0 && items.length > 1)) {
        changed = true; items = kept
      }
      // IN — a car newly stamped with one of this run's grouping codes joins it,
      // inheriting that group's loading lane + dealer. Cars that already left the
      // yard are not pulled back in.
      const held = new Set(items.map((i) => i.vin))
      const added: QueueItem[] = []
      for (const vin in rows) {
        const g = group.get(vin)
        if (!g || held.has(vin) || gone.has(vin)) continue
        if (runOfGroup.get(g) !== q.id) continue
        if (q.site && rows[vin].site && rows[vin].site !== q.site) continue
        const mate = q.items.find((i) => (i.group || group.get(i.vin)) === g)
        added.push({ vin, addedAt: Date.now(), done: false, group: g, laneLoad: mate?.laneLoad, dest: mate?.dest })
      }
      if (added.length) { changed = true; items = [...items, ...added] }
    }
    if (!changed) return q
    dirty.push(q.id)
    return { ...q, items }
  })
  // ── ล้าง "เอาออกจากกระดานประตู" ที่หมดอายุแล้ว ────────────────────────────
  // บันทึกนี้ผูกกับรอบการมาถึงรอบนี้เท่านั้น พอรถไม่ได้เป็น Pre Gate-in แล้ว
  // (เข้าลานจริง / ออกจากลาน / ถูกลบทิ้ง) บันทึกก็หมดหน้าที่ ต้องล้างทิ้ง
  // ไม่งั้นรอบหน้าที่รถกลับมารอที่ประตูอีก มันจะถูกซ่อนค้างไปตลอด — ธงค้าง
  // แบบเดียวกับที่ทำให้คิวงานเพี้ยนมาแล้ว
  const dis = useOps.getState().dismissed
  if (useTracking.getState().loaded) {
    const stale = Object.keys(dis).filter((v) => !stillWaiting.has(v))
    if (stale.length) useOps.getState().undismissPreGateIn(stale)
  }
  if (!dirty.length) return
  useOps.setState({ queues: next })
  for (const id of dirty) pushQueue(useOps.getState, id)
}
function scheduleReconcile() {
  if (reconcileTimer) clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(reconcileGateOuts, 800)
}
useTracking.subscribe(scheduleReconcile) // rows changed (import / scan / realtime)
useOps.subscribe(scheduleReconcile)      // queues changed (created / loaded from cloud)

export function useQueues(): WorkQueue[] {
  return useOps((s) => s.queues)
}

// "this car's gate work is finished" lives in carStatus.ts (hasLeftGate) so the
// reconciler, the queue cards and the station badges cannot drift apart again.

/**
 * Has this car passed the gate outbound at ANY point in its life — even if its
 * status has since gone back to Pre Gate-in?
 *
 * Three independent traces, because no single one survives every path a car can
 * take: the gate-out stamp the sheet carries, and the row's own audit history
 * (which records the Car Status the gate wrote). Either is proof; a car that
 * has genuinely never left carries neither, so it is never mistaken for one
 * that has.
 */
function everLeftGate(r: TrackRow): boolean {
  if (isGateOutStamp(r.cells['Gate Out time stamp']) || isGateOutStamp(r.cells['Gate Out Date'])) return true
  return (r.history ?? []).some((h) => /gate\s*-?\s*out/i.test(h.to ?? ''))
}

/**
 * Queues with gated-out cars removed. A vehicle that has left the yard must
 * drop out of every ordinary queue view + count no matter how it was gated out
 * (mobile scan, Excel import, re-import). EXCEPTION: a delivery **sequence**
 * (Grouping-to-Dealer) KEEPS its gated-out cars — gate-out IS the final stage
 * of that run, so the cars stay visible (shown "Gate-out") and the progress
 * counts up 1/17 → 17/17 instead of the total shrinking. Display-only.
 */
export function useActiveQueues(): WorkQueue[] {
  const queues = useOps((s) => s.queues)
  const rows = useTracking((s) => s.rows)
  return useMemo(() => {
    const gone = new Set<string>()
    const waiting = new Set<string>()          // อยู่ที่ Pre Gate-in ตอนนี้
    const leftAtOf = new Map<string, number>() // vin → เวลาที่ออกจากลานครั้งล่าสุด (0 = ไม่รู้)
    for (const vin in rows) {
      const r = rows[vin]
      if (hasLeftGate(r.cells)) { gone.add(vin); continue }
      if (deriveCarStatus(r.cells) !== 'Pre Gate-in') continue
      waiting.add(vin)
      if (everLeftGate(r)) leftAtOf.set(vin, gateOutScanMs(r.cells))
    }
    if (!gone.size && !waiting.size) return queues
    /**
     * Is this car's part in THIS run already history?
     *
     * True only for a car that left the yard and has come back (sold and
     * returned, re-imported) AND for a run that was already running before it
     * left. Its arrival lot still listed it as scanned while the board also
     * showed it waiting in the "(รอ Gate-in · ยังไม่มีคิวงาน)" card — the same
     * VIN in two queues saying opposite things — and its old delivery run
     * counted backwards (6/6 → 5/6) and could never be closed.
     *
     * A run created AFTER it left is the run for THIS arrival, so it stays.
     * When the sheet does not date the gate-out, fall back to whether this run
     * had already finished with the car.
     *
     * The run's OWN record comes first: an item flagged `gatedOut` is this run
     * watching the car leave, and that outranks anything the sheet still says —
     * the sheet's gate-out stamp can be cleared or overwritten when the car is
     * re-imported for its next arrival, and then nothing in the row remembers
     * the trip. That left the car ticked "scanned" inside its old arrival lot
     * while its status read Pre Gate-in, so the ops-scan station showed it as
     * already gated in and the gate could not scan it back into the yard.
     */
    const partIsHistory = (q: WorkQueue, i: QueueItem): boolean => {
      if (!waiting.has(i.vin)) return false
      if (i.gatedOut) return true
      const leftAt = leftAtOf.get(i.vin)
      if (leftAt === undefined) return false   // ไม่เคยออกจากลาน → ไม่ใช่รถกลับเข้ามาใหม่
      if (leftAt > 0) return (q.createdAt || 0) <= leftAt
      return !!i.done
    }
    return queues.map((q) => {
      const drop = (i: QueueItem) => partIsHistory(q, i) || (!isSequenceQueue(q) && gone.has(i.vin))
      // a delivery run KEEPS its gated-out cars — gate-out is its final stage and
      // its progress must count up 1/17 → 17/17, not shrink
      return q.items.some(drop) ? { ...q, items: q.items.filter((i) => !drop(i)) } : q
    })
  }, [queues, rows])
}

/** The first not-yet-complete station task for a VIN (queues in creation order). */
export function activeProcess(vin: string, queues: WorkQueue[]): { queue: WorkQueue; item: QueueItem } | null {
  for (const q of queues) {
    const item = q.items.find((i) => i.vin === vin && !i.done)
    if (item) return { queue: q, item }
  }
  return null
}

export const stageOf = (item: QueueItem): QueueStage => item.stage ?? 'queued'

/** A Grouping-to-Dealer delivery sequence. `kind` is dropped on the cloud
 *  round-trip (no column), so fall back to the per-item laneLoad which lives in
 *  the items JSONB and always survives. */
/**
 * Is this an arrival lot (the queues the gate works through)?
 *
 * Shared so the Dashboard card, the Gate In/Out board and the Ops-Scan station
 * all pick out the same queues instead of each re-deriving the rule.
 *
 * Identity is the queue's TYPE, not its name. Import names a lot
 * "(yard · date · N)" and the rule used to be "name starts with (" — so the
 * moment the office renamed a lot to something meaningful it stopped counting
 * as an arrival lot and vanished from the board and from every phone at the
 * gate. The name is a label; the type is what the lot IS. Lots created before
 * the type existed still resolve by name through queueTypeOf.
 */
export const isPreGateInQueue = (q: WorkQueue): boolean => queueTypeOf(q) === 'GATEIN'

export const isSequenceQueue = (q: WorkQueue): boolean =>
  q.kind === 'sequence' || q.items.some((i) => i.laneLoad != null || i.dest != null)

/** Delivery-sequence stage for one car: queued → wash → lane → gated-out. */
export function seqStageOf(i: QueueItem): 'queued' | 'wash' | 'lane' | 'gateout' {
  if (i.gatedOut) return 'gateout'
  if (i.atLaneAt) return 'lane'
  if (i.atWashAt) return 'wash'
  return 'queued'
}

/** Has this car actually come through the gate, per the tracking sheet?
 *  Blank status counts as still waiting; a car that has since gated out still
 *  arrived once, so it counts too. Same test the reconciler sorts rows with. */
export function hasArrived(cells: Record<string, string>): boolean {
  if (hasLeftGate(cells)) return true
  const cs = (cells['Car Status'] || '').trim()
  return !!cs && cs.toLowerCase() !== 'pre gate-in'
}

/**
 * Has this arrival-lot car actually come through the gate?
 *
 * Read from the CAR'S OWN status, never the item's tick flag. The flag is
 * written by whichever device reconciles first and can be written back by
 * another whose copy of the sheet is a minute behind, so the same lot read
 * 544/545 on the ops-scan station and 410/545 on the admin board — the station
 * counted flags, the board counted cars. The car's status cannot flap, and it
 * is the source the Dashboard headline already uses. A VIN with no sheet row
 * falls back to the flag; there is nothing else to read.
 */
export function gateInArrived(i: QueueItem): boolean {
  const cells = useTracking.getState().rows[i.vin]?.cells
  return cells ? hasArrived(cells) : i.done
}

/** The cars of a Pre Gate-in lot still waiting at the gate (same rule). */
export function gateInPendingItems(q: WorkQueue): QueueItem[] {
  return q.items.filter((i) => !gateInArrived(i))
}

export function queueProgress(q: WorkQueue) {
  const total = q.items.length
  // ── Pre Gate-in lots count the CARS, not the tick flag ──
  // The flag is written by whichever device reconciles first and can be written
  // back by another whose copy of the sheet is a minute behind — the board
  // flapped between "15/100" and "100/100" on the same lot. The car's own Car
  // Status cannot flap, and it is the very source the Dashboard headline
  // ("ยังไม่เข้าลาน") already counts, so the headline and the per-lot lines
  // finally agree instead of reading 90 above and 177 below.
  // A VIN with no sheet row falls back to the flag — there is nothing to read.
  if (isPreGateInQueue(q)) {
    const rows = useTracking.getState().rows
    const done = q.items.reduce((n, i) => {
      const cells = rows[i.vin]?.cells
      return n + (cells ? (hasArrived(cells) ? 1 : 0) : (i.done ? 1 : 0))
    }, 0)
    return { total, done, remaining: total - done, pct: total ? Math.round((done / total) * 100) : 0 }
  }
  // count the way the STATION counts (stationProgress): a car is progress the
  // moment its OK/NG is recorded ('checked'), not only after a driver returns
  // it to a slot — the admin board read 0/67 while the field read 3/67.
  const done = q.items.reduce((n, i) => n + (i.done || stageOf(i) === 'checked' ? 1 : 0), 0)
  return { total, done, remaining: total - done, pct: total ? Math.round((done / total) * 100) : 0 }
}

/** A drive left open for this long (driver closed the app mid-trip, never
 *  pressed "ถึงแล้ว") is stale — stop showing the car as being driven. */
const DRIVING_TTL_MS = 4 * 60 * 60 * 1000

/** The driver currently behind the wheel of this car, or undefined. */
export function drivingNow(i: QueueItem): string | undefined {
  if (!i.drivingBy || i.done) return undefined
  return i.drivingAt && Date.now() - i.drivingAt > DRIVING_TTL_MS ? undefined : i.drivingBy
}

/**
 * Progress of a STATION queue (PM / PDI / FINAL CHECK) as the station sees it:
 * a car counts the moment its OK/NG is recorded. `done` alone only flips when
 * the driver has taken the car back to a parking slot — a separate job — so the
 * station's own counter sat at 0/20 with cars already inspected.
 */
export function stationProgress(q: WorkQueue) {
  const total = q.items.length
  const done = q.items.reduce((n, i) => n + (i.done || stageOf(i) === 'checked' ? 1 : 0), 0)
  return { total, done, remaining: total - done }
}

/**
 * Has this delivery-run car finished its gate work?
 *
 * Read from the LIVE sheet status first, exactly like gateInArrived does for
 * arrivals. The item's own `gatedOut`/`done` flag is written by whichever device
 * handled the car, and a device that gates a car out by another path (plain
 * Gate-out screen, an import) never sets it — so the run card, which has always
 * read the live status, showed "62/62 คัน · เหลือ 0" while the flags said
 * otherwise and the run stayed on the board with nothing left to do.
 */
export function seqCarGone(i: QueueItem): boolean {
  if (i.gatedOut || i.done) return true
  const cells = useTracking.getState().rows[i.vin]?.cells
  return !!cells && hasLeftGate(cells)
}

/** A queue is "complete" once every car in it is done (gated-in / gated-out).
 *  Complete queues drop off the live views and file under their creation day. */
export function isQueueComplete(q: WorkQueue): boolean {
  // An EMPTY delivery run / arrival lot is FINISHED, not "0% done". Both are
  // created with their cars in one go (the DN import, the arrival file), so
  // empty means the cars left it afterwards — delivered, or taken out by hand.
  // Reading that as unfinished is what left "0/0 คัน · เหลือ 0" cards sitting
  // on the Gate-out board for ever with no work in them and no way off.
  // Station queues (PM / PDI / …) are exempt: those really are built empty and
  // filled by hand, and must not vanish between the two steps.
  if (!q.items.length) return isSequenceQueue(q) || isPreGateInQueue(q)
  // A Pre Gate-in lot is finished when its CARS are all in, not when the tick
  // flag says so — the flag is written back and forth between devices, which
  // made a finished lot flicker on and off the boards (see queueProgress).
  if (isPreGateInQueue(q)) { const { total, done } = queueProgress(q); return done >= total }
  // …and a delivery run when its cars have all LEFT, by the same reasoning
  if (isSequenceQueue(q)) return q.items.every(seqCarGone)
  return q.items.every((i) => i.done)
}

/** The STATION's work on a queue is finished: every car is done or at least
 *  checked (OK/NG recorded). Such a queue reads "เหลือ 0" on the station
 *  counter but never satisfied isQueueComplete while cars sat checked-but-not-
 *  returned — so it lingered on the station and driver lists forever. */
export function isStationWorkComplete(q: WorkQueue): boolean {
  return q.items.length > 0 && q.items.every((i) => i.done || stageOf(i) === 'checked')
}

/** Aggregate across all queues — gated-out cars excluded so the stat cards
 *  match the queue rows below them. */
export function useOpsTotals() {
  const queues = useActiveQueues()
  return useMemo(() => {
    let vehicles = 0, done = 0
    for (const q of queues) { vehicles += q.items.length; done += q.items.reduce((n, i) => n + (i.done ? 1 : 0), 0) }
    return { queues: queues.length, vehicles, done, remaining: vehicles - done }
  }, [queues])
}
