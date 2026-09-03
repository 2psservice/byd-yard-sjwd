import { useMemo } from 'react'
import { create } from 'zustand'
import { quotaSafeStorage } from '../lib/persistStorage'
import { persist } from 'zustand/middleware'
import type { Column } from '../lib/trackingColumns'
import { defaultColumns, reconcileColumns, columnNameKey, duplicatesBuiltIn, MAX_FILTERS, DEFAULT_FILTER_COLS } from '../lib/trackingColumns'
import type { ParseResult, RowEvent, TrackRow } from '../lib/excelTracking'
import { parseTrackingWorkbook } from '../lib/excelTracking'
import { idbBulkPut, idbClear, idbDelete, idbGetAllRows, idbPut } from '../lib/idb'
import * as db from '../lib/db'
import { supabase } from '../lib/supabase'
import { onSync, sendSync, type RowMsg, type RowsPayload } from '../lib/syncBus'
import { useYard } from './useYard'
import { siteForRow, siteIdForLocation, coInspectionAccepts } from '../lib/siteScope'
import { CAR_STATUS_ORDER, deriveCarStatus, isGateOutStamp } from '../lib/carStatus'
import type { RealtimeChannel } from '@supabase/supabase-js'

// live channel (module-scoped — never persisted)
let trackingChannel: RealtimeChannel | null = null
// remember a websocket drop so the re-subscribe runs an incremental syncCloud
// to catch up on rows changed while the socket was down
let trackingHadDrop = false
// one sync at a time: the reconcile clock, the tab-visible catch-up and a
// reconnect can all fire within the same second, and two runs racing would both
// read the same `lastSync` and push the same rows twice
let syncInFlight = false
// a realtime payload can arrive with the record body stripped (Supabase drops it
// when the row exceeds the channel's max_record_bytes — a car with a long cell
// set + audit history reaches that). The event then carries no VIN, so nothing
// can be applied from it; remember that SOMETHING changed and reconcile shortly.
let truncatedSyncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleTruncatedSync(run: () => void) {
  if (truncatedSyncTimer) clearTimeout(truncatedSyncTimer)
  truncatedSyncTimer = setTimeout(() => { truncatedSyncTimer = null; run() }, 1500)
}

// VINs whose direct push to the cloud failed (database down / timing out).
// Every fire-and-forget write below lands here on failure, and the next
// syncCloud pushes their CURRENT copy again until one lands. Without this, an
// edit made while the database was struggling stayed local-only until the
// 6-hour full sync — the operator saw "saved", every other device saw the old
// value for half a day.
const failedPush = new Set<string>()
/** Fire-and-forget row push that REMEMBERS failures for syncCloud to retry. */
function pushRows(rows: TrackRow[]): void {
  if (!rows.length) return
  db.upsertTrackingRows(rows)
    .then(() => { for (const r of rows) failedPush.delete(r.vin) })
    .catch(() => { for (const r of rows) failedPush.add(r.vin) })
}

/** A car that no longer exists must not keep sitting in a station's work queue.
 *  Lazy import — useOps reads useYard, which reads back this way. */
function purgeFromQueues(vins: string[]): void {
  if (!vins.length) return
  import('./useOps')
    .then((m) => m.useOps.getState().purgeVins(vins))
    .catch(() => {})
}

/** A car put back to Pre Gate-in is arriving AGAIN, so the arrival lot that
 *  already gated it in has to let it go — otherwise that finished shipment
 *  re-opens and the board reads "249/291" instead of showing the new batch as
 *  its own lot. Lazy import — same reason as purgeFromQueues. */
/** Did this edit turn a car that was already in the yard back into an expected
 *  arrival? Only the TRANSITION counts — a car that was Pre Gate-in before the
 *  edit and still is has not been re-announced, and its live lot keeps it. */
const reannouncedArrival = (before: TrackRow, after: TrackRow): boolean =>
  deriveCarStatus(after.cells) === 'Pre Gate-in' && deriveCarStatus(before.cells) !== 'Pre Gate-in'

function releaseArrivalLots(vins: string[]): void {
  if (!vins.length) return
  import('./useOps')
    .then((m) => m.useOps.getState().releaseArrivedFromLots(vins))
    .catch(() => {})
}

/**
 * Clear queue items left behind by a car deleted BEFORE this ran.
 *
 * Catching the delete as it happens only helps from now on; a car removed last
 * week is already gone from every row set, and its tombstone has long fallen
 * out of the incremental sync window — so the stranded queue line would sit
 * there for good. Here the queue itself names the suspects: any VIN it holds
 * that this device has no row for. That alone proves nothing — the row may
 * simply not have synced yet, and not every queued car comes from the tracking
 * sheet at all — so the cloud is asked which of them carry a TOMBSTONE, and
 * only those are removed. A failed query removes nothing.
 */
let orphanSweepAt = 0
async function sweepOrphanQueueItems(rows: Record<string, TrackRow>): Promise<void> {
  if (!db.isConfigured() || Date.now() - orphanSweepAt < 5 * 60_000) return
  const { useOps } = await import('./useOps').catch(() => ({ useOps: null as never }))
  if (!useOps) return
  const suspects = [...new Set(
    useOps.getState().queues.flatMap((q) => q.items.map((i) => i.vin)).filter((v) => !rows[v]),
  )]
  if (!suspects.length) return
  orphanSweepAt = Date.now()
  const dead = await db.fetchDeletedVins(suspects).catch(() => null)
  if (!dead?.size) return // offline, or nothing actually deleted → drop nothing
  useOps.getState().purgeVins([...dead])
}

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
  /** true only while the tracking-rows Realtime channel is actually
   *  SUBSCRIBED — see useYard's unitsRealtimeConnected for why this matters
   *  (the header's "Connected" pill used to be a hardcoded label). */
  realtimeConnected: boolean

  loadFromIdb: () => Promise<void>
  syncCloud: () => Promise<void>
  subscribeRealtime: () => void
  unsubscribeRealtime: () => void
  importFile: (file: File) => Promise<ParseResult>
  commitImport: (res: ParseResult) => void
  commitCoInspection: (res: ParseResult) => { updated: number; added: number; skipped: number; gateOut: number; moved: number }
  /** Set a cell and log it. `src: 'scan'` marks the write as a FIELD STATION
   *  action (ops-scan), which is what lets a report tell a real recording apart
   *  from an import or an office edit — the only thing that may be printed as
   *  "the time the yard recorded this". */
  updateCell: (vin: string, key: string, value: string, src?: 'scan') => void
  /** Set a cell WITHOUT writing a history line — for system/media cells (e.g. the
   *  per-car "Vin Photo" label shot) whose value may be a huge data-URL that must
   *  never be copied into the row's Event history. */
  setCellNoHistory: (vin: string, key: string, value: string) => void
  bulkUpdate: (vins: string[], key: string, value: string) => void
  /** Append a free-form audit entry to a row's history (no cell change) — used to
   *  log damage add/remove so the admin Event tab keeps a permanent record. */
  appendHistory: (vin: string, entry: RowEvent) => void
  /** Merge rows fetched straight from the cloud (per-VIN scan fallback) into
   *  this device's copy — newer wins, never clobbers fresher local edits. */
  adoptCloudRows: (rows: TrackRow[]) => number
  /** Version of the system-history purge this device has already run cloud-side.
   *  Bumping SYS_HISTORY_PURGE_V forces one full sync that cleans every row. */
  sysHistoryPurged: number
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
 *  each row's cells + synced to cloud; this just makes it visible/usable).
 *
 *  A header that only re-spells a column we already have gets no column of its
 *  own: the file's "LOCATION" used to sit beside the computed "Location" as a
 *  second, permanently empty column, and that empty one is what people read. */
function mergeImportedColumns(columns: Column[], headers: string[] | undefined): Column[] {
  if (!headers?.length) return columns
  const have = new Set(columns.flatMap((c) => [columnNameKey(c.key), columnNameKey(c.label)]))
  const extra: Column[] = []
  for (const h of headers) {
    const key = (h ?? '').trim()
    const name = columnNameKey(key)
    if (!key || have.has(name)) continue
    have.add(name)
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

// ── เก็บกวาดประวัติการย้ายที่ "ระบบ" เขียนเอง ─────────────────────────────────
// เดิมระบบมีกลไกจัดตำแหน่งรถให้อัตโนมัติ แล้วบันทึกลงประวัติการย้ายในนาม "ระบบ"
// ตอนนี้เลิกใช้แล้ว (ตำแหน่งรถเปลี่ยนได้ทางเดียวคือพนักงาน / ops scan / admin)
// แต่บรรทัดเก่ายังค้างอยู่ในฐานข้อมูล กินพื้นที่และทำให้อ่านประวัติแล้วไม่รู้ว่า
// ใครย้ายรถจริง จึงลบทิ้งทุกจุดที่แถวไหลเข้าเครื่อง แล้วเขียนกลับขึ้น cloud ให้
// หายถาวรทุกเครื่อง — เหลือแต่ประวัติของพนักงานและแอดมิน
// `\b` is an ASCII word boundary — it never matches after Thai letters, so the
// test has to be a plain prefix. No staff account is called "ระบบ" / "system".
const isSystemEvent = (h: RowEvent) => {
  const by = (h.by ?? '').trim()
  return by.startsWith('ระบบ') || /^system\b/i.test(by)
}

/** Bump to re-run the cloud-side sweep on every device (one full sync each). */
const SYS_HISTORY_PURGE_V = 1

/** The row without its system-authored entries — returns the SAME object when
 *  there is nothing to drop, so callers can use identity to spot rows to save. */
function stripSystemHistory(r: TrackRow): TrackRow {
  const h = r.history
  if (!h?.length) return r
  const kept = h.filter((e) => !isSystemEvent(e))
  return kept.length === h.length ? r : { ...r, history: kept }
}

const MAX_ROW_HISTORY = 100
// how close together two Location moves on the SAME car by the SAME actor
// have to land to count as one physical cascade rather than two real moves
const LOCATION_BURST_MS = 90_000
function withHistoryEntry(r: TrackRow, key: string, value: string, columns: Column[], by: string, src?: 'scan'): TrackRow {
  const from = r.cells[key] ?? ''
  const cells = { ...r.cells, [key]: value }
  if (from === value) return { ...r, cells } // unchanged value — still write, skip the log entry
  const label = columns.find((c) => c.key === key)?.label ?? key
  const entry: RowEvent = { at: Date.now(), by, field: label, from, to: value, ...(src ? { src } : {}) }
  return { ...r, cells, history: [...(r.history ?? []), entry].slice(-MAX_ROW_HISTORY) }
}

/** The sheet column that says which yard a car belongs to. */
const LOCATION_YARD_KEY = 'Location yard'

/**
 * Editing a row's Location-yard MOVES the car to that yard.
 *
 * The Unit List, the yard plan and every station read a row's `site` tag, not
 * its Location-yard text — so changing the cell alone left the car listed in
 * the yard it had just left, and invisible in the one it was going to. An admin
 * bringing a car over from 38 ไร่ had no way to make NYB2 see it at all.
 *
 * A moved car has not passed the NEW yard's gate yet, so it lands as Pre
 * Gate-in and shows up on that yard's Gate-in board waiting to be scanned in.
 * Its placement in the OLD yard is released (see useYard.moveUnitsToSite) —
 * the car is not standing in that lane any more.
 */
function applyYardMove(next: TrackRow, key: string, columns: Column[], by: string): TrackRow {
  if (key !== LOCATION_YARD_KEY) return next
  const { sites } = useYard.getState()
  const target = siteIdForLocation(next.cells, sites)
  if (!target || target === next.site) return next
  let out: TrackRow = { ...next, site: target }
  // an explicit Car Status wins over every derived signal, so a car that gated
  // out of its old yard reads as Pre Gate-in here without erasing its history
  if (deriveCarStatus(out.cells) !== 'Pre Gate-in') out = withHistoryEntry(out, 'Car Status', 'Pre Gate-in', columns, by)
  useYard.getState().moveUnitsToSite([out.vin], target)
  return out
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
      realtimeConnected: false,
      sysHistoryPurged: 0,

      loadFromIdb: async () => {
        if (get().loaded) return
        let rows: Record<string, TrackRow> = {}
        try {
          const all = await idbGetAllRows()
          // backfill rows imported before "Last update" existed → use the import time
          const fallback = get().lastImport?.at ?? Date.now()
          const fixed: TrackRow[] = []
          const phantom: string[] = [] // blank-Vin rows → purge locally + in the cloud
          for (const raw of all) {
            if (!hasVin(raw)) { phantom.push(raw.vin); continue }
            const r = stripSystemHistory(raw)
            if (r.updatedAt == null) r.updatedAt = fallback
            if (r !== raw || raw.updatedAt == null) fixed.push(r)
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
                for (const r of siteRows) if (hasVin(r)) rec[r.vin] = stripSystemHistory(r)
                set({ rows: rec })
                idbBulkPut(Object.values(rec)).catch(() => {})
              }
            } catch { /* fall through to the full sync below */ }
          }
        }
        // reconcile every yard in the background (incremental after the first run)
        get().syncCloud()
      },

      // Two-way merge between this device (IndexedDB) and Supabase, keyed by VIN
      // with last-write-wins on updatedAt. INCREMENTAL after the first sync: only
      // rows changed since `lastSync` are pulled/pushed, so repeat loads are near
      // instant instead of re-downloading all ~11 MB every time.
      syncCloud: async () => {
        if (!db.isConfigured() || syncInFlight) return
        syncInFlight = true
        try {
        const startedAt = Date.now()
        const lastSync = get().lastSync ?? 0
        const local = get().rows
        const hasLocal = Object.keys(local).length > 0
        // full pull the first time, or as a safety resync if the last one is stale (>6h);
        // otherwise fetch only what changed since last sync (minus a 2-min skew margin)
        const stale = startedAt - lastSync > 6 * 3600_000
        // the retired system-history sweep needs to SEE every row once, and an
        // incremental sync only returns rows changed since last time
        const needPurge = get().sysHistoryPurged !== SYS_HISTORY_PURGE_V
        let incremental = lastSync > 0 && hasLocal && !stale && !needPurge
        // ── self-heal for a silently-truncated copy ──
        // A pull that failed mid-way used to pass for complete, so lastSync got
        // stamped over a fraction of the sheet — and from then on the minute-
        // sync only asked "what changed since", which can never restore rows it
        // never had. Each device froze at a different fraction: one browser
        // counted 8 cars In Yard, another 280, in a yard really holding ~2,300.
        // One HEAD count exposes the deficit; being clearly short → full pull.
        // (Margin absorbs writes racing this check; null = can't tell → skip.)
        if (incremental) {
          const cloudLive = await db.countTrackingRows().catch(() => null)
          if (cloudLive != null && cloudLive - Object.keys(local).length > 20) incremental = false
        }
        const since = incremental ? lastSync - 120_000 : undefined

        let cloud: TrackRow[] = []
        try { cloud = await db.fetchTrackingRows(since) } catch { return }
        const cloudByVin = new Map(cloud.map((r) => [r.vin, r]))

        // cloud → local: apply tombstones (remove) and pull rows missing locally
        // or newer in the cloud. A tombstone (deletedAt set) always wins over a
        // stale local copy → the delete propagates to every device.
        const merged: Record<string, TrackRow> = { ...local }
        // rows whose CLOUD copy still carries the retired "ระบบ" move history —
        // they need re-writing even when this device's own copy is already clean
        // (loadFromIdb strips on read, so `local` alone can never reveal them)
        const dirty: TrackRow[] = []
        const pull: TrackRow[] = []
        const drop: string[] = []
        const phantom: string[] = [] // blank-Vin rows in the cloud → tombstone them
        // every VIN the cloud says is gone — INCLUDING ones this device dropped
        // on an earlier run. A queue item can outlive the row it points at, and
        // then only the tombstone can tell us to clear it out.
        const gone: string[] = []
        for (const cr of cloud) {
          if (!cr.deletedAt && stripSystemHistory(cr) !== cr) dirty.push(cr)
          const lr = local[cr.vin]
          if (cr.deletedAt) {
            gone.push(cr.vin)
            if (lr) { delete merged[cr.vin]; drop.push(cr.vin) }
          } else if (!hasVin(cr)) {
            gone.push(cr.vin)
            if (lr) { delete merged[cr.vin]; drop.push(cr.vin) }
            phantom.push(cr.vin)
          } else if (!lr || (cr.updatedAt ?? 0) > (lr.updatedAt ?? 0)) {
            const clean = stripSystemHistory(cr)
            merged[cr.vin] = clean; pull.push(clean)
            broadcastOnly.delete(cr.vin) // the authoritative row (with history) is here now
          }
        }
        // also sweep any blank-Vin rows already sitting in local state
        for (const lr of Object.values(local)) if (!hasVin(lr) && !drop.includes(lr.vin)) { delete merged[lr.vin]; drop.push(lr.vin) }
        if (phantom.length) db.deleteTrackingRows(phantom).catch(() => {})
        purgeFromQueues(gone)

        // local → cloud: on a full run, anything the cloud lacks or is older on;
        // incrementally, just local edits since last sync (covers offline changes).
        // Never re-push a VIN the cloud has tombstoned — that was the resurrection bug.
        // `local` is the pre-merge snapshot, so a row the pull just replaced is
        // still sitting in it with its OLD contents — pushing that writes the
        // stale copy straight back over the fresher one we just accepted.
        const pulled = new Set(pull.map((r) => r.vin))
        const push: TrackRow[] = []
        for (const lr of Object.values(local)) {
          if (!hasVin(lr)) continue // never re-push phantom rows
          if (pulled.has(lr.vin)) continue // superseded a moment ago — not ours to write
          // a row this device only heard ABOUT (broadcast, no history on the
          // wire) is not ours to write back — pushing it would erase the
          // sender's new audit line for everyone
          if (broadcastOnly.has(lr.vin)) continue
          const cr = cloudByVin.get(lr.vin)
          if (cr?.deletedAt) continue
          if (incremental) {
            if ((lr.updatedAt ?? 0) > lastSync) push.push(lr)
          } else {
            if (!cr || (lr.updatedAt ?? 0) > (cr.updatedAt ?? 0)) push.push(lr)
          }
        }

        // sweep the retired system-authored move history out of every row this
        // device holds, and push the cleaned rows so the cloud copy shrinks too
        const pruned: TrackRow[] = []
        for (const vin in merged) {
          const clean = stripSystemHistory(merged[vin])
          if (clean !== merged[vin]) { merged[vin] = clean; pruned.push(clean) }
        }
        // …plus the ones only the cloud still holds dirty. Keep OUR history when
        // this device has the fresher row — the cloud's is the stale copy then.
        for (const cr of dirty) {
          if (merged[cr.vin] && pruned.every((r) => r.vin !== cr.vin)) pruned.push(merged[cr.vin])
        }

        // a row that arrived FROM the cloud is already common knowledge — record
        // it as shared so the announcer below doesn't relay it back out again
        for (const r of pull) rowShared.set(r.vin, r.updatedAt ?? 0)
        if (pull.length || drop.length || pruned.length) { set({ rows: merged }) }
        if (pull.length || pruned.length) idbBulkPut([...pull, ...pruned]).catch(() => {})
        if (drop.length) idbDelete(drop).catch(() => {})
        // one write per VIN — Postgres rejects a batch that names the same
        // conflict target twice (a pruned row may also be in `push`)
        const outgoing = new Map(push.map((r) => [r.vin, r] as const))
        for (const r of pruned) outgoing.set(r.vin, merged[r.vin])
        // rows whose direct push failed earlier (database was down) — resend
        // their CURRENT copy. Their updatedAt predates lastSync by now, so the
        // incremental condition above would never pick them up again.
        for (const vin of failedPush) {
          if (outgoing.has(vin)) continue
          const r = merged[vin]
          // row gone (deleted meanwhile) → nothing left to deliver, stop tracking it
          if (!r || !hasVin(r) || cloudByVin.get(vin)?.deletedAt) { failedPush.delete(vin); continue }
          if (!broadcastOnly.has(vin)) outgoing.set(vin, r)
        }
        if (outgoing.size) pushRows([...outgoing.values()])
        set({ lastSync: startedAt })
        // a full run has now seen — and cleaned — every row; don't force another
        if (!incremental) set({ sysHistoryPurged: SYS_HISTORY_PURGE_V })
        // occasionally clear tombstones older than 30 days so the table stays lean
        if (!incremental) db.purgeTrackingTombstones(30 * 24 * 3600_000).catch(() => {})
        sweepOrphanQueueItems(merged).catch(() => {})
        } finally { syncInFlight = false }
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
                // key-only / truncated DELETE — nothing to apply, but something
                // DID change: reconcile rather than drop the event on the floor
                if (!vin) { scheduleTruncatedSync(() => get().syncCloud().catch(() => {})); return }
                set((s) => { if (!s.rows[vin]) return s; const rows = { ...s.rows }; delete rows[vin]; return { rows } })
                idbDelete([vin]).catch(() => {})
                purgeFromQueues([vin])
                return
              }
              const r = payload.new as { vin?: string; cells?: Record<string, string> | null; updated_at?: string | null; site?: string | null; deleted_at?: string | null; history?: TrackRow['history'] | null }
              // body stripped by the server (row over max_record_bytes): the VIN
              // is gone, so this device cannot know WHICH car changed. Silently
              // returning is what left one browser reading 2,200 In Yard while
              // another read 2,198 — pull the delta instead.
              if (!r?.vin) { scheduleTruncatedSync(() => get().syncCloud().catch(() => {})); return }
              // soft-delete arrives here as an UPDATE with deleted_at set → drop locally
              if (r.deleted_at) {
                const vin = r.vin
                set((s) => { if (!s.rows[vin]) return s; const rows = { ...s.rows }; delete rows[vin]; return { rows } })
                idbDelete([vin]).catch(() => {})
                purgeFromQueues([vin])
                return
              }
              if (!(r.cells?.['Vin'] ?? '').trim()) return // ignore phantom blank-Vin inserts
              const incoming: TrackRow = stripSystemHistory({
                vin: r.vin,
                cells: r.cells ?? {},
                updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now(),
                site: r.site ?? undefined,
                history: r.history ?? undefined,
              })
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
              set({ realtimeConnected: true })
              if (!trackingHadDrop) return
              trackingHadDrop = false
              get().syncCloud().catch(() => {})
              return
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              set({ realtimeConnected: false })
              trackingHadDrop = true
              if (trackingChannel) { supabase.removeChannel(trackingChannel); trackingChannel = null }
              setTimeout(() => {
                if (!trackingChannel && useYard.getState().loggedInUserId) get().subscribeRealtime()
              }, 4000)
            }
          })
      },

      unsubscribeRealtime: () => {
        if (trackingChannel) { supabase.removeChannel(trackingChannel); trackingChannel = null }
        if (truncatedSyncTimer) { clearTimeout(truncatedSyncTimer); truncatedSyncTimer = null } // no reconcile after logout / site switch
        set({ realtimeConnected: false })
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
        pushRows(added)
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
        pushRows(changed)
        set({
          rows,
          columns: applyOptions(get().columns, res.options),
          loaded: true,
          lastImport: { inYard: updated + added, total: res.total, gatedOut: res.gatedOut, at: now },
        })
        return { updated, added, skipped, gateOut, moved }
      },

      updateCell: (vin, key, value, src) => {
        const r = get().rows[vin]
        if (!r) return
        const by = useYard.getState().currentUser
        const cols = get().columns
        const next: TrackRow = { ...applyYardMove(withHistoryEntry(r, key, value, cols, by, src), key, cols, by), updatedAt: Date.now() }
        set({ rows: { ...get().rows, [vin]: next } })
        idbPut(next).catch(() => {})
        pushRows([next])
        // read the DERIVED status, so a yard move (which sets Pre Gate-in inside
        // applyYardMove) releases the old yard's lot too, not just an explicit
        // Car Status edit
        if (reannouncedArrival(r, next)) releaseArrivalLots([vin])
      },

      setCellNoHistory: (vin, key, value) => {
        const r = get().rows[vin]
        if (!r || r.cells[key] === value) return
        const next: TrackRow = { ...r, cells: { ...r.cells, [key]: value }, updatedAt: Date.now() }
        set({ rows: { ...get().rows, [vin]: next } })
        idbPut(next).catch(() => {})
        pushRows([next])
      },

      adoptCloudRows: (incoming) => {
        let adopted = 0
        const fresh: TrackRow[] = []
        set((s) => {
          const rows = { ...s.rows }
          for (const raw of incoming) {
            if (!hasVin(raw) || raw.deletedAt) continue
            const r = stripSystemHistory(raw)
            const cur = rows[r.vin]
            if (cur && (cur.updatedAt ?? 0) >= (r.updatedAt ?? 0)) continue // local is fresher
            rows[r.vin] = r
            fresh.push(r)
            adopted++
          }
          return adopted ? { rows } : s
        })
        if (fresh.length) idbBulkPut(fresh).catch(() => {})
        return adopted
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
        // a Location burst — scanning several cars down one lane re-shoves the
        // SAME not-yet-scanned car once per additional scan, and re-parking
        // logic can do the same — so one physical car can otherwise pick up a
        // handful of near-instant hops that are only noise once it settles.
        // Roll them into the ONE line a person actually cares about: where it
        // really started, where it ended up. A DIFFERENT actor mid-burst still
        // gets its own line — that IS a second real event.
        if (lastH && entry.field === 'Location' && lastH.field === 'Location' && lastH.by === entry.by
            && entry.at - lastH.at >= 0 && entry.at - lastH.at < LOCATION_BURST_MS) {
          const merged: TrackRow = { ...r,
            history: [...hist.slice(0, -1), { ...lastH, to: entry.to, at: entry.at }],
            updatedAt: Date.now() }
          set({ rows: { ...get().rows, [vin]: merged } })
          idbPut(merged).catch(() => {})
          pushRows([merged])
          return
        }
        const next: TrackRow = { ...r, history: [...hist, entry].slice(-MAX_ROW_HISTORY), updatedAt: Date.now() }
        set({ rows: { ...get().rows, [vin]: next } })
        idbPut(next).catch(() => {})
        pushRows([next])
      },

      bulkUpdate: (vins, key, value) => {
        const rows = { ...get().rows }
        const { columns } = get()
        const by = useYard.getState().currentUser
        const now = Date.now()
        const changed: TrackRow[] = []
        const reannounced: string[] = []
        for (const vin of vins) {
          const r = rows[vin]
          if (!r) continue
          const next: TrackRow = { ...applyYardMove(withHistoryEntry(r, key, value, columns, by), key, columns, by), updatedAt: now }
          rows[vin] = next
          changed.push(next)
          if (reannouncedArrival(r, next)) reannounced.push(vin)
        }
        set({ rows })
        idbBulkPut(changed).catch(() => {})
        pushRows(changed)
        releaseArrivalLots(reannounced)
      },

      addRow: (vin, cells = {}) => {
        const v = vin.trim().toUpperCase()
        if (!v || get().rows[v]) return false
        const { sites, currentSite } = useYard.getState()
        const fullCells = { 'Vin': v, 'Car Status': 'Pre Gate-in', ...cells }
        const row: TrackRow = { vin: v, cells: fullCells, updatedAt: Date.now(), site: siteForRow(fullCells, sites, currentSite) }
        set({ rows: { ...get().rows, [v]: row } })
        idbPut(row).catch(() => {})
        pushRows([row])
        return true
      },

      deleteRows: (vins) => {
        const rows = { ...get().rows }
        for (const v of vins) delete rows[v]
        set({ rows })
        idbDelete(vins).catch(() => {})
        db.deleteTrackingRows(vins).catch(() => {})
        purgeFromQueues(vins) // no station should keep asking for a deleted car
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
          // refuse a name that only re-spells a built-in column — reconcileColumns
          // drops those on the next load, so allowing it here would let a column
          // appear and then silently vanish
          if (duplicatesBuiltIn(trimmed)) {
            useYard.getState().toast('err', `มีคอลัมน์ชื่อ "${trimmed}" อยู่แล้ว`)
            return s
          }
          let key = trimmed
          let n = 2
          while (s.columns.some((c) => columnNameKey(c.key) === columnNameKey(key))) key = `${trimmed} (${n++})`
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
      partialize: (s) => ({ columns: s.columns, filterCols: s.filterCols, defaultSeeded: s.defaultSeeded, viewDefaultVersion: s.viewDefaultVersion, lastImport: s.lastImport, lastSync: s.lastSync, sysHistoryPurged: s.sysHistoryPurged }),
      merge: (persisted, current) => {
        const p = persisted as Partial<TrackingState> | undefined
        return {
          ...current, ...p,
          columns: reconcileColumns(p?.columns),
          filterCols: Array.isArray(p?.filterCols) ? p!.filterCols!.slice(0, MAX_FILTERS) : initialFilterCols(),
          defaultSeeded: p?.defaultSeeded ?? false,
          viewDefaultVersion: p?.viewDefaultVersion ?? 0,
          sysHistoryPurged: p?.sysHistoryPurged ?? 0,
        }
      },
    },
  ),
)

// ── ทุกเครื่องเห็นสถานะรถชุดเดียวกัน (1): ประกาศทันทีที่มีการแก้ ────────────────
// The reconcile clock below bounds how far two screens can drift, but a minute
// is a long time at a gate where a car's status decides whether the next person
// may scan it. So mirror what positions already do: every row this device
// changes is ANNOUNCED on the broadcast bus the moment it changes, and every
// client applies what it hears straight into its own copy. Broadcast needs no
// publication membership and no DDL, so it keeps working in exactly the cases
// that make the row-level stream drop events.
//
// Last-write-wins on `at` (the sender's updatedAt) settles any collision, the
// same rule the row-level stream uses — so the two paths can never fight.
const ROW_BROADCAST_MAX = 30
/** updatedAt last known shared with the other clients — sent OR received.
 *  Comparing against it is what stops a received row echoing straight back. */
const rowShared = new Map<string, number>()
const pendingRows = new Map<string, RowMsg>()
let rowsTimer: ReturnType<typeof setTimeout> | null = null
/** Cars whose local copy arrived by broadcast, so it carries fresh cells but
 *  NOT the sender's new history line. Such a row must never be pushed back to
 *  the cloud — the upsert writes the whole row and would erase that line
 *  everywhere. It is dropped from here the moment a real pull refills it. */
const broadcastOnly = new Set<string>()

function flushRows() {
  rowsTimer = null
  if (!pendingRows.size) return
  const rows = [...pendingRows.values()]
  pendingRows.clear()
  // a wave this size is an import / bulk sync, not somebody editing a car —
  // those devices pull it themselves, and the payload would blow the bus limit
  if (rows.length > ROW_BROADCAST_MAX) return
  sendSync('status', { rows } satisfies RowsPayload)
}

useTracking.subscribe((s, prev) => {
  if (s.rows === prev.rows) return
  for (const vin in s.rows) {
    const r = s.rows[vin]
    const at = r.updatedAt ?? 0
    if (rowShared.get(vin) === at) continue
    const first = prev.rows[vin] === undefined
    rowShared.set(vin, at)
    // changed HERE, so this device owns the row again and may write it back
    broadcastOnly.delete(vin)
    if (first) continue // a row arriving from the initial load is not an edit
    pendingRows.set(vin, { vin, cells: r.cells ?? {}, at })
  }
  if (pendingRows.size && !rowsTimer) rowsTimer = setTimeout(flushRows, 250)
})

onSync('status', (p: RowsPayload) => {
  const rows = p?.rows
  if (!Array.isArray(rows) || !rows.length) return
  const fresh: TrackRow[] = []
  useTracking.setState((s) => {
    const next = { ...s.rows }
    let hit = 0
    for (const m of rows) {
      if (!m?.vin || !(m.cells?.['Vin'] ?? '').trim()) continue
      const cur = next[m.vin]
      if (!cur) continue // this device does not hold the car — its own sync brings it
      if ((cur.updatedAt ?? 0) >= m.at) { rowShared.set(m.vin, cur.updatedAt ?? 0); continue }
      // Land a hair BEHIND the sender's stamp: the cells are live on screen at
      // once, and the cloud copy — the one that also carries the new history
      // line — still reads as newer, so the next reconcile refills it. Stamping
      // m.at exactly would tie, and this device would keep a row with no record
      // of the change that just happened to it.
      const at = m.at - 1
      rowShared.set(m.vin, at) // mark as shared BEFORE the set() so it is not echoed back
      broadcastOnly.add(m.vin)
      // history is deliberately not on the wire — keep the copy this device has
      const row: TrackRow = { ...cur, cells: m.cells, updatedAt: at }
      next[m.vin] = row
      fresh.push(row)
      hit++
    }
    return hit ? { rows: next } : s
  })
  if (fresh.length) idbBulkPut(fresh).catch(() => {})
})

// ── ทุกเครื่องเห็นสถานะรถชุดเดียวกัน (2): นาฬิกากระทบยอดสถานะ ─────────────────
// Car positions already have three independent paths to every device (realtime,
// the `moves` broadcast, and the placement clock). Car STATUS had only one —
// the realtime stream — so a single missed event left that browser counting a
// car as In Yard forever while everyone else had it Gate-out, with nothing to
// correct it short of a reload. Events do get missed: the server strips the
// body of an oversized row, and the change poller has a per-tick ceiling that a
// bulk import or a busy minute at the gate blows straight through.
//
// syncCloud is already incremental — one query for rows touched since the last
// run — so asking on a clock costs a request that usually returns nothing, and
// it bounds how far any two screens can drift apart.
const STATUS_RESYNC_MS = 60_000
if (typeof window !== 'undefined') {
  const resync = () => {
    // a hidden tab shows no one anything — skip its minute tick; the
    // visibilitychange listener below re-syncs the moment it comes back
    if (document.visibilityState === 'hidden') return
    const s = useTracking.getState()
    if (!s.loaded || !useYard.getState().loggedInUserId) return
    s.syncCloud().catch(() => {})
  }
  setInterval(resync, STATUS_RESYNC_MS)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resync() })
  window.addEventListener('online', resync)
}

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
