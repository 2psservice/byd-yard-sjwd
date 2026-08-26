import { useMemo } from 'react'
import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type {
  AppUser, Block, Damage, DamageInput, GpsPoint, Lang, ParkingPolicy, Site, SlotCandidate, Trailer, Trip, Unit, UserRole, VehicleModel, View,
} from '../types'
import { BLOCKS, DEFAULT_POLICIES, MODELS, generateSample, matchModel, paintHex } from '../lib/sampleData'
import { autoAssign, nextFreeSlotInBlock } from '../lib/parkingEngine'
import { haversineM, makeDemoTrip, mulberry32, slotToLatLng } from '../lib/geo'
import { IN_YARD_STATUSES } from '../lib/carStatus'
import type { RawRow } from '../lib/excel'
import type { DefectRow, TrackRow } from '../lib/excelTracking'
import * as db from '../lib/db'
import { useUnitsView } from './useUnitsView'
import { idbGetAllUnits, idbPutUnits, idbDeleteUnits } from '../lib/idb'
import { onSync, sendSync, type MoveMsg, type MovesPayload } from '../lib/syncBus'
import { hashPassword, verifyPassword, isHashed } from '../lib/password'
import { resolvePart, resolveDefect } from '../lib/masterDefect'
import { supabase } from '../lib/supabase'
import { blockKeyOfTag, pos as posCode } from '../lib/format'
import { laneFromCloud } from '../lib/laneCloud'
import type { DbDamage, DbUnit } from '../lib/database.types'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface Toast { id: number; kind: 'ok' | 'err' | 'info'; msg: string }
let tid = 0

/** Put the Unit List in a state where a drill-down's cars are actually visible:
 *  the Units tab, with the leftover search / grouping / per-column filters
 *  cleared so nothing silently ANDs the result down to zero rows. */
const revealUnitList = () => {
  useUnitsView.getState().patch({ tab: 'units', q: '', fGroup: '', colFilters: {} })
}

/** Append a move line to the car's tracking-row history (same trail ops scan and
 *  the admin Event tab read). Lazy import — useTracking reads useYard. */
function logMoveEvent(vin: string, by: string, from: string, to: string): void {
  import('./useTracking')
    .then((m) => m.useTracking.getState().appendHistory(vin, { at: Date.now(), by, field: 'Location', from, to }))
    .catch(() => {})
}

/** Append a damage audit line to the car's tracking-row history so it shows in
 *  the admin Unit → Event tab and survives the damage being deleted. Loaded
 *  lazily to avoid a static import cycle with useTracking (which reads useYard). */
function logDamageEvent(vin: string, text: string, by: string): void {
  import('./useTracking')
    .then((m) => m.useTracking.getState().appendHistory(vin, { at: Date.now(), by, field: '__damage', from: '', to: text }))
    .catch(() => {})
}

// live channel + per-vin last-applied timestamp (echo / stale-write guard)
let unitsChannel: RealtimeChannel | null = null
// the units websocket can silently die on a long-open screen (admin's yard
// plan) — remember a drop so the re-subscribe catches up on missed moves
let unitsHadDrop = false
const unitTs = new Map<string, number>()

// How many times loadFromSupabase has failed in a row, and the pending retry.
// Module scope so concurrent callers share one backoff and one timer instead of
// each starting its own retry loop against an already-struggling database.
let loadRetry = 0
let loadRetryTimer: ReturnType<typeof setTimeout> | null = null

/** A unit whose `model` is the CANONICAL policy id. The stored model can be
 *  empty (placeholder unit) or non-canonical ("BYD ATTO 2" vs "ATTO2"), which
 *  makes the parking policy fall back to "any block". Always re-derive it via
 *  matchModel (the same keying the Rules page uses) so allowed-blocks holds. */
function withModelId(u: Unit): Unit {
  const model = matchModel(u.modelName || u.model || '').id
  return model === u.model ? u : { ...u, model }
}

/** Deepest lane the parking engine may fill. The setting is a global ceiling —
 *  each block is still limited by its OWN row count (`block.rows`), so raising
 *  this alone does not make a 8-row block stack 20 deep. */
export const MAX_LANE_DEPTH = 20

// ── ตำแหน่งรถ: ระบบห้ามแตะ ────────────────────────────────────────────────────
// เดิมมี "lane compaction" คอยเลื่อนรถขึ้นมาปิดช่องว่างในเลนเองอัตโนมัติ (คันที่
// 3 เลื่อนขึ้นเป็นคันที่ 2 เมื่อคันหน้าออกไป) แล้วเขียนตำแหน่งใหม่ขึ้น cloud
// โดยไม่บันทึกประวัติ — หน้างานตั้ง R7 ไว้ กลับมาดูอีกทีรถไปอยู่ R9 หารถไม่เจอ
// ตอนนี้เอาออกทั้งหมด: ตำแหน่งรถเปลี่ยนได้ทางเดียวคือพนักงาน / ops scan / admin
// สั่งเอง ช่องว่างที่รถออกไปแล้วปล่อยไว้ตามจริง แล้วให้ nextFreeSlotInBlock มา
// เติมเองตอนจอดคันใหม่

// ── Defect import helpers (Defect-Yard / Defect-Factory → Damage) ───────────
function defHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const DEF_MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
function parseDefDate(s?: string): number | undefined {
  if (!s) return undefined
  const t = s.trim(); if (!t) return undefined
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)            // 2026-06-29
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)    // 29/06/2026 (d/m/y)
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]).getTime() }
  m = t.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{2,4})$/) // 29-Jun-26
  if (m) { const mo = DEF_MONTHS[m[2].toLowerCase()]; if (mo != null) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(y, mo, +m[1]).getTime() } }
  return undefined
}
/** Map a defect-sheet row to a Damage. Deterministic id → re-import replaces, no
 *  dupes. The id hashes EVERY field so two rows that differ in any column (e.g.
 *  category / incharge / status) stay distinct — only byte-identical rows share a
 *  base id, and importDefects then suffixes those so none are lost. */
function defectToDamage(def: DefectRow): Damage {
  const id = `df_${def.source}_${defHash([
    def.vin, def.position ?? '', def.defect ?? '', def.date ?? '',
    def.categoryNG ?? '', def.categoryRepair ?? '', def.incharge ?? '',
    def.statusRepair ?? '', def.repairDate ?? '', def.from ?? '',
    def.stockOfStatus ?? '', def.model ?? '', def.remark ?? '',
  ].join('|'))}`
  return {
    id,
    area: def.position || '—',
    // Defect/NG text; when the source cell is blank fall back to category → position
    // → '—' so the row is never the ugly literal "defect"
    type: def.defect || def.categoryNG || def.position || '—',
    item: def.defect || undefined,
    severity: /heavy/i.test(def.categoryNG ?? '') ? 'major' : 'minor',
    at: parseDefDate(def.date) ?? Date.now(),
    by: def.source === 'yard' ? 'Defect-Yard' : def.source === 'factory' ? 'Defect-Factory' : 'Defect-Whale',
    source: def.source === 'yard' ? 'yardDefect' : def.source === 'factory' ? 'factoryDefect' : 'whaleDefect',
    note: [def.from, def.stockOfStatus, def.remark].filter(Boolean).join(' · ') || undefined,
    categoryNG: (def.categoryNG as Damage['categoryNG']) || undefined,
    categoryRepair: (def.categoryRepair as Damage['categoryRepair']) || undefined,
    incharge: (def.incharge as Damage['incharge']) || undefined,
    statusRepair: (def.statusRepair as Damage['statusRepair']) || undefined,
    repairDate: parseDefDate(def.repairDate),
  }
}

interface YardState {
  // --- settings ---
  lang: Lang
  planMode: 'AUTO' | 'SEMI'
  currentUser: string
  currentDriver: string
  groupModelsInRow: boolean
  laneDepth: number // max cars stacked per lane (ช่อง) before the engine opens the next lane, 1…MAX_LANE_DEPTH
  appUsers: AppUser[]
  view: View
  unitPreset: string | null // dashboard → Unit List quick filter ('inYard'|'parked'|'gatein'|'expected'|'damage')
  unitVinFilter: { label: string; vins: string[] } | null // drill-down → Unit List filtered to an explicit VIN set (e.g. a PM-plan cell)

  // --- sites ---
  sites: Site[]
  currentSite: string | null
  siteModalOpen: boolean

  // --- data ---
  units: Record<string, Unit>
  trailers: Trailer[]
  models: VehicleModel[]
  blocksBySite: Record<string, Block[]>
  policies: ParkingPolicy[]
  trips: Trip[]

  // --- transient ---
  toasts: Toast[]
  focus: string | null

  // --- setters ---
  setLang: (l: Lang) => void
  setView: (v: View) => void
  setUnitPreset: (p: string | null) => void
  setUnitVinFilter: (f: { label: string; vins: string[] } | null) => void
  setPlanMode: (m: 'AUTO' | 'SEMI') => void
  setUser: (u: string) => void
  setDriver: (d: string) => void
  loggedInUserId: string | null
  loginAt: number | null // session start — day-change auto-logout compares this to "today"
  addAppUser: (name: string, role: UserRole, username: string, password: string) => void
  updateAppUser: (id: string, patch: Partial<Pick<AppUser, 'name' | 'role' | 'active' | 'username' | 'password'>>) => void
  removeAppUser: (id: string) => void
  loadAppUsersFromCloud: () => Promise<void>
  login: (username: string, password: string) => Promise<boolean>
  logout: () => void
  setGroupModels: (b: boolean) => void
  setLaneDepth: (n: number) => void
  toast: (kind: Toast['kind'], msg: string) => void
  dismissToast: (id: number) => void
  setFocus: (vin: string | null) => void

  // --- sites ---
  addSite: (name: string, code?: string) => void
  updateSite: (id: string, patch: { name?: string; code?: string }) => void
  removeSite: (id: string) => void
  setCurrentSite: (id: string) => void
  openSiteModal: () => void
  closeSiteModal: () => void

  // --- data ops ---
  importUnits: (rows: RawRow[]) => { added: number; updated: number }
  loadSample: () => void
  clearAll: () => void
  removeUnit: (vin: string) => void
  /** Gate-out: mark the car DEPARTED and release its parking slot. */
  markDeparted: (vin: string) => void
  /** Gate-out a whole DN in one shot — same as markDeparted per car, but ONE
   *  state update + ONE cloud write, so a 124-car delivery run does not fire
   *  124 renders and 124 upserts. */
  markDepartedMany: (vins: string[]) => void
  markTrailerArrived: (no: number, arrived?: boolean) => void
  gateIn: (vin: string) => void
  setInspected: (vin: string, v: boolean) => void
  addDamage: (vin: string, d: DamageInput) => void
  /** Defects whose cloud write never landed (retries exhausted — dead network,
   *  backgrounded mid-save). Kept until flushPendingDamages() confirms them, so
   *  a full units re-pull (visibilitychange / online / next login) doesn't
   *  silently overwrite the local-only defect and make it look "never saved". */
  pendingDamages: Record<string, { vin: string; dmg: Damage }>
  /** Retry every still-unconfirmed defect write. Safe to call anytime — a no-op
   *  when the queue is empty or a flush is already in flight. */
  flushPendingDamages: () => Promise<void>
  removeDamage: (vin: string, id: string) => void
  updateDamage: (vin: string, id: string, patch: Partial<import('../types').Damage>) => void
  updateRepairStatus: (vin: string, id: string, status: string) => void
  addManualDamage: (vin: string, f: { position?: string; defect?: string; categoryNG?: string; categoryRepair?: string; incharge?: string; note?: string; date?: string; statusRepair?: string; repairDate?: string; severity?: 'minor' | 'major'; photos?: string[] }) => void
  /** Add the SAME manual defect to many VINs at once (Unit List bulk action).
   *  `source` routes it to the right Report sheet (yardDefect → Defect-Yard,
   *  factoryDefect → Defect-Factory); defaults to 'manual' (→ Defect-Yard). */
  addManualDamageBulk: (vins: string[], f: { position?: string; defect?: string; categoryNG?: string; categoryRepair?: string; incharge?: string; note?: string; date?: string; statusRepair?: string; repairDate?: string; severity?: 'minor' | 'major'; source?: import('../types').DamageSource }) => number
  suggest: (vin: string) => SlotCandidate | null
  assign: (vin: string, slot: { block: string; row: number; slot: number }, driver?: string, mode?: 'AUTO' | 'SEMI') => void
  confirmParked: (vin: string) => void
  resetParking: (vin: string) => void
  /** Update Location import — bulk place cars into block/row/slot as PARKED. */
  /** Move cars. `from` (where the caller SAW the car when it decided) turns the
   *  write into a compare-and-set: the move lands only if the car is still
   *  there, so two phones acting on the same lane a moment apart cannot
   *  overwrite each other. Omit it and the write is unconditional, as before. */
  updateLocations: (items: {
    vin: string; block: string; row: number; slot: number
    modelName?: string; color?: string; gateInAt?: number
    from?: { block?: string; row?: number; slot?: number }
  }[]) => number
  autoParkAll: () => number
  /** Auto-park every listed VIN into the WCL staging block that doesn't
   *  already have a real block/row/slot — leaves already-positioned units
   *  untouched. Used to backfill legacy "Gate-in" cars onto the same WCL
   *  placement a fresh gate-in now gets. Returns how many were placed.
   *  @param siteId park against THIS site's WCL block/occupancy instead of
   *  the currently-selected site — the caller must pre-group vins by site,
   *  since a car can only be positioned using its own yard's block layout. */
  parkUnpositionedAtWcl: (vins: string[], siteId?: string) => number
  setPolicy: (model: string, patch: Partial<ParkingPolicy>) => void
  loadPolicies: () => Promise<void>
  // --- yard layout editor ---
  addBlock: (b?: Partial<Block>) => string
  updateBlock: (id: string, patch: Partial<Block>) => void
  removeBlock: (id: string) => void
  /** Rename a block's internal id (badge letter). Returns the applied id, or null when empty/duplicate. */
  // --- gps ---
  startTrip: (vin: string, driver: string, from: string, to: string) => void
  appendGps: (vin: string, p: GpsPoint, sim?: boolean) => void
  endTrip: (vin: string) => void
  purgeNonTracking: (realVins: Set<string>) => void
  ensureUnitSites: () => void
  /** Give every car on a shared square its own คันที่ — same lane only, never a
   *  different ช่อง. Returns how many cars were re-numbered. */
  dedupeSlots: () => Promise<number>
  /** Re-read VIN + position for this yard from the cloud and adopt what it says,
   *  so every device converges on the same plan even if a realtime event dropped. */
  refreshPlacements: () => Promise<number>
  // --- supabase ---
  loadFromSupabase: () => Promise<void>
  /** boot cache: fill the yard plan from IndexedDB before the network answers */
  loadUnitsFromIdb: () => Promise<void>
  /** true once the cloud's units for the active site have fully landed —
   *  the Yard Plan shows its "ไม่แสดงบนผัง" number only when it's FINAL */
  unitsCloudDone: boolean
  /** true only while the units Realtime channel is actually SUBSCRIBED — the
   *  header's "Connected" pill used to be a hardcoded label with no relation
   *  to the real websocket, so a device whose socket silently died (flaky
   *  yard wifi) kept showing "Connected" forever with no cue to refresh,
   *  while its yard-plan positions quietly drifted out of sync with other
   *  devices. */
  unitsRealtimeConnected: boolean
  subscribeRealtime: () => void
  unsubscribeRealtime: () => void
  // --- co-inspection defects ---
  /** @param onProgress 0–100 with a Thai phase label, for the import screen's bar */
  importDefects: (defects: DefectRow[], trackingRows: Record<string, TrackRow>, onProgress?: (pct: number, label: string) => void) => Promise<{ units: number; damages: number }>
}

/** Next free block id — single letters A–Z, then B1, B2… */
function nextBlockId(blocks: Block[]): string {
  const used = new Set(blocks.map((b) => b.id))
  for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); if (!used.has(c)) return c }
  let n = 1; while (used.has('Z' + n)) n++; return 'Z' + n
}

const siteKey = (site: string | null) => site ?? '_global'
const curBlocks = (s: { blocksBySite: Record<string, Block[]>; currentSite: string | null }): Block[] =>
  s.blocksBySite[siteKey(s.currentSite)] ?? []

/** Universal Gate-in staging block — every model auto-parks here first, then
 *  moves to its real slot later via Re-location. A car sitting here is waiting
 *  in preload, NOT parked in a real yard slot, so counts of "cars in a slot"
 *  must exclude it (see the Yard Plan headline). */
export const WCL_STAGING_BLOCK = 'WCL'

// ── yard-plan layout → cloud (debounced: updateBlock fires per drag-frame) ──
let blockSyncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleBlockSync(get: () => { currentSite: string | null; blocksBySite: Record<string, Block[]> }) {
  if (blockSyncTimer) clearTimeout(blockSyncTimer)
  blockSyncTimer = setTimeout(() => {
    blockSyncTimer = null
    const s = get()
    const sid = s.currentSite
    if (!sid || !db.isConfigured()) return // '_global' layout (no site picked) stays local
    db.replaceBlocks(sid, s.blocksBySite[siteKey(sid)] ?? [])
      .then(() => sendSync('blocks', { siteId: sid })) // other clients refetch this yard's layout
      .catch((e) => console.error('[db] syncBlocks', e))
  }, 1200)
}

// ── pending-defect retry (self-rescheduling, backs off while offline) ──────
let pendingDamagesTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Re-attach this device's not-yet-synced defects onto a unit fetched from the
 * cloud. Every "adopt the cloud copy wholesale" merge must pass through here:
 * a defect still waiting in pendingDamages exists ONLY in local state, so a
 * bare `units[u.vin] = cloudCopy` erased it from the screen — and the flusher
 * then read that absence as "already landed" and dropped it from the queue
 * too. That pair is how a station saw "บันทึก Defect แล้ว" and minutes later
 * the defect (photos and all) was gone everywhere.
 */
export function attachPendingDamages(
  pending: Record<string, { vin: string; dmg: Damage }>, u: Unit,
): Unit {
  const extra = Object.values(pending)
    .filter((p) => p.vin === u.vin && !u.damages.some((x) => x.id === p.dmg.id))
    .map((p) => p.dmg)
  return extra.length ? { ...u, damages: [...u.damages, ...extra] } : u
}

let pendingDamagesFlushing = false
function scheduleFlushPendingDamages(get: () => { flushPendingDamages: () => Promise<void>; pendingDamages: Record<string, unknown> }, delay = 15_000) {
  if (pendingDamagesTimer) clearTimeout(pendingDamagesTimer)
  pendingDamagesTimer = setTimeout(() => {
    pendingDamagesTimer = null
    get().flushPendingDamages().finally(() => {
      // still something left (offline / retry failed again) — keep trying
      if (Object.keys(get().pendingDamages).length) scheduleFlushPendingDamages(get, Math.min(delay * 1.5, 60_000))
    })
  }, delay)
}

// zustand's persist middleware JSON.stringifies + writes the ENTIRE persisted
// slice to localStorage synchronously on every single `set()` call. This store's
// slice includes `units` (all damages across the yard, several MB) — so typing
// one character anywhere that dispatches a `set()` (e.g. the block-name field in
// Yard Plan) froze the main thread for the full serialize+write before the next
// keystroke could register. Deferring the actual stringify+write to a short idle
// window collapses a burst of keystrokes into one write, without changing what
// ends up persisted (a `beforeunload` flush covers refresh/close right after typing).
function debouncedLocalStorage<S>(delay = 500): PersistStorage<S> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingName: string | null = null
  let pendingValue: StorageValue<S> | null = null
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (pendingName !== null) {
      try {
        // Damage photos are multi-hundred-KB base64 strings — persisting them
        // blows past the ~5-10MB localStorage quota, and a QuotaExceededError
        // here silently loses EVERY state change since the last good flush.
        // The cloud owns the photos (damages.photo_url/photo_urls); strip them
        // from the local snapshot and let loadFromSupabase restore them on boot.
        const json = JSON.stringify(pendingValue, (k, v) => (k === 'photo' || k === 'photos' ? undefined : v))
        localStorage.setItem(pendingName, json)
      } catch (e) { console.error('[persist] flush failed', e) }
      pendingName = null; pendingValue = null
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush)
    // mobile PWAs are usually discarded WITHOUT beforeunload — pagehide /
    // visibilitychange:hidden are the reliable pair on iOS/Android
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
  }
  return {
    getItem: (name) => {
      const str = localStorage.getItem(name)
      return str ? (JSON.parse(str) as StorageValue<S>) : null
    },
    setItem: (name, value) => {
      pendingName = name; pendingValue = value
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, delay)
    },
    removeItem: (name) => {
      if (timer) { clearTimeout(timer); timer = null }
      pendingName = null; pendingValue = null
      localStorage.removeItem(name)
    },
  }
}

export const useYard = create<YardState>()(
  persist(
    (set, get) => ({
      lang: 'en', // default UI language — English (users can switch to TH in the top bar)
      planMode: 'AUTO',
      currentUser: 'สมชาย ป.',
      currentDriver: 'ก้องภพ',
      groupModelsInRow: true,
      laneDepth: 7,
      loggedInUserId: null,
      loginAt: null,
      appUsers: [
        { id: 'u1', name: 'admin', role: 'admin', active: true, username: 'admin', password: 'admin' },
      ],
      view: 'dashboard',
      unitPreset: null,
      unitVinFilter: null,

      sites: [
        { id: 'a5', name: 'A5', createdAt: 0 },
        { id: 'c0', name: 'C0', createdAt: 0 },
        { id: 'a1', name: 'A1', createdAt: 0 },
        { id: 'sjwd-rayong', name: 'sjwd rayong', createdAt: 0 },
      ],
      currentSite: null,
      siteModalOpen: false,

      units: {},
      trailers: [],
      models: MODELS,
      blocksBySite: { _global: BLOCKS },
      policies: DEFAULT_POLICIES,
      trips: [],

      toasts: [],
      focus: null,

      setFocus: (focus) => set({ focus }),
      setLang: (lang) => set({ lang }),
      // changing view clears any dashboard quick-filter; the dashboard re-sets it
      // right after navigating (StrictMode-safe — no mount-effect consumption).
      setView: (view) => set({ view, unitPreset: null, unitVinFilter: null }),
      // ── drill-down = "show me EXACTLY these cars" ────────────────────────
      // The Unit List keeps its filter state (tab / search / grouping box /
      // per-column pickers) in a PERSISTED store, so whatever the operator
      // last used is still armed when a dashboard card sends them over — and
      // it ANDs with the drill-down. A stale "Car Status = In Yard" column
      // filter therefore made "Pre Gate-in 302" open an EMPTY table (the In
      // Yard card looked fine only because that leftover filter agreed with
      // it). A left-over Grouping/Mylist tab hid the result the same way.
      // Clearing here covers every drill-down source at once (KPI cards,
      // Summary + Vin-Of-Status pivot cells, PM-plan VIN sets).
      setUnitPreset: (unitPreset) => {
        if (unitPreset) { revealUnitList(); set({ unitVinFilter: null }) }
        set({ unitPreset })
      },
      setUnitVinFilter: (unitVinFilter) => {
        if (unitVinFilter) { revealUnitList(); set({ unitPreset: null }) }
        set({ unitVinFilter })
      },
      setPlanMode: (planMode) => set({ planMode }),
      setUser: (currentUser) => set({ currentUser }),
      setDriver: (currentDriver) => set({ currentDriver }),
      addAppUser: (name, role, username, password) => {
        const user: AppUser = {
          id: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          name: name.trim(), role, active: true, username: username.trim(), password,
        }
        set(s => ({ appUsers: [...s.appUsers, user] }))
        db.upsertAppUser(user).catch((e) => {
          console.error('[db] addAppUser', e)
          get().toast('err', `บันทึกผู้ใช้ "${user.name}" ขึ้นคลาวด์ไม่สำเร็จ — จะซิงค์ให้อัตโนมัติเมื่อเปิดแอปครั้งถัดไป`)
        })
      },
      updateAppUser: (id, patch) => {
        set(s => ({ appUsers: s.appUsers.map(u => u.id === id ? { ...u, ...patch } : u) }))
        const updated = get().appUsers.find(u => u.id === id)
        if (updated) db.upsertAppUser(updated).catch((e) => {
          console.error('[db] updateAppUser', e)
          get().toast('err', `บันทึกการแก้ไขผู้ใช้ "${updated.name}" ขึ้นคลาวด์ไม่สำเร็จ`)
        })
      },
      removeAppUser: (id) => {
        set(s => ({ appUsers: s.appUsers.filter(u => u.id !== id) }))
        db.deleteAppUser(id).catch((e) => console.error('[db] removeAppUser', e))
      },
      // Reconcile the login roster with Supabase so a field account created on
      // one device works on any other. MERGE, never blind-overwrite: an account
      // that exists only locally means its cloud push never landed (refresh
      // aborted the request, or the account was created on a pre-sync build) —
      // wipe it and that person can never log in again. Keep it and push it up
      // instead, so the roster self-heals on every app start.
      loadAppUsersFromCloud: async () => {
        if (!db.isConfigured()) return
        const cloud = await db.fetchAppUsers()
        if (cloud === null) return // fetch failed (offline) — keep the local roster untouched
        if (cloud.length === 0) {
          // TRULY empty cloud (first run) → seed from this device
          await Promise.all(get().appUsers.map((u) => db.upsertAppUser(u))).catch((e) => console.error('[db] seed appUsers', e))
          return
        }
        // The cloud roster is the source of truth. The old merge kept "local-only"
        // users AND re-pushed them — so a user deleted by the admin was resurrected
        // by any device that still cached them, and could log in again forever.
        set({ appUsers: cloud })
        // fail-closed: if the signed-in account was deleted or deactivated,
        // end this session instead of leaving it running (or worse, letting a
        // null role fall through to the full admin shell).
        const uid = get().loggedInUserId
        if (uid) {
          const me = cloud.find((u) => u.id === uid)
          if (!me || !me.active) {
            get().logout()
            get().toast('info', 'บัญชีนี้ถูกปิดการใช้งานหรือถูกลบ — กรุณาติดต่อแอดมิน')
          }
        }
      },
      login: async (username, password) => {
        const s = get()
        // username matches case-insensitively — an admin typing "TEST" when
        // creating a user shouldn't lock that person out for typing "test"
        const norm = (v: string) => v.trim().toLowerCase()
        const user = s.appUsers.find(u => norm(u.username) === norm(username) && u.active)
        if (!user || !(await verifyPassword(password, user.password))) return false
        // legacy plaintext row → upgrade to a salted hash in place (local + cloud)
        if (!isHashed(user.password)) {
          const hashed = await hashPassword(password)
          set((st) => ({ appUsers: st.appUsers.map((u) => (u.id === user.id ? { ...u, password: hashed } : u)) }))
          db.upsertAppUser({ ...user, password: hashed }).catch((e) => console.error('[db] upgrade password hash', e))
        }
        // every login: stamp the session day (auto-logout on day change) and
        // clear the site so the operator must pick their yard again — prevents
        // recording work into another site left selected by the previous shift
        set({
          loggedInUserId: user.id, currentUser: user.name, loginAt: Date.now(),
          currentSite: null, siteModalOpen: true,
          view: user.role === 'admin' ? s.view : 'yardops',
        })
        if (norm(user.username) === 'admin' && password === 'admin')
          get().toast('err', 'บัญชี admin ยังใช้รหัสผ่านเริ่มต้น — กรุณาเปลี่ยนที่หน้า ตั้งค่า')
        return true
      },
      logout: () => set({ loggedInUserId: null, loginAt: null, currentSite: null, siteModalOpen: false }),
      setGroupModels: (groupModelsInRow) => set({ groupModelsInRow }),
      setLaneDepth: (n) => {
        const laneDepth = Math.max(1, Math.min(MAX_LANE_DEPTH, Math.round(n || 0)))
        set({ laneDepth })
        // lane depth is shared across every device/yard — persist to the cloud
        // and broadcast so open phones/tablets reload it right away.
        db.saveAppConfig('lane_depth', { laneDepth }).catch((e) => console.error('[db] saveLaneDepth', e))
        sendSync('policies', {})
      },

      // ── sites ──────────────────────────────────────────────────────────────
      addSite: (name, code) => {
        const s = get()
        const trimmed = name.trim()
        if (!trimmed) return
        if (s.sites.some((x) => x.name.toLowerCase() === trimmed.toLowerCase())) return
        const site: Site = {
          id: `site-${++tid}-${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name: trimmed, code: code?.trim() || undefined, createdAt: Date.now(), custom: true,
        }
        set({ sites: [...s.sites, site] })
        db.upsertSites([site]).catch((e) => console.error('[db] addSite', e))
      },
      updateSite: (id, patch) => {
        const s = get()
        const name = patch.name?.trim()
        if (patch.name !== undefined && !name) return
        if (name && s.sites.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) return
        const sites = s.sites.map((x) =>
          x.id === id
            ? { ...x, ...(name ? { name } : {}), ...(patch.code !== undefined ? { code: patch.code.trim() || undefined } : {}) }
            : x,
        )
        set({ sites })
        const updated = sites.find((x) => x.id === id)
        if (updated) db.upsertSites([updated]).catch((e) => console.error('[db] updateSite', e))
      },
      removeSite: (id) => {
        set((s) => ({
          sites: s.sites.filter((x) => x.id !== id),
          currentSite: s.currentSite === id ? null : s.currentSite,
        }))
        db.deleteSite(id).catch((e) => console.error('[db] removeSite', e))
      },
      setCurrentSite: (id) => {
        set({ currentSite: id, siteModalOpen: false })
        // units/trailers are loaded per-site → fetch the newly selected yard
        get().loadFromSupabase().catch((e) => console.error('[db] setCurrentSite load', e))
      },
      openSiteModal: () => set({ siteModalOpen: true }),
      closeSiteModal: () => set({ siteModalOpen: false }),

      toast: (kind, msg) => {
        const id = ++tid
        set((s) => ({ toasts: [...s.toasts, { id, kind, msg }] }))
        setTimeout(() => get().dismissToast(id), 3200)
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

      // ── data ops ────────────────────────────────────────────────────────────

      importUnits: (rows) => {
        const units = { ...get().units }
        const trailers = [...get().trailers]
        const trailerNos = new Set(trailers.map((t) => t.no))
        const siteId = get().currentSite
        let added = 0
        let updated = 0
        const changedUnits: Unit[] = []
        const newTrailers: Trailer[] = []
        for (const r of rows) {
          if (!r.vin) continue
          const m = matchModel(r.model || '')
          const existed = units[r.vin]
          const u: Unit = existed
            ? { ...existed }
            : { vin: r.vin, model: m.id, modelName: m.name, color: r.color || '—', category: 'EXPORT', status: 'EXPECTED', trailer: r.trailer ?? 0, damages: [], importedAt: Date.now() }
          u.model = m.id
          u.modelName = m.name
          if (r.color) { u.color = r.color; u.colorHex = paintHex(r.color) }
          if (r.variant) u.variant = r.variant
          if (r.lot) u.lot = r.lot
          if (r.trailer) u.trailer = r.trailer
          if (siteId && !u.site) u.site = siteId
          units[r.vin] = u
          changedUnits.push(u)
          existed ? updated++ : added++
          if (r.trailer && !trailerNos.has(r.trailer)) {
            trailerNos.add(r.trailer)
            const t: Trailer = { no: r.trailer, arrived: false }
            trailers.push(t)
            newTrailers.push(t)
          }
        }
        trailers.sort((a, b) => a.no - b.no)
        set({ units, trailers })
        // sync to Supabase — WITHOUT the placement columns. This runs on every
        // file import AND on App.tsx's minute-by-minute model heal, from this
        // device's copy of the yard. That copy goes stale the moment another
        // phone re-locates a car, so writing block/row/slot here pushed the OLD
        // position back over the new one — the "ops ตั้ง R7 แล้วรถไปโผล่ R9"
        // report. Model/colour/lot are what this call owns; position is not.
        db.upsertUnitsKeepPlacement(changedUnits).catch((e) => console.error('[db] importUnits', e))
        if (siteId && newTrailers.length) {
          Promise.all(newTrailers.map((t) => db.upsertTrailer(siteId, t)))
            .then(() => sendSync('trailers', { siteId }))
            .catch((e) => console.error('[db] importTrailers', e))
        }
        return { added, updated }
      },

      loadSample: () => {
        const { units, trailers } = generateSample()
        const siteIds = get().sites.map((s) => s.id)
        if (siteIds.length) Object.values(units).forEach((u, i) => { u.site = siteIds[i % siteIds.length] })
        const trips = seedTrips(units)
        const bySite: Record<string, Block[]> = { _global: BLOCKS }
        for (const id of siteIds) bySite[id] = BLOCKS
        set({ units, trailers, trips, policies: DEFAULT_POLICIES, blocksBySite: bySite, models: MODELS })
      },

      clearAll: () => {
        // scoped to the ACTIVE yard only — the old global delete wiped every
        // site's units/damages (~15k rows) from one yard's "clear data" button.
        const sid = get().currentSite
        if (!sid) return
        set((s) => {
          const units: Record<string, Unit> = {}
          for (const [vin, u] of Object.entries(s.units)) if (u.site && u.site !== sid) units[vin] = u
          return { units, trailers: [], trips: [] }
        })
        // damages + trips cascade automatically (FK on delete cascade)
        db.deleteUnitsForSite(sid).catch((e) => console.error('[db] clearAll units', e))
        db.deleteTrailersForSite(sid).catch((e) => console.error('[db] clearAll trailers', e))
      },

      removeUnit: (vin) => {
        const before = get().units
        if (!before[vin]) return
        const units = { ...before }
        delete units[vin]
        // the lane keeps its hole — no other car may be moved by this
        set((s) => ({ units, trips: s.trips.filter((t) => t.vin !== vin) }))
        db.deleteUnit(vin).catch((e) => console.error('[db] removeUnit', e))
      },

      markDeparted: (vin) => {
        // Nothing ever set DEPARTED before, so a gated-out car kept PARKED with
        // its block/row/slot — the engine counted the slot occupied forever and
        // after enough gate-outs the auto-plan reported a full yard.
        const before = get().units
        const u = before[vin]
        if (!u) return // sheet-only car (no yard unit) — nothing to release
        const units = { ...before }
        units[vin] = { ...u, status: 'DEPARTED', block: undefined, row: undefined, slot: undefined }
        // the car that leaves frees ONLY its own place — every other car in the
        // lane stays exactly where the yard put it
        set({ units })
        db.upsertUnits([units[vin]]).catch((e) => console.error('[db] markDeparted', e))
      },

      markDepartedMany: (vins) => {
        const before = get().units
        const units = { ...before }
        const cleared: Unit[] = []
        for (const vin of vins) {
          const u = units[vin]
          if (!u) continue // sheet-only car (no yard unit) — nothing to release
          const updated: Unit = { ...u, status: 'DEPARTED', block: undefined, row: undefined, slot: undefined }
          units[vin] = updated
          cleared.push(updated)
        }
        if (!cleared.length) return
        set({ units })
        db.upsertUnits(cleared).catch((e) => console.error('[db] markDepartedMany', e))
      },

      markTrailerArrived: (no, arrived = true) => {
        const siteId = get().currentSite
        set((s) => ({
          trailers: s.trailers.map((t) =>
            t.no === no ? { ...t, arrived, arrivedAt: arrived ? Date.now() : undefined } : t,
          ),
        }))
        if (siteId) {
          const trailer = get().trailers.find((t) => t.no === no)
          if (trailer) db.upsertTrailer(siteId, trailer).then(() => sendSync('trailers', { siteId })).catch((e) => console.error('[db] markTrailerArrived', e))
        }
      },

      gateIn: (vin) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          const now = Date.now()
          // a fresh gate-in auto-parks straight into the universal WCL staging
          // block — Car Status reads "In Yard" immediately, no separate
          // "Gate-in" stage and no Driver hand-off; the real final slot comes
          // later via Re-location. Falls back to the old GATE_IN stage (blank
          // location) only if WCL isn't configured for this site or is full.
          // occupancy must be scoped to THIS site — s.units mixes every site's
          // cars, and another yard's WCL block (same name) would otherwise
          // look occupied by cars that were never anywhere near this one
          const siteUnits = Object.values(s.units).filter((x) => !x.site || x.site === s.currentSite)
          const slot = u.status === 'EXPECTED' ? nextFreeSlotInBlock(WCL_STAGING_BLOCK, curBlocks(s), siteUnits) : null
          const updated: Unit = {
            ...u,
            status: slot ? 'PARKED' : (u.status === 'EXPECTED' ? 'GATE_IN' : u.status),
            ...(slot ? { block: slot.block, row: slot.row, slot: slot.slot, parkedAt: now } : {}),
            gateInAt: u.gateInAt ?? now, gateInBy: s.currentUser, inspected: true, site: s.currentSite ?? u.site,
          }
          db.upsertUnit(updated).catch((e) => console.error('[db] gateIn', e))
          return { units: { ...s.units, [vin]: updated } }
        }),

      parkUnpositionedAtWcl: (vins, siteId) => {
        const s = get()
        const site = siteId ?? s.currentSite
        const blocks = curBlocks({ blocksBySite: s.blocksBySite, currentSite: site })
        // simulated occupancy grows as each car is placed, so two cars in the
        // same batch land on DIFFERENT WCL slots instead of both claiming slot 1
        let occ = Object.values(s.units).filter((x) => !x.site || x.site === site)
        const now = Date.now()
        const changed: Unit[] = []
        for (const vin of vins) {
          const u = s.units[vin]
          if (!u || (u.block && u.row && u.slot)) continue // already positioned — leave it alone
          const slot = nextFreeSlotInBlock(WCL_STAGING_BLOCK, blocks, occ)
          if (!slot) continue
          const updated: Unit = { ...u, block: slot.block, row: slot.row, slot: slot.slot, status: 'PARKED', parkedAt: u.parkedAt ?? now }
          changed.push(updated)
          occ = [...occ, updated]
        }
        if (!changed.length) return 0
        set((st) => {
          const units = { ...st.units }
          for (const u of changed) units[u.vin] = u
          return { units }
        })
        db.upsertUnits(changed).catch((e) => console.error('[db] parkUnpositionedAtWcl', e))
        return changed.length
      },

      setInspected: (vin, v) =>
        set((s) => {
          if (!s.units[vin]) return s
          const updated: Unit = { ...s.units[vin], inspected: v }
          db.upsertUnitKeepPlacement(updated).catch((e) => console.error('[db] setInspected', e))
          return { units: { ...s.units, [vin]: updated } }
        }),

      addDamage: (vin, d) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          // id must be globally unique — damages.id is the cloud PK across ALL
          // vehicles and devices. The old `d${++tid}` counter reset to 0 on every
          // page load, so a fresh session's first damage collided with an existing
          // cloud row (23505) and the insert failed on every retry.
          const dmg = { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), by: s.currentUser, ...d, photo: d.photo ?? d.photos?.[0] }
          // FK-safe: ensure the parent unit row is in the cloud before the damage.
          // Retries a few times on its own (weak yard wifi/cellular); if it still
          // fails, queue it for flushPendingDamages() to retry later instead of
          // dropping it — otherwise the next full units re-pull (backgrounding
          // the app to take a photo, reconnecting) silently overwrites this
          // local-only defect and it looks like the save never happened.
          db.upsertUnitKeepPlacement(u).then(() => db.insertDamage(vin, dmg)).catch((e) => {
            console.error('[db] addDamage', e)
            get().toast('err', `บันทึก Defect ไว้ในเครื่องนี้ แต่ยังไม่ขึ้น cloud (เน็ตหลุด?) — กำลังลองใหม่อัตโนมัติ — ${vin.slice(-6)}`)
            set((s2) => ({ pendingDamages: { ...s2.pendingDamages, [dmg.id]: { vin, dmg } } }))
            scheduleFlushPendingDamages(get)
          })
          return { units: { ...s.units, [vin]: { ...u, damages: [...u.damages, dmg] } } }
        }),

      pendingDamages: {},
      flushPendingDamages: async () => {
        if (pendingDamagesFlushing) return
        const pending = get().pendingDamages
        const entries = Object.entries(pending)
        if (!entries.length) return
        pendingDamagesFlushing = true
        try {
          const done: string[] = []
          for (const [id, { vin, dmg }] of entries) {
            const u = get().units[vin]
            // NOTE: a damage missing from the LOCAL unit proves nothing — a
            // cloud merge may have overwritten the unit while this entry was
            // still queued. Reading that absence as "already landed" (the old
            // logic) silently dropped the queue entry, and the defect — photos
            // and all — was gone everywhere. The queue itself is the truth:
            // push until the CLOUD write succeeds (insertDamage treats a
            // duplicate id as success, so a landed-but-unconfirmed write from
            // an earlier round converges instead of erroring forever).
            try {
              // FK-safe: parent unit row first. A car merged away locally can
              // still exist in the cloud — then the insert rides on that row.
              if (u) await db.upsertUnitKeepPlacement(u)
              await db.insertDamage(vin, dmg)
              done.push(id)
              // it is in the cloud now — if a merge stripped it from the local
              // copy meanwhile, put it back so the screen agrees again
              set((s) => {
                const cu = s.units[vin]
                if (!cu || cu.damages.some((x) => x.id === id)) return s
                return { units: { ...s.units, [vin]: { ...cu, damages: [...cu.damages, dmg] } } }
              })
            } catch (e) {
              // no local unit AND the cloud insert failed → the car is gone
              // everywhere (deleted / never registered); the defect has no home
              if (!u) { done.push(id); continue }
              console.error('[db] flushPendingDamages', vin, e)
            }
          }
          if (done.length) {
            set((s) => {
              const next = { ...s.pendingDamages }
              for (const id of done) delete next[id]
              return { pendingDamages: next }
            })
          }
        } finally { pendingDamagesFlushing = false }
      },

      removeDamage: (vin, id) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          const gone = u.damages.find((x) => x.id === id)
          // tell other devices WHICH car lost a defect — the realtime DELETE
          // event may arrive key-less, and the old fallback for that case
          // (re-pull the whole site) is exactly the load storm this replaces
          db.deleteDamage(id).then(() => sendSync('dmg', { vins: [vin] })).catch((e) => console.error('[db] removeDamage', e))
          // permanent audit line in the admin Event tab (survives the delete)
          if (gone) {
            const what = gone.item || gone.note || gone.type || 'Defect'
            logDamageEvent(vin, `ลบ Defect · ${gone.area || '—'} · ${what}`, s.currentUser)
          }
          return { units: { ...s.units, [vin]: { ...u, damages: u.damages.filter((x) => x.id !== id) } } }
        }),

      // Admin-added damage from the Damages tab. Creates a minimal unit if the car
      // doesn't have one yet. source 'manual' → co-inspection re-import never deletes it.
      addManualDamage: (vin, f) => {
        const s = get()
        const now = Date.now()
        const dmg: Damage = {
          id: `man${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          // resolve against the master Part/Defect lists so the admin form stores
          // English in area/item and Thai in areaTh/itemTh — exactly like the
          // Gate-in capture. Without this a Thai pick leaked into the
          // English-only Defect export.
          area: resolvePart(f.position?.trim() ?? '').en || '—',
          areaTh: resolvePart(f.position?.trim() ?? '').th || undefined,
          type: f.defect?.trim() || '—',
          item: resolveDefect(f.defect?.trim() ?? '').en || undefined,
          itemTh: resolveDefect(f.defect?.trim() ?? '').th || undefined,
          severity: f.severity ?? (/heavy/i.test(f.categoryNG ?? '') ? 'major' : 'minor'),
          at: parseDefDate(f.date) ?? now,
          by: s.currentUser,
          source: 'manual',
          note: f.note?.trim() || undefined,
          categoryNG: (f.categoryNG?.trim() as Damage['categoryNG']) || undefined,
          categoryRepair: (f.categoryRepair?.trim() as Damage['categoryRepair']) || undefined,
          incharge: (f.incharge?.trim() as Damage['incharge']) || undefined,
          statusRepair: (f.statusRepair?.trim() as Damage['statusRepair']) || undefined,
          repairDate: parseDefDate(f.repairDate),
          repairHistory: f.statusRepair?.trim() ? [{ status: f.statusRepair.trim(), at: now, by: s.currentUser }] : undefined,
          photos: f.photos?.length ? f.photos : undefined,
          photo: f.photos?.[0],
        }
        const existing = s.units[vin]
        const m = existing ?? {
          vin, model: '', modelName: '', color: '—', trailer: 0,
          status: 'GATE_IN' as const, damages: [], importedAt: now, site: s.currentSite ?? undefined,
        }
        const u: Unit = { ...m, damages: [...m.damages, dmg] }
        set({ units: { ...s.units, [vin]: u } })
        // FK-safe: parent unit first, then the damage
        db.upsertUnitKeepPlacement(u).then(() => db.upsertDamages([{ vin, d: dmg }])).catch((e) => console.error('[db] addManualDamage', e))
      },

      addManualDamageBulk: (vins, f) => {
        const s = get()
        const now = Date.now()
        const units = { ...s.units }
        const changedUnits: Unit[] = []
        const dmgItems: { vin: string; d: Damage }[] = []
        const severity = f.severity ?? (/heavy/i.test(f.categoryNG ?? '') ? 'major' : 'minor')
        const at = parseDefDate(f.date) ?? now
        for (const vin of new Set(vins)) {
          const dmg: Damage = {
            id: `man${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            area: f.position?.trim() || '—',
            type: f.defect?.trim() || '—',
            item: f.defect?.trim() || undefined,
            severity,
            at,
            by: s.currentUser,
            source: f.source ?? 'manual',
            note: f.note?.trim() || undefined,
            categoryNG: (f.categoryNG?.trim() as Damage['categoryNG']) || undefined,
            categoryRepair: (f.categoryRepair?.trim() as Damage['categoryRepair']) || undefined,
            incharge: (f.incharge?.trim() as Damage['incharge']) || undefined,
            statusRepair: (f.statusRepair?.trim() as Damage['statusRepair']) || undefined,
            repairDate: parseDefDate(f.repairDate),
            repairHistory: f.statusRepair?.trim() ? [{ status: f.statusRepair.trim(), at: now, by: s.currentUser }] : undefined,
          }
          const existing = units[vin]
          const m = existing ?? {
            vin, model: '', modelName: '', color: '—', trailer: 0,
            status: 'GATE_IN' as const, damages: [], importedAt: now, site: s.currentSite ?? undefined,
          }
          const u: Unit = { ...m, damages: [...m.damages, dmg] }
          units[vin] = u; changedUnits.push(u); dmgItems.push({ vin, d: dmg })
        }
        if (!changedUnits.length) return 0
        set({ units })
        // FK-safe: parent units first (batch), then the damages (batch)
        db.upsertUnitsKeepPlacement(changedUnits).then(() => db.upsertDamages(dmgItems)).catch((e) => console.error('[db] addManualDamageBulk', e))
        return changedUnits.length
      },

      updateDamage: (vin, id, patch) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          db.patchDamage(id, patch, vin).catch((e) => console.error('[db] updateDamage', e))
          return { units: { ...s.units, [vin]: { ...u, damages: u.damages.map((x) => x.id === id ? { ...x, ...patch } : x) } } }
        }),

      // Change a defect's Status Repair + append to its history (who / when).
      updateRepairStatus: (vin, id, status) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          const now = Date.now()
          const by = s.currentUser
          let patched: import('../types').Damage | null = null
          const damages = u.damages.map((d) => {
            if (d.id !== id || d.statusRepair === status) return d
            const repairHistory = [...(d.repairHistory ?? []), { status, from: d.statusRepair, at: now, by }]
            // any status other than "Waiting Repair" resolves the Defect (leaves the
            // repair queue); reopening to Waiting Repair clears the resolve stamp.
            const resolved = status !== 'Waiting Repair'
            const next = {
              ...d,
              statusRepair: status as import('../types').DamageStatusRepair,
              repairHistory,
              ...(resolved
                ? (d.repairDate ? {} : { repairDate: now, repairedBy: by })
                : { repairDate: undefined, repairedBy: undefined }),
            }
            patched = next
            return next
          })
          if (!patched) return s
          const p = patched as import('../types').Damage
          db.patchDamage(id, {
            statusRepair: p.statusRepair, repairHistory: p.repairHistory,
            repairDate: p.repairDate, repairedBy: p.repairedBy,
          }).catch((e) => console.error('[db] updateRepairStatus', e))
          return { units: { ...s.units, [vin]: { ...u, damages } } }
        }),

      suggest: (vin) => {
        const u = get().units[vin]
        if (!u) return null
        return autoAssign(withModelId(u), curBlocks(get()), get().policies, Object.values(get().units), get().groupModelsInRow, get().laneDepth)
      },

      assign: (vin, slot, driver, mode) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          const now = Date.now()
          const updated: Unit = {
            ...u,
            block: slot.block, row: slot.row, slot: slot.slot,
            status: 'ASSIGNED', planMode: mode ?? s.planMode,
            assignedAt: now, drivingStartedAt: now,
            driver: driver || s.currentDriver,
          }
          db.upsertUnit(updated).catch((e) => console.error('[db] assign', e))
          return { units: { ...s.units, [vin]: updated } }
        }),

      confirmParked: (vin) =>
        set((s) => {
          const u = s.units[vin]
          if (!u || !u.block) return s
          const updated: Unit = { ...u, status: 'PARKED', parkedAt: Date.now() }
          db.upsertUnit(updated).catch((e) => console.error('[db] confirmParked', e))
          return { units: { ...s.units, [vin]: updated } }
        }),

      resetParking: (vin) => {
        const before = get().units
        const u = before[vin]
        if (!u) return
        const { block, row, slot, assignedAt, drivingStartedAt, parkedAt, ...rest } = u
        const units = { ...before }
        units[vin] = { ...rest, status: 'GATE_IN' }
        set({ units })
        db.upsertUnits([units[vin]]).catch((e) => console.error('[db] resetParking', e))
      },

      // Update Location import: place each car into its lane's block/row at the
      // given slot. Creates a minimal unit for VINs not in the system yet.
      updateLocations: (items) => {
        const s = get()
        const units = { ...s.units }
        const changed: Unit[] = []
        const now = Date.now()
        for (const it of items) {
          const existed = units[it.vin]
          const m = matchModel(it.modelName || existed?.modelName || '')
          const base: Unit = existed ?? {
            vin: it.vin, model: m.id, modelName: m.name,
            color: it.color || '—', colorHex: it.color ? paintHex(it.color) : undefined,
            category: 'EXPORT', status: 'PARKED', trailer: 0, damages: [], importedAt: now,
          }
          const u: Unit = {
            ...base,
            ...(existed && !existed.modelName && it.modelName ? { model: m.id, modelName: m.name } : {}),
            block: it.block, row: it.row, slot: it.slot,
            status: 'PARKED', parkedAt: now,
            gateInAt: base.gateInAt ?? it.gateInAt,
            // Blocks are per-yard (blocksBySite) and several yards own a block of the
            // SAME name (e.g. every yard has a "WCL"). Parking a car into the ACTIVE
            // yard's block means it is physically in THAT yard, so re-tag it — keeping
            // `base.site` would file it under the yard it came from and make it surface
            // in that yard's WCL instead of this one's.
            site: s.currentSite ?? base.site ?? undefined,
          }
          units[it.vin] = u
          changed.push(u)
        }
        if (!changed.length) return 0
        // ONLY the cars named in this request move — the lane a car leaves keeps
        // its hole, and no bystander is ever re-numbered behind the user's back
        set({ units })
        const intentional = new Set(changed.map((u) => u.vin))
        const guarded = items.filter((it) => it.from && intentional.has(it.vin))
        const plain = [...intentional].filter((v) => !guarded.some((g) => g.vin === v))
        if (plain.length) {
          db.upsertUnits(plain.map((v) => units[v])).catch((e) => console.error('[db] updateLocations', e))
        }
        if (guarded.length) {
          // compare-and-set: a car somebody else moved between our read and this
          // write is left exactly where THEY put it, and the operator is told —
          // silently winning the race is how a car ends up back in a lane it left
          void (async () => {
            const lost: { vin: string; at: string }[] = []
            for (const it of guarded) {
              const res = await db.updatePlacementIfUnchanged({ vin: it.vin, from: it.from! }, units[it.vin])
                .catch(() => ({ applied: true as const }))
              if (res.applied) continue
              lost.push({ vin: it.vin, at: posCode(res.current) || '—' })
              // adopt what the cloud says rather than keeping our rejected guess
              set((st) => {
                const cur = st.units[it.vin]
                if (!cur) return st
                return { units: { ...st.units, [it.vin]: { ...cur, ...res.current } } }
              })
            }
            if (lost.length) {
              get().toast('err', lost.length === 1
                ? `รถ ${lost[0].vin.slice(-6)} เพิ่งถูกย้ายไป ${lost[0].at} โดยเครื่องอื่น — ตำแหน่งนี้ไม่ถูกบันทึก กรุณาสแกนใหม่`
                : `${lost.length} คันเพิ่งถูกย้ายโดยเครื่องอื่น — ไม่ได้บันทึกทับ กรุณาสแกนใหม่`)
            }
          })()
        }
        return changed.length
      },

      autoParkAll: () => {
        const { policies, groupModelsInRow, laneDepth, currentDriver } = get()
        const blocks = curBlocks(get())
        const units = { ...get().units }
        let n = 0
        const changed: Unit[] = []
        for (const u of Object.values(units)) {
          if (u.status !== 'GATE_IN') continue
          const a = autoAssign(withModelId(u), blocks, policies, Object.values(units), groupModelsInRow, laneDepth)
          if (!a) continue
          const now = Date.now()
          const updated: Unit = {
            ...u, block: a.block, row: a.row, slot: a.slot, status: 'PARKED', planMode: 'AUTO',
            assignedAt: now, drivingStartedAt: now, parkedAt: now, driver: u.driver || currentDriver || 'Auto',
          }
          units[u.vin] = updated
          changed.push(updated)
          n++
        }
        set({ units })
        db.upsertUnits(changed).catch((e) => console.error('[db] autoParkAll', e))
        return n
      },

      setPolicy: (model, patch) => {
        set((s) => ({
          policies: s.policies.some((p) => p.model === model)
            ? s.policies.map((p) => (p.model === model ? { ...p, ...patch } : p))
            : [...s.policies, { model, enabled: true, allowedBlocks: 'ALL', exclusiveRow: false, ...patch }],
        }))
        // parking rules are shared across devices — persist to the cloud AND
        // broadcast so every open phone/tablet applies the new rule immediately
        // (previously rules lived only in the device where they were set).
        const policies = get().policies
        db.saveAppConfig('parking_policies', policies).catch((e) => console.error('[db] savePolicies', e))
        sendSync('policies', { policies })
      },

      loadPolicies: async () => {
        const cloud = await db.fetchAppConfig<ParkingPolicy[]>('parking_policies').catch(() => null)
        if (Array.isArray(cloud) && cloud.length) set({ policies: cloud })
        const depth = await db.fetchAppConfig<{ laneDepth?: number }>('lane_depth').catch(() => null)
        if (depth && typeof depth.laneDepth === 'number') set({ laneDepth: Math.max(1, Math.min(MAX_LANE_DEPTH, depth.laneDepth)) })
      },

      // ── yard layout editor ─────────────────────────────────────────────────
      addBlock: (b) => {
        const s0 = get(); const key = siteKey(s0.currentSite); const cur = s0.blocksBySite[key] ?? []
        const id = b?.id || nextBlockId(cur)
        const blk: Block = {
          id, name: b?.name ?? `Block ${id}`, rows: b?.rows ?? 4, cols: b?.cols ?? 10, zone: b?.zone ?? 'Y',
          x: b?.x ?? 40, y: b?.y ?? 40, w: b?.w ?? 260, h: b?.h ?? 130, rot: b?.rot ?? 0,
          color: b?.color, kind: b?.kind ?? 'park',
        }
        set((s) => ({ blocksBySite: { ...s.blocksBySite, [key]: [...(s.blocksBySite[key] ?? []), blk] } }))
        scheduleBlockSync(get)
        return id
      },
      updateBlock: (id, patch) => {
        set((s) => { const key = siteKey(s.currentSite); const cur = s.blocksBySite[key] ?? []
          return { blocksBySite: { ...s.blocksBySite, [key]: cur.map((b) => (b.id === id ? { ...b, ...patch } : b)) } } })
        scheduleBlockSync(get)
      },
      removeBlock: (id) => {
        set((s) => { const key = siteKey(s.currentSite); const cur = s.blocksBySite[key] ?? []
          return { blocksBySite: { ...s.blocksBySite, [key]: cur.filter((b) => b.id !== id) } } })
        scheduleBlockSync(get)
      },


      // ── gps ──────────────────────────────────────────────────────────────
      startTrip: (vin, driver, from, to) =>
        set((s) => {
          // close any stale open trip at its LAST FIX time, not "now" — a phone
          // that died mid-drive days ago must not record a multi-day duration
          const trips = s.trips.map((t) =>
            t.vin === vin && !t.endedAt ? { ...t, endedAt: t.path[t.path.length - 1]?.t ?? t.startedAt } : t,
          )
          const trip: Trip = { id: `t${++tid}${Date.now()}`, vin, driver, startedAt: Date.now(), from, to, path: [] }
          const u = s.units[vin]
          return {
            trips: [...trips, trip],
            units: u ? { ...s.units, [vin]: { ...u, tripCount: (u.tripCount ?? 0) + 1 } } : s.units,
          }
        }),

      appendGps: (vin, p, sim) =>
        set((s) => {
          let idx = -1
          for (let i = s.trips.length - 1; i >= 0; i--) {
            if (s.trips[i].vin === vin && !s.trips[i].endedAt) { idx = i; break }
          }
          if (idx < 0) return s
          const trip = s.trips[idx]
          const last = trip.path[trip.path.length - 1]
          if (last && haversineM(last, p) < 0.8 && p.t - last.t < 4000) return s
          const path = [...trip.path, p]
          const trips = s.trips.slice()
          // sim flag: fabricated (permission-denied / no-fix fallback) points must
          // not masquerade as a real GPS trace in Tracking / trip playback
          trips[idx] = { ...trip, path, sim: trip.sim || sim || undefined }
          const u = s.units[vin]
          return {
            trips,
            units: u ? { ...s.units, [vin]: { ...u, lastPos: p } } : s.units,
          }
        }),

      endTrip: (vin) =>
        set((s) => {
          let idx = -1
          for (let i = s.trips.length - 1; i >= 0; i--) {
            if (s.trips[i].vin === vin && !s.trips[i].endedAt) { idx = i; break }
          }
          if (idx < 0) return s
          const trip = s.trips[idx]
          let dist = 0
          for (let i = 1; i < trip.path.length; i++) dist += haversineM(trip.path[i - 1], trip.path[i])
          const trips = s.trips.slice()
          trips[idx] = { ...trip, endedAt: Date.now(), distanceM: Math.round(dist) }
          return { trips }
        }),

      purgeNonTracking: (realVins) =>
        set((s) => ({
          units: Object.fromEntries(Object.entries(s.units).filter(([vin]) => realVins.has(vin))),
          trailers: [],
          trips: s.trips.filter((tr) => realVins.has(tr.vin)),
        })),

      /**
       * รถซ้อนช่องกัน → เลื่อนเติมให้เต็มในแถวเดิม ห้ามข้ามแถว
       *
       * A square can end up claimed by two cars (two devices handing out the
       * same คันที่ down one lane). The plan draws one car per square, so the
       * other one simply is not on the plan — staff walk to a lane and find a
       * car the system says is somewhere else.
       *
       * The repair is deliberately the narrowest one possible: the car that has
       * stood there longest keeps the square, the others take the free คันที่
       * numbers left in THE SAME ช่อง (block + slot never change), and a car
       * that already has a square to itself is never touched. Every device
       * computes the identical answer from the identical data — longest-parked
       * first, VIN as the tie-break — so they all converge instead of fighting.
       *
       * Runs only once this device holds the whole yard (unitsCloudDone): fixing
       * against a half-loaded copy is how the duplicates got created in the
       * first place.
       */
      dedupeSlots: async () => {
        const s0 = get()
        if (!s0.unitsCloudDone) return 0
        const blocks = curBlocks(s0)
        const depthOf = (blockTag?: string) => {
          const b = blocks.find((x) => blockKeyOfTag(x.name) === blockKeyOfTag(blockTag) || blockKeyOfTag(x.id) === blockKeyOfTag(blockTag))
          return b?.rows ?? MAX_LANE_DEPTH
        }
        const parked = (u: Unit) => !!u.block && !!u.row && !!u.slot
          && (u.status === 'PARKED' || u.status === 'ASSIGNED' || u.status === 'LOADED')
        // lane identity: block + ช่อง + yard
        const laneKey = (u: Unit) => `${blockKeyOfTag(u.block)}|${u.site ?? ''}|${u.slot}`

        // ── pass 1: does anything even LOOK like a clash? (local, costs nothing)
        const lanes = new Map<string, Unit[]>()
        for (const u of Object.values(s0.units)) {
          if (!parked(u)) continue
          const k = laneKey(u)
          const arr = lanes.get(k)
          if (arr) arr.push(u); else lanes.set(k, [u])
        }
        const looksClashed = (lane: Unit[]) => {
          const seen = new Set<number>()
          for (const u of lane) { if (seen.has(u.row!)) return true; seen.add(u.row!) }
          return false
        }
        const suspects = [...lanes.entries()].filter(([, lane]) => looksClashed(lane))
        if (!suspects.length) return 0 // the overwhelmingly common case — no query at all

        // ── pass 2: ask the cloud who is REALLY in those lanes, before moving anyone.
        // This runs by itself, with nobody watching, so it must never act on a
        // hunch. Most "clashes" this device sees are not clashes at all: it is
        // still holding a car somebody drove elsewhere, and the pile is imaginary.
        // Acting on that wrote the car back into the lane it had left — the same
        // fault as the row scan's, but silent and on a timer. Only lanes that
        // still look clashed once the cloud has spoken get touched.
        const verified = new Map<string, Unit[]>()
        const healed: Unit[] = []
        for (const [k, lane] of suspects) {
          const [blockId, site, slotStr] = k.split('|')
          const slot = Number(slotStr)
          const scope = Object.values(s0.units).filter((u) => (u.site ?? '') === site)
          const fresh = await laneFromCloud(scope, site || null, blockId, slot)
          const byVin = new Map(fresh.map((u) => [u.vin, u] as const))
          // whatever the cloud corrected, adopt — this device was simply wrong
          for (const u of lane) {
            const now = byVin.get(u.vin)
            if (now && (now.block !== u.block || now.row !== u.row || now.slot !== u.slot)) healed.push(now)
          }
          verified.set(k, fresh.filter((u) => parked(u) && laneKey(u) === k))
        }

        const moved: Unit[] = []
        const guards: db.PlacementGuard[] = []
        const units = { ...get().units }
        // `healed` cars come straight from a cloud lane fetch (laneFromCloud) —
        // real damages, but not this device's own not-yet-synced defect if the
        // insert hasn't landed yet. A bare overwrite here erased it: this runs
        // automatically after every units change (see the useYard.subscribe
        // below), so a defect saved on a car sitting in a busy staging lane
        // (WCL — every gate-in and re-location car in one lane) could vanish
        // within the debounce window of the SAME save that added it.
        const pendingNow = get().pendingDamages
        for (const u of healed) units[u.vin] = attachPendingDamages(pendingNow, u)
        for (const lane of verified.values()) {
          const byDepth = new Map<number, Unit[]>()
          for (const u of lane) {
            const arr = byDepth.get(u.row!)
            if (arr) arr.push(u); else byDepth.set(u.row!, [u])
          }
          if (![...byDepth.values()].some((a) => a.length > 1)) continue // ไม่ได้ซ้อนจริง
          const taken = new Set(byDepth.keys())
          const depth = depthOf(lane[0].block)
          for (const [, cars] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
            if (cars.length < 2) continue
            // longest-parked keeps the square; VIN breaks a tie so every device
            // picks the same winner
            const order = [...cars].sort((a, b) =>
              (a.parkedAt ?? a.importedAt ?? 0) - (b.parkedAt ?? b.importedAt ?? 0) || a.vin.localeCompare(b.vin))
            for (const u of order.slice(1)) {
              let free = 0
              for (let r = 1; r <= depth; r++) if (!taken.has(r)) { free = r; break }
              if (!free) break // แถวเต็มจริงๆ — ปล่อยไว้ให้คนตัดสิน ห้ามย้ายไปแถวอื่น
              taken.add(free)
              const next = { ...u, row: free }
              units[u.vin] = next
              moved.push(next)
              guards.push({ vin: u.vin, from: { block: u.block, row: u.row, slot: u.slot } })
              logMoveEvent(u.vin, 'แก้ตำแหน่งซ้ำ (แถวเดิม)', posCode(u), posCode(next))
            }
          }
        }
        if (healed.length && !moved.length) { set({ units }); return 0 }
        if (!moved.length) return 0
        set({ units })
        // compare-and-set here too: this runs unattended, so a car somebody is
        // parking at this very moment must win over the tidy-up, not lose to it
        let applied = 0
        for (let i = 0; i < moved.length; i++) {
          const res = await db.updatePlacementIfUnchanged(guards[i], moved[i]).catch(() => ({ applied: true as const }))
          if (res.applied) { applied++; continue }
          set((st) => {
            const cur = st.units[guards[i].vin]
            return cur ? { units: { ...st.units, [guards[i].vin]: { ...cur, ...res.current } } } : st
          })
        }
        if (applied) get().toast('info', `พบรถซ้อนช่องกัน — จัดคันที่ใหม่ในแถวเดิม ${applied} คัน`)
        return applied
      },

      /**
       * ทุกเครื่องเห็นผังเหมือนกัน: re-read VIN + position for this yard and adopt
       * what the cloud says. Realtime keeps screens live, but an event that never
       * arrives leaves one device drawing a stale plan forever — nothing else
       * re-checks. This pass is cheap (position columns only, no defects), so it
       * can run on a timer and whenever the screen comes back into view.
       */
      refreshPlacements: async () => {
        const siteId = get().currentSite
        if (!db.isConfigured() || !siteId) return 0
        let cloud: Unit[]
        try { cloud = await db.fetchUnitPlacements(siteId) } catch { return 0 }
        if (!cloud.length) return 0
        let changed = 0
        set((s) => {
          const units = { ...s.units }
          const seen = new Set<string>()
          for (const c of cloud) {
            seen.add(c.vin)
            const cur = units[c.vin]
            if (cur && cur.block === c.block && cur.row === c.row && cur.slot === c.slot && cur.status === c.status) continue
            // keep everything this device knows that the light pass does not carry
            units[c.vin] = cur ? { ...cur, block: c.block, row: c.row, slot: c.slot, status: c.status, site: c.site } : c
            changed++
          }
          // a car this device still parks here but the cloud no longer lists is
          // one that left through another device — free its square
          for (const u of Object.values(units)) {
            if (u.site !== siteId || !u.block || seen.has(u.vin)) continue
            units[u.vin] = { ...u, status: 'DEPARTED', block: undefined, row: undefined, slot: undefined }
            changed++
          }
          return changed ? { units } : s
        })
        if (changed) get().dedupeSlots().catch(() => {})
        return changed
      },

      ensureUnitSites: () =>
        set((s) => {
          const ids = s.sites.map((x) => x.id)
          if (!ids.length) return s
          const vals = Object.values(s.units)
          if (vals.every((u) => u.site)) return s
          const units = { ...s.units }
          let i = 0
          for (const u of vals) {
            if (!u.site) { units[u.vin] = { ...u, site: ids[i % ids.length] }; i++ }
          }
          return { units }
        }),

      unitsCloudDone: false,
      unitsRealtimeConnected: false,

      // ── boot cache: the yard plan's cars, straight from IndexedDB ─────────
      // Fills only VINs the store doesn't hold yet (an in-memory copy — a
      // fresher localStorage hydration or a write this session — always wins).
      loadUnitsFromIdb: async () => {
        try {
          const cached = await idbGetAllUnits()
          if (!cached.length) return
          set((s) => {
            const units = { ...s.units }
            let added = 0
            // departed cars are history, not the yard — keep them out of memory
            for (const u of cached) if (u?.vin && u.status !== 'DEPARTED' && !units[u.vin]) { units[u.vin] = u; added++ }
            return added ? { units } : s
          })
          // sweep departed entries written before the in-yard-only rule out of
          // the store, so the next boot doesn't read 18k history rows again
          const departed = cached.filter((u) => u?.vin && u.status === 'DEPARTED').map((u) => u.vin)
          if (departed.length) idbDeleteUnits(departed).catch(() => {})
        } catch { /* IndexedDB unavailable — the cloud load fills in as before */ }
      },

      // ── Supabase ───────────────────────────────────────────────────────────
      loadFromSupabase: async () => {
        if (!db.isConfigured()) return
        // 1) sites: the cloud is the source of truth so add / edit / delete on one
        //    device propagates to the others. Seed local defaults only on first run.
        const cloudSites = await db.fetchSites()
        if (cloudSites.length === 0) {
          await db.upsertSites(get().sites).catch((e) => console.error('[db] seed sites', e))
        } else {
          set((s) => {
            const ids = new Set(cloudSites.map((x) => x.id))
            return { sites: cloudSites, currentSite: s.currentSite && ids.has(s.currentSite) ? s.currentSite : null }
          })
        }
        // 2) pull units + trailers for the ACTIVE site only — units carry ~15k
        //    damage rows across all yards (~8 MB); scoping to one site keeps this
        //    light, and switching sites re-fetches. Merge per-vin, never drop local.
        const siteId = get().currentSite
        if (!siteId) return // no yard picked yet → wait; setCurrentSite re-runs this
        // the cars are ABOUT to refresh from the cloud — while that runs the
        // "ไม่แสดงบนผัง" math is transient, so the plan shows a loading chip
        // instead of a shrinking number (re-armed on every site switch too)
        set({ unitsCloudDone: false })
        try {
        // 3) yard-plan layout FIRST, on its own: the block list is a few KB and
        //    comes back in a blink, while fetchAllUnits pages through ~800 cars
        //    WITH their damages (seconds). Awaiting them together held the
        //    layout hostage, so a device with a cold cache stared at an empty
        //    grid ("ยังไม่มีบล็อกในผัง") for the whole units fetch. Painting it
        //    the moment it lands means the yard's shape is on screen straight
        //    away and the cars fill into it behind.
        //    Cloud is the source of truth (any device's edit pushed there);
        //    when the cloud has none, seed it from this device so an existing
        //    local layout propagates to other machines.
        const blocksDone = db.fetchBlocks(siteId).then((cloudBlocks) => {
          if (cloudBlocks.length) {
            set((s) => ({ blocksBySite: { ...s.blocksBySite, [siteKey(siteId)]: cloudBlocks } }))
          } else {
            const local = get().blocksBySite[siteKey(siteId)] ?? []
            if (local.length) db.replaceBlocks(siteId, local).catch((e) => console.error('[db] seedBlocks', e))
          }
        }).catch((e) => console.error('[db] fetchBlocks', e))
        // a defect this device queued in pendingDamages hasn't reached the cloud
        // yet — a plain per-vin overwrite below would silently erase it (looks
        // like the save never happened). Re-attach it onto the incoming cloud
        // row until flushPendingDamages() confirms it landed.
        const pendingByVin = new Map<string, Damage[]>()
        for (const p of Object.values(get().pendingDamages)) {
          const arr = pendingByVin.get(p.vin) ?? []
          arr.push(p.dmg)
          pendingByVin.set(p.vin, arr)
        }
        const withPending = (u: Unit): Unit => {
          const extra = pendingByVin.get(u.vin)?.filter((d) => !u.damages.some((x) => x.id === d.id))
          return extra?.length ? { ...u, damages: [...u.damages, ...extra] } : u
        }
        // stream: paint cars into the yard plan page by page — a cold device
        // used to stare at an empty plan until the LAST page of ~2,000 cars
        // (+ damages) had arrived; now they flow in with the layout
        const streamUnits = (batch: Unit[]) => set((s) => {
          const units = { ...s.units }
          for (const u of batch) units[u.vin] = withPending(u)
          return { units }
        })
        // VIN + ตำแหน่ง มาก่อน: the placement-only pass runs alongside the full
        // one and lands first, so the plan shows where every car stands while the
        // defects and the rest of each record are still downloading. It carries no
        // defects, so a car this device already has keeps the ones it has.
        const streamPlacements = (batch: Unit[]) => set((s) => {
          const units = { ...s.units }
          for (const u of batch) {
            const cur = units[u.vin]
            units[u.vin] = cur ? { ...u, damages: cur.damages } : withPending(u)
          }
          return { units }
        })
        const [cloud, trailers] = await Promise.all([
          db.fetchAllUnits(siteId, streamUnits, streamPlacements),
          db.fetchTrailers(siteId),
        ])
        await blocksDone // callers may assume the layout is settled on return
        if (cloud.length || trailers.length) {
          set((s) => {
            const merged: Record<string, Unit> = { ...s.units }
            for (const u of cloud) merged[u.vin] = withPending(u)
            return { units: merged, trailers: trailers.length ? trailers : s.trailers }
          })
        }
        set({ unitsCloudDone: true })
          loadRetry = 0 // landed — the next failure starts from the short delay again
        } catch (e) {
          // a partial/failed fetch must NOT flip unitsCloudDone — that would
          // show the "ไม่แสดงบนผัง" count as final while this device is
          // actually still missing a chunk of cars (the cross-device count
          // mismatch this used to cause). Keep the loading chip up and retry.
          //
          // BACK OFF. This retried every 3s forever, and each attempt re-pulls
          // the whole site's units. When the database slows down, ~35 devices
          // all land in that loop at once — ~700 full-table pulls a minute — so
          // a brief wobble became a self-sustaining storm that kept the database
          // saturated and every station failing. Doubling up to a minute (with
          // jitter, so the fleet doesn't retry in lockstep) still recovers on
          // its own but lets the database out from under the load.
          console.error('[db] loadFromSupabase units', e)
          const wait = Math.min(3000 * 2 ** loadRetry, 60_000) * (0.75 + Math.random() * 0.5)
          loadRetry++
          if (loadRetryTimer) clearTimeout(loadRetryTimer)
          loadRetryTimer = setTimeout(() => {
            loadRetryTimer = null
            // a backgrounded tab is nobody's screen — retrying from it only adds
            // load. App.tsx re-pulls on visibilitychange, so it catches up anyway.
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            if (get().currentSite === siteId) get().loadFromSupabase()
          }, wait)
        }
      },

      // Live yard-plan updates: assign / park / gate-in on any device broadcasts
      // through Supabase Realtime so every admin screen moves cars without a refresh.
      subscribeRealtime: () => {
        if (!db.isConfigured() || unitsChannel) return
        unitsChannel = supabase
          .channel('units_changes')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'units' },
            (payload) => {
              if (payload.eventType === 'DELETE') {
                const vin = (payload.old as { vin?: string })?.vin
                if (!vin) return
                unitTs.delete(vin)
                set((s) => { if (!s.units[vin]) return s; const units = { ...s.units }; delete units[vin]; return { units } })
                return
              }
              const r = payload.new as DbUnit
              if (!r?.vin) return
              // site-scope: loadFromSupabase deliberately loads one yard, but this
              // channel received every yard's events — injecting other sites' units
              // (each with damages:[]) bloated localStorage toward its quota
              const sid = get().currentSite
              if (sid && r.site_id && r.site_id !== sid && !get().units[r.vin]) return
              const ts = r.updated_at ? new Date(r.updated_at).getTime() : Date.now()
              if ((unitTs.get(r.vin) ?? 0) >= ts) return // stale / self-echo
              unitTs.set(r.vin, ts)
              set((s) => {
                const cur = s.units[r.vin]
                return { units: { ...s.units, [r.vin]: db.parseUnitRow(r, cur?.damages ?? []) } }
              })
            },
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'damages' },
            (payload) => {
              if (payload.eventType === 'DELETE') {
                const id = (payload.old as { id?: string })?.id
                if (!id) {
                  // key-less DELETE payload — the deleting device announces the
                  // car on the 'dmg' broadcast (see removeDamage), and this
                  // client refreshes JUST that car there. The old fallback —
                  // re-pulling the ENTIRE site with photos on every device —
                  // was a major source of the database timeout storms.
                  return
                }
                set((s) => {
                  for (const vin in s.units) {
                    const u = s.units[vin]
                    if (u.damages.some((d) => d.id === id))
                      return { units: { ...s.units, [vin]: { ...u, damages: u.damages.filter((d) => d.id !== id) } } }
                  }
                  return s
                })
                return
              }
              const r = payload.new as DbDamage
              if (!r?.vin) {
                // truncated INSERT/UPDATE (base64 photos > realtime max) — the
                // record body was dropped, so this event can't even say WHICH
                // car changed. The writer announces the VIN on the 'dmg'
                // broadcast instead (insertDamage / patchDamage / upsertDamages)
                // and the onSync('dmg') receiver below refreshes just that car.
                // The old fallback — every device re-pulling the ENTIRE site
                // with photos per defect saved — was the single biggest load
                // storm on the database (the afternoon 57014 timeout floods).
                return
              }
              const dmg = db.rowToDamage(r)
              set((s) => {
                const u = s.units[r.vin]
                if (!u) return s // unit not loaded here yet — fetchAllUnits will include it
                const exists = u.damages.some((d) => d.id === dmg.id)
                const damages = exists ? u.damages.map((d) => (d.id === dmg.id ? dmg : d)) : [...u.damages, dmg]
                return { units: { ...s.units, [r.vin]: { ...u, damages } } }
              })
            },
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'sites' },
            (payload) => {
              if (payload.eventType === 'DELETE') {
                const id = (payload.old as { id?: string })?.id
                if (!id) return
                set((s) => ({ sites: s.sites.filter((x) => x.id !== id), currentSite: s.currentSite === id ? null : s.currentSite }))
                return
              }
              const r = payload.new as { id?: string; name?: string; code?: string | null; custom?: boolean | null; created_at?: string | null }
              if (!r?.id) return
              const site: Site = { id: r.id, name: r.name ?? '', code: r.code ?? undefined, custom: r.custom ?? false, createdAt: r.created_at ? new Date(r.created_at).getTime() : 0 }
              set((s) => {
                const exists = s.sites.some((x) => x.id === site.id)
                return { sites: exists ? s.sites.map((x) => (x.id === site.id ? site : x)) : [...s.sites, site] }
              })
            },
          )
          // self-healing subscription: an admin screen left open for hours loses
          // the websocket and the yard plan silently freezes — reconnect with a
          // short backoff and re-pull the site's units to catch up on every
          // relocation missed while the socket was down
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              set({ unitsRealtimeConnected: true })
              if (!unitsHadDrop) return
              unitsHadDrop = false
              const sid = get().currentSite
              if (!sid) return
              db.fetchAllUnits(sid).then((cloud) => {
                if (!cloud.length) return
                set((s) => {
                  const merged: Record<string, Unit> = { ...s.units }
                  // never let the cloud copy erase a defect still queued locally
                  for (const u of cloud) merged[u.vin] = attachPendingDamages(s.pendingDamages, u)
                  return { units: merged }
                })
              }).catch(() => {})
              return
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              set({ unitsRealtimeConnected: false })
              unitsHadDrop = true
              if (unitsChannel) { supabase.removeChannel(unitsChannel); unitsChannel = null }
              setTimeout(() => {
                // still logged in and nobody resubscribed already (site switch)?
                if (!unitsChannel && get().loggedInUserId) get().subscribeRealtime()
              }, 4000)
            }
          })
      },

      unsubscribeRealtime: () => {
        if (unitsChannel) { supabase.removeChannel(unitsChannel); unitsChannel = null; unitTs.clear() }
        set({ unitsRealtimeConnected: false })
      },

      // Defect-Yard / Defect-Factory rows → Damage records on each VIN's unit.
      // Creates a minimal unit (from the tracking row) when one doesn't exist yet,
      // so imported defects display in the Unit List / Check views. Deterministic
      // damage ids mean re-importing the same file updates rather than duplicates.
      importDefects: async (defects, trackingRows, onProgress) => {
        if (!defects.length) return { units: 0, damages: 0 }
        // phase weights across the whole run — the cloud writes dominate the
        // wall clock (10k+ rows), so they own most of the bar
        const phase = (from: number, to: number, label: string) => (done: number, total: number) =>
          onProgress?.(from + (to - from) * (total ? done / total : 1), label)
        onProgress?.(0, 'กำลังรวมข้อมูล Defect…')
        const units = { ...get().units }
        const site = get().currentSite ?? undefined
        const byVin = new Map<string, DefectRow[]>()
        for (const d of defects) { const a = byVin.get(d.vin); if (a) a.push(d); else byVin.set(d.vin, [d]) }

        let newUnits = 0
        let dmgCount = 0
        const now = Date.now()
        const changedUnits: Unit[] = []
        const dmgItems: { vin: string; d: Damage }[] = []
        const removedIds: string[] = []
        const DEF_SRC = new Set(['yardDefect', 'factoryDefect', 'whaleDefect'])
        for (const [vin, defs] of byVin) {
          let u = units[vin]
          if (!u) {
            const tr = trackingRows[vin]
            const cs = tr?.cells['Car Status'] ?? ''
            const m = matchModel(tr?.cells['Model name'] ?? tr?.cells['Model'] ?? defs[0].model ?? '')
            u = {
              vin, model: m.id, modelName: m.name,
              color: tr?.cells['Color'] ?? defs[0].model ?? '—', colorHex: paintHex(tr?.cells['Color'] ?? ''),
              trailer: parseInt(tr?.cells['Grouping  Number'] ?? '0') || 0,
              status: IN_YARD_STATUSES.has(cs.trim()) ? 'GATE_IN' : 'EXPECTED',
              damages: [], importedAt: Date.now(), site,
            }
            newUnits++
          } else {
            u = { ...u, damages: [...u.damages] }
          }
          // REPLACE semantics: the latest file is authoritative for this VIN's
          // imported defects. Keep in-app damages (walk-around/PDI/mechanic/update)
          // untouched; drop any old file-defect that isn't in the new file; inherit
          // the audit trail for defects that carry over (same id, or a healed twin).
          const dayKey = (src: string | undefined, area: string, at: number) => `${src}|${area}|${new Date(at).toDateString()}`
          const fileById = new Map<string, Damage>()
          // A VIN can legitimately carry many identical-looking defect rows (same
          // position/defect/date). Their base id collides, so suffix repeats by
          // occurrence order (deterministic → re-import of the same file is still
          // idempotent). Without this, N identical rows collapsed into ONE and the
          // rest silently vanished from the export.
          const seenBase = new Map<string, number>()
          for (const def of defs) {
            const d = defectToDamage(def)
            const k = seenBase.get(d.id) ?? 0
            seenBase.set(d.id, k + 1)
            if (k > 0) d.id = `${d.id}~${k}`
            fileById.set(d.id, d)
          }
          const newIds = new Set(fileById.keys())

          const inApp: Damage[] = []              // in-app damages — always preserved
          const oldById = new Map<string, Damage>()   // carry-over file defects (inherit history)
          const healedTwin = new Map<string, Damage>() // pre-fix 'defect' artifacts (inherit by pos+day)
          for (const d of u.damages) {
            if (!d.source || !DEF_SRC.has(d.source)) { inApp.push(d); continue }
            if (d.type === 'defect' && !d.item) { healedTwin.set(dayKey(d.source, d.area, d.at), d); removedIds.push(d.id); continue }
            if (newIds.has(d.id)) { oldById.set(d.id, d); continue }
            removedIds.push(d.id) // old defect no longer in the latest file → remove
          }

          const result: Damage[] = [...inApp]
          // duplicate-wound rule: the SAME wound recorded both at the station
          // (walk-around / PDI / mechanic) and in the Co-Inspection file must
          // show as ONE defect. The in-app record wins — it carries photos and
          // the mechanic's trail — so the file's copy is skipped; if an earlier
          // import already added that copy, it is removed now. Matching is by
          // normalized position + defect text across EN/TH labels.
          const normTxt = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, '')
          const inAppKeys = new Set<string>()
          for (const d of inApp) {
            for (const a of [d.area, d.areaTh]) for (const t of [d.type, d.item, d.itemTh]) {
              const na = normTxt(a), nt = normTxt(t)
              if (na && nt && na !== '—' && nt !== '—') inAppKeys.add(`${na}|${nt}`)
            }
          }
          const dupOfInApp = (d: Damage) => {
            for (const a of [d.area, d.areaTh]) for (const t of [d.type, d.item, d.itemTh]) {
              const na = normTxt(a), nt = normTxt(t)
              if (na && nt && inAppKeys.has(`${na}|${nt}`)) return true
            }
            return false
          }
          for (let dmg of fileById.values()) {
            if (inAppKeys.size && dupOfInApp(dmg)) {
              if (oldById.has(dmg.id)) removedIds.push(dmg.id)
              continue
            }
            const base = oldById.get(dmg.id) ?? healedTwin.get(dayKey(dmg.source, dmg.area, dmg.at))
            if (base) {
              // keep evidence captured in-app that the workbook can't carry —
              // photos, remark/note, Thai labels. Without this a weekly re-import
              // permanently wiped the mechanic's photos off every device + cloud.
              dmg = {
                ...dmg,
                photo:  dmg.photo  ?? base.photo,
                photos: dmg.photos?.length ? dmg.photos : base.photos,
                remark: dmg.remark ?? base.remark,
                note:   dmg.note   ?? base.note,
                areaTh: dmg.areaTh ?? base.areaTh,
                itemTh: dmg.itemTh ?? base.itemTh,
              }
              const hist = base.repairHistory ?? []
              if (dmg.statusRepair && base.statusRepair && dmg.statusRepair !== base.statusRepair) {
                dmg = { ...dmg, repairHistory: [...hist, { status: dmg.statusRepair, from: base.statusRepair, at: now, by: 'Co-Inspection Import' }] }
              } else if (!dmg.statusRepair && base.statusRepair) {
                dmg = { ...dmg, statusRepair: base.statusRepair, repairDate: base.repairDate, repairedBy: base.repairedBy, repairHistory: hist }
              } else {
                dmg = { ...dmg, repairHistory: hist }
              }
            }
            result.push(dmg)
            dmgItems.push({ vin, d: dmg })
            dmgCount++
          }
          u.damages = result
          units[vin] = u
          changedUnits.push(u)
        }
        set({ units }) // reveal locally at once; AWAIT the cloud writes so the caller
        // can keep a "saving…" state up and the user won't reload mid-upload (that
        // was silently truncating the 16k-row damage push → units synced, damages lost)
        try {
          onProgress?.(12, 'กำลังลบ Defect เดิมที่ไม่มีในไฟล์…')
          if (removedIds.length) await db.deleteDamages(removedIds, phase(12, 25, 'กำลังลบ Defect เดิมที่ไม่มีในไฟล์…'))
          // KEEP PLACEMENT: a defect sheet says nothing about where a car stands,
          // so this write must never carry block/row/slot (see db.ts) — otherwise
          // it wipes the yard-plan slot of every VIN whose unit this device has
          // not loaded from the cloud yet.
          await db.upsertUnitsKeepPlacement(changedUnits, phase(25, 45, 'กำลังบันทึกข้อมูลรถ…')) // FK parents first
          await db.upsertDamages(dmgItems, phase(45, 100, 'กำลังบันทึก Defect ขึ้น cloud…'))
        } catch (e) { console.error('[db] importDefects', e) }
        onProgress?.(100, 'เสร็จแล้ว')
        return { units: newUnits, damages: dmgCount }
      },
    }),
    {
      name: 'byd-yard-control',
      version: 6,
      storage: debouncedLocalStorage(),
      migrate: (state: any, fromVersion: number) => {
        let s = state
        if (fromVersion < 2) {
          s = { ...s, units: {}, trailers: [], trips: [] }
        }
        if (fromVersion < 3) {
          const old: Block[] = Array.isArray(s.blocks) ? s.blocks : BLOCKS
          const bySite: Record<string, Block[]> = { _global: old }
          for (const site of (Array.isArray(s.sites) ? s.sites : [])) bySite[site.id] = old
          s = { ...s, blocksBySite: bySite }
          delete s.blocks
        }
        if (fromVersion < 4) {
          const fixed = (Array.isArray(s.appUsers) ? s.appUsers : []).map((u: any) => ({
            ...u,
            username: u.username || '',
            password: u.password || '',
          }))
          const hasAdmin = fixed.some((u: any) => u.role === 'admin' && u.username && u.password)
          s = {
            ...s,
            loggedInUserId: null,
            appUsers: hasAdmin ? fixed : [
              { id: 'u1', name: 'admin', role: 'admin', active: true, username: 'admin', password: 'admin' },
            ],
          }
        }
        if (fromVersion < 5) {
          // site is no longer remembered across sessions — every entry re-picks
          s = { ...s, currentSite: null, loginAt: null }
        }
        if (fromVersion < 6) {
          // default UI language is now English — flip the stale persisted 'th'
          // (the OLD default, not a deliberate choice) to English once. Users can
          // switch back to TH any time in the top bar; the choice then persists.
          s = { ...s, lang: 'en' }
        }
        return s
      },
      // NOTE: currentSite IS persisted, but only within a login session. Field
      // tablets reload the page every time the operator switches apps (LINE →
      // back), and re-picking the yard mid-shift lost the screen they were on.
      // The previous-shift safety still holds: sessions expire at midnight and
      // logout() clears currentSite, so every LOGIN still re-picks the yard.
      partialize: (s) => ({
        lang: s.lang, planMode: s.planMode, currentUser: s.currentUser, currentDriver: s.currentDriver,
        groupModelsInRow: s.groupModelsInRow, laneDepth: s.laneDepth, view: s.view, appUsers: s.appUsers, loggedInUserId: s.loggedInUserId,
        loginAt: s.loginAt, currentSite: s.currentSite,
        // units moved to IndexedDB (see the write-through above): the snapshot
        // here regularly outgrew localStorage's ~5 MB cap and the whole save
        // then failed silently — losing not just units but EVERYTHING in this
        // key. {} keeps the shape for hydration; loadUnitsFromIdb refills.
        units: {}, trailers: s.trailers, policies: s.policies, blocksBySite: s.blocksBySite, models: s.models,
        // trips grew forever (full GPS path per drive) until localStorage hit its
        // quota and EVERY state change silently stopped persisting. Keep the 30
        // most recent, each capped to its last 600 fixes (~10 min at 1 Hz).
        trips: s.trips.slice(-30).map((t) => (t.path.length > 600 ? { ...t, path: t.path.slice(-600) } : t)),
        sites: s.sites,
        // survive a killed app / reload before the retry landed — otherwise a
        // defect that failed to sync and then got the tab closed on it is lost
        // for good instead of being retried on the next launch
        pendingDamages: s.pendingDamages,
      }),
    },
  ),
)

// ── units → IndexedDB write-through (yard-plan boot cache) ──────────────────
// localStorage caps at ~5 MB and fails SILENTLY past it — with ~2,000 cars +
// damages the units snapshot stopped saving on heavier devices, so the plan
// opened empty and re-downloaded everything every time. IndexedDB has no such
// cap. Debounced; photos stripped (multi-hundred-KB base64 — cloud owns them);
// flushed when the tab hides (mobile PWAs die without beforeunload).
let unitsIdbTimer: ReturnType<typeof setTimeout> | null = null
let unitsIdbLastRef: Record<string, Unit> | null = null
let unitsIdbLastKeys: Set<string> | null = null
function flushUnitsIdb() {
  if (unitsIdbTimer) { clearTimeout(unitsIdbTimer); unitsIdbTimer = null }
  const units = useYard.getState().units
  // in-yard only: DEPARTED cars are excluded from the cache — and by leaving
  // them out of `keys`, any departed car still sitting in the IDB store from
  // an earlier version is deleted by the gone-diff below
  const live = Object.values(units).filter((u) => u.status !== 'DEPARTED')
  const vals = live.map((u) => (u.damages.length
    ? { ...u, damages: u.damages.map((d) => ({ ...d, photo: undefined, photos: undefined })) }
    : u))
  idbPutUnits(vals).catch((e) => console.error('[idb] units put', e))
  const keys = new Set(live.map((u) => u.vin))
  if (unitsIdbLastKeys) {
    const gone = [...unitsIdbLastKeys].filter((k) => !keys.has(k))
    if (gone.length) idbDeleteUnits(gone).catch(() => {})
  }
  unitsIdbLastKeys = keys
}
useYard.subscribe((s) => {
  if (s.units === unitsIdbLastRef) return
  unitsIdbLastRef = s.units
  if (unitsIdbTimer) clearTimeout(unitsIdbTimer)
  unitsIdbTimer = setTimeout(flushUnitsIdb, 1500)
})
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { if (unitsIdbTimer) flushUnitsIdb() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && unitsIdbTimer) flushUnitsIdb()
  })
}

// ── ตำแหน่งรถ → ทุกเครื่องเห็นทันที ──────────────────────────────────────────
// The units table streams row-level changes, and when that stream is healthy
// every screen follows along. But it is one mechanism with one failure mode:
// if those events do not arrive — the table is not in the realtime publication,
// the socket is wedged, a proxy ate the frames — the yard plan simply stops
// changing and NOTHING in the app can tell. Ops re-locates a car, the admin's
// plan keeps showing the old spot, and only a page refresh puts it right.
//
// So every position this device writes is also ANNOUNCED on the broadcast bus,
// which needs no publication membership, and every client applies what it hears
// straight to its own plan. Two independent paths for the one thing the whole
// yard is looking at.
const posSig = (u?: Unit) =>
  u ? `${u.block ?? '-'}|${u.slot ?? 0}|${u.row ?? 0}|${u.status}` : ''
/** Last position known to be shared with the other clients — sent OR received.
 *  Comparing against it is what stops a received move being echoed straight
 *  back out again. */
const posShared = new Map<string, string>()
const pendingMoves = new Map<string, MoveMsg>()
let movesTimer: ReturnType<typeof setTimeout> | null = null
/** More than a handful of cars changing at once is a bulk load / re-sync, not
 *  someone moving a car — those devices reconcile on their own. */
const MOVES_BROADCAST_MAX = 200

function flushMoves() {
  movesTimer = null
  if (!pendingMoves.size) return
  const moves = [...pendingMoves.values()]
  pendingMoves.clear()
  if (moves.length > MOVES_BROADCAST_MAX) return
  sendSync('moves', { siteId: useYard.getState().currentSite, moves } satisfies MovesPayload)
}

useYard.subscribe((s, prev) => {
  if (s.units === prev.units) return
  for (const vin in s.units) {
    const u = s.units[vin]
    const sig = posSig(u)
    if (posShared.get(vin) === sig) continue
    const first = prev.units[vin] === undefined
    posShared.set(vin, sig)
    if (first) continue // a car arriving from the initial load is not a move
    pendingMoves.set(vin, { vin, block: u.block, row: u.row, slot: u.slot, status: u.status, at: Date.now() })
  }
  if (pendingMoves.size && !movesTimer) movesTimer = setTimeout(flushMoves, 250)
})

onSync('moves', (p: MovesPayload) => {
  const moves = p?.moves
  if (!Array.isArray(moves) || !moves.length) return
  const sid = useYard.getState().currentSite
  if (p.siteId && sid && p.siteId !== sid) return // another yard's move
  useYard.setState((s) => {
    const units = { ...s.units }
    let hit = 0
    for (const m of moves) {
      const cur = units[m.vin]
      if (!cur) continue // this device does not hold the car — its own load will bring it
      const next: Unit = { ...cur, block: m.block, row: m.row, slot: m.slot, status: (m.status as Unit['status']) ?? cur.status }
      const sig = posSig(next)
      if (posSig(cur) === sig) { posShared.set(m.vin, sig); continue }
      posShared.set(m.vin, sig) // mark as shared BEFORE the set() so it is not echoed back
      units[m.vin] = next
      hit++
    }
    return hit ? { units } : s
  })
})

// ── รถซ้อนช่องกัน → จัดคันที่ใหม่ในแถวเดิม (อัตโนมัติ) ────────────────────────
// A collision can appear from any device at any moment (a relocation racing
// another phone's), so the check rides on the units store itself. dedupeSlots
// only acts on squares claimed by MORE THAN ONE car and only ever re-numbers
// within the same ช่อง — a lane with holes but no collision is left exactly as
// the yard put it, and no car ever changes lane. It also writes nothing when
// there is nothing to fix, so its own set() cannot loop.
let dedupeTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDedupe(delay = 1200) {
  if (dedupeTimer) clearTimeout(dedupeTimer)
  dedupeTimer = setTimeout(() => {
    dedupeTimer = null
    try { useYard.getState().dedupeSlots().catch(() => {}) } catch { /* store mid-teardown */ }
  }, delay)
}
useYard.subscribe((s, prev) => {
  if (s.units !== prev.units || s.unitsCloudDone !== prev.unitsCloudDone) scheduleDedupe()
})

// ── ทุกเครื่องเห็นผังเดียวกัน: นาฬิกากระทบยอดตำแหน่ง ──────────────────────────
// Realtime carries every move the moment it happens, but a websocket that drops
// an event — or a phone that was asleep — leaves that device drawing a plan
// nobody else sees, with nothing to correct it until someone reloads. Re-reading
// VIN + position is cheap (no defects), so do it on a timer and whenever the
// screen comes back, and adopt whatever the cloud says.
const PLACEMENT_RESYNC_MS = 3 * 60_000
if (typeof window !== 'undefined') {
  const resync = () => {
    // a backgrounded tab is nobody's screen — its 16-page sweep every 3 minutes
    // was pure database load with no one looking. The visibilitychange listener
    // below re-syncs the moment the tab comes back, so nothing is missed.
    if (document.visibilityState === 'hidden') return
    const s = useYard.getState()
    if (!s.loggedInUserId || !s.currentSite || !s.unitsCloudDone) return
    s.refreshPlacements().catch(() => {})
  }
  setInterval(resync, PLACEMENT_RESYNC_MS)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resync() })
  window.addEventListener('online', resync)
}

// ── syncBus receivers: another device changed the layout / trailers → refetch ──
onSync('blocks', async (p: { siteId?: string }) => {
  const siteId = p?.siteId
  if (!siteId) return
  const blocks = await db.fetchBlocks(siteId)
  useYard.setState((s) => ({ blocksBySite: { ...s.blocksBySite, [siteId]: blocks } }))
})
onSync('trailers', async (p: { siteId?: string }) => {
  const siteId = p?.siteId
  if (!siteId || useYard.getState().currentSite !== siteId) return
  const trailers = await db.fetchTrailers(siteId)
  useYard.setState({ trailers })
})
// another device changed a parking rule → adopt it. The broadcast carries the
// full policy list so online devices update instantly even without app_config;
// loadPolicies() (from the cloud) is the fallback for devices that reconnect.
onSync('policies', (p: { policies?: ParkingPolicy[] }) => {
  if (Array.isArray(p?.policies) && p.policies.length) useYard.setState({ policies: p.policies })
  else useYard.getState().loadPolicies().catch(() => {})
})
// another device saved/edited/removed a defect whose photos are too big for the
// realtime row stream — it names the cars here, and this client refreshes JUST
// those (one small per-VIN fetch) instead of the old full-site re-pull.
onSync('dmg', (p: { vins?: string[] }) => {
  const vins = (p?.vins ?? []).filter((v) => typeof v === 'string' && v)
  if (!vins.length || vins.length > 50) return
  db.fetchUnitsByVins(vins).then((cloud) => {
    if (!cloud.length) return
    useYard.setState((s) => {
      const units = { ...s.units }
      // never let the cloud copy erase a defect still queued locally
      for (const u of cloud) units[u.vin] = attachPendingDamages(s.pendingDamages, u)
      return { units }
    })
  }).catch((e) => console.error('[db] dmg sync pull', e))
})

// ---------- demo GPS seeding ----------
const DEMO_DRIVERS = ['ก้องภพ', 'ณัฐวุฒิ', 'สุริยา', 'จิรายุ', 'พีรพล', 'อรรถพล', 'ชัยวัฒน์', 'วีรชัย', 'ธนกร', 'อนุชา']

function seedTrips(units: Record<string, Unit>): Trip[] {
  const rand = mulberry32(0x42d)
  const trips: Trip[] = []
  const list = Object.values(units).filter((u) => u.status === 'PARKED' || u.status === 'ASSIGNED')
  const now = Date.now()
  list.forEach((u, i) => {
    const dest = slotToLatLng(u.block, u.row, u.slot)
    const label = u.block ? `${u.block}${u.slot}.${u.row}` : 'Yard'
    const n = 1 + Math.floor(rand() * 3)
    let last: GpsPoint | undefined
    for (let k = 0; k < n; k++) {
      const daysAgo = (n - k) * (1 + Math.floor(rand() * 2))
      const startedAt = now - daysAgo * 86400000 - Math.floor(rand() * 6 * 3600000)
      const driver = DEMO_DRIVERS[(i + k) % DEMO_DRIVERS.length]
      const trip = makeDemoTrip(u.vin, driver, dest, label, startedAt, rand)
      trips.push(trip)
      last = trip.path[trip.path.length - 1]
    }
    if (last) { u.lastPos = last; u.tripCount = n }
  })
  trips.sort((a, b) => a.startedAt - b.startedAt)
  return trips
}

// ---------- derived selectors ----------
export function useUnits(): Unit[] {
  const units = useYard((s) => s.units)
  return useMemo(() => Object.values(units), [units])
}

/** The logged-in app user (null when logged out). */
export function useMe(): AppUser | null {
  return useYard((s) => s.appUsers.find((u) => u.id === s.loggedInUserId) ?? null)
}

/** Roles other than admin are field stations — they only ever see Yard Ops. */
export const isOpsOnlyRole = (role: UserRole | undefined | null): boolean => !!role && role !== 'admin'

export function useBlocks(): Block[] {
  const bySite = useYard((s) => s.blocksBySite)
  const site = useYard((s) => s.currentSite)
  return useMemo(() => bySite[site ?? '_global'] ?? [], [bySite, site])
}

export function useTrips(): Trip[] {
  return useYard((s) => s.trips)
}

export function tripsForVin(trips: Trip[], vin: string): Trip[] {
  return trips.filter((t) => t.vin === vin).sort((a, b) => b.startedAt - a.startedAt)
}
