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

/** Cell naming the 2+ sites a "shared shuttle" Pre Gate-in import might land
 *  at, when the file itself can't say which one — a comma-joined list of
 *  site ids. Set only by that import path; every other row leaves it blank. */
export const CANDIDATE_SITES_KEY = 'Candidate Sites'

export function candidateSiteIds(cells: Record<string, string>): string[] {
  return (cells[CANDIDATE_SITES_KEY] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** A still-unclaimed shared-shuttle row (no `site` tag yet) named as a
 *  candidate for THIS site — visible for Gate-in scanning at every yard it
 *  could still land at, without rowInSite's stricter scoping ever showing it
 *  anywhere else (Unit List, reports, the wider Dashboard breakdown…), so it
 *  can never leak to a site it was never actually shuttled toward. Whichever
 *  site's Gate-in scans it first claims it for real (see doTrackingGateIn),
 *  and it stops being a candidate everywhere the moment `site` is set. */
export function isPreGateInCandidate(row: TrackRow | undefined, currentSite: string | null): boolean {
  if (!currentSite || !row || row.site) return false
  return candidateSiteIds(row.cells).includes(currentSite)
}

/** Does this yard work with this car? Its own cars, PLUS any shared-shuttle car
 *  still waiting to be claimed that named this yard as a destination — those are
 *  genuinely ITS arrivals to expect, so the Dashboard counts them, the Gate-in
 *  station can scan them and the Unit List lists them. One rule, so no screen
 *  can disagree with the count another one shows. */
export const siteWorksWith = (row: TrackRow | undefined, currentSite: string | null, sites: Site[]): boolean =>
  rowInSite(row, currentSite, sites) || isPreGateInCandidate(row, currentSite)

export function rowsForSite(all: TrackRow[], currentSite: string | null, sites: Site[]): TrackRow[] {
  if (!currentSite) return all
  return all.filter((r) => siteWorksWith(r, currentSite, sites))
}

/** A grouping run's "Delivery Location" sometimes names one of THIS app's own
 *  yards rather than a real external dealer — BYD writes it as e.g. "VEHICLE
 *  60Rai" for a car whose next stop is the 60 Rai yard, not a customer. Used
 *  to auto-transfer a car straight into Pre Gate-in at that yard the moment
 *  it truly gates out (see App.tsx's reconciliation sweep), instead of
 *  someone having to notice and re-import a Vin List Inventory sheet by hand.
 *
 *  Matches by substring so "VEHICLE 60Rai" / "TO 60 RAI" / etc. all hit the
 *  Site named "60 Rai" — a real dealer name is exceedingly unlikely to
 *  contain one of the app's own yard names. Site keys under 4 characters are
 *  skipped: a short code ("A5") would false-positive inside an ordinary
 *  dealer name. */
// stricter than the file's own `norm` (which only COLLAPSES whitespace, for
// exact-match comparisons elsewhere here) — this one strips it out entirely,
// so "60 Rai" and "60Rai" compare equal regardless of how either side spaced it
const stripAll = (s: string) => s.trim().toLowerCase().replace(/[\s._\-#]/g, '')

export function deliveryDestinationSite(deliveryLocation: string, sites: Site[]): Site | undefined {
  const dl = stripAll(deliveryLocation)
  if (!dl) return undefined
  return sites.find((s) => [s.name, s.code].filter(Boolean).map((x) => stripAll(x as string)).some((k) => k.length >= 4 && dl.includes(k)))
}
