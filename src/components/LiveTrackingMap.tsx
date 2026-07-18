/**
 * LiveTrackingMap — Leaflet map for live GPS + trip playback.
 * Leaflet is loaded once from CDN (no bundler dependency). Markers are HTML
 * divIcons labelled by VIN (not people). Used by the admin Tracking page and
 * the driver DrivingScreen mini-map.
 */
import { useEffect, useRef, useState } from 'react'
import { YARD_CENTER } from '../lib/geo'

// ── one-time Leaflet CDN loader ───────────────────────────────────────────────
let leafletPromise: Promise<any> | null = null
function ensureLeaflet(): Promise<any> {
  if ((window as any).L) return Promise.resolve((window as any).L)
  if (leafletPromise) return leafletPromise
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
    document.head.appendChild(css)
    const js = document.createElement('script')
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
    js.async = true
    js.onload = () => resolve((window as any).L)
    js.onerror = () => reject(new Error('leaflet-load-failed'))
    document.head.appendChild(js)
  })
  return leafletPromise
}

export interface MapMarker {
  vin: string
  lat: number
  lng: number
  color?: string
  label?: string   // text shown in the pill (defaults to VIN suffix)
  active?: boolean // pulsing highlight (e.g. currently driving)
}

interface Props {
  markers: MapMarker[]
  path?: { lat: number; lng: number }[]
  focusVin?: string | null
  accuracy?: { lat: number; lng: number; acc: number } | null
  height?: number | string
  onSelect?: (vin: string) => void
  follow?: boolean   // pan to the latest path point each update (driving)
  compact?: boolean  // hide zoom buttons (mini map)
  rounded?: boolean
}

const pill = (m: MapMarker) => {
  const text = m.label ?? m.vin.slice(-6)
  const c = m.color ?? '#2563eb'
  const ring = m.active ? `box-shadow:0 0 0 3px ${c}55, 0 4px 10px rgba(0,0,0,.35);` : 'box-shadow:0 3px 8px rgba(0,0,0,.3);'
  return `
    <div style="position:absolute;left:0;top:0;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;">
      <div style="background:${c};color:#fff;font:700 11px/1 'JetBrains Mono',monospace;letter-spacing:.3px;
                  padding:4px 7px;border-radius:7px;white-space:nowrap;border:1.5px solid #fff;${ring}">${text}</div>
      <div style="width:2px;height:8px;background:${c};"></div>
      <div style="width:9px;height:9px;border-radius:50%;background:${c};border:2px solid #fff;margin-top:-1px;${m.active ? 'animation:pulseDot 1.4s infinite;' : ''}"></div>
    </div>`
}

export function LiveTrackingMap({
  markers, path, focusVin, accuracy, height = 360, onSelect, follow, compact, rounded = true,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const layersRef = useRef<{ markers?: any; path?: any; acc?: any }>({})
  const [err, setErr] = useState(false)
  const [ready, setReady] = useState(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  // init
  useEffect(() => {
    let dead = false
    ensureLeaflet()
      .then((L) => {
        if (dead || !elRef.current || mapRef.current) return
        const map = L.map(elRef.current, {
          center: [YARD_CENTER.lat, YARD_CENTER.lng],
          zoom: 17, zoomControl: !compact, attributionControl: false,
        })
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
        mapRef.current = map
        layersRef.current.markers = L.layerGroup().addTo(map)
        setReady(true)
      })
      .catch(() => setErr(true))
    return () => {
      dead = true
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
    }
  }, [compact])

  // markers
  useEffect(() => {
    const L = (window as any).L
    const map = mapRef.current
    if (!L || !map || !layersRef.current.markers) return
    const grp = layersRef.current.markers
    grp.clearLayers()
    markers.forEach((m) => {
      const icon = L.divIcon({ html: pill(m), className: '', iconSize: [0, 0], iconAnchor: [0, 0] })
      const mk = L.marker([m.lat, m.lng], { icon, zIndexOffset: m.active ? 1000 : 0 })
      mk.on('click', () => onSelectRef.current?.(m.vin))
      grp.addLayer(mk)
    })
  }, [markers, ready])

  // focused path
  useEffect(() => {
    const L = (window as any).L
    const map = mapRef.current
    if (!L || !map) return
    if (layersRef.current.path) { map.removeLayer(layersRef.current.path); layersRef.current.path = undefined }
    if (path && path.length > 1) {
      const latlngs = path.map((p) => [p.lat, p.lng])
      const line = L.polyline(latlngs, { color: '#2563eb', weight: 4, opacity: 0.9, lineJoin: 'round' })
      const start = L.circleMarker(latlngs[0], { radius: 5, color: '#16a34a', fillColor: '#16a34a', fillOpacity: 1, weight: 2 })
      const grp = L.featureGroup([line, start]).addTo(map)
      layersRef.current.path = grp
      if (!follow) map.fitBounds(line.getBounds().pad(0.35), { maxZoom: 18 })
    }
  }, [path, ready])

  // accuracy circle + follow
  useEffect(() => {
    const L = (window as any).L
    const map = mapRef.current
    if (!L || !map) return
    if (layersRef.current.acc) { map.removeLayer(layersRef.current.acc); layersRef.current.acc = undefined }
    if (accuracy) {
      layersRef.current.acc = L.circle([accuracy.lat, accuracy.lng], {
        radius: Math.max(1.5, accuracy.acc), color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.12, weight: 1,
      }).addTo(map)
    }
    if (follow) {
      const target = accuracy ?? (path && path.length ? path[path.length - 1] : null)
      if (target) map.panTo([target.lat, target.lng], { animate: true, duration: 0.8 })
    }
  }, [accuracy, follow, path, ready])

  // fit to all markers when focus changes (non-follow)
  useEffect(() => {
    const L = (window as any).L
    const map = mapRef.current
    if (!L || !map || follow || path) return
    if (focusVin) {
      const m = markers.find((x) => x.vin === focusVin)
      if (m) map.setView([m.lat, m.lng], 18, { animate: true })
    } else if (markers.length) {
      const fg = L.featureGroup(markers.map((m: MapMarker) => L.marker([m.lat, m.lng])))
      map.fitBounds(fg.getBounds().pad(0.3), { maxZoom: 17 })
    }
  }, [focusVin, ready])

  if (err) {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-1"
        style={{ height, borderRadius: rounded ? 16 : 0, background: '#eef1f6', color: 'var(--muted)' }}>
        <div className="text-[13px] font-semibold">โหลดแผนที่ไม่ได้</div>
        <div className="text-[11px]">ต้องการอินเทอร์เน็ตเพื่อโหลด Leaflet / OpenStreetMap</div>
      </div>
    )
  }

  return (
    // isolate: trap Leaflet's high z-index panes/controls (up to 1000) in their
    // own stacking context so they can't bleed over app modals (Select Site etc.)
    <div className="relative" style={{ height, isolation: 'isolate' }}>
      <div ref={elRef} style={{ height: '100%', width: '100%', borderRadius: rounded ? 16 : 0, overflow: 'hidden', background: '#dfe6ee' }} />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
          กำลังโหลดแผนที่…
        </div>
      )}
    </div>
  )
}
