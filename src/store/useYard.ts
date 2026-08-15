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
import { blockKeyOfTag } from '../lib/format'
import type { RawRow } from '../lib/excel'
import type { DefectRow, TrackRow } from '../lib/excelTracking'
import * as db from '../lib/db'
import { useUnitsView } from './useUnitsView'
import { idbGetAllUnits, idbPutUnits, idbDeleteUnits } from '../lib/idb'
import { onSync, sendSync } from '../lib/syncBus'
import { hashPassword, verifyPassword, isHashed } from '../lib/password'
import { resolvePart, resolveDefect } from '../lib/masterDefect'
import { supabase } from '../lib/supabase'
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

// A damage row that carries base64 photos can exceed Supabase Realtime's
// max_record_bytes; the server then delivers the change WITHOUT the record
// body (no vin), so other devices silently never learn about that damage
// until a full reload. When we see such a truncated damage event we schedule
// one debounced re-pull of the active site's units so nothing is lost.
let damageRefetchTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDamageRefetch(run: () => void) {
  if (damageRefetchTimer) clearTimeout(damageRefetchTimer)
  damageRefetchTimer = setTimeout(() => { damageRefetchTimer = null; run() }, 1500)
}

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

// ── lane compaction ──────────────────────────────────────────────────────────
/** One lane = block name + yard + column. */
const laneKey = (u: { block?: string; slot?: number; site?: string }) =>
  `${blockKeyOfTag(u.block)}|${u.site ?? ''}|${u.slot ?? 0}`

/** Lanes these (pre-move) units were parked in. */
function lanesOf(list: (Unit | undefined)[]): Set<string> {
  const s = new Set<string>()
  for (const u of list) if (u?.block && u.row && u.slot) s.add(laneKey(u))
  return s
}

/** Re-pack the given lanes so positions read 1,2,3… with no holes: when the
 *  2nd car of a lane leaves, cars 3-4-5 shift up one place (คันที่ 3 4 5
 *  เลื่อนขึ้น). MUTATES `units` in place and returns the changed cars. Because
 *  lanes never keep holes, every "first free position" scan (re-location,
 *  parking engine, Update Location import) now lands a returning car at the
 *  END of its lane — exactly the yard's rule for a car that comes back. */
function compactLanes(units: Record<string, Unit>, lanes: Set<string>): Unit[] {
  if (!lanes.size) return []
  const byLane = new Map<string, Unit[]>()
  for (const vin in units) {
    const u = units[vin]
    if (!u.block || !u.row || !u.slot || u.status === 'DEPARTED') continue
    const k = laneKey(u)
    if (!lanes.has(k)) continue
    const arr = byLane.get(k)
    if (arr) arr.push(u); else byLane.set(k, [u])
  }
  const changed: Unit[] = []
  for (const arr of byLane.values()) {
    arr.sort((a, b) => a.row! - b.row!)
    arr.forEach((u, i) => {
      if (u.row !== i + 1) {
        const nu = { ...u, row: i + 1 }
        units[u.vin] = nu
        changed.push(nu)
      }
    })
  }
  return changed
}

/** Persist compaction-slid rows through the stale-copy guard. EVERY device
 *  compacts lanes (boot pass, gate-out sweep, departures, relocations) using
 *  its LOCAL copy — one that may not have received a relocation done elsewhere.
 *  Unchecked, that stale copy is "slid" back into the old lane and pushed with
 *  a fresh timestamp, overwriting the real move (a car moved N1602 → N3201 on
 *  device A was re-written to N1601 by device B compacting lane N16). Before
 *  persisting, compare each slid car's CLOUD position with the position this
 *  device slid it FROM: a mismatch means our copy was stale — adopt the cloud
 *  row and drop our write for that car. The adopt triggers another (now fresh)
 *  pass that converges properly. Offline / no cloud: persist as before. */
function persistSlid(
  setUnits: (fn: (s: { units: Record<string, Unit> }) => { units: Record<string, Unit> }) => void,
  before: Record<string, Unit>,
  slid: Unit[],
  label: string,
) {
  if (!slid.length) return
  const finish = (rows: Unit[]) => {
    if (rows.length) db.upsertUnits(rows).catch((e) => console.error(`[db] ${label}`, e))
  }
  if (!db.isConfigured()) { finish(slid); return }
  const prevPos = new Map(slid.map((u) => {
    const p = before[u.vin]
    return [u.vin, p ? `${p.block}|${p.slot}|${p.row}` : ''] as const
  }))
  db.fetchUnitsByVins(slid.map((u) => u.vin))
    .then((cloud) => {
      const cloudBy = new Map(cloud.map((u) => [u.vin, u]))
      const push: Unit[] = []
      const adopt: Unit[] = []
      for (const u of slid) {
        const c = cloudBy.get(u.vin)
        if (!c) { push.push(u); continue } // not in cloud yet — keep ours
        if (`${c.block}|${c.slot}|${c.row}` === prevPos.get(u.vin)) push.push(u)
        else adopt.push(c) // cloud moved on — our slide used a stale copy
      }
      if (adopt.length) {
        setUnits((s) => {
          const next = { ...s.units }
          for (const c of adopt) next[c.vin] = { ...c, damages: s.units[c.vin]?.damages?.length ? s.units[c.vin].damages : c.damages }
          return { units: next }
        })
      }
      finish(push)
    })
    .catch(() => finish(slid)) // cloud unreachable (offline) — persist as before
}

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
  /** One pass over EVERY lane: close all holes left by departures that happened
   *  before compaction existed. Runs after boot / site-switch loads; idempotent
   *  and deterministic, so concurrent devices converge on the same layout. */
  compactAllLanes: () => number
  markTrailerArrived: (no: number, arrived?: boolean) => void
  gateIn: (vin: string) => void
  setInspected: (vin: string, v: boolean) => void
  addDamage: (vin: string, d: DamageInput) => void
  removeDamage: (vin: string, id: string) => void
  updateDamage: (vin: string, id: string, patch: Partial<import('../types').Damage>) => void
  updateRepairStatus: (vin: string, id: string, status: string) => void
  addManualDamage: (vin: string, f: { position?: string; defect?: string; categoryNG?: string; categoryRepair?: string; incharge?: string; note?: string; date?: string; statusRepair?: string; repairDate?: string; severity?: 'minor' | 'major' }) => void
  /** Add the SAME manual defect to many VINs at once (Unit List bulk action).
   *  `source` routes it to the right Report sheet (yardDefect → Defect-Yard,
   *  factoryDefect → Defect-Factory); defaults to 'manual' (→ Defect-Yard). */
  addManualDamageBulk: (vins: string[], f: { position?: string; defect?: string; categoryNG?: string; categoryRepair?: string; incharge?: string; note?: string; date?: string; statusRepair?: string; repairDate?: string; severity?: 'minor' | 'major'; source?: import('../types').DamageSource }) => number
  suggest: (vin: string) => SlotCandidate | null
  assign: (vin: string, slot: { block: string; row: number; slot: number }, driver?: string, mode?: 'AUTO' | 'SEMI') => void
  confirmParked: (vin: string) => void
  resetParking: (vin: string) => void
  /** Update Location import — bulk place cars into block/row/slot as PARKED. */
  updateLocations: (items: { vin: string; block: string; row: number; slot: number; modelName?: string; color?: string; gateInAt?: number }[]) => number
  autoParkAll: () => number
  /** Auto-park every listed VIN into the WCL staging block that doesn't
   *  already have a real block/row/slot — leaves already-positioned units
   *  untouched. Used to backfill legacy "Gate-in" cars onto the same WCL
   *  placement a fresh gate-in now gets. Returns how many were placed. */
  parkUnpositionedAtWcl: (vins: string[]) => number
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
  // --- supabase ---
  loadFromSupabase: () => Promise<void>
  /** boot cache: fill the yard plan from IndexedDB before the network answers */
  loadUnitsFromIdb: () => Promise<void>
  /** true once the cloud's units for the active site have fully landed —
   *  the Yard Plan shows its "ไม่แสดงบนผัง" number only when it's FINAL */
  unitsCloudDone: boolean
  subscribeRealtime: () => void
  unsubscribeRealtime: () => void
  // --- co-inspection defects ---
  importDefects: (defects: DefectRow[], trackingRows: Record<string, TrackRow>) => Promise<{ units: number; damages: number }>
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
 *  moves to its real slot later via Re-location. */
const WCL_STAGING_BLOCK = 'WCL'

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
        // units/trailers are loaded per-site → fetch the newly selected yard,
        // then close up any lane holes left from before compaction existed
        get().loadFromSupabase()
          .catch((e) => console.error('[db] setCurrentSite load', e))
          .finally(() => { try { get().compactAllLanes() } catch { /* noop */ } })
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
        // sync to Supabase
        db.upsertUnits(changedUnits).catch((e) => console.error('[db] importUnits', e))
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
        const old = before[vin]
        if (!old) return
        const units = { ...before }
        delete units[vin]
        const slid = compactLanes(units, lanesOf([old]))
        set((s) => ({ units, trips: s.trips.filter((t) => t.vin !== vin) }))
        db.deleteUnit(vin).catch((e) => console.error('[db] removeUnit', e))
        persistSlid(set, before, slid, 'removeUnit compact')
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
        // the lane it left closes up behind it (คันถัดไปเลื่อนขึ้น) — the slide
        // goes through the stale-copy guard, the departure itself pushes as-is
        const slid = compactLanes(units, lanesOf([u]))
        set({ units })
        db.upsertUnits([units[vin]]).catch((e) => console.error('[db] markDeparted', e))
        persistSlid(set, before, slid, 'markDeparted compact')
      },

      markDepartedMany: (vins) => {
        const before = get().units
        const units = { ...before }
        const old: Unit[] = []
        const cleared: Unit[] = []
        for (const vin of vins) {
          const u = units[vin]
          if (!u) continue // sheet-only car (no yard unit) — nothing to release
          old.push(u)
          const updated: Unit = { ...u, status: 'DEPARTED', block: undefined, row: undefined, slot: undefined }
          units[vin] = updated
          cleared.push(updated)
        }
        if (!cleared.length) return
        const slid = compactLanes(units, lanesOf(old))
        set({ units })
        db.upsertUnits(cleared).catch((e) => console.error('[db] markDepartedMany', e))
        persistSlid(set, before, slid, 'markDepartedMany compact')
      },

      compactAllLanes: () => {
        const before = get().units
        const units = { ...before }
        const lanes = lanesOf(Object.values(units))
        const changed = compactLanes(units, lanes)
        if (!changed.length) return 0
        set({ units })
        persistSlid(set, before, changed, 'compactAllLanes')
        return changed.length
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

      parkUnpositionedAtWcl: (vins) => {
        const s = get()
        const blocks = curBlocks(s)
        // simulated occupancy grows as each car is placed, so two cars in the
        // same batch land on DIFFERENT WCL slots instead of both claiming slot 1
        let occ = Object.values(s.units).filter((x) => !x.site || x.site === s.currentSite)
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
          db.upsertUnit(updated).catch((e) => console.error('[db] setInspected', e))
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
          // fails, tell the operator — a silent console.error is invisible on a phone
          // and the record would only exist on this one device.
          db.upsertUnit(u).then(() => db.insertDamage(vin, dmg)).catch((e) => {
            console.error('[db] addDamage', e)
            get().toast('err', `บันทึก Defect ไว้ในเครื่องนี้ แต่ยังไม่ขึ้น cloud (เน็ตหลุด?) — ${vin.slice(-6)}`)
          })
          return { units: { ...s.units, [vin]: { ...u, damages: [...u.damages, dmg] } } }
        }),

      removeDamage: (vin, id) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          const gone = u.damages.find((x) => x.id === id)
          db.deleteDamage(id).catch((e) => console.error('[db] removeDamage', e))
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
        }
        const existing = s.units[vin]
        const m = existing ?? {
          vin, model: '', modelName: '', color: '—', trailer: 0,
          status: 'GATE_IN' as const, damages: [], importedAt: now, site: s.currentSite ?? undefined,
        }
        const u: Unit = { ...m, damages: [...m.damages, dmg] }
        set({ units: { ...s.units, [vin]: u } })
        // FK-safe: parent unit first, then the damage
        db.upsertUnit(u).then(() => db.upsertDamages([{ vin, d: dmg }])).catch((e) => console.error('[db] addManualDamage', e))
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
        db.upsertUnits(changedUnits).then(() => db.upsertDamages(dmgItems)).catch((e) => console.error('[db] addManualDamageBulk', e))
        return changedUnits.length
      },

      updateDamage: (vin, id, patch) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          db.patchDamage(id, patch).catch((e) => console.error('[db] updateDamage', e))
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
        const slid = compactLanes(units, lanesOf([u]))
        set({ units })
        db.upsertUnits([units[vin]]).catch((e) => console.error('[db] resetParking', e))
        persistSlid(set, before, slid, 'resetParking compact')
      },

      // Update Location import: place each car into its lane's block/row at the
      // given slot. Creates a minimal unit for VINs not in the system yet.
      updateLocations: (items) => {
        const s = get()
        const units = { ...s.units }
        const changed: Unit[] = []
        const now = Date.now()
        // lanes the moved cars are leaving — they close up after the move
        const fromLanes = lanesOf(items.map((it) => units[it.vin]))
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
        // a lane a car moved OUT of keeps no hole — cars behind it shift up.
        // (Lanes cars moved INTO are excluded automatically: their occupants sit
        // at 1..n already, and the mover was appended at first-free = n+1.)
        const moved = changed.length
        const slid = compactLanes(units, fromLanes)
        set({ units })
        // the deliberate placements push as-is (a relocation IS an intentional
        // overwrite); only the compaction slide goes through the stale-copy
        // guard. One write per car — a car both placed AND re-rowed must not
        // appear twice in the same upsert batch (Postgres rejects that).
        const intentional = new Set(changed.map((u) => u.vin))
        db.upsertUnits([...intentional].map((v) => units[v])).catch((e) => console.error('[db] updateLocations', e))
        persistSlid(set, s.units, slid.filter((u) => !intentional.has(u.vin)), 'updateLocations compact')
        return moved
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
        // stream: paint cars into the yard plan page by page — a cold device
        // used to stare at an empty plan until the LAST page of ~2,000 cars
        // (+ damages) had arrived; now they flow in with the layout
        const streamUnits = (batch: Unit[]) => set((s) => {
          const units = { ...s.units }
          for (const u of batch) units[u.vin] = u
          return { units }
        })
        const [cloud, trailers] = await Promise.all([
          db.fetchAllUnits(siteId, streamUnits),
          db.fetchTrailers(siteId),
        ])
        await blocksDone // callers may assume the layout is settled on return
        if (cloud.length || trailers.length) {
          set((s) => {
            const merged: Record<string, Unit> = { ...s.units }
            for (const u of cloud) merged[u.vin] = u
            return { units: merged, trailers: trailers.length ? trailers : s.trailers }
          })
        }
        } finally { set({ unitsCloudDone: true }) }
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
                  // key-only/truncated DELETE payload — refetch this site's units so
                  // the removal still lands here (mirror of the INSERT/UPDATE path;
                  // otherwise the deleted defect lingered and could be re-uploaded)
                  scheduleDamageRefetch(() => {
                    const siteId = get().currentSite
                    if (!siteId) return
                    db.fetchAllUnits(siteId).then((cloud) => {
                      if (!cloud.length) return
                      set((s) => {
                        const merged: Record<string, Unit> = { ...s.units }
                        for (const u of cloud) merged[u.vin] = u
                        return { units: merged }
                      })
                    }).catch((e) => console.error('[db] damage delete refetch', e))
                  })
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
                // record body was dropped. Re-pull this site's units so the new
                // damage (and its photos, straight from the DB) still shows here.
                scheduleDamageRefetch(() => {
                  const siteId = get().currentSite
                  if (!siteId) return
                  db.fetchAllUnits(siteId).then((cloud) => {
                    if (!cloud.length) return
                    set((s) => {
                      const merged: Record<string, Unit> = { ...s.units }
                      for (const u of cloud) merged[u.vin] = u
                      return { units: merged }
                    })
                  }).catch((e) => console.error('[db] damage refetch', e))
                })
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
              if (!unitsHadDrop) return
              unitsHadDrop = false
              const sid = get().currentSite
              if (!sid) return
              db.fetchAllUnits(sid).then((cloud) => {
                if (!cloud.length) return
                set((s) => {
                  const merged: Record<string, Unit> = { ...s.units }
                  for (const u of cloud) merged[u.vin] = u
                  return { units: merged }
                })
              }).catch(() => {})
              return
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
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
        if (damageRefetchTimer) { clearTimeout(damageRefetchTimer); damageRefetchTimer = null } // don't refetch after logout/site switch
      },

      // Defect-Yard / Defect-Factory rows → Damage records on each VIN's unit.
      // Creates a minimal unit (from the tracking row) when one doesn't exist yet,
      // so imported defects display in the Unit List / Check views. Deterministic
      // damage ids mean re-importing the same file updates rather than duplicates.
      importDefects: async (defects, trackingRows) => {
        if (!defects.length) return { units: 0, damages: 0 }
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
          if (removedIds.length) await db.deleteDamages(removedIds)
          await db.upsertUnits(changedUnits) // FK parents first
          await db.upsertDamages(dmgItems)
        } catch (e) { console.error('[db] importDefects', e) }
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

// ── realtime lane compaction ─────────────────────────────────────────────────
// Lanes must never sit with holes, no matter which device caused them: a
// gate-out on another phone arrives here through the units realtime channel,
// and this debounced pass closes the gap moments later. compactAllLanes is
// deterministic and writes nothing when lanes are already tight, so the
// subscription can't loop (its own set() triggers one more pass that no-ops)
// and every device converges on the same layout.
let compactTimer: ReturnType<typeof setTimeout> | null = null
function scheduleCompact(delay = 900) {
  if (compactTimer) clearTimeout(compactTimer)
  compactTimer = setTimeout(() => {
    try { useYard.getState().compactAllLanes() } catch { /* store mid-teardown */ }
  }, delay)
}
useYard.subscribe((s, prev) => { if (s.units !== prev.units) scheduleCompact() })
scheduleCompact(1500) // heal once shortly after boot, without waiting for the cloud load

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
