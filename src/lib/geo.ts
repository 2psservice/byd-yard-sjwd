// ============================================================
//  Geo helpers — BYD Yard Control GPS tracking
//  Yard sits at the BYD Rayong plant (WHA Industrial Estate).
// ============================================================
import type { GpsPoint, Trip } from '../types'

/** Yard centre (BYD Rayong, WHA IE). Used as the map home + sim origin. */
export const YARD_CENTER = { lat: 12.928, lng: 101.0865 }
/** Gate / preload area — where every drive starts. */
export const GATE_POINT = { lat: 12.92742, lng: 101.08498 }

const EARTH = 6371000 // m
const D2R = Math.PI / 180

/** Great-circle distance between two lat/lng points, in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * D2R
  const dLng = (b.lng - a.lng) * D2R
  const la1 = a.lat * D2R
  const la2 = b.lat * D2R
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Total length of a path in metres. */
export function pathDistanceM(path: { lat: number; lng: number }[]): number {
  let d = 0
  for (let i = 1; i < path.length; i++) d += haversineM(path[i - 1], path[i])
  return Math.round(d)
}

/** Move a point by (east, north) metres → new lat/lng. */
export function offsetMeters(p: { lat: number; lng: number }, east: number, north: number) {
  const dLat = north / 111320
  const dLng = east / (111320 * Math.cos(p.lat * D2R))
  return { lat: p.lat + dLat, lng: p.lng + dLng }
}

/** Initial bearing a→b in degrees (0=N, 90=E). */
export function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const y = Math.sin((b.lng - a.lng) * D2R) * Math.cos(b.lat * D2R)
  const x =
    Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) -
    Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lng - a.lng) * D2R)
  return (Math.atan2(y, x) / D2R + 360) % 360
}

/** km/h ← m/s (Geolocation speed). Returns 0 for null/NaN. */
export function msToKmh(ms: number | null | undefined): number {
  if (ms == null || Number.isNaN(ms) || ms < 0) return 0
  return Math.round(ms * 3.6)
}

/** Deterministic destination for a slot so the same car always maps to the same spot. */
export function slotToLatLng(block: string | undefined, row = 0, slot = 0) {
  // spread blocks in a rough grid east/north of the gate
  const bi = block ? block.charCodeAt(0) - 65 : 0 // A=0
  const east = 30 + bi * 34 + slot * 2.6
  const north = 30 + row * 6.5 + (bi % 2) * 8
  return offsetMeters(YARD_CENTER, east, north)
}

/**
 * Build a believable GPS path from the gate to a destination, sampled ~every
 * 1.5 s with small lateral jitter (≈ lane width). Used to seed demo trips and
 * as the on-device fallback when the browser has no real GPS.
 */
export function simulatePath(
  dest: { lat: number; lng: number },
  startedAt: number,
  rand: () => number = Math.random,
): GpsPoint[] {
  const total = haversineM(GATE_POINT, dest)
  const steps = Math.max(6, Math.round(total / 12)) // ~12 m per sample
  const head = bearing(GATE_POINT, dest)
  const out: GpsPoint[] = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    // ease-in-out so it accelerates from the gate and slows into the slot
    const ease = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2
    const base = {
      lat: GATE_POINT.lat + (dest.lat - GATE_POINT.lat) * ease,
      lng: GATE_POINT.lng + (dest.lng - GATE_POINT.lng) * ease,
    }
    const jitter = offsetMeters(base, (rand() - 0.5) * 2.4, (rand() - 0.5) * 2.4)
    // speed bell curve, peak ~18 km/h mid-route, crawl at ends
    const speed = Math.round(4 + Math.sin(f * Math.PI) * 15 + (rand() - 0.5) * 3)
    out.push({
      lat: jitter.lat,
      lng: jitter.lng,
      t: startedAt + i * 1500,
      speed: Math.max(0, speed),
      heading: head,
      acc: 2 + rand() * 2, // ~2–4 m
    })
  }
  return out
}

/** Construct a finished demo trip for a parked/assigned unit. */
export function makeDemoTrip(
  vin: string,
  driver: string,
  dest: { lat: number; lng: number },
  toLabel: string,
  startedAt: number,
  rand: () => number = Math.random,
): Trip {
  const path = simulatePath(dest, startedAt, rand)
  return {
    id: `t${startedAt}${Math.round(rand() * 1e4)}`,
    vin,
    driver,
    startedAt,
    endedAt: path[path.length - 1]?.t,
    from: 'Gate',
    to: toLabel,
    path,
    distanceM: pathDistanceM(path),
    sim: true,
  }
}

/** Small seeded RNG so demo data is stable across reloads. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
