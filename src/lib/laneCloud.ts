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
/**
 * ตำแหน่งที่เครื่องนี้ "เพิ่งยิงแต่ยังเขียนขึ้นคลาวด์ไม่เสร็จ" — คลาวด์ยังเห็นช่องเก่าของรถคันนั้น
 *
 * 16 ต.ค. 10:48: ยิง Re-location คันแรกเข้า F15 ได้คันที่ 4 · 7 วินาทีต่อมายิงคันที่สองเข้า F15 — ตอนถามคลาวด์ คันแรกยังเขียนไม่ถึง
 * (ถึงช้า 9 วินาที) คลาวด์ตอบว่าคันแรกยังอยู่ช่องเดิม และค่าคลาวด์ทับตำแหน่งใหม่ในเครื่อง → คันที่สองได้คันที่ 4 ซ้ำ = รถซ้อนช่อง
 * ระหว่างที่การเขียนของรถคันไหนยังไม่เสร็จ ให้ตำแหน่งในเครื่องของคันนั้นเป็นฝ่ายชนะ (หมดอายุเองกันค้าง)
 */
export const PLACEMENT_IN_FLIGHT_TTL_MS = 10 * 60_000
const inFlight = new Map<string, { token: number; at: number }>()
/** เริ่มเขียนตำแหน่งของรถเหล่านี้ (token = รหัสคำสั่งวาง ใช้กันคำสั่งเก่าลบเครื่องหมายของคำสั่งใหม่กว่า) */
export function markPlacementInFlight(vins: Iterable<string>, token: number, now = Date.now()): void {
  for (const v of vins) inFlight.set(v, { token, at: now })
}
/** เขียนเสร็จแล้ว — ลบเฉพาะเครื่องหมายที่ยังเป็นของคำสั่งนี้ */
export function clearPlacementInFlight(vins: Iterable<string>, token: number): void {
  for (const v of vins) if (inFlight.get(v)?.token === token) inFlight.delete(v)
}
export function isPlacementInFlight(vin: string, now = Date.now()): boolean {
  const e = inFlight.get(vin)
  if (!e) return false
  if (now - e.at > PLACEMENT_IN_FLIGHT_TTL_MS || now < e.at) { inFlight.delete(vin); return false }
  return true
}
/** สำหรับเทสต์ */
export function _resetPlacementInFlight(): void { inFlight.clear() }

async function readLane(local: Unit[], siteId: string | null, blockId: string, slot: number, timeoutMs: number): Promise<Unit[]> {
  const deadline = <T,>(p: Promise<T>) => Promise.race([
    p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ])
  const cloud = await deadline(fetchUnitsInLane(siteId, slot))
  const byVin = new Map(local.map(u => [u.vin, u] as const))
  const confirmed = new Set<string>()
  // the cloud is the authority — except for a car THIS device just placed whose write has not landed yet:
  // the cloud still shows its old spot, and letting that win hands the new spot out twice (see inFlight)
  for (const u of cloud) { confirmed.add(u.vin); if (!isPlacementInFlight(u.vin)) byVin.set(u.vin, u) }
  // local-only claims on this lane: the cloud was asked about this exact lane
  // and did not name them. That is what a car that has moved away looks like
  // — but also what an unsynced local placement looks like, so ask outright
  // rather than assuming, and only move what the cloud actually answers for.
  const ghosts = [...byVin.values()]
    .filter(u => !confirmed.has(u.vin) && !isPlacementInFlight(u.vin) && u.slot === slot && u.block && blockKeyOfTag(u.block) === blockId)
    .map(u => u.vin)
  if (ghosts.length) {
    const real = await deadline(fetchUnitsByVins(ghosts))
    for (const u of real) byVin.set(u.vin, u)
  }
  return [...byVin.values()]
}

export async function laneFromCloud(local: Unit[], siteId: string | null, blockId: string, slot: number): Promise<Unit[]> {
  if (!isConfigured() || !blockId || !slot) return local
  try {
    return await readLane(local, siteId, blockId, slot, 2500)
  } catch {
    return local // offline / slow yard wifi — behave as before
  }
}

/** ความยาวรอคำตอบเลนจากคลาวด์ของ laneFromCloudStrict: ครั้งแรก แล้วลองซ้ำอีกครั้งที่รอนานขึ้น */
export const STRICT_LANE_TIMEOUTS_MS = [4000, 8000]

/**
 * เหมือน laneFromCloud แต่ "ไม่เดา": อ่านเลนจากคลาวด์ไม่ได้ (หมดเวลา/ไม่มีเน็ต) → ลองซ้ำหนึ่งครั้งที่รอนานขึ้น แล้วโยน error
 * ใช้กับยิงตามแถว — เดิมหมดเวลา 2.5 วิแล้วใช้ข้อมูลในเครื่อง ซึ่งบนมือถือที่โหลดรถยังไม่ครบไม่มีรถเดิมของเลน
 * → วางคันที่ยิงทับรถเดิม (P05 NYB2 17 ต.ค. 11:21: 3 คันแรกไม่เห็นรถเดิม 5 คัน ช่องซ้อน)
 */
export async function laneFromCloudStrict(local: Unit[], siteId: string | null, blockId: string, slot: number): Promise<Unit[]> {
  if (!isConfigured() || !blockId || !slot) return local
  let last: unknown
  for (const ms of STRICT_LANE_TIMEOUTS_MS) {
    try { return await readLane(local, siteId, blockId, slot, ms) } catch (e) { last = e }
  }
  throw last instanceof Error ? last : new Error('lane read failed')
}
