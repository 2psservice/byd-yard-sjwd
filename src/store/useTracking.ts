import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Column } from '../lib/trackingColumns'
import { defaultColumns, reconcileColumns } from '../lib/trackingColumns'
import type { ParseResult, RowEvent, TrackRow } from '../lib/excelTracking'
import { parseTrackingWorkbook } from '../lib/excelTracking'
import { idbBulkPut, idbClear, idbDelete, idbGetAllRows, idbPut } from '../lib/idb'
import * as db from '../lib/db'
import { supabase } from '../lib/supabase'
import { useYard } from './useYard'
import { siteForRow, siteIdForLocation, coInspectionAccepts } from '../lib/siteScope'
import { CAR_STATUS_ORDER, deriveCarStatus, isGateOutStamp } from '../lib/carStatus'
import type { RealtimeChannel } from '@supabase/supabase-js'

// live channel (module-scoped — never persisted)
let trackingChannel: RealtimeChannel | null = null

interface TrackingState {
  rows: Record<string, TrackRow>   // keyed by VIN (in memory; persisted in IndexedDB)
  columns: Column[]
  loaded: boolean
  importing: boolean
  lastImport: { inYard: number; total: number; gatedOut: number; at: number } | null
  lastSync: number // epoch ms of the last successful cloud sync (0 = never → full pull)

  loadFromIdb: () => Promise<void>
  syncCloud: () => Promise<void>
  subscribeRealtime: () => void
  unsubscribeRealtime: () => void
  importFile: (file: File) => Promise<ParseResult>
  commitImport: (res: ParseResult) => void
  commitCoInspection: (res: ParseResult) => { updated: number; added: number; skipped: number; gateOut: number; moved: number }
  updateCell: (vin: string, key: string, value: string) => void
  bulkUpdate: (vins: string[], key: string, value: string) => void
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
      loaded: false,
      importing: false,
      lastImport: null,
      lastSync: 0,

      loadFromIdb: async () => {
        if (get().loaded) return
        let rows: Record<string, TrackRow> = {}
        try {
          const all = await idbGetAllRows()
          // backfill rows imported before "Last update" existed → use the import time
          const fallback = get().lastImport?.at ?? Date.now()
          const fixed: TrackRow[] = []
          for (const r of all) {
            if (r.updatedAt == null) { r.updatedAt = fallback; fixed.push(r) }
            rows[r.vin] = r
          }
          if (fixed.length) idbBulkPut(fixed).catch(() => {})
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
                for (const r of siteRows) rec[r.vin] = r
                set({ rows: rec })
                idbBulkPut(siteRows).catch(() => {})
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
        try { cloud = await db.fetchTrackingRows(since) } catch { return }
        const cloudByVin = new Map(cloud.map((r) => [r.vin, r]))

        // cloud → local: rows missing locally, or newer in the cloud
        const merged: Record<string, TrackRow> = { ...local }
        const pull: TrackRow[] = []
        for (const cr of cloud) {
          const lr = local[cr.vin]
          if (!lr || (cr.updatedAt ?? 0) > (lr.updatedAt ?? 0)) { merged[cr.vin] = cr; pull.push(cr) }
        }

        // local → cloud: on a full run, anything the cloud lacks or is older on;
        // incrementally, just local edits since last sync (covers offline changes)
        const push: TrackRow[] = []
        for (const lr of Object.values(local)) {
          if (incremental) {
            if ((lr.updatedAt ?? 0) > lastSync) push.push(lr)
          } else {
            const cr = cloudByVin.get(lr.vin)
            if (!cr || (lr.updatedAt ?? 0) > (cr.updatedAt ?? 0)) push.push(lr)
          }
        }

        if (pull.length) { set({ rows: merged }); idbBulkPut(pull).catch(() => {}) }
        if (push.length) db.upsertTrackingRows(push).catch(() => {})
        set({ lastSync: startedAt })
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
              const r = payload.new as { vin?: string; cells?: Record<string, string> | null; updated_at?: string | null; site?: string | null }
              if (!r?.vin) return
              const incoming: TrackRow = {
                vin: r.vin,
                cells: r.cells ?? {},
                updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now(),
                site: r.site ?? undefined,
              }
              set((s) => {
                const cur = s.rows[incoming.vin]
                if (cur && (cur.updatedAt ?? 0) >= (incoming.updatedAt ?? 0)) return s // stale / self-echo
                idbPut(incoming).catch(() => {})
                return { rows: { ...s.rows, [incoming.vin]: incoming } }
              })
            },
          )
          .subscribe()
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
        const stageOf = (s: string) => { const i = ORDER.indexOf(s); return i < 0 ? 0 : i }
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
        // gate-out rows: never added as new cars, but an EXISTING VIN whose file
        // row now says gate-out means the car left the yard — merge the file's
        // cells (Gate Out time stamp ฯลฯ) and force Car Status = Gate-out.
        // Applied regardless of the active yard: a gate-out is global truth.
        let gateOut = 0
        for (const r of res.gateOutRows ?? []) {
          const existing = rows[r.vin]
          if (!existing) continue
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
    }),
    {
      name: 'sjwd-tracking',
      // only the (small) column config is persisted to localStorage; rows live in IndexedDB
      partialize: (s) => ({ columns: s.columns, lastImport: s.lastImport, lastSync: s.lastSync }),
      merge: (persisted, current) => {
        const p = persisted as Partial<TrackingState> | undefined
        return { ...current, ...p, columns: reconcileColumns(p?.columns) }
      },
    },
  ),
)

// memoized array of rows to avoid new-reference selector loops
export function useTrackingRows(): TrackRow[] {
  const rows = useTracking((s) => s.rows)
  return useMemo(() => Object.values(rows), [rows])
}

export function useVisibleColumns(): Column[] {
  const columns = useTracking((s) => s.columns)
  return useMemo(() => columns.filter((c) => c.visible), [columns])
}
