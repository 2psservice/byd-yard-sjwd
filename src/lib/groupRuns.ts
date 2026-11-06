/**
 * One grouping number, two kinds of work.
 *
 * BYD numbers a yard's dealer plan ("FIS Ready to Grouping for delivery", cars sold to dealers) and a
 * yard-to-yard move plan ("NYB2 Phase2 Grouping to 3D RINCHA") from the same series, so ONE number can
 * name a dealer group AND a move group in the same yard. On 06/11 NYB2 had 31 dealer groups, and 14 of
 * those numbers were also groups of its 210-car move to 3D RINCHA (no car in both).
 *
 * The two stay separate runs. What tells them apart is where the group's cars go, the Delivery
 * Location: a dealer, or one of the app's own yards (deliveryDestinationSite, the same rule Gate-out
 * uses to decide a car is moving yards). That value travels with each queue item (`dest`) and with
 * the car's row ('Dealer Location'), so every device can tell which kind of work a car is.
 */
import type { Site } from '../types'
import type { QueueItem, WorkQueue } from '../store/useOps'
import { deliveryDestinationSite } from './siteScope'

/** Grouping numbers compare the way a person reads them off the DN: case and spaces don't matter. */
export const groupNo = (s?: string): string => (s ?? '').toUpperCase().replace(/\s+/g, '')

/** What a Delivery Location means for its cars: '' = delivered to a dealer · a site id = moved to that yard. */
export const destPurpose = (dest: string | undefined, sites: Site[]): string =>
  deliveryDestinationSite((dest ?? '').trim(), sites)?.id ?? ''

/** The purpose a run gives one of its groups, read from that group's own Delivery Location.
 *  null = no car of the group in this run carries one (an old run), so nothing can be said. */
export function runGroupPurpose(items: QueueItem[], group: string, sites: Site[]): string | null {
  const g = groupNo(group)
  for (const i of items) if (groupNo(i.group) === g && (i.dest ?? '').trim()) return destPurpose(i.dest, sites)
  return null
}

/** How the gate names each kind: "Grouping for delivery" · "Grouping to 3D RINCHA". */
export const purposeLabel = (purpose: string, sites: Site[]): string =>
  purpose ? `Grouping to ${sites.find((s) => s.id === purpose)?.name ?? purpose}` : 'Grouping for delivery'

/** One kind of work a grouping number names: the runs giving it, and the cars of that number in them. */
export interface GroupChoice { purpose: string; label: string; runIds: string[]; runNames: string[]; vins: string[] }

/**
 * The kinds of work the given runs (a yard's open delivery runs) give one grouping number. One entry
 * is the normal case; two or more and the gate asks which one the scanned DN is before listing cars.
 * Dealer delivery first, then moves by yard name.
 */
export function groupChoices(runs: WorkQueue[], group: string, sites: Site[]): GroupChoice[] {
  const g = groupNo(group)
  if (!g) return []
  const by = new Map<string, GroupChoice>()
  for (const q of runs) {
    const items = q.items.filter((i) => groupNo(i.group) === g)
    if (!items.length) continue
    const purpose = runGroupPurpose(items, g, sites) ?? ''
    let c = by.get(purpose)
    if (!c) by.set(purpose, (c = { purpose, label: purposeLabel(purpose, sites), runIds: [], runNames: [], vins: [] }))
    c.runIds.push(q.id)
    c.runNames.push(q.name)
    for (const i of items) if (!c.vins.includes(i.vin)) c.vins.push(i.vin)
  }
  return [...by.values()].sort((a, b) => Number(!!a.purpose) - Number(!!b.purpose) || a.label.localeCompare(b.label))
}
