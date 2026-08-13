import { useMemo } from 'react'
import { create } from 'zustand'
import { quotaSafeStorage } from '../lib/persistStorage'
import { persist } from 'zustand/middleware'
import type { Column } from '../lib/trackingColumns'
import { defaultColumns, reconcileColumns, MAX_FILTERS, DEFAULT_FILTER_COLS } from '../lib/trackingColumns'
import type { ParseResult, RowEvent, TrackRow } from '../lib/excelTracking'
import { parseTrackingWorkbook } from '../lib/excelTracking'
import { idbBulkPut, idbClear, idbDelete, idbGetAllRows, idbPut } from '../lib/idb'
import * as db from '../lib/db'
import { supabase } from '../lib/supabase'
import { onSync, sendSync } from '../lib/syncBus'
import { isOnlineOnly } from '../lib/onlineMode'
import { useYard } from './useYard'
import { siteForRow, siteIdForLocation, coInspectionAccepts } from '../lib/siteScope'
import { CAR_STATUS_ORDER, deriveCarStatus, isGateOutStamp } from '../lib/carStatus'
import type { RealtimeChannel } from '@supabase/supabase-js'

// live channel (module-scoped — never persisted)
let trackingChannel: RealtimeChannel | null = null
// remember a websocket drop so the re-subscribe runs an incremental syncCloud
// to catch up on rows changed while the socket was down
let trackingHadDrop = false

/** Migrate the filter config from its old standalone localStorage key (pre-store). */
function initialFilterCols(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem('sjwd-filter-cols') || 'null')
    if (Array.isArray(saved) && saved.every((k) => typeof k === 'string')) return saved.slice(0, MAX_FILTERS)
  } catch { /* ignore */ }
  return DEFAULT_FILTER_COLS
}

const VIEW_DEFAULT_KEY = 'unit_view_default' // shared cloud config id
interface ViewDefault { columns?: Column[]; filterCols?: string[]; updatedAt?: number }

interface TrackingState {
  rows: Record<string, TrackRow>   // keyed by VIN (in memory; persisted in IndexedDB)
  columns: Column[]
  filterCols: string[]             // Unit-List filter bar: which columns are filters (ordered)
  defaultSeeded: boolean           // has this device ever adopted a shared default?
  viewDefaultVersion: number       // updatedAt of the last shared default this device adopted (0 = none)
  loaded: boolean
  importing: boolean
  lastImport: { inYard: number; total: number; gatedOut: number; at: number } | null
  lastSync: number // epoch ms of the last successful cloud sync (0 = never → full pull)

  loadFromIdb: () => Promise<void>
  syncCloud: () => Promise<void>
  /** full per-VIN diff against the cloud index — converges this device 100% */
  reconcileCloud: () => Promise<void>
  /** verify local row count matches the cloud's, reconciling until it does */
  ensureComplete: () => Promise<void>
  /** cloud's exact row total (null = unknown) — powers the sync-status badge */
  cloudTotal: number | null
  refreshCloudTotal: () => Promise<void>
  subscribeRealtime: () => void
  unsubscribeRealtime: () => void
  importFile: (file: File) => Promise<ParseResult>
  commitImport: (res: ParseResult) => void
  commitCoInspection: (res: ParseResult) => { updated: number; added: number; skipped: number; gateOut: number; moved: number }
  updateCell: (vin: string, key: string, value: string) => void
  bulkUpdate: (vins: string[], key: string, value: string) => void
  /** Append a free-form audit entry to a row's history (no cell change) — used to
   *  log damage add/remove so the admin Event tab keeps a permanent record. */
  appendHistory: (vin: string, entry: RowEvent) => void
  addRow: (vin: string, cells?: Record<string, string>) => boolean
  deleteRows: (vins: string[]) => void
  clearRows: () => void

  // column ops
  setColumns: (cols: Column[]) => void
  toggleColumn: (key: string) => void
  showAll: (visible: boolean) => void
  moveColumn: (key: string, dir: -1 | 1) => void
  reorderColumn: (dragKey: string, dropKey: string) => void
  addColumn: (label: string) => void
  removeColumn: (key: string) => void
  resetColumns: () => void

  // filter config + shared "default view" (columns + filters) preset
  setFilterCols: (cols: string[] | ((c: string[]) => string[])) => void
  seedViewDefault: () => Promise<void>     // one-time: pull the shared default onto a fresh device
  saveViewDefault: () => Promise<void>     // admin: publish current columns + filters as the shared default
  resetToViewDefault: () => Promise<boolean> // pull the shared default on demand (overrides local)
  saveMyView: () => Promise<void>          // บันทึก: save THIS USER's columns + filters to the cloud
  loadMyView: () => Promise<void>          // login: restore the user's saved view (newer than the shared default wins)
}

// merge live select-options discovered during import into the column defs
function applyOptions(columns: Column[], options: Record<string, string[]>): Column[] {
  return columns.map((c) => {
    const live = options[c.key]
    if (!live || !live.length) return c
    const merged = [...new Set([...(c.options ?? []), ...live])].sort()
    return { ...c, type: 'select', options: merged }
  })
}

/** Add a plain text column for every imported header not already in the config,
 *  so EVERY uploaded column shows up in the Unit List (data is already stored in
 *  each row's cells + synced to cloud; this just makes it visible/usable). */
function mergeImportedColumns(columns: Column[], headers: string[] | undefined): Column[] {
  if (!headers?.length) return columns
  const have = new Set(columns.map((c) => c.key))
  const extra: Column[] = []
  for (const h of headers) {
    const key = (h ?? '').trim()
    if (!key || have.has(key)) continue
    have.add(key)
    extra.push({ key, label: key, group: 'vehicle', type: 'text', width: 150, visible: true, editable: true, custom: true })
  }
  return extra.length ? [...columns, ...extra] : columns
}

// Every station's cell writes (Gate-in, Driver, PDI/PM/FC, Gate-out, Relocation)
// and admin edits from the Unit List context menu funnel through updateCell/
// bulkUpdate — logging there gives the RowDetail "Event" tab full coverage for
// free, with no per-caller wiring. Capped so a long-lived VIN's history can't
// grow unbounded.
// A legitimate tracking row always carries its VIN in cells['Vin'] (every create
// path sets it). A row with a blank Vin cell is a phantom — a malformed insert
// that shows as an empty line in the Unit List. Drop these on ingest and purge
// them from the cloud so they disappear on every device.
const hasVin = (r: { cells?: Record<string, string> | null } | null | undefined) =>
  !!(r?.cells?.['Vin'] ?? '').trim()

const MAX_ROW_HISTORY = 100
function withHistoryEntry(r: TrackRow, key: string, value: string, columns: Column[], by: string): TrackRow {
  const from = r.cells[key] ?? ''
  const cells = { ...r.cells, [key]: value }
  if (from === value) return { ...r, cells } // unchanged value — still write, skip the log entry
  const label = columns.find((c) => c.key === key)?.label ?? key
  const entry: RowEvent = { at: Date.now(), by, field: label, from, to: value }
  return { ...r, cells, history: [...(r.history ?? []), entry].slice(-MAX_ROW_HISTORY) }
}

export const useTracking = create<TrackingState>()(
  persist(
    (set, get) => ({
      rows: {},
      columns: defaultColumns(),
      filterCols: initialFilterCols(),
      defaultSeeded: false,
      viewDefaultVersion: 0,
      loaded: false,
      importing: false,
      lastImport: null,
      lastSync: 0,
      cloudTotal: null,

      loadFromIdb: async () => {
        if (get().loaded) return

        // ── ONLINE 100%: this device holds nothing of its own ───────────────
        // Start from an empty table, wipe whatever an older build cached, and
        // fill the screen from the cloud only. Nothing on this device can make
        // its numbers differ from anyone else's.
        if (isOnlineOnly() && db.isConfigured()) {
          set({ rows: {}, lastSync: 0 })
          idbClear().catch(() => {})
          // fast first paint: the ACTIVE yard, filtered server-side (~2 MB)
          const y = useYard.getState()
          const siteName = y.sites.find((s) => s.id === y.currentSite)?.name
          if (siteName) {
            try {
              const siteRows = await db.fetchTrackingRowsForSite(siteName)
              if (siteRows.length) {
                const rec: Record<string, TrackRow> = {}
                for (const r of siteRows) if (hasVin(r)) rec[r.vin] = r
                set({ rows: rec, loaded: true }) // cloud data — safe to show
              }
            } catch { /* the full pull below is the real load */ }
          }
          // full set, verified against the cloud's exact count
          await get().syncCloud().catch(() => {})
          set({ loaded: true }) // release the loader even if the network failed
          get().ensureComplete().catch(() => {})
          return
        }

        let rows: Record<string, TrackRow> = {}
        try {
          const all = await idbGetAllRows()
          // backfill rows imported before "Last update" existed → use the import time
          const fallback = get().lastImport?.at ?? Date.now()
          const fixed: TrackRow[] = []
          const phantom: string[] = [] // blank-Vin rows → purge locally + in the cloud
          for (const r of all) {
            if (!hasVin(r)) { phantom.push(r.vin); continue }
            if (r.updatedAt == null) { r.updatedAt = fallback; fixed.push(r) }
            rows[r.vin] = r
          }
          if (fixed.length) idbBulkPut(fixed).catch(() => {})
          if (phantom.length) {
            idbDelete(phantom).catch(() => {})
            db.deleteTrackingRows(phantom).catch(() => {}) // soft-delete → propagates to every device
          }
        } catch { /* IndexedDB unavailable — fall through with empty rows */ }

        const hasLocal = Object.keys(rows).length > 0
        // reveal the UI immediately — never block the splash on the network
        set({ rows, loaded: true })

        if (!hasLocal) {
          // fresh device (e.g. a new phone): pull the ACTIVE yard first — a
          // server-side "Location yard" filter (~2 MB, not the full 11 MB) — so the
          // current site fills in fast, before the full background sync
          const y = useYard.getState()
          const siteName = y.sites.find((s) => s.id === y.currentSite)?.name
          if (siteName) {
            try {
              const siteRows = await db.fetchTrackingRowsForSite(siteName)
              if (siteRows.length) {
                const rec: Record<string, TrackRow> = {}
                for (const r of siteRows) if (hasVin(r)) rec[r.vin] = r
                set({ rows: rec })
                idbBulkPut(siteRows.filter(hasVin)).catch(() => {})
              }
            } catch { /* fall through to the full sync below */ }
          }
        }
        // reconcile every yard in the background (incremental after the first
        // run), then verify the device actually holds the cloud's full set —
        // a first load that came up short used to stay short forever
        get().syncCloud().then(() => get().ensureComplete()).catch(() => {})
      },

      refreshCloudTotal: async () => {
        const n = await db.countTrackingRows()
        if (n !== null) set({ cloudTotal: n })
      },

      // ── convergence check: does this device hold every cloud row? ──────────
      // Compares the cloud's exact row count with the local one and runs the
      // per-VIN reconcile until they agree (max 3 tries). This is what makes 20
      // devices opening at once all land on the same number instead of each
      // freezing at whatever its first load happened to fetch.
      ensureComplete: async () => {
        if (!db.isConfigured()) return
        for (let attempt = 0; attempt < 3; attempt++) {
          const cloudCount = await db.countTrackingRows()
          if (cloudCount == null) return // can't verify → decide nothing
          const localCount = Object.keys(get().rows).length
          if (localCount === cloudCount) return // exact mirror of the cloud
          console.warn(`[tracking] out of sync: local ${localCount} vs cloud ${cloudCount} — reconciling (try ${attempt + 1})`)
          await get().reconcileCloud()
          if (Object.keys(get().rows).length === cloudCount) return
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      },

      // Two-way merge between this device (IndexedDB) and Supabase, keyed by VIN
      // with last-write-wins on updatedAt. INCREMENTAL after the first sync: only
      // rows changed since `lastSync` are pulled/pushed, so repeat loads are near
      // instant instead of re-downloading all ~11 MB every time.
      syncCloud: async () => {
        if (!db.isConfigured()) return
        const startedAt = Date.now()
        const lastSync = get().lastSync ?? 0
        const local = get().rows
        const hasLocal = Object.keys(local).length > 0
        // full pull the first time, or as a safety resync if the last one is stale (>6h);
        // otherwise fetch only what changed since last sync (minus a 2-min skew margin)
        const stale = startedAt - lastSync > 6 * 3600_000
        const incremental = lastSync > 0 && hasLocal && !stale
        const since = incremental ? lastSync - 120_000 : undefined

        let cloud: TrackRow[] = []
        let complete = false
        try { const res = await db.fetchTrackingRows(since); cloud = res.rows; complete = res.complete } catch { return }
        const cloudByVin = new Map(cloud.map((r) => [r.vin, r]))

        // cloud → local: apply tombstones (remove) and pull rows missing locally
        // or newer in the cloud. A tombstone (deletedAt set) always wins over a
        // stale local copy → the delete propagates to every device.
        const merged: Record<string, TrackRow> = { ...local }
        const pull: TrackRow[] = []
        const drop: string[] = []
        const phantom: string[] = [] // blank-Vin rows in the cloud → tombstone them
        for (const cr of cloud) {
          const lr = local[cr.vin]
          if (cr.deletedAt) {
            if (lr) { delete merged[cr.vin]; drop.push(cr.vin) }
          } else if (!hasVin(cr)) {
            if (lr) { delete merged[cr.vin]; drop.push(cr.vin) }
            phantom.push(cr.vin)
          } else if (!lr || (cr.updatedAt ?? 0) > (lr.updatedAt ?? 0)) {
            merged[cr.vin] = cr; pull.push(cr)
          }
        }
        // also sweep any blank-Vin rows already sitting in local state
        for (const lr of Object.values(local)) if (!hasVin(lr) && !drop.includes(lr.vin)) { delete merged[lr.vin]; drop.push(lr.vin) }
        if (phantom.length) db.deleteTrackingRows(phantom).catch(() => {})

        // local → cloud: MIRROR mode — the screen shows the CLOUD, 100%.
        // On a full pull that is VERIFIED COMPLETE (every page arrived and the
        // row total matches the cloud's exact count), a local row the cloud
        // does not have is removed from this device — EXCEPT rows this device
        // itself edited after its last sync (offline work): those are pushed
        // up instead of lost. An INCOMPLETE pull never deletes anything and
        // never advances lastSync — that completeness guard is what was
        // missing when a truncated pull wiped thousands of rows.
        const push: TrackRow[] = []
        for (const lr of Object.values(local)) {
          if (!hasVin(lr)) continue // never re-push phantom rows
          const cr = cloudByVin.get(lr.vin)
          if (cr?.deletedAt) continue
          if (incremental) {
            if ((lr.updatedAt ?? 0) > lastSync) push.push(lr)
          } else if (lastSync > 0) {
            if ((lr.updatedAt ?? 0) > lastSync) push.push(lr) // own un-pushed edits → keep + upload
            else if (complete && !cr && !drop.includes(lr.vin)) { delete merged[lr.vin]; drop.push(lr.vin) }
          } else {
            // first-ever sync: seed the cloud from this device
            if (!cr || (lr.updatedAt ?? 0) > (cr.updatedAt ?? 0)) push.push(lr)
          }
        }

        if (pull.length || drop.length) { set({ rows: merged }) }
        if (pull.length) idbBulkPut(pull).catch(() => {})
        if (drop.length) idbDelete(drop).catch(() => {})
        // await the push: if it FAILED, lastSync must stay put so these edits
        // keep counting as "newer than lastSync" and the next mirror pass
        // rescues them instead of deleting rows the cloud never received
        const pushOk = push.length ? await db.upsertTrackingRows(push).catch(() => false) : true
        // a PARTIAL pull must not advance lastSync either: doing so switched the
        // next run to incremental and the missing rows were never fetched again —
        // that is how a device stayed stuck at 213 of 1,980 rows forever
        if (complete && pushOk) set({ lastSync: startedAt })
        else if (!complete) console.error('[tracking] partial sync — lastSync not advanced, will pull fully again')
        else console.error('[tracking] push failed — lastSync not advanced so local edits stay protected')
        // occasionally clear tombstones older than 30 days so the table stays lean
        if (!incremental) db.purgeTrackingTombstones(30 * 24 * 3600_000).catch(() => {})
      },

      // ── full per-VIN reconciliation against the cloud ──────────────────────
      // Incremental syncs drift: a device that misses a tombstone window (or a
      // realtime event) keeps ghost rows forever, so two screens show different
      // yard counts (1,978 vs 2,318). This pass diffs a LIGHT index of every
      // cloud row (vin + updated_at + deleted_at, ~40 bytes each) against local
      // state and converges on the cloud 100%:
      //  - cloud newer / missing locally → backfill those rows
      //  - local rows the cloud tombstoned or no longer has → drop, UNLESS this
      //    device edited them since its last sync (offline work → push up)
      reconcileCloud: async () => {
        if (!db.isConfigured()) return
        const idx = await db.fetchTrackingIndex()
        if (idx === null) return // fetch failed — decide nothing from it
        const local = get().rows
        const lastSync = get().lastSync ?? 0
        const byVin = new Map(idx.map((r) => [r.vin, r]))
        const pullVins: string[] = []
        for (const r of idx) {
          if (r.deletedAt) continue
          const lr = local[r.vin]
          if (!lr || r.updatedAt > (lr.updatedAt ?? 0)) pullVins.push(r.vin)
        }
        // MIRROR against the index — which is safe to trust because
        // fetchTrackingIndex verifies its walk against the cloud's exact count
        // and returns null on any shortfall (the truncation bug can't recur).
        // Rows the cloud doesn't list are removed so every screen shows the
        // cloud 100%; the one exception is this device's own edits newer than
        // its last sync (offline work) — pushed up instead of lost.
        const drop: string[] = []
        const rescue: TrackRow[] = []
        for (const lr of Object.values(local)) {
          const cr = byVin.get(lr.vin)
          if (cr && !cr.deletedAt) continue
          if (cr?.deletedAt) { drop.push(lr.vin); continue } // deliberate delete
          if (hasVin(lr) && (lr.updatedAt ?? 0) > lastSync) { rescue.push(lr); continue }
          drop.push(lr.vin) // not on the verified-complete cloud → not shown
        }
        if (drop.length > 50)
          console.warn(`[tracking] mirror: removing ${drop.length} rows not present on the cloud`)
        const pulled = pullVins.length ? await db.fetchTrackingRowsByVins(pullVins) : []
        if (!pulled.length && !drop.length && !rescue.length) return
        set((s) => {
          const rows = { ...s.rows }
          for (const vin of drop) delete rows[vin]
          for (const r of pulled) if (hasVin(r) && !r.deletedAt) rows[r.vin] = r
          return { rows }
        })
        if (pulled.length) idbBulkPut(pulled.filter((r) => hasVin(r) && !r.deletedAt)).catch(() => {})
        if (drop.length) idbDelete(drop).catch(() => {})
        if (rescue.length) db.upsertTrackingRows(rescue).catch(() => {})
        if (drop.length || pulled.length)
          console.info(`[tracking] reconcile: +${pulled.length} · -${drop.length} · rescued ${rescue.length}`)
      },

      // Live updates: any device that changes a car's status / cells broadcasts
      // through Supabase Realtime → every other client merges it instantly (no
      // refresh). last-write-wins on updatedAt also blocks the self-echo.
      subscribeRealtime: () => {
        if (!db.isConfigured() || trackingChannel) return
        trackingChannel = supabase
          .channel('tracking_rows_changes')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'tracking_rows' },
            (payload) => {
              if (payload.eventType === 'DELETE') {
                const vin = (payload.old as { vin?: string })?.vin
                if (!vin) return
                set((s) => { if (!s.rows[vin]) return s; const rows = { ...s.rows }; delete rows[vin]; return { rows } })
                idbDelete([vin]).catch(() => {})
                return
              }
              const r = payload.new as { vin?: string; cells?: Record<string, string> | null; updated_at?: string | null; site?: string | null; deleted_at?: string | null; history?: TrackRow['history'] | null }
              if (!r?.vin) return
              // soft-delete arrives here as an UPDATE with deleted_at set → drop locally
              if (r.deleted_at) {
                const vin = r.vin
                set((s) => { if (!s.rows[vin]) return s; const rows = { ...s.rows }; delete rows[vin]; return { rows } })
                idbDelete([vin]).catch(() => {})
                return
              }
              if (!(r.cells?.['Vin'] ?? '').trim()) return // ignore phantom blank-Vin inserts
              const incoming: TrackRow = {
                vin: r.vin,
                cells: r.cells ?? {},
                updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now(),
                site: r.site ?? undefined,
                history: r.history ?? undefined,
              }
              set((s) => {
                const cur = s.rows[incoming.vin]
                if (cur && (cur.updatedAt ?? 0) >= (incoming.updatedAt ?? 0)) return s // stale / self-echo
                // payload without history (column omitted / truncated) must NOT wipe
                // the local audit trail — a later updateCell on this device would then
                // upsert history:null to the cloud, destroying it everywhere.
                if (!incoming.history?.length && cur?.history?.length) incoming.history = cur.history
                idbPut(incoming).catch(() => {})
                return { rows: { ...s.rows, [incoming.vin]: incoming } }
              })
            },
          )
          // self-healing subscription — mirror of the units channel: reconnect
          // after a silent websocket death and run an incremental syncCloud to
          // catch up on rows changed while the socket was down
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              if (!trackingHadDrop) return
              trackingHadDrop = false
              get().syncCloud().catch(() => {})
              return
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              trackingHadDrop = true
              if (trackingChannel) {
                // defer: removing the channel INSIDE its own status callback
                // recurses in supabase-js when the socket closes instantly
                const ch = trackingChannel; trackingChannel = null
                setTimeout(() => { supabase.removeChannel(ch).catch(() => {}) }, 0)
              }
              setTimeout(() => {
                if (!trackingChannel && useYard.getState().loggedInUserId) get().subscribeRealtime()
              }, 4000)
            }
          })
      },

      unsubscribeRealtime: () => {
        if (trackingChannel) { supabase.removeChannel(trackingChannel); trackingChannel = null }
      },

      importFile: async (file) => {
        set({ importing: true })
        try {
          const res = await parseTrackingWorkbook(file)
          get().commitImport(res)
          set({ importing: false })
          return res
        } catch (e) {
          set({ importing: false })
          throw e
        }
      },

      commitImport: (res) => {
        const rows: Record<string, TrackRow> = { ...get().rows }
        // skip VINs already in the system — never overwrite existing (edited) data
        const now = Date.now()
        const { sites, currentSite } = useYard.getState()
        const added: TrackRow[] = []
        for (const r of res.rows) {
          if (rows[r.vin]) continue
          const stamped = { ...r, updatedAt: now, site: siteForRow(r.cells, sites, currentSite) }
          rows[r.vin] = stamped; added.push(stamped)
        }
        // sold cars stay in the system: a gate-out row whose Location yard names
        // the ACTIVE yard is this yard's own history — import it with Car Status
        // = Gate-out so a fresh/re-import never makes a sold car vanish. Other
        // yards' gate-outs (the master file carries ~57k across all yards and
        // years) stay excluded, exactly as before.
        for (const r of res.gateOutRows ?? []) {
          if (rows[r.vin]) continue
          if (!currentSite || siteIdForLocation(r.cells, sites) !== currentSite) continue
          const cells = { ...r.cells, 'Car Status': 'Gate-out' }
          const stamped: TrackRow = { vin: r.vin, cells, updatedAt: now, site: currentSite }
          rows[r.vin] = stamped; added.push(stamped)
        }
        idbBulkPut(added).catch(() => {})
        db.upsertTrackingRows(added).catch(() => {})
        set({
          rows,
          // surface EVERY uploaded column in the Unit List (not just the canonical set)
          columns: mergeImportedColumns(applyOptions(get().columns, res.options), res.headers),
          loaded: true,
          lastImport: { inYard: added.length, total: res.total, gatedOut: res.gatedOut, at: Date.now() },
        })
      },

      // Co-Inspection import: MERGE the file's columns into existing VINs (update
      // PDI / RE PDI / OK date / Final check / PM… cells) and add any new VINs.
      // Never overwrites a car's live operational "Car Status", and only non-empty
      // incoming values overlay (so blank inspection cells don't wipe real data).
      commitCoInspection: (res) => {
        const rows = { ...get().rows }
        const now = Date.now()
        const { sites, currentSite } = useYard.getState()
        // co-inspection status rule:
        //  • "Gate Out time stamp" is a real date/timestamp ⇒ the car left the
        //    yard → force Gate-out (NEVER In Yard), overriding any prior status.
        //    A PLAN value like "แผนรับวันที่ 10/07/2026" is NOT a gate-out — the
        //    car is still in the yard (see isGateOutStamp).
        //  • otherwise the car is physically in a yard → promote to In Yard,
        //    but only forward (never demote Moving/PDI/Ready)
        const GATE_OUT_TS = 'Gate Out time stamp'
        const ORDER = CAR_STATUS_ORDER as readonly string[]
        const IN_YARD_STAGE = ORDER.indexOf('In Yard')
        // unknown statuses are LIVE station writes ('PARKING PDI', 'PDI NG',
        // 'FINAL CHECK OK', 'Wash for sale', lane labels…) — treat them as
        // already ≥ In Yard so the daily merge doesn't demote a car that is
        // mid-inspection back to 'In Yard' and erase its NG flag.
        const stageOf = (s: string) => { const i = ORDER.indexOf(s); return i < 0 ? IN_YARD_STAGE : i }
        const promote = (cells: Record<string, string>): boolean => {
          if (isGateOutStamp(cells['Gate Out time stamp'])) {
            if (cells['Car Status'] !== 'Gate-out') { cells['Car Status'] = 'Gate-out'; return true }
            return false
          }
          // The file says this car is NOT gated out (blank stamp / pickup plan) and it
          // sits in the yard we're importing for. A stored 'Gate-out' is therefore
          // stale — the car was transferred in from another yard (e.g. BYD Factory →
          // Auto Tran 20Rai), which gate-outs it at the ORIGIN. Restore it to In Yard,
          // otherwise it stays invisible at its new yard forever.
          // ('Pre Gate-out' is a live ops-scan state awaiting the 09:30 flush — leave it.)
          if (cells['Car Status'] === 'Gate-out') { cells['Car Status'] = 'In Yard'; return true }
          if (stageOf(deriveCarStatus(cells)) < IN_YARD_STAGE && cells['Car Status'] !== 'In Yard') {
            cells['Car Status'] = 'In Yard'; return true
          }
          return false
        }
        const changed: TrackRow[] = []
        let updated = 0
        let added = 0
        let skipped = 0
        let moved = 0 // held cars the file re-assigns to another yard → tag corrected
        for (const r of res.rows) {
          // yard scoping: only rows for the active site (or unplaced) — others belong to another yard
          if (!coInspectionAccepts(r.cells, sites, currentSite)) {
            // The file places this car in ANOTHER yard. We must not import it into the
            // active yard — but if we ALREADY hold it, our stored tag is stale (it was
            // mis-tagged by an earlier import, or the car has since moved). Re-tag it to
            // the yard the file names. Without this it stays stuck in the active yard's
            // list forever, because this import skips it on every run.
            const stale = rows[r.vin]
            if (stale) {
              const ly = (r.cells['Location yard'] ?? '').trim()
              const trueSite = siteIdForLocation(r.cells, sites) // undefined ⇒ a yard with no Site
              if (stale.site !== trueSite || (ly && stale.cells['Location yard'] !== ly)) {
                const next: TrackRow = {
                  ...stale,
                  cells: ly ? { ...stale.cells, 'Location yard': ly } : stale.cells,
                  site: trueSite,
                  updatedAt: now,
                }
                rows[r.vin] = next
                changed.push(next)
                moved++
              }
            }
            skipped++
            continue
          }
          const existing = rows[r.vin]
          if (existing) {
            const cells = { ...existing.cells }
            let didChange = false
            for (const [k, v] of Object.entries(r.cells)) {
              if (k === 'Car Status') continue // don't blindly copy the file's status
              if (v != null && v !== '' && cells[k] !== v) { cells[k] = v; didChange = true }
            }
            // "Gate Out time stamp" is AUTHORITATIVE in the master sheet, so it must be
            // able to CLEAR. The non-empty-only overlay above can never erase a stale
            // stamp, which would pin a transferred-in car to Gate-out forever.
            if (GATE_OUT_TS in r.cells) {
              const incoming = (r.cells[GATE_OUT_TS] ?? '').trim()
              if ((cells[GATE_OUT_TS] ?? '') !== incoming) { cells[GATE_OUT_TS] = incoming; didChange = true }
            }
            if (promote(cells)) didChange = true
            // a car that moved yards carries a NEW "Location yard" → re-tag it to that
            // site (the old `existing.site ?? …` pinned it to the yard it came from).
            const site = siteIdForLocation(cells, sites) ?? existing.site ?? siteForRow(cells, sites, currentSite)
            if (!didChange && site === existing.site) continue
            const next: TrackRow = { ...existing, cells, site, updatedAt: now }
            rows[r.vin] = next
            changed.push(next)
            updated++
          } else {
            const cells = { ...r.cells }
            promote(cells)
            const stamped: TrackRow = { ...r, cells, updatedAt: now, site: siteForRow(cells, sites, currentSite) }
            rows[r.vin] = stamped
            changed.push(stamped)
            added++
          }
        }
        // gate-out rows: an EXISTING VIN whose file row now says gate-out means
        // the car left the yard — merge the file's cells (Gate Out time stamp
        // ฯลฯ) and force Car Status = Gate-out. Applied regardless of the
        // active yard: a gate-out is global truth.
        let gateOut = 0
        for (const r of res.gateOutRows ?? []) {
          const existing = rows[r.vin]
          if (!existing) {
            // sold car MISSING from the system (e.g. cleared + re-imported):
            // when it belongs to the ACTIVE yard, restore it as Gate-out so the
            // data stays in the system — never silently gone. Other yards'
            // historical gate-outs stay excluded.
            if (!currentSite || siteIdForLocation(r.cells, sites) !== currentSite) continue
            const cells = { ...r.cells, 'Car Status': 'Gate-out' }
            const stamped: TrackRow = { vin: r.vin, cells, updatedAt: now, site: currentSite }
            rows[r.vin] = stamped
            changed.push(stamped)
            gateOut++
            continue
          }
          const cells = { ...existing.cells }
          let didChange = false
          for (const [k, v] of Object.entries(r.cells)) {
            if (k === 'Car Status') continue
            if (v != null && v !== '' && cells[k] !== v) { cells[k] = v; didChange = true }
          }
          if (promote(cells)) didChange = true
          // gateOutRows all carry a real gate-out timestamp now → force Gate-out
          if (cells['Car Status'] !== 'Gate-out') { cells['Car Status'] = 'Gate-out'; didChange = true }
          if (!didChange) continue
          const next: TrackRow = { ...existing, cells, updatedAt: now }
          rows[r.vin] = next
          changed.push(next)
          gateOut++
        }
        idbBulkPut(changed).catch(() => {})
        db.upsertTrackingRows(changed).catch(() => {})
        set({
          rows,
          columns: applyOptions(get().columns, res.options),
          loaded: true,
          lastImport: { inYard: updated + added, total: res.total, gatedOut: res.gatedOut, at: now },
        })
        return { updated, added, skipped, gateOut, moved }
      },

      updateCell: (vin, key, value) => {
        const r = get().rows[vin]
        if (!r) return
        const by = useYard.getState().currentUser
        const next: TrackRow = { ...withHistoryEntry(r, key, value, get().columns, by), updatedAt: Date.now() }
        set({ rows: { ...get().rows, [vin]: next } })
        idbPut(next).catch(() => {})
        db.upsertTrackingRows([next]).catch(() => {})
      },

      appendHistory: (vin, entry) => {
        const r = get().rows[vin]
        if (!r) return // only tracking-row cars keep an Event history
        // one physical action is ONE history line: a double-tap / double-Enter /
        // duplicated event firing the same entry seconds apart is dropped here,
        // so every caller is covered at once
        const hist = r.history ?? []
        const lastH = hist[hist.length - 1]
        if (lastH && lastH.field === entry.field && lastH.from === entry.from
            && lastH.to === entry.to && lastH.by === entry.by
            && Math.abs(entry.at - lastH.at) < 8000) return
        const next: TrackRow = { ...r, history: [...hist, entry].slice(-MAX_ROW_HISTORY), updatedAt: Date.now() }
        set({ rows: { ...get().rows, [vin]: next } })
        idbPut(next).catch(() => {})
        db.upsertTrackingRows([next]).catch(() => {})
      },

      bulkUpdate: (vins, key, value) => {
        const rows = { ...get().rows }
        const { columns } = get()
        const by = useYard.getState().currentUser
        const now = Date.now()
        const changed: TrackRow[] = []
        for (const vin of vins) {
          const r = rows[vin]
          if (!r) continue
          const next: TrackRow = { ...withHistoryEntry(r, key, value, columns, by), updatedAt: now }
          rows[vin] = next
          changed.push(next)
        }
        set({ rows })
        idbBulkPut(changed).catch(() => {})
        db.upsertTrackingRows(changed).catch(() => {})
      },

      addRow: (vin, cells = {}) => {
        const v = vin.trim().toUpperCase()
        if (!v || get().rows[v]) return false
        const { sites, currentSite } = useYard.getState()
        const fullCells = { 'Vin': v, 'Car Status': 'Pre Gate-in', ...cells }
        const row: TrackRow = { vin: v, cells: fullCells, updatedAt: Date.now(), site: siteForRow(fullCells, sites, currentSite) }
        set({ rows: { ...get().rows, [v]: row } })
        idbPut(row).catch(() => {})
        db.upsertTrackingRows([row]).catch(() => {})
        return true
      },

      deleteRows: (vins) => {
        const rows = { ...get().rows }
        for (const v of vins) delete rows[v]
        set({ rows })
        idbDelete(vins).catch(() => {})
        db.deleteTrackingRows(vins).catch(() => {})
      },

      clearRows: () => {
        set({ rows: {}, lastImport: null, lastSync: 0 })
        idbClear().catch(() => {})
        db.clearTrackingRows().catch(() => {})
      },

      setColumns: (columns) => set({ columns }),
      toggleColumn: (key) =>
        set((s) => ({ columns: s.columns.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)) })),
      showAll: (visible) => set((s) => ({ columns: s.columns.map((c) => ({ ...c, visible })) })),
      moveColumn: (key, dir) =>
        set((s) => {
          const i = s.columns.findIndex((c) => c.key === key)
          const j = i + dir
          if (i < 0 || j < 0 || j >= s.columns.length) return s
          const cols = [...s.columns]
          ;[cols[i], cols[j]] = [cols[j], cols[i]]
          return { columns: cols }
        }),
      // drag-and-drop reorder: move dragKey to just before dropKey
      reorderColumn: (dragKey, dropKey) =>
        set((s) => {
          if (dragKey === dropKey) return s
          const cols = [...s.columns]
          const from = cols.findIndex((c) => c.key === dragKey)
          if (from < 0 || !cols.some((c) => c.key === dropKey)) return s
          const [moved] = cols.splice(from, 1)
          const insertAt = cols.findIndex((c) => c.key === dropKey)
          cols.splice(insertAt, 0, moved)
          return { columns: cols }
        }),
      addColumn: (label) =>
        set((s) => {
          const trimmed = label.trim()
          if (!trimmed) return s
          let key = trimmed
          let n = 2
          while (s.columns.some((c) => c.key === key)) key = `${trimmed} (${n++})`
          const col: Column = { key, label: trimmed, group: 'pm', type: 'text', width: 140, visible: true, editable: true, custom: true }
          return { columns: [...s.columns, col] }
        }),
      removeColumn: (key) =>
        set((s) => {
          const col = s.columns.find((c) => c.key === key)
          if (!col?.custom) return s // only custom columns are removable; others can be hidden
          return { columns: s.columns.filter((c) => c.key !== key) }
        }),
      resetColumns: () => set({ columns: defaultColumns() }),

      setFilterCols: (cols) => set((s) => ({ filterCols: typeof cols === 'function' ? cols(s.filterCols) : cols })),

      // shared-default sync (runs on every login). A device adopts the shared
      // default the FIRST time it sees one, AND again whenever the admin has
      // published a NEWER one (updatedAt greater than what this device last
      // adopted) — so re-saving the default propagates the column order + filters
      // to EVERY user and EVERY yard, not just brand-new devices. Between
      // publishes a user's own tweaks are left untouched.
      seedViewDefault: async () => {
        const cfg = await db.fetchAppConfig<ViewDefault>(VIEW_DEFAULT_KEY).catch(() => null)
        if (!cfg || !Array.isArray(cfg.columns)) return // no default yet → try again next boot
        const remoteV = cfg.updatedAt ?? 0
        const localV = get().viewDefaultVersion ?? 0
        if (get().defaultSeeded && remoteV <= localV) return // already on the latest
        set({
          columns: reconcileColumns(cfg.columns),
          filterCols: Array.isArray(cfg.filterCols) ? cfg.filterCols.slice(0, MAX_FILTERS) : get().filterCols,
          defaultSeeded: true,
          viewDefaultVersion: remoteV,
        })
      },

      // publish the current view as the shared default for everyone (admin).
      // strip merged import options to keep the blob small; reconcile re-adds them.
      // stamps updatedAt so every other device re-adopts it on their next login.
      saveViewDefault: async () => {
        const columns = get().columns.map(({ options, ...c }) => c) as Column[]
        const updatedAt = Date.now()
        await db.saveAppConfig(VIEW_DEFAULT_KEY, { columns, filterCols: get().filterCols, updatedAt })
        set({ defaultSeeded: true, viewDefaultVersion: updatedAt })
        // tell every OTHER open client to adopt it immediately (no re-login needed)
        sendSync('viewdefault')
      },

      resetToViewDefault: async () => {
        const cfg = await db.fetchAppConfig<ViewDefault>(VIEW_DEFAULT_KEY).catch(() => null)
        if (!cfg || !Array.isArray(cfg.columns)) return false
        set({
          columns: reconcileColumns(cfg.columns),
          filterCols: Array.isArray(cfg.filterCols) ? cfg.filterCols.slice(0, MAX_FILTERS) : get().filterCols,
          defaultSeeded: true,
          viewDefaultVersion: cfg.updatedAt ?? get().viewDefaultVersion ?? 0,
        })
        return true
      },

      // ── per-user saved view (the บันทึก button) ────────────────────────────
      // localStorage persistence dies SILENTLY when the device's quota is full
      // (this yard's data is big enough to hit it), so a refresh could lose the
      // customization. The explicit Save writes the view to the CLOUD keyed by
      // user name; every login restores it — on any device.
      saveMyView: async () => {
        const user = useYard.getState().currentUser?.trim()
        if (!user) throw new Error('no user')
        const columns = get().columns.map(({ options, ...c }) => c) as Column[]
        await db.saveAppConfig(`${VIEW_DEFAULT_KEY}_u_${user}`, {
          columns, filterCols: get().filterCols, updatedAt: Date.now(),
        })
      },
      loadMyView: async () => {
        const user = useYard.getState().currentUser?.trim()
        if (!user) return
        const cfg = await db.fetchAppConfig<ViewDefault>(`${VIEW_DEFAULT_KEY}_u_${user}`).catch(() => null)
        if (!cfg || !Array.isArray(cfg.columns)) return
        // the personal save wins only when NEWER than the shared default this
        // device adopted — a fresher admin publish takes precedence
        if ((cfg.updatedAt ?? 0) <= (get().viewDefaultVersion ?? 0)) return
        set({
          columns: reconcileColumns(cfg.columns),
          filterCols: Array.isArray(cfg.filterCols) ? cfg.filterCols.slice(0, MAX_FILTERS) : get().filterCols,
        })
      },
    }),
    {
      name: 'sjwd-tracking',
      // only the (small) column + filter config is persisted to localStorage; rows live in IndexedDB
      storage: quotaSafeStorage(),
      // UI config only. In online-100% mode lastSync is NOT kept either: the
      // device starts empty on every load, so the next run must be a full pull.
      partialize: (s) => ({
        columns: s.columns, filterCols: s.filterCols, defaultSeeded: s.defaultSeeded,
        viewDefaultVersion: s.viewDefaultVersion, lastImport: s.lastImport,
        lastSync: isOnlineOnly() ? 0 : s.lastSync,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<TrackingState> | undefined
        return {
          ...current, ...p,
          columns: reconcileColumns(p?.columns),
          filterCols: Array.isArray(p?.filterCols) ? p!.filterCols!.slice(0, MAX_FILTERS) : initialFilterCols(),
          defaultSeeded: p?.defaultSeeded ?? false,
          viewDefaultVersion: p?.viewDefaultVersion ?? 0,
        }
      },
    },
  ),
)

// admin published a new shared default → adopt it live on every other open
// client (version-checked inside seedViewDefault, so it only pulls when newer).
onSync('viewdefault', () => { useTracking.getState().seedViewDefault().catch((e) => console.error('[viewdefault] sync pull', e)) })

// memoized array of rows to avoid new-reference selector loops
export function useTrackingRows(): TrackRow[] {
  const rows = useTracking((s) => s.rows)
  return useMemo(() => Object.values(rows), [rows])
}

export function useVisibleColumns(): Column[] {
  const columns = useTracking((s) => s.columns)
  return useMemo(() => columns.filter((c) => c.visible), [columns])
}
