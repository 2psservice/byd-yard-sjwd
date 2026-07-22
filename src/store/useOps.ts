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
import { PM_KEYS } from '../lib/trackingColumns'

/** Process stage of one vehicle within a station queue (PDI / PM / Wash …).
 *  queued → (driver delivers) at-station → (staff records) checked → (driver returns) done. */
export type QueueStage = 'queued' | 'at-station' | 'checked'

/** Work category of a queue — drives the icon and, more importantly, WHERE a
 *  completed car's date is stamped back into the tracking sheet (its Overview):
 *   PM → the next empty PM1…PM15 slot · PDI → the "PDI" date ·
 *   FINAL → "Final check date" (+ Final Status) · WASH / SPECIAL → no cell,
 *   the completion is only recorded in the car's Event log. */
export type QueueType = 'PDI' | 'PM' | 'FINAL' | 'WASH' | 'SPECIAL'

/** Preset work types offered on the Operation page (order = button order). */
export const QUEUE_TYPES: { type: QueueType; name: string; th: string }[] = [
  { type: 'PM', name: 'PM', th: 'PM' },
  { type: 'PDI', name: 'PDI', th: 'PDI' },
  { type: 'FINAL', name: 'FINAL CHECK', th: 'FINAL CHECK' },
  { type: 'WASH', name: 'Wash for sale', th: 'Wash for sale' },
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
  deliveredBy?: string     // driver who drove the car TO the station
  deliveredAt?: number
  checkedBy?: string       // staff who recorded OK / NG at the station
  checkedAt?: number
  returnedBy?: string      // driver who drove the car back to a parking slot
  returnedAt?: number
  // ── delivery sequence (Grouping to Dealer) ──
  laneLoad?: string        // loading-lane target, from the grouping Lane load (e.g. "O1")
  dest?: string            // delivery / dealer location
  atWashAt?: number        // driver scan #1: car moved to Wash for sale
  atLaneAt?: number        // driver scan #2: car moved from Wash for sale to its loading lane
  gatedOut?: boolean       // gate-out confirmed → Car Status set to Gate-out
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
  const n = q.name.toLowerCase()
  if (n.includes('final')) return 'FINAL'
  if (n.includes('pdi')) return 'PDI'
  if (n.includes('wash')) return 'WASH'
  if (/\bpm\b|^pm|pm[\s·-]/.test(n) || n.startsWith('pm')) return 'PM'
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
function stampOverview(q: WorkQueue, vin: string, result?: 'OK' | 'NG'): boolean {
  const type = queueTypeOf(q)
  if (type === 'WASH' || type === 'SPECIAL') return false // event-log only, no cell
  const tr = useTracking.getState()
  const row = tr.rows[vin]
  if (!row) return false
  const d = todayCell()
  if (type === 'PM') {
    const slot = PM_KEYS.find((k) => !(row.cells[k] || '').trim())
    if (!slot) return false // all 15 PM slots already used
    tr.updateCell(vin, slot, d)
    return true
  }
  if (type === 'PDI') {
    // 1st PDI → "PDI"; each redo → next empty RE-PDI slot (Re-PDI 1…8)
    const slot = PDI_KEYS.find((k) => !(row.cells[k] || '').trim())
    if (!slot) return false // PDI + all 8 re-PDI slots already used
    tr.updateCell(vin, slot, d)
    return true
  }
  // FINAL — stamp the done-date into "Final check date"
  tr.updateCell(vin, 'Final check date', d)
  return true
}

let qid = 0

interface OpsState {
  queues: WorkQueue[]
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
  toggleDone: (id: string, vin: string, by?: string) => void
  setAllDone: (id: string, done: boolean, by?: string) => void
  clearQueues: () => void
  // process flow
  deliverToStation: (id: string, vin: string, fromSlot?: string, by?: string) => void
  recordCheck: (id: string, vin: string, result: 'OK' | 'NG', by?: string) => void
  returnToSlot: (id: string, vin: string, by?: string) => void
  // ── delivery sequence (Grouping to Dealer) ──
  createSequence: (name: string, by: string, items: { vin: string; laneLoad?: string; dest?: string }[]) => string
  markAtWash: (id: string, vin: string, by?: string) => void        // driver scan #1
  markAtLane: (id: string, vin: string, by?: string) => void        // driver scan #2
  confirmSeqGateOut: (id: string, vin: string, by?: string) => void // gate-out confirmed
  /** Pull queues from the cloud. authoritative=true replaces local even when the cloud is empty
   *  (broadcast refetch); false = boot merge (cloud wins when non-empty, else seed local up). */
  loadFromCloud: (authoritative?: boolean) => Promise<void>
}

/** Push one queue to the cloud + tell other clients to refetch (fire-and-forget). */
function pushQueue(get: () => OpsState, id: string) {
  const q = get().queues.find((x) => x.id === id)
  if (!q) return
  db.upsertOpsQueue(q).then(() => sendSync('ops')).catch((e) => console.error('[db] pushQueue', e))
}

export const useOps = create<OpsState>()(
  persist(
    (set, get) => ({
      queues: [],

      createQueue: (name, by, site) => {
        const n = name.trim()
        if (!n) return ''
        const existing = get().queues.find((q) => q.name.toLowerCase() === n.toLowerCase())
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
        let id = get().queues.find((q) => q.name.toLowerCase() === n.toLowerCase())?.id ?? ''
        if (!id) id = `q${++qid}${now}`
        set((s) => {
          const base = s.queues.some((q) => q.id === id)
            ? s.queues
            : [...s.queues, { id, name: n, createdAt: now, createdBy: by, items: [] as QueueItem[], site: siteTag }]
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
        return id
      },

      createTypedQueue: (type, name, by, site) => {
        const siteTag = site ?? useYard.getState().currentSite ?? undefined
        const base = (name || '').trim() || (QUEUE_TYPES.find((t) => t.type === type)?.name ?? type)
        // unique display name within this yard: "PM", "PM 2", "PM 3" …
        const taken = new Set(
          get().queues.filter((q) => (q.site ?? null) === (siteTag ?? null)).map((q) => q.name.toLowerCase()),
        )
        let n = base
        for (let k = 2; taken.has(n.toLowerCase()); k++) n = `${base} ${k}`
        const id = `q${++qid}${Date.now()}`
        set((s) => ({ queues: [...s.queues, { id, name: n, type, createdAt: Date.now(), createdBy: by, items: [], site: siteTag }] }))
        pushQueue(get, id)
        return id
      },

      removeQueue: (id) => {
        set((s) => ({ queues: s.queues.filter((q) => q.id !== id) }))
        db.deleteOpsQueue(id).then(() => sendSync('ops')).catch((e) => console.error('[db] removeQueue', e))
      },

      renameQueue: (id, name) => {
        set((s) => ({ queues: s.queues.map((q) => (q.id === id ? { ...q, name: name.trim() || q.name } : q)) }))
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
        return { added, dup }
      },

      removeVin: (id, vin) => {
        set((s) => ({ queues: s.queues.map((q) => (q.id === id ? { ...q, items: q.items.filter((i) => i.vin !== vin) } : q)) }))
        pushQueue(get, id)
      },

      toggleDone: (id, vin, by) => {
        const q = get().queues.find((x) => x.id === id)
        const it = q?.items.find((i) => i.vin === vin)
        // becoming done for the first time → stamp its date into the Overview
        const wrote = q && it && !it.done && !it.stamped ? stampOverview(q, vin, it.result) : false
        set((s) => ({
          queues: s.queues.map((qq) =>
            qq.id === id
              ? { ...qq, items: qq.items.map((i) => (i.vin === vin ? { ...i, done: !i.done, doneAt: !i.done ? Date.now() : undefined, doneBy: !i.done ? by : undefined, stamped: i.stamped || wrote } : i)) }
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
        set({ queues: [] })
        db.clearOpsQueues().then(() => sendSync('ops')).catch((e) => console.error('[db] clearQueues', e))
      },

      // ── process flow ──────────────────────────────────────────────────────
      deliverToStation: (id, vin, fromSlot, by) => {
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id
              ? { ...q, items: q.items.map((i) => (i.vin === vin ? { ...i, stage: 'at-station', fromSlot, deliveredBy: by, deliveredAt: Date.now() } : i)) }
              : q,
          ),
        }))
        pushQueue(get, id)
      },

      recordCheck: (id, vin, result, by) => {
        set((s) => ({
          queues: s.queues.map((q) =>
            q.id === id
              ? { ...q, items: q.items.map((i) => (i.vin === vin ? { ...i, stage: 'checked', result, checkedBy: by, checkedAt: Date.now(), doneBy: by } : i)) }
              : q,
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
              ? { ...qq, items: qq.items.map((i) => (i.vin === vin ? { ...i, done: true, doneAt: Date.now(), doneBy: by ?? i.doneBy, returnedBy: by, returnedAt: Date.now(), stamped: i.stamped || wrote } : i)) }
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
          .map((it) => ({ vin: it.vin.trim().toUpperCase(), laneLoad: it.laneLoad, dest: it.dest }))
          .filter((it) => it.vin)
          .map((it) => ({ vin: it.vin, addedAt: now, done: false, laneLoad: it.laneLoad, dest: it.dest }))
        const existing = get().queues.find((q) => q.name.toLowerCase() === n.toLowerCase())
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

      loadFromCloud: async (authoritative = false) => {
        const cloud = await db.fetchOpsQueues()
        if (cloud === null) return // table missing / offline — keep local state
        if (cloud.length) set({ queues: cloud })
        else if (authoritative) set({ queues: [] }) // e.g. another device cleared all
        else {
          // first run: cloud empty → seed it from this device's local queues
          const local = get().queues
          if (local.length) await Promise.all(local.map((q) => db.upsertOpsQueue(q)))
        }
      },
    }),
    { name: 'sjwd-ops' },
  ),
)

// another client changed a queue → refetch (cloud is authoritative on broadcast)
onSync('ops', () => { useOps.getState().loadFromCloud(true).catch((e) => console.error('[ops] sync pull', e)) })

// ── keep queues honest about gate-outs (data-level, one place) ───────────────
// A car whose LIVE Car Status says Gate-out is finished work in EVERY queue,
// no matter how it left (ops-scan, co-inspection import, re-import): mark its
// items gatedOut+done. Ordinary queues then hide the row entirely (filter
// below); a delivery sequence keeps it — grey "gate out" — so the run counts
// 1/17 → 17/17. Runs debounced whenever tracking data changes.
let reconcileTimer: ReturnType<typeof setTimeout> | null = null
function reconcileGateOuts() {
  const rows = useTracking.getState().rows
  const gone = new Set<string>()
  for (const vin in rows) if (isGoneStatus(rows[vin].cells['Car Status'])) gone.add(vin)
  if (!gone.size) return
  const dirty: string[] = []
  const next = useOps.getState().queues.map((q) => {
    let changed = false
    const items = q.items.map((i) => {
      if (!gone.has(i.vin) || (i.done && i.gatedOut)) return i
      changed = true
      return { ...i, gatedOut: true, done: true, doneAt: i.doneAt ?? Date.now() }
    })
    if (!changed) return q
    dirty.push(q.id)
    return { ...q, items }
  })
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

/** A car that has left the yard (gate-out) is no longer pending work. */
function isGoneStatus(s?: string): boolean {
  const v = (s ?? '').trim().toLowerCase()
  return v === 'gate-out' || v === 'gate out'
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
    for (const vin in rows) if (isGoneStatus(rows[vin].cells['Car Status'])) gone.add(vin)
    if (!gone.size) return queues
    return queues.map((q) => {
      if (isSequenceQueue(q)) return q // sequence runs keep gated-out cars for progress
      return q.items.some((i) => gone.has(i.vin)) ? { ...q, items: q.items.filter((i) => !gone.has(i.vin)) } : q
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
export const isSequenceQueue = (q: WorkQueue): boolean =>
  q.kind === 'sequence' || q.items.some((i) => i.laneLoad != null || i.dest != null)

/** Delivery-sequence stage for one car: queued → wash → lane → gated-out. */
export function seqStageOf(i: QueueItem): 'queued' | 'wash' | 'lane' | 'gateout' {
  if (i.gatedOut) return 'gateout'
  if (i.atLaneAt) return 'lane'
  if (i.atWashAt) return 'wash'
  return 'queued'
}

export function queueProgress(q: WorkQueue) {
  const total = q.items.length
  const done = q.items.reduce((n, i) => n + (i.done ? 1 : 0), 0)
  return { total, done, remaining: total - done, pct: total ? Math.round((done / total) * 100) : 0 }
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
