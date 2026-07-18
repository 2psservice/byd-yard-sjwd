/**
 * DrivingScreen — Tesla-style full-screen driving HUD shown while a driver is
 * moving a car to its slot. Big live GPS speed (km/h) replaces the "P", the car
 * PNG sits under it, and every fix is recorded into the car's trip. A live
 * Leaflet mini-map shows the path being laid down.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Navigation, MapPin, Gauge, CheckCircle2, Crosshair, Satellite, ArrowUp } from 'lucide-react'
import { CarTopView } from './CarTopView'
import { LiveTrackingMap } from './LiveTrackingMap'
import { useGeoTracker } from '../lib/useGeoTracker'
import { useYard, useTrips } from '../store/useYard'
import { haversineM } from '../lib/geo'
import type { Unit } from '../types'

export function DrivingScreen({
  unit, driverName, dest, destLabel, fromLabel = 'Preload', onArrive, onCancel,
}: {
  unit: Unit
  driverName: string
  dest: { lat: number; lng: number } | null
  destLabel: string
  fromLabel?: string
  onArrive: () => void
  onCancel: () => void
}) {
  const appendGps = useYard((s) => s.appendGps)
  const trips = useTrips()
  const startedAt = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)

  const readout = useGeoTracker(true, dest, (p) => appendGps(unit.vin, p))

  useEffect(() => {
    const i = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(i)
  }, [])

  // live path of the current (open) trip
  const path = useMemo(() => {
    for (let i = trips.length - 1; i >= 0; i--) {
      if (trips[i].vin === unit.vin && !trips[i].endedAt) return trips[i].path
    }
    return []
  }, [trips, unit.vin])

  const distance = useMemo(() => {
    let d = 0
    for (let i = 1; i < path.length; i++) d += haversineM(path[i - 1], path[i])
    return Math.round(d)
  }, [path])

  const remaining = useMemo(() => {
    if (!dest || readout.lat == null) return null
    return Math.round(haversineM({ lat: readout.lat, lng: readout.lng! }, dest))
  }, [dest, readout.lat, readout.lng])

  const color = unit.colorHex ?? '#cfd6dd'
  const m = Math.floor(elapsed / 60)
  const s = String(elapsed % 60).padStart(2, '0')
  const acquiring = readout.status === 'acquiring'

  const markers = readout.lat != null
    ? [{ vin: unit.vin, lat: readout.lat, lng: readout.lng!, color: '#2563eb', label: '▲', active: true }]
    : path.length ? [{ vin: unit.vin, lat: path[path.length - 1].lat, lng: path[path.length - 1].lng, color: '#2563eb', active: true }] : []

  return createPortal((
    <div className="fixed inset-0 z-[100] flex flex-col select-none"
      style={{ background: 'radial-gradient(120% 80% at 50% 0%, #16203a 0%, #0b1120 55%, #060a14 100%)' }}>

      {/* moving lane backdrop */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ opacity: 0.5 }}>
        <div className="road-lane road-lane-l" />
        <div className="road-lane road-lane-r" />
      </div>

      {/* top bar */}
      <div className="relative flex items-center justify-between px-4 pt-4">
        <button onClick={onCancel}
          className="w-10 h-10 rounded-full flex items-center justify-center active:scale-90 transition"
          style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', backdropFilter: 'blur(4px)' }}>
          <X size={18} />
        </button>
        <GpsBadge status={readout.status} acc={readout.acc} />
      </div>

      {/* speed + car */}
      <div className="relative flex-1 flex flex-col items-center justify-center min-h-0">
        {/* big speed (replaces the P) */}
        <div className="flex flex-col items-center -mb-1">
          <div className="flex items-end gap-2 leading-none">
            <span className="display font-black tabular" style={{
              fontSize: 96, color: '#fff', textShadow: '0 4px 30px rgba(96,165,250,0.45)',
              letterSpacing: '-3px',
            }}>{acquiring ? '–' : readout.speedKmh}</span>
            <span className="font-bold mb-4" style={{ fontSize: 17, color: 'rgba(255,255,255,0.55)' }}>km/h</span>
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-semibold -mt-1" style={{ color: '#60a5fa' }}>
            <Gauge size={13} /> {acquiring ? 'กำลังหาสัญญาณ GPS…' : 'ความเร็วจาก GPS มือถือ'}
          </div>
        </div>

        {/* route: ปลายทาง (บน) ▲ ต้นทาง (ล่าง) — direction of travel */}
        <div className="relative flex flex-col items-center mt-1.5">
          {/* destination above */}
          <div className="flex flex-col items-center">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.18em]" style={{ color: 'rgba(74,222,128,0.7)' }}>ปลายทาง</div>
            <div className="flex items-center gap-1.5 leading-none mt-0.5">
              <Navigation size={16} style={{ color: '#4ade80' }} />
              <span className="display font-black" style={{ fontSize: 28, color: '#4ade80', textShadow: '0 2px 16px rgba(74,222,128,0.4)' }}>{destLabel}</span>
            </div>
            <ArrowUp size={22} className="arrow-up mt-1" style={{ color: '#4ade80' }} />
          </div>

          <CarTopView color={color} width={132} />

          {/* origin below */}
          <div className="flex flex-col items-center -mt-1">
            <div style={{ width: 2, height: 14, background: 'linear-gradient(rgba(255,255,255,0.05),rgba(255,255,255,0.3))' }} />
            <div className="px-3 py-1.5 rounded-full flex items-center gap-2"
              style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <span className="text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: 'rgba(255,255,255,0.4)' }}>ต้นทาง</span>
              <span className="text-[13px] font-bold text-white">{fromLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {/* stat row */}
      <div className="relative grid grid-cols-3 gap-2 px-4 mb-2">
        {[
          { ic: <Crosshair size={14} />, label: 'ความแม่นยำ', val: readout.acc != null ? `±${readout.acc.toFixed(0)} ม.` : '—' },
          { ic: <Navigation size={14} />, label: 'เหลืออีก', val: remaining != null ? `${remaining} ม.` : '—' },
          { ic: <MapPin size={14} />, label: 'วิ่งแล้ว', val: `${distance} ม.` },
        ].map((x) => (
          <div key={x.label} className="rounded-xl py-2 px-2 text-center" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div className="flex items-center justify-center gap-1 text-[10px] font-semibold mb-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {x.ic} {x.label}
            </div>
            <div className="text-[15px] font-bold tabular" style={{ color: '#fff' }}>{x.val}</div>
          </div>
        ))}
      </div>

      {/* live mini-map */}
      <div className="relative px-4 mb-2">
        <LiveTrackingMap markers={markers} path={path} follow height={150}
          accuracy={readout.lat != null && readout.acc != null ? { lat: readout.lat, lng: readout.lng!, acc: readout.acc } : null} />
        <div className="absolute top-3 left-7 px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 z-[500]"
          style={{ background: 'rgba(6,10,20,0.7)', color: '#fff', backdropFilter: 'blur(4px)' }}>
          <span className="live" style={{ color: '#4ade80' }}>●</span> บันทึกเส้นทาง GPS
        </div>
      </div>

      {/* driver + timer + actions */}
      <div className="relative px-4 pb-5">
        <div className="flex items-center justify-between mb-2.5 text-[12.5px]" style={{ color: 'rgba(255,255,255,0.65)' }}>
          <span className="flex items-center gap-1.5">
            <span className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white"
              style={{ background: 'var(--st-yard)' }}>{driverName.slice(0, 1)}</span>
            {driverName}
          </span>
          <span className="flex items-center gap-1.5 tabular font-mono font-semibold text-[14px]" style={{ color: '#fff' }}>
            <span className="live" style={{ color: '#4ade80' }}>●</span> {m}:{s}
          </span>
        </div>
        <button onClick={onArrive}
          className="w-full h-16 rounded-2xl text-[17px] font-bold flex items-center justify-center gap-2 transition-all active:scale-95"
          style={{ background: '#16a34a', color: '#fff', boxShadow: '0 10px 30px -6px rgba(22,163,74,0.6)' }}>
          <CheckCircle2 size={22} /> ถึงแล้ว · ยืนยันจอด {destLabel}
        </button>
      </div>
    </div>
  ), document.body)
}

function GpsBadge({ status, acc }: { status: string; acc?: number }) {
  const real = status === 'real'
  const sim = status === 'sim'
  const color = real ? '#4ade80' : sim ? '#fbbf24' : '#94a3b8'
  const text = real ? 'GPS แม่นยำ' : sim ? 'โหมดจำลอง' : 'กำลังเชื่อมต่อ'
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-bold"
      style={{ background: 'rgba(255,255,255,0.08)', color, backdropFilter: 'blur(4px)', border: `1px solid ${color}40` }}>
      <Satellite size={13} /> {text}{real && acc != null ? ` ±${acc.toFixed(0)}ม.` : ''}
    </div>
  )
}
