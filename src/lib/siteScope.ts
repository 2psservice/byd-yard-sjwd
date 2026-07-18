/**
 * Yard/site scoping for the master vehicle list (tracking rows).
 * A row belongs to a site by its `site` tag (set at import) or, for legacy rows
 * with no tag, by matching its "Location yard" cell to the site's name / code.
 */
import type { Site } from '../types'
import type { TrackRow } from './excelTracking'

const norm = (s?: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

export const locationYard = (cells: Record<string, string>) => (cells['Location yard'] ?? '').trim()

/** A site's match keys (name + optional code), normalized. */
const siteKeys = (site: Site) => [site.name, site.code].filter(Boolean).map((x) => norm(x as string))

/** Does this row's "Location yard" name the given site? */
export function locationMatchesSite(cells: Record<string, string>, site: Site): boolean {
  const ly = norm(locationYard(cells))
  return ly !== '' && siteKeys(site).includes(ly)
}

/** The site whose name/code matches this row's "Location yard" — undefined when the
 *  cell is blank or names a yard that has no Site (e.g. "BYD Factory"). */
export function siteIdForLocation(cells: Record<string, string>, sites: Site[]): string | undefined {
  const ly = norm(locationYard(cells))
  if (!ly) return undefined
  return sites.find((s) => siteKeys(s).includes(ly))?.id
}

/** Site a row belongs to at import time: a Location-yard match if any, else the active site. */
export function siteForRow(cells: Record<string, string>, sites: Site[], currentSite: string | null): string | undefined {
  return siteIdForLocation(cells, sites) ?? currentSite ?? undefined
}

/** Co-Inspection accepts a row for the active site: unplaced (empty Location yard), or it names the active site. */
export function coInspectionAccepts(cells: Record<string, string>, sites: Site[], currentSite: string | null): boolean {
  if (!currentSite) return true
  const ly = norm(locationYard(cells))
  if (!ly) return true // unplaced → belongs to the active import site
  const cur = sites.find((s) => s.id === currentSite)
  return !!cur && siteKeys(cur).includes(ly)
}

/** Unit List membership: tagged rows use their tag; legacy untagged fall back to Location-yard match. */
export function rowInSite(row: TrackRow | undefined, currentSite: string | null, sites: Site[]): boolean {
  if (!currentSite) return true // no site selected → show everything
  if (!row) return false
  if (row.site) return row.site === currentSite
  const cur = sites.find((s) => s.id === currentSite)
  return !!cur && locationMatchesSite(row.cells, cur)
}
