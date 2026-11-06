/**
 * The nightly e-mail backup of every yard's Unit List (scripts/daily-unit-csv.ts, run at midnight
 * Thai time by .github/workflows/daily-unit-backup.yml).
 *
 * Each yard's file is the CSV the Unit List's CSV button writes at that yard with no filter set:
 *  - the yard's own cars, by the same rule the list uses (rowsForSite)
 *  - Final Status / Vin Of Status as the screen shows them (overlayInspection, from the open defects)
 *  - Location from the car's slot in THAT yard
 *  - the columns of the shared Unit List view, in its order, headed by their labels
 * Pure: the script fetches, this shapes.
 */
import type { Damage, Site } from '../types'
import { trackRowsCsvText, type TrackRow } from './excelTracking'
import { reconcileColumns, LOCATION_KEY, type Column } from './trackingColumns'
import { rowsForSite } from './siteScope'
import { overlayInspection } from './inspectionStatus'
import { yardLocFull } from './groupingImport'
import { deriveCarStatus, IN_YARD_STATUSES } from './carStatus'

/** What the list reads from a yard's car record: its slot, and its defects for the status overlay. */
export interface BackupUnit { block?: string; row?: number; slot?: number; damages: Damage[] }

/** The shared view's visible columns (app_config `unit_view_default`), or the built-in default view. */
export const backupColumns = (saved?: Column[]): Column[] => reconcileColumns(saved).filter((c) => c.visible)

/** One yard's Unit List rows, as the screen shows them. */
export function yardUnitList(site: Site, sites: Site[], rows: TrackRow[], units: Record<string, BackupUnit>): TrackRow[] {
  return rowsForSite(rows, site.id, sites).map((r) => {
    const u = units[r.vin]
    const shown = overlayInspection(r, u)
    return { ...shown, cells: { ...shown.cells, [LOCATION_KEY]: yardLocFull(u) } }
  })
}

export const yardCsv = (columns: Column[], list: TrackRow[]): string =>
  trackRowsCsvText(columns.map((c) => ({ key: c.key, label: c.label })), list)

export interface YardTally { total: number; inYard: number; preGateIn: number; other: number }

/** The counts the e-mail lists per yard: in the yard now · waiting to come in · everything else (gone out, preload…). */
export function tallyYard(list: TrackRow[]): YardTally {
  const t: YardTally = { total: list.length, inYard: 0, preGateIn: 0, other: 0 }
  for (const r of list) {
    const s = deriveCarStatus(r.cells)
    if (s === 'Pre Gate-in') t.preGateIn++
    else if (IN_YARD_STATUSES.has(s)) t.inYard++
    else t.other++
  }
  return t
}

/** "SJWD_60_RAI_2026-11-07.csv" — letters, digits and Thai kept, anything else becomes "_". */
export function backupFileName(site: Site, day: string): string {
  const name = (site.name || site.code || site.id).trim().replace(/[^A-Za-z0-9฀-๿-]+/g, '_').replace(/^_+|_+$/g, '')
  return `SJWD_${name || site.id}_${day}.csv`
}
