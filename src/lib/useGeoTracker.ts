// ============================================================
//  useGeoTracker — live high-accuracy GPS while driving.
//  Prefers the real device GPS; falls back to a smooth simulator
//  when the browser has no Geolocation / permission (desktop preview)
//  so the driving screen + path recording still demo correctly.
// ============================================================
import { useEffect, useRef, useState } from 'react'
import type { GpsPoint } from '../types'
import { GATE_POINT, bearing, haversineM, msToKmh, offsetMeters } from './geo'

export type GeoStatus = 'idle' | 'acquiring' | 'real' | 'sim'

export interface GeoReadout {
  speedKmh: number
  acc?: number       // accuracy radius (m)
  heading?: number
  lat?: number
  lng?: number
  status: GeoStatus
  error?: string
}

/**
 * @param active  start/stop tracking
 * @param dest    destination (for the simulator fallback heading)
 * @param onPoint called on every fix with a GpsPoint to record
 */
export function useGeoTracker(
  active: boolean,
  dest: { lat: number; lng: number } | null,
  onPoint: (p: GpsPoint) => void,
): GeoReadout {
  const [readout, setReadout] = useState<GeoReadout>({ speedKmh: 0, status: 'idle' })
  const onPointRef = useRef(onPoint)
  onPointRef.current = onPoint
  const lastFix = useRef<GpsPoint | null>(null)
  const gotReal = useRef(false)

  useEffect(() => {
    if (!active) { setReadout({ speedKmh: 0, status: 'idle' }); return }
    lastFix.current = null
    gotReal.current = false
    setReadout({ speedKmh: 0, status: 'acquiring' })

    let watchId: number | null = null
    let simTimer: ReturnType<typeof setInterval> | null = null
    let simFallback: ReturnType<typeof setTimeout> | null = null

    const emit = (p: GpsPoint, status: GeoStatus) => {
      lastFix.current = p
      onPointRef.current(p)
      setReadout({ speedKmh: p.speed ?? 0, acc: p.acc, heading: p.heading, lat: p.lat, lng: p.lng, status })
    }

    // ── real GPS ──
    const startReal = () => {
      if (!('geolocation' in navigator)) { startSim(); return }
      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            gotReal.current = true
            if (simTimer) { clearInterval(simTimer); simTimer = null }
            const c = pos.coords
            const prev = lastFix.current
            // device speed if present, else derive from movement
            let kmh = msToKmh(c.speed)
            if ((c.speed == null || Number.isNaN(c.speed)) && prev) {
              const dt = (pos.timestamp - prev.t) / 1000
              if (dt > 0) kmh = Math.round((haversineM(prev, { lat: c.latitude, lng: c.longitude }) / dt) * 3.6)
            }
            emit(
              {
                lat: c.latitude, lng: c.longitude, t: pos.timestamp,
                speed: kmh,
                heading: c.heading != null && !Number.isNaN(c.heading) ? c.heading : prev ? bearing(prev, { lat: c.latitude, lng: c.longitude }) : undefined,
                acc: c.accuracy,
              },
              'real',
            )
          },
          () => { if (!gotReal.current) startSim() },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 },
        )
      } catch { startSim() }
      // if no real fix within 4s, light up the simulator so the screen is alive
      simFallback = setTimeout(() => { if (!gotReal.current) startSim() }, 4000)
    }

    // ── simulator fallback ──
    const startSim = () => {
      if (simTimer || gotReal.current) return
      const target = dest ?? offsetMeters(GATE_POINT, 80, 80)
      const total = Math.max(40, haversineM(GATE_POINT, target))
      const head = bearing(GATE_POINT, target)
      let traveled = 0
      simTimer = setInterval(() => {
        if (gotReal.current) { if (simTimer) clearInterval(simTimer); simTimer = null; return }
        // accelerate to ~16 km/h then ease toward the slot
        const remain = total - traveled
        const targetKmh = remain < 18 ? Math.max(3, remain) : 16
        const stepM = (targetKmh / 3.6) * 1.2 // 1.2 s tick
        traveled = Math.min(total, traveled + stepM)
        const f = traveled / total
        const base = {
          lat: GATE_POINT.lat + (target.lat - GATE_POINT.lat) * f,
          lng: GATE_POINT.lng + (target.lng - GATE_POINT.lng) * f,
        }
        const jit = offsetMeters(base, (Math.sin(traveled) * 1.2), (Math.cos(traveled * 1.3) * 1.2))
        emit(
          { lat: jit.lat, lng: jit.lng, t: Date.now(), speed: Math.round(targetKmh), heading: head, acc: 2.5 },
          'sim',
        )
      }, 1200)
    }

    startReal()

    return () => {
      if (watchId != null && 'geolocation' in navigator) navigator.geolocation.clearWatch(watchId)
      if (simTimer) clearInterval(simTimer)
      if (simFallback) clearTimeout(simFallback)
    }
  }, [active, dest?.lat, dest?.lng])

  return readout
}
