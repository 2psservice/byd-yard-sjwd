/**
 * Yard/site scoping for the master vehicle list (tracking rows).
 * A row belongs to a site by its `site` tag (set at import) or, for legacy rows
 * with no tag, by matching its "Location yard" cell to the site's name / code.
 */
import type { Site } from '../types'
import type { TrackRow } from './excelTracking'
import { tripsOf, TRIPS_CELL, TRIP_SCOPED_KEYS, type TripSnapshot } from './tripHistory'
import { GATE_OUT_ORIGIN_SITE_KEY, CAR_STATUS_KEY, gateOutOriginAt, inYardAssertedAt, fmtGateOutStamp, isGateOutStamp, gateOutScanMs } from './carStatus'

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

/**
 * When this car last went out through `siteId`'s gate — and the round that
 * ended with it, which is the car as this yard last saw it.
 *
 * TWO records answer this, newest wins:
 *
 *  · the ORIGIN MARKER written at the scan (GATE_OUT_ORIGIN_SITE_KEY). Exact,
 *    but it only exists for departures scanned since that shipped.
 *  · the CLOSED ROUND itself (tripHistory). Every yard-to-yard move closes a
 *    round, and the snapshot keeps the yard the car was standing in when it
 *    did — so this reaches back through every departure the yard ever made,
 *    including all the ones from before the marker existed. Without it the
 *    Gate-out card counted only the newly-marked departures and read 132
 *    where the yard itself could count 196 cars gone.
 *
 * Returns null when this car never left this yard.
 */
export function departureFromSite(
  cells: Record<string, string>, siteId: string | null | undefined, sites: Site[],
): { at: number; trip?: TripSnapshot } | null {
  if (!siteId) return null
  // ลานนี้เองยืนยันทีหลังว่ารถยังอยู่ในลาน ⇒ บันทึก "ออกไปแล้ว" ของลานนี้ผิด
  // และถูกแก้แล้ว — คำยืนยันของคนที่ยืนอยู่ตรงนั้นชนะบันทึกเก่าของลานตัวเอง
  // (เป็นทางเดียวที่แอดมินจะแก้รถที่ค้างสถานะ Gate-out ให้ถูกได้ ดู asDeparted
  //  ในหน้ารายการรถ ซึ่งทับช่อง Car Status เป็น Gate-out ตายตัว)
  // คำยืนยันของลานอื่นไม่เกี่ยว — ยิง Gate-in ที่ปลายทางคือคำยืนยันของปลายทาง
  // ลานต้นทางต้องยังจำได้ว่าตัวเองยิงรถออกไปเมื่อไหร่
  const asserted = inYardAssertedAt(cells, siteId)
  const stillHere = (d: { at: number; trip?: TripSnapshot } | null) =>
    d && asserted > d.at ? null : d
  const trips = tripsOf(cells)
  // the marker names a site id outright — no name matching needed
  if (cells[GATE_OUT_ORIGIN_SITE_KEY] === siteId) {
    const at = gateOutOriginAt(cells)
    if (at > 0) return stillHere({ at, trip: trips.find((t) => t.cells['Gate Out Time'] === String(at)) })
  }
  const site = sites.find((s) => s.id === siteId)
  if (!site) return null
  const keys = siteKeys(site)
  let best: { at: number; trip: TripSnapshot } | null = null
  for (const t of trips) {
    if (!keys.includes(norm(t.yard))) continue
    // the round's own gate-out stamp, else the moment it was closed — a round
    // only ever closes because the car had already gone
    const at = parseInt(t.cells['Gate Out Time'] || '', 10)
    const ms = Number.isFinite(at) && at > 0 ? at : t.closedAt
    if (ms > 0 && (!best || ms > best.at)) best = { at: ms, trip: t }
  }
  return stillHere(best)
}

/**
 * Has this car gone out through `siteId`'s gate — and not come back?
 *
 * No time window by default, on purpose. A departure is a FACT, not news that
 * expires: a car that left last month has still left, and the yard counts it
 * among the cars it has sent out. Windowing this is what made the Gate-out
 * card disagree with the yard's own reckoning twice over — 113 against 176
 * when it counted one 09:30 flush cycle, then 132 against 196 when it counted
 * a week. "Come back" is the caller's half of the question: a car standing in
 * this yard again is not away, however many times it has left before (see the
 * rowInSite guard on the Dashboard, and departedRows in the Unit List).
 *
 * `since` narrows it to departures after a moment, for a caller that really
 * does want "lately".
 */
export function departedFromSite(
  cells: Record<string, string>, siteId: string | null | undefined, sites: Site[], since = 0,
): boolean {
  const d = departureFromSite(cells, siteId, sites)
  return !!d && d.at >= since
}

/**
 * รถที่ลานนี้ยิงออกไปแล้ว มองจากลานนี้ = "รถอย่างที่ลานนี้เห็นครั้งสุดท้าย"
 *
 * แถวสดของรถเป็นของลานที่รถไปอยู่ตอนนี้ (ปลายทางยิง Gate-in ทับวันที่/ผู้ตรวจ
 * แล้วเริ่มงาน PDI/PM ของตัวเอง) แยกยาร์ด แยกงาน — ข้อมูลรอบที่จบไปแล้วของลาน
 * ต้นทางต้องไม่ขยับตามงานของปลายทาง จึงประกอบแถวขึ้นใหม่จากรอบที่ปิดไป:
 *  · ช่องรายเที่ยวทั้งหมดของแถวสดถูกถอดออกก่อน (ไม่ใช่แค่ทับด้วยของรอบเก่า —
 *    ช่องที่รอบเก่าไม่มี เช่นผู้ตรวจ Gate-in ที่ปลายทางเพิ่งเขียน จะทะลุมาแทน)
 *  · แล้วใส่ช่องของรอบที่จบไปกลับเข้าไป · ชื่อลาน = ลานนี้ · สถานะ = Gate-out
 *  · ประวัติการแก้ไขและรอบที่ปิดไป ตัดที่เวลาที่รถออก (เผื่อไว้นิดหน่อยให้
 *    รายการที่การยิงออกครั้งนั้นเองเขียนต่อท้ายในวินาทีถัดมา)
 * คืน null ถ้าลานนี้ไม่มีบันทึกว่ารถออกไป
 */
export const DEPARTURE_SETTLE_MS = 60_000

export function departedViewFrom(r: TrackRow, siteId: string | null | undefined, sites: Site[]): TrackRow | null {
  const d = departureFromSite(r.cells, siteId, sites)
  if (!d) return null
  const cutoff = d.at + DEPARTURE_SETTLE_MS
  const cells: Record<string, string> = { ...r.cells }
  for (const k of TRIP_SCOPED_KEYS) delete cells[k]
  Object.assign(cells, d.trip?.cells ?? {})
  const site = sites.find((s) => s.id === siteId)
  if (d.trip?.yard) cells['Location yard'] = d.trip.yard
  else if (site) cells['Location yard'] = site.name
  cells['Car Status'] = 'Gate-out'
  cells['Gate Out Time'] = String(d.at)
  cells['Gate Out time stamp'] = d.trip?.cells['Gate Out time stamp'] || fmtGateOutStamp(d.at)
  const trips = tripsOf(r.cells).filter((t) => t.closedAt <= cutoff)
  if (trips.length) cells[TRIPS_CELL] = JSON.stringify(trips)
  else delete cells[TRIPS_CELL]
  return { ...r, cells, history: (r.history ?? []).filter((h) => h.at <= cutoff) }
}

/**
 * ทำไมรถคันนี้ถึงอ่านได้ว่า "Gate-out" เมื่อมองจากยาร์ดนี้ — ตอบเป็นภาษาคน
 *
 * สถานะ Gate-out ไม่ได้มาจากการยิงที่ประตูเสมอไป ไฟล์ที่อัปโหลดก็ทำให้เป็นได้
 * (มีวันที่ออกติดมาในไฟล์) เวลามีรถขึ้นเป็น Gate-out ทั้งที่ยังจอดอยู่ในลาน
 * คนหน้างานต้องตอบได้ว่า "มาจากไหน" ก่อนจะแก้ ไม่งั้นแก้แล้วไฟล์รอบหน้าก็ตีกลับอีก
 *
 * (แผนรับที่เลยกำหนดเกิน 2 วัน เคยเป็นอีกเหตุผลหนึ่งในนี้ด้วย — ตัดออกแล้วพร้อม
 * กับกฎเดียวกันใน deriveCarStatus ดูคอมเมนต์ที่นั่น)
 *
 * เรียงตามลำดับที่ deriveCarStatus ตัดสินจริง คืน null ถ้าไม่ได้อ่านเป็น Gate-out
 */
export function gateOutReason(
  cells: Record<string, string>, siteId: string | null | undefined, sites: Site[],
): string | null {
  const d = departureFromSite(cells, siteId, sites)
  if (d) return `ยาร์ดนี้บันทึกว่ารถออกไปแล้ว เมื่อ ${fmtGateOutStamp(d.at)}`
  const stamp = (cells['Gate Out time stamp'] ?? '').trim()
  const explicit = (cells[CAR_STATUS_KEY] ?? '').trim()
  if (explicit === 'Pre Gate-out') return 'ยิงออกที่ประตูแล้ว รอตัดยอดรอบ 09:30'
  if (explicit === 'Gate-out') {
    return gateOutScanMs(cells) > 0 && (cells['Gate Out Time'] ?? '').trim()
      ? `ยิงออกที่ประตูเมื่อ ${fmtGateOutStamp(gateOutScanMs(cells))}`
      : 'ช่อง Car Status ถูกตั้งเป็น Gate-out (มาจากไฟล์ที่อัปโหลด หรือมีคนตั้งไว้)'
  }
  if (isGateOutStamp(stamp)) return `ไฟล์มีวันที่ออกติดมา — "${stamp}"`
  const alt = (cells['Gate Out Date'] ?? '').trim()
  if (isGateOutStamp(alt)) return `ไฟล์มีวันที่ออกติดมา (ช่อง Gate Out Date) — "${alt}"`
  return null
}

/** ชื่อยาร์ดที่แถวนี้เป็นของ — ป้ายยาร์ดก่อน ไม่มีค่อยดูช่อง Location yard
 *  ใช้ตอบคนที่ยืนอยู่ยาร์ดอื่นว่า "รถอยู่ที่ไหน" โดยไม่เปิดข้อมูลของรถให้ */
export function rowYardName(row: TrackRow, sites: Site[]): string {
  const s = row.site ? sites.find((x) => x.id === row.site) : undefined
  return s?.name ?? locationYard(row.cells)
}

/**
 * แยกยาร์ด แยกงาน — การค้นหาเห็นเฉพาะรถของยาร์ดที่ยืนอยู่ เลขวินที่ค้นแล้วไม่อยู่
 * ในรายการของยาร์ดนี้ ตอบได้แค่ว่า "อยู่ใน Site ไหน" ไม่เปิดแถวของยาร์ดนั้นให้ดู
 * หรือแก้ (ของเดิมดึงแถวของยาร์ดอื่นมาแสดงในตารางเลย)
 *  `listed` = เลขวินที่ยาร์ดนี้แสดงอยู่แล้ว (รวมรถที่ออกไปแล้วซึ่งยังโชว์เป็น Gate-out)
 */
export function whereElse(
  query: string, allRows: TrackRow[], listed: Set<string>, sites: Site[], max = 5,
): { vin: string; yard: string }[] {
  const q = query.trim().toUpperCase().replace(/\s+/g, '')
  if (q.length < 5) return [] // สั้นกว่าเลขท้าย 5 ตัว = กำลังไล่ดู ไม่ใช่ตามหารถคันหนึ่ง
  const out: { vin: string; yard: string }[] = []
  for (const r of allRows) {
    if (listed.has(r.vin) || !r.vin.includes(q)) continue
    out.push({ vin: r.vin, yard: rowYardName(r, sites) || 'ยาร์ดอื่น' })
    if (out.length >= max) break
  }
  return out
}
