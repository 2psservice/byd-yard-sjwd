/**
 * Shared "หา รถ / ใบหารถ" logic — used by both the Units Mylist tab and the
 * Yard Plan find-car panel so the two stay in lock-step.
 *
 * Search accepts a free-text blob (paste from Excel / email / typed) mixing
 * full VINs and short tokens (last-5 digits, etc.):
 *   • token ≥ 11 chars → exact VIN match
 *   • shorter token     → suffix/substring match (typing "154237" finds the
 *                         car whose VIN ends in it)
 * Results are de-duplicated, so a full VIN plus its own suffix count once.
 */
import type { TrackRow } from './excelTracking'
import type { FindListRow } from './groupingPrint'
import { siteGroupingConfig, yardLocCode } from './groupingImport'

export interface MatchResult {
  found: TrackRow[]
  notFound: string[]
  asked: number
}

export function matchVins(text: string, allRows: TrackRow[]): MatchResult {
  const tokens = text.toUpperCase().match(/[A-Z0-9]{3,20}/g) ?? []
  const uniq = [...new Set(tokens)]
  const byVin = new Map(allRows.map((r) => [r.vin, r]))
  const found: TrackRow[] = []
  const notFound: string[] = []
  const seen = new Set<string>()
  for (const tok of uniq) {
    let hits: TrackRow[]
    if (tok.length >= 11) { const r = byVin.get(tok); hits = r ? [r] : [] }
    else hits = allRows.filter((r) => r.vin.endsWith(tok) || r.vin.includes(tok))
    if (!hits.length) { notFound.push(tok); continue }
    for (const r of hits) if (!seen.has(r.vin)) { seen.add(r.vin); found.push(r) }
  }
  return { found, notFound, asked: uniq.length }
}

/** unit placement needed to resolve a yard-location code */
export interface UnitLite { block?: string; slot?: number; modelName?: string; color?: string }

/** Build ใบหารถ rows: yard-location code (with cell fallbacks) + display fields. */
export function toFindListRows(
  found: TrackRow[],
  unitByVin: (vin: string) => UnitLite | undefined,
  siteName: string,
): FindListRow[] {
  const prefix = siteGroupingConfig(siteName).prefix
  return found.map((r) => {
    const u = unitByVin(r.vin)
    const loc = yardLocCode(u ? { block: u.block, slot: u.slot } : null, prefix)
      || r.cells['storage Yard'] || r.cells['Location yard'] || ''
    return {
      vin: r.vin,
      model: r.cells['Model'] || u?.modelName || r.cells['Model name'] || '',
      color: r.cells['Color'] || u?.color || '',
      location: loc,
      remark: r.cells['หมายเหตุ'] || r.cells['Remark'] || '',
    }
  })
}
