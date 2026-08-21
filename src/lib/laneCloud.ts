/**
 * Reading a lane's real occupants from the cloud before writing into it.
 *
 * Shared by every screen that hands out a spot in a lane — the Re-location
 * station's row scan and single save, and the yard plan's "แยกช่อง" — so one
 * rule decides who is standing where, instead of each screen trusting whatever
 * its own device happens to remember.
 */
import type { Unit } from '../types'
import { fetchUnitsByVins, fetchUnitsInLane, isConfigured } from './db'
import { blockKeyOfTag } from './format'

/**
 * The lane as the CLOUD knows it, merged over what this device holds.
 *
 * "คันที่ N" is handed out as the first free depth, and it used to be computed
 * from the local units cache alone. That cache fills page by page, so a phone
 * opened a minute ago genuinely does not know about the cars already standing
 * in the lane — it hands out คันที่ 1 on top of someone, two cars claim the
 * same square, and the yard plan (one car per square) then draws four cars for
 * a lane holding five. Ask the cloud for that one lane before writing.
 *
 * Falls back to the local view when offline or when the yard's wifi stalls —
 * a relocation must never be blocked by a slow network.
 *
 * The lane query alone is not enough, and this is the subtle half. It asks for
 * the cars the cloud puts in THIS lane, so it can only ever ADD cars this
 * device did not know about. A car this device still believes is parked here,
 * but which somebody moved to another lane hours ago, is simply absent from
 * that answer — and absence left the stale local copy standing. The rebuild
 * then counted the ghost as an occupant and slid it down the lane, writing the
 * car back to a spot it left long ago: a car that had gone to N34 reappeared at
 * K09 every time anyone scanned K09, over and over. So the cars only THIS
 * device claims for the lane are looked up by VIN as well, and wherever the
 * cloud says they are is what counts.
 */
export async function laneFromCloud(local: Unit[], siteId: string | null, blockId: string, slot: number): Promise<Unit[]> {
  if (!isConfigured() || !blockId || !slot) return local
  const deadline = <T,>(p: Promise<T>) => Promise.race([
    p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
  ])
  try {
    const cloud = await deadline(fetchUnitsInLane(siteId, slot))
    const byVin = new Map(local.map(u => [u.vin, u] as const))
    const confirmed = new Set<string>()
    for (const u of cloud) { byVin.set(u.vin, u); confirmed.add(u.vin) } // the cloud is the authority
    // local-only claims on this lane: the cloud was asked about this exact lane
    // and did not name them. That is what a car that has moved away looks like
    // — but also what an unsynced local placement looks like, so ask outright
    // rather than assuming, and only move what the cloud actually answers for.
    const ghosts = [...byVin.values()]
      .filter(u => !confirmed.has(u.vin) && u.slot === slot && u.block && blockKeyOfTag(u.block) === blockId)
      .map(u => u.vin)
    if (ghosts.length) {
      const real = await deadline(fetchUnitsByVins(ghosts))
      for (const u of real) byVin.set(u.vin, u)
    }
    return [...byVin.values()]
  } catch {
    return local // offline / slow yard wifi — behave as before
  }
}
