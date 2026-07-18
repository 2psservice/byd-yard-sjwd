/**
 * Tracking — admin live GPS map + per-car driving history.
 * Shows every car's latest position on a Leaflet map (markers labelled by VIN),
 * a searchable car list, and for a selected car: its full trip history timeline
 * (who drove it, when, where) with the GPS path drawn on the map.
 */
import { useMemo, useState } from 'react'
import {
  Radar, Search, MapPin, Route, User, Clock, Navigation, Gauge,
  Car, History, Crosshair, X, ChevronRight,
} from 'lucide-react'
import { useUnits, useTrips, tripsForVin } from '../store/useYard'
import { useYard } from '../store/useYard'
import { LiveTrackingMap, type MapMarker } from '../components/LiveTrackingMap'
import { PageHead, cx } from '../components/ui'
import { STATUS_META, timeAgo, clock } from '../lib/format'
import { modelById } from '../lib/sampleData'
import type { Trip, Unit } from '../types'

const fmtDur = (a: number, b?: number) => {
  if (!b) return '—'
  const s = Math.floor((b - a) / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')} น.` : `${s} วิ`
}
const fmtDist = (m?: number) => (m == null ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} กม.` : `${m} ม.`)
const dayKey = (t: number) => new Date(t).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' })

export function Tracking() {
  const lang = useYard((s) => s.lang)
  const units = useUnits()
  const trips = useTrips()
  const [q, setQ] = useState('')
  const [selVin, setSelVin] = useState<string | null>(null)
  const [selTripId, setSelTripId] = useState<string | null>(null)

  // cars that have a known position, newest movement first
  const tracked = useMemo(
    () => units.filter((u) => u.lastPos).sort((a, b) => (b.lastPos!.t) - (a.lastPos!.t)),
    [units],
  )

  // search by VIN, model, or any driver who has driven the car
  const driversByVin = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const t of trips) (map[t.vin] ??= new Set()).add(t.driver)
    return map
  }, [trips])

  const filtered = useMemo(() => {
    const query = q.trim().toUpperCase()
    if (!query) return tracked
    return tracked.filter((u) =>
      u.vin.toUpperCase().includes(query) ||
      u.modelName.toUpperCase().includes(query) ||
      [...(driversByVin[u.vin] ?? [])].some((d) => d.toUpperCase().includes(query)),
    )
  }, [tracked, q, driversByVin])

  const selUnit = selVin ? units.find((u) => u.vin === selVin) ?? null : null
  const selTrips = useMemo(() => (selVin ? tripsForVin(trips, selVin) : []), [trips, selVin])
  const activeTrip = useMemo(
    () => selTrips.find((t) => t.id === selTripId) ?? selTrips[0] ?? null,
    [selTrips, selTripId],
  )

  const openTrips = useMemo(() => trips.filter((t) => !t.endedAt), [trips])
  const openVins = useMemo(() => new Set(openTrips.map((t) => t.vin)), [openTrips])

  const markers: MapMarker[] = useMemo(
    () => (selUnit
      ? (selUnit.lastPos ? [{ vin: selUnit.vin, lat: selUnit.lastPos.lat, lng: selUnit.lastPos.lng, color: modelById(selUnit.model)?.color ?? '#2563eb', active: openVins.has(selUnit.vin) }] : [])
      : tracked.map((u) => ({
          vin: u.vin, lat: u.lastPos!.lat, lng: u.lastPos!.lng,
          color: modelById(u.model)?.color ?? '#2563eb', active: openVins.has(u.vin),
        }))),
    [tracked, selUnit, openVins],
  )

  const pick = (vin: string) => { setSelVin(vin); setSelTripId(null) }

  return (
    <div className="max-w-[1300px] mx-auto">
      <PageHead
        title={<span className="flex items-center gap-2"><Radar size={20} style={{ color: 'var(--brand)' }} /> ติดตาม GPS รถ</span>}
        sub="ตำแหน่งล่าสุด · เส้นทางการขับ · ประวัติคนขับรายคัน"
        right={
          <div className="flex items-center gap-2 text-[12px]">
            <span className="badge" style={{ color: 'var(--st-yard)', background: 'rgba(34,197,94,0.12)' }}>
              <span className="live">●</span> {openVins.size} กำลังขับ
            </span>
            <span className="badge" style={{ color: 'var(--brand)', background: 'rgba(37,99,235,0.1)' }}>
              {tracked.length} คันมีพิกัด
            </span>
          </div>
        }
      />

      <div className="grid lg:grid-cols-[340px_1fr] gap-4">
        {/* ── left: searchable car list ── */}
        <div className="panel flex flex-col overflow-hidden" style={{ maxHeight: 'calc(100vh - 180px)' }}>
          <div className="p-3 border-b hairline">
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--chip)' }}>
              <Search size={15} style={{ color: 'var(--muted)' }} />
              <input
                value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="ค้นหา VIN / รุ่น / คนขับ…"
                className="bg-transparent outline-none text-[13px] w-full vin"
              />
              {q && <button onClick={() => setQ('')}><X size={14} style={{ color: 'var(--muted)' }} /></button>}
            </div>
          </div>
          <div className="overflow-auto flex-1">
            {filtered.length === 0 && (
              <div className="p-8 text-center text-[13px]" style={{ color: 'var(--faint)' }}>
                ไม่พบรถที่ตรงกับ “{q}”
              </div>
            )}
            {filtered.map((u) => {
              const m = STATUS_META[u.status]
              const drivers = driversByVin[u.vin]?.size ?? 0
              const live = openVins.has(u.vin)
              return (
                <button key={u.vin} onClick={() => pick(u.vin)}
                  className={cx('w-full text-left px-3.5 py-3 border-b hairline transition-colors flex items-center gap-3',
                    selVin === u.vin ? 'bg-[#eef4ff]' : 'hover:bg-[#f8f9fb]')}>
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: modelById(u.model)?.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="vin text-[12.5px] font-semibold clip">{u.vin.slice(-10)}</span>
                      {live && <span className="live text-[10px]" style={{ color: 'var(--st-yard)' }}>●</span>}
                    </div>
                    <div className="text-[11px] mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
                      <span>{u.modelName}</span>
                      <span style={{ color: 'var(--faint)' }}>·</span>
                      <span className="flex items-center gap-0.5"><Clock size={10} /> {timeAgo(u.lastPos!.t, lang)}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="badge" style={{ color: m.color, background: m.bg }}>{lang === 'th' ? m.th : m.en}</span>
                    <div className="text-[10px] mt-1 flex items-center justify-end gap-0.5" style={{ color: 'var(--faint)' }}>
                      <User size={9} /> {drivers} คน · {u.tripCount ?? 0} เที่ยว
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── right: map + detail ── */}
        <div className="space-y-4 min-w-0">
          <div className="panel p-2">
            <LiveTrackingMap
              markers={markers}
              path={activeTrip?.path}
              focusVin={selVin}
              onSelect={pick}
              height={selUnit ? 380 : 460}
            />
          </div>

          {!selUnit ? (
            <div className="panel p-8 text-center" style={{ color: 'var(--faint)' }}>
              <Radar size={32} className="mx-auto mb-2" style={{ color: 'var(--line-strong)' }} />
              <div className="text-[14px] font-semibold" style={{ color: 'var(--muted)' }}>เลือกรถเพื่อดูเส้นทางและประวัติ</div>
              <div className="text-[12px] mt-1">แตะหมุดบนแผนที่ หรือเลือกจากรายการด้านซ้าย</div>
            </div>
          ) : (
            <CarDetail unit={selUnit} trips={selTrips} activeTrip={activeTrip} onPickTrip={setSelTripId} lang={lang} />
          )}
        </div>
      </div>
    </div>
  )
}

function CarDetail({
  unit, trips, activeTrip, onPickTrip, lang,
}: {
  unit: Unit
  trips: Trip[]
  activeTrip: Trip | null
  onPickTrip: (id: string) => void
  lang: 'th' | 'en'
}) {
  const m = STATUS_META[unit.status]
  const drivers = useMemo(() => Array.from(new Set(trips.map((t) => t.driver))), [trips])
  const totalDist = useMemo(() => trips.reduce((s, t) => s + (t.distanceM ?? 0), 0), [trips])

  // group trips by day for the timeline
  const grouped = useMemo(() => {
    const g: { day: string; items: Trip[] }[] = []
    for (const t of trips) {
      const k = dayKey(t.startedAt)
      const last = g[g.length - 1]
      if (last && last.day === k) last.items.push(t)
      else g.push({ day: k, items: [t] })
    }
    return g
  }, [trips])

  return (
    <div className="space-y-4 fade-up">
      {/* header card */}
      <div className="panel overflow-hidden">
        <div className="p-4 flex items-center gap-3" style={{ background: 'linear-gradient(135deg,#0d1726,#1b2c45)' }}>
          <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(255,255,255,0.1)' }}>
            <Car size={22} style={{ color: '#fff' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="vin text-[15px] font-bold text-white clip">{unit.vin}</div>
            <div className="text-[12px]" style={{ color: 'rgba(255,255,255,0.6)' }}>{unit.modelName} · {unit.color}</div>
          </div>
          <span className="badge" style={{ color: '#fff', background: 'rgba(255,255,255,0.16)' }}>{lang === 'th' ? m.th : m.en}</span>
        </div>
        <div className="grid grid-cols-4 divide-x" style={{ borderColor: 'var(--line)' }}>
          {[
            { ic: <Route size={15} />, label: 'เที่ยว', val: trips.length },
            { ic: <User size={15} />, label: 'คนขับ', val: drivers.length },
            { ic: <Navigation size={15} />, label: 'ระยะรวม', val: fmtDist(totalDist) },
            { ic: <MapPin size={15} />, label: 'ตำแหน่ง', val: unit.block ? `${unit.block}${unit.slot}.${unit.row}` : '—' },
          ].map((x) => (
            <div key={x.label} className="p-3 text-center">
              <div className="flex items-center justify-center gap-1 text-[10.5px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>
                {x.ic}{x.label}
              </div>
              <div className="text-[15px] font-bold tabular">{x.val}</div>
            </div>
          ))}
        </div>
        {unit.lastPos && (
          <div className="px-4 py-2.5 border-t hairline flex items-center justify-between text-[11.5px]" style={{ color: 'var(--muted)' }}>
            <span className="flex items-center gap-1.5">
              <Crosshair size={12} style={{ color: 'var(--brand)' }} />
              พิกัดล่าสุด <span className="vin">{unit.lastPos.lat.toFixed(5)}, {unit.lastPos.lng.toFixed(5)}</span>
            </span>
            <span>± {unit.lastPos.acc?.toFixed(0) ?? '—'} ม. · {timeAgo(unit.lastPos.t, lang)}</span>
          </div>
        )}
      </div>

      {/* timeline */}
      <div className="panel overflow-hidden">
        <div className="px-4 py-3 border-b hairline flex items-center gap-2">
          <History size={15} style={{ color: 'var(--brand)' }} />
          <span className="font-semibold text-[14px]">ประวัติการขับ</span>
          <span className="text-[12px]" style={{ color: 'var(--muted)' }}>· {trips.length} เที่ยว</span>
        </div>
        {trips.length === 0 ? (
          <div className="p-6 text-center text-[13px]" style={{ color: 'var(--faint)' }}>ยังไม่มีประวัติการขับ</div>
        ) : (
          <div className="p-3">
            {grouped.map((g) => (
              <div key={g.day} className="mb-1">
                <div className="text-[11px] font-bold px-1 py-1.5 sticky top-0" style={{ color: 'var(--faint)' }}>{g.day}</div>
                {g.items.map((t) => {
                  const active = activeTrip?.id === t.id
                  return (
                    <button key={t.id} onClick={() => onPickTrip(t.id)}
                      className={cx('w-full text-left rounded-xl p-3 mb-1.5 transition-all flex items-start gap-3',
                        active ? 'ring-2' : 'hover:bg-[#f8f9fb]')}
                      style={active ? { background: '#eef4ff', boxShadow: '0 0 0 2px var(--brand)' } : { background: 'var(--chip)' }}>
                      {/* timeline dot */}
                      <div className="flex flex-col items-center pt-0.5">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ background: active ? 'var(--brand)' : 'var(--line-strong)' }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                            style={{ background: 'var(--st-yard)' }}>{t.driver.slice(0, 1)}</span>
                          <span className="font-semibold text-[13px]">{t.driver}</span>
                          {!t.endedAt && <span className="badge" style={{ color: 'var(--st-yard)', background: 'rgba(34,197,94,0.12)' }}><span className="live">●</span> กำลังขับ</span>}
                          {t.sim && <span className="text-[9.5px] px-1.5 py-0.5 rounded" style={{ background: '#fff7ed', color: '#c2680b' }}>sim</span>}
                        </div>
                        <div className="text-[11.5px] mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: 'var(--muted)' }}>
                          <span className="flex items-center gap-1"><Clock size={11} /> {clock(t.startedAt)}</span>
                          <span className="flex items-center gap-1"><Navigation size={11} /> {t.from} → {t.to}</span>
                          <span className="flex items-center gap-1"><Route size={11} /> {fmtDist(t.distanceM)}</span>
                          <span className="flex items-center gap-1"><Gauge size={11} /> {fmtDur(t.startedAt, t.endedAt)}</span>
                        </div>
                      </div>
                      <ChevronRight size={15} style={{ color: active ? 'var(--brand)' : 'var(--faint)' }} className="mt-1 shrink-0" />
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
