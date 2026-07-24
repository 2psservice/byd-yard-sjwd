import { useMemo } from 'react'
import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type {
  AppUser, Block, Damage, DamageInput, GpsPoint, Lang, ParkingPolicy, Site, SlotCandidate, Trailer, Trip, Unit, UserRole, VehicleModel, View,
} from '../types'
import { BLOCKS, DEFAULT_POLICIES, MODELS, generateSample, matchModel, paintHex } from '../lib/sampleData'
import { autoAssign } from '../lib/parkingEngine'
import { haversineM, makeDemoTrip, mulberry32, slotToLatLng } from '../lib/geo'
import { IN_YARD_STATUSES } from '../lib/carStatus'
import type { RawRow } from '../lib/excel'
import type { DefectRow, TrackRow } from '../lib/excelTracking'
import * as db from '../lib/db'
import { onSync, sendSync } from '../lib/syncBus'
import { supabase } from '../lib/supabase'
import type { DbDamage, DbUnit } from '../lib/database.types'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface Toast { id: number; kind: 'ok' | 'err' | 'info'; msg: string }
let tid = 0

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
const unitTs = new Map<string, number>()

/** A unit whose `model` is the CANONICAL policy id. The stored model can be
 *  empty (placeholder unit) or non-canonical ("BYD ATTO 2" vs "ATTO2"), which
 *  makes the parking policy fall back to "any block". Always re-derive it via
 *  matchModel (the same keying the Rules page uses) so allowed-blocks holds. */
function withModelId(u: Unit): Unit {
  const model = matchModel(u.modelName || u.model || '').id
  return model === u.model ? u : { ...u, model }
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
  laneDepth: number // max cars stacked per lane (ช่อง) before the engine opens the next lane
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
  login: (username: string, password: string) => boolean
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
  setPolicy: (model: string, patch: Partial<ParkingPolicy>) => void
  loadPolicies: () => Promise<void>
  // --- yard layout editor ---
  addBlock: (b?: Partial<Block>) => string
  updateBlock: (id: string, patch: Partial<Block>) => void
  removeBlock: (id: string) => void
  /** Rename a block's internal id (badge letter). Returns the applied id, or null when empty/duplicate. */
  renameBlockId: (id: string, newId: string) => string | null
  // --- gps ---
  startTrip: (vin: string, driver: string, from: string, to: string) => void
  appendGps: (vin: string, p: GpsPoint) => void
  endTrip: (vin: string) => void
  purgeNonTracking: (realVins: Set<string>) => void
  ensureUnitSites: () => void
  // --- supabase ---
  loadFromSupabase: () => Promise<void>
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
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', flush)
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
      setUnitPreset: (unitPreset) => set({ unitPreset }),
      setUnitVinFilter: (unitVinFilter) => set({ unitVinFilter }),
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
        if (cloud.length === 0) {
          // empty cloud (first run, or transient fetch error) → seed from this
          // device; upsert by id is idempotent so a false-empty does no harm
          await Promise.all(get().appUsers.map((u) => db.upsertAppUser(u))).catch((e) => console.error('[db] seed appUsers', e))
          return
        }
        const cloudIds = new Set(cloud.map((u) => u.id))
        const localOnly = get().appUsers.filter((u) => !cloudIds.has(u.id))
        set({ appUsers: [...cloud, ...localOnly] })
        for (const u of localOnly) {
          db.upsertAppUser(u).catch((e) => console.error('[db] re-push local appUser', e))
        }
      },
      login: (username, password) => {
        const s = get()
        // username matches case-insensitively — an admin typing "TEST" when
        // creating a user shouldn't lock that person out for typing "test"
        const norm = (v: string) => v.trim().toLowerCase()
        const user = s.appUsers.find(u => norm(u.username) === norm(username) && u.password === password && u.active)
        if (!user) return false
        // every login: stamp the session day (auto-logout on day change) and
        // clear the site so the operator must pick their yard again — prevents
        // recording work into another site left selected by the previous shift
        set({
          loggedInUserId: user.id, currentUser: user.name, loginAt: Date.now(),
          currentSite: null, siteModalOpen: true,
          view: user.role === 'admin' ? s.view : 'yardops',
        })
        return true
      },
      logout: () => set({ loggedInUserId: null, loginAt: null, currentSite: null, siteModalOpen: false }),
      setGroupModels: (groupModelsInRow) => set({ groupModelsInRow }),
      setLaneDepth: (n) => {
        const laneDepth = Math.max(1, Math.min(8, Math.round(n || 0)))
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
        set({ units: {}, trailers: [], trips: [] })
        // damages + trips cascade automatically (FK on delete cascade)
        db.deleteAllUnits().catch((e) => console.error('[db] clearAll units', e))
        db.deleteAllTrailers().catch((e) => console.error('[db] clearAll trailers', e))
      },

      removeUnit: (vin) => {
        set((s) => {
          if (!s.units[vin]) return s
          const units = { ...s.units }
          delete units[vin]
          return { units, trips: s.trips.filter((t) => t.vin !== vin) }
        })
        db.deleteUnit(vin).catch((e) => console.error('[db] removeUnit', e))
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
          const updated: Unit = { ...u, status: u.status === 'EXPECTED' ? 'GATE_IN' : u.status, gateInAt: u.gateInAt ?? Date.now(), gateInBy: s.currentUser, inspected: true, site: s.currentSite ?? u.site }
          db.upsertUnit(updated).catch((e) => console.error('[db] gateIn', e))
          return { units: { ...s.units, [vin]: updated } }
        }),

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
          id: `man${++tid}_${now.toString(36)}`,
          area: f.position?.trim() || '—',
          type: f.defect?.trim() || '—',
          item: f.defect?.trim() || undefined,
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
            id: `man${++tid}_${now.toString(36)}`,
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

      resetParking: (vin) =>
        set((s) => {
          const u = s.units[vin]
          if (!u) return s
          const { block, row, slot, assignedAt, drivingStartedAt, parkedAt, ...rest } = u
          const updated: Unit = { ...rest, status: 'GATE_IN' }
          db.upsertUnit(updated).catch((e) => console.error('[db] resetParking', e))
          return { units: { ...s.units, [vin]: updated } }
        }),

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
        set({ units })
        db.upsertUnits(changed).catch((e) => console.error('[db] updateLocations', e))
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
        if (depth && typeof depth.laneDepth === 'number') set({ laneDepth: Math.max(1, Math.min(8, depth.laneDepth)) })
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

      // Rename a block's internal id (the badge letter). Units in this site
      // parked under the old id are re-tagged so their cars follow the block.
      renameBlockId: (id, newId) => {
        const next = newId.trim().toUpperCase()
        if (!next) return null
        if (next === id) return next
        const s = get()
        // locate the bucket that actually holds this block — usually the current
        // site, but fall back to any bucket (e.g. '_global', or a layout loaded
        // under a different key) so the rename never silently no-ops.
        let key = siteKey(s.currentSite)
        if (!(s.blocksBySite[key] ?? []).some((b) => b.id === id)) {
          const hit = Object.keys(s.blocksBySite).find((k) => (s.blocksBySite[k] ?? []).some((b) => b.id === id))
          if (hit) key = hit
        }
        const cur = s.blocksBySite[key] ?? []
        if (!cur.some((b) => b.id === id) || cur.some((b) => b.id === next)) return null
        // re-tag parked units: scope to the bucket's site (the real site id; the
        // '_global' bucket has no site so re-tag any unit parked under the old id)
        const bucketSite = key === '_global' ? null : key
        const units = { ...s.units }
        const changed: Unit[] = []
        for (const [vin, u] of Object.entries(units)) {
          if (u.block === id && (!bucketSite || u.site === bucketSite)) {
            const nu = { ...u, block: next }
            units[vin] = nu; changed.push(nu)
          }
        }
        set({
          blocksBySite: { ...s.blocksBySite, [key]: cur.map((b) => (b.id === id ? { ...b, id: next } : b)) },
          ...(changed.length ? { units } : {}),
        })
        if (changed.length) db.upsertUnits(changed).catch((e) => console.error('[db] renameBlockId', e))
        scheduleBlockSync(get) // replaceBlocks prunes the old-id cloud row
        return next
      },

      // ── gps ──────────────────────────────────────────────────────────────
      startTrip: (vin, driver, from, to) =>
        set((s) => {
          const trips = s.trips.map((t) =>
            t.vin === vin && !t.endedAt ? { ...t, endedAt: Date.now() } : t,
          )
          const trip: Trip = { id: `t${++tid}${Date.now()}`, vin, driver, startedAt: Date.now(), from, to, path: [] }
          const u = s.units[vin]
          return {
            trips: [...trips, trip],
            units: u ? { ...s.units, [vin]: { ...u, tripCount: (u.tripCount ?? 0) + 1 } } : s.units,
          }
        }),

      appendGps: (vin, p) =>
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
          trips[idx] = { ...trip, path }
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
        const [cloud, trailers, cloudBlocks] = await Promise.all([
          db.fetchAllUnits(siteId),
          db.fetchTrailers(siteId),
          db.fetchBlocks(siteId),
        ])
        // 3) yard-plan layout: cloud is the source of truth (any device's edit
        //    pushed there); when the cloud has none, seed it from this device so
        //    an existing local layout propagates to other machines.
        if (cloudBlocks.length) {
          set((s) => ({ blocksBySite: { ...s.blocksBySite, [siteKey(siteId)]: cloudBlocks } }))
        } else {
          const local = get().blocksBySite[siteKey(siteId)] ?? []
          if (local.length) db.replaceBlocks(siteId, local).catch((e) => console.error('[db] seedBlocks', e))
        }
        if (!cloud.length && !trailers.length) return
        set((s) => {
          const merged: Record<string, Unit> = { ...s.units }
          for (const u of cloud) merged[u.vin] = u
          return { units: merged, trailers: trailers.length ? trailers : s.trailers }
        })
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
                if (!id) return
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
              if (!r?.vin) return
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
          .subscribe()
      },

      unsubscribeRealtime: () => {
        if (unitsChannel) { supabase.removeChannel(unitsChannel); unitsChannel = null; unitTs.clear() }
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
          for (let dmg of fileById.values()) {
            const base = oldById.get(dmg.id) ?? healedTwin.get(dayKey(dmg.source, dmg.area, dmg.at))
            if (base) {
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
      // NOTE: currentSite is deliberately NOT persisted — the operator must pick
      // their yard on every entry (login or fresh page load) so work is never
      // recorded into a site left selected by the previous shift.
      partialize: (s) => ({
        lang: s.lang, planMode: s.planMode, currentUser: s.currentUser, currentDriver: s.currentDriver,
        groupModelsInRow: s.groupModelsInRow, laneDepth: s.laneDepth, view: s.view, appUsers: s.appUsers, loggedInUserId: s.loggedInUserId,
        loginAt: s.loginAt,
        units: s.units, trailers: s.trailers, policies: s.policies, blocksBySite: s.blocksBySite, models: s.models,
        trips: s.trips, sites: s.sites,
      }),
    },
  ),
)

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
