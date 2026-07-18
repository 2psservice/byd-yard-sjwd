import { useMemo, useState } from 'react'
import { User, Navigation, CheckCircle2, Clock, Car, ArrowRight } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { PageHead, cx } from '../components/ui'
import type { Unit } from '../types'

function fmtDate(ts?: number) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`
}
function fmtTime(ts?: number) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtDuration(startTs?: number, endTs?: number) {
  if (!startTs || !endTs) return '—'
  const s = Math.max(0, Math.floor((endTs - startTs) / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m === 0) return `${sec} วิ`
  return `${m} นาที ${sec} วิ`
}
function slotLabel(u: Unit) {
  if (!u.block) return '—'
  // column-first: block + column(slot) + "." + row-in-column (e.g. RR38.5)
  return `${u.block}${u.slot}.${u.row}`
}

interface DriverGroup {
  name: string
  parked: Unit[]
  driving: Unit[]
  lastActivity: number
}

function buildGroups(units: Unit[]): DriverGroup[] {
  const map = new Map<string, Unit[]>()
  for (const u of units) {
    if (!u.driver) continue
    if (u.status !== 'PARKED' && u.status !== 'ASSIGNED') continue
    if (!map.has(u.driver)) map.set(u.driver, [])
    map.get(u.driver)!.push(u)
  }
  return [...map.entries()]
    .map(([name, all]) => ({
      name,
      parked:  all.filter(u => u.status === 'PARKED').sort((a, b) => (b.parkedAt ?? 0) - (a.parkedAt ?? 0)),
      driving: all.filter(u => u.status === 'ASSIGNED'),
      lastActivity: Math.max(...all.map(u => u.parkedAt ?? u.assignedAt ?? 0)),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity)
}

function UnitRow({ u, lang }: { u: Unit; lang: 'th' | 'en' }) {
  const isParked  = u.status === 'PARKED'
  const ts        = isParked ? u.parkedAt : u.assignedAt
  return (
    <tr className="border-t hairline hover:bg-[var(--chip)] transition-colors">
      {/* status dot */}
      <td className="pl-4 pr-2 py-2.5 w-6">
        <div className="w-2 h-2 rounded-full mx-auto" style={{
          background: isParked ? 'var(--st-yard)' : 'var(--brand)',
        }} />
      </td>
      {/* VIN */}
      <td className="px-3 py-2.5">
        <span className="vin text-[12.5px] font-semibold">{u.vin}</span>
      </td>
      {/* model */}
      <td className="px-3 py-2.5 text-[12.5px] whitespace-nowrap">{u.modelName}</td>
      {/* color */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: u.colorHex, border: '1px solid rgba(0,0,0,0.1)' }} />
          <span className="text-[12px] whitespace-nowrap">{u.color}</span>
        </div>
      </td>
      {/* from → to */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
          <span style={{ color: 'var(--muted)' }}>Gate</span>
          <ArrowRight size={12} style={{ color: 'var(--faint)' }} />
          <span className="font-semibold tabular" style={{ color: isParked ? 'var(--st-yard)' : 'var(--brand)' }}>
            {slotLabel(u)}
          </span>
        </div>
      </td>
      {/* date */}
      <td className="px-3 py-2.5 text-[12px] tabular whitespace-nowrap" style={{ color: 'var(--muted)' }}>
        {fmtDate(ts)}
      </td>
      {/* time */}
      <td className="px-3 py-2.5 text-[12px] tabular whitespace-nowrap font-semibold">
        {fmtTime(ts)}
      </td>
      {/* duration */}
      <td className="px-3 py-2.5 pr-4 text-[12px] tabular whitespace-nowrap" style={{ color: 'var(--muted)' }}>
        {isParked ? fmtDuration(u.drivingStartedAt, u.parkedAt) : (
          <span style={{ color: 'var(--brand)' }}>กำลังขับ…</span>
        )}
      </td>
    </tr>
  )
}

function DriverCard({ g, lang }: { g: DriverGroup; lang: 'th' | 'en' }) {
  const allUnits = [...g.driving, ...g.parked]
  const total = allUnits.length

  return (
    <div className="panel overflow-hidden">
      {/* driver header */}
      <div className="flex items-center gap-4 px-4 py-3 border-b hairline"
        style={{ background: 'var(--chip)' }}>
        <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-[15px] shrink-0"
          style={{ background: 'var(--brand)', color: '#fff' }}>
          {g.name.slice(0, 1)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-[14.5px]">{g.name}</div>
          <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
            ขับรถทั้งหมด {total} คัน
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {g.driving.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: 'var(--brand)' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'var(--brand)' }}>
                กำลังขับ {g.driving.length} คัน
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <CheckCircle2 size={14} style={{ color: 'var(--st-yard)' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'var(--st-yard)' }}>
              จอดแล้ว {g.parked.length} คัน
            </span>
          </div>
          <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
            ล่าสุด {fmtDate(g.lastActivity)} {fmtTime(g.lastActivity)}
          </div>
        </div>
      </div>

      {/* unit table */}
      <table className="w-full text-[12.5px] border-collapse">
        <thead>
          <tr style={{ background: 'var(--app-bg)' }}>
            {['', 'VIN', 'รุ่น', 'สี', 'จาก → ที่จอด', 'วันที่', 'เวลา', 'ระยะเวลา'].map(h => (
              <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold first:pl-4 last:pr-4"
                style={{ color: 'var(--faint)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allUnits.map(u => <UnitRow key={u.vin} u={u} lang={lang} />)}
        </tbody>
      </table>
    </div>
  )
}

export function Driver() {
  const lang  = useYard((s) => s.lang)
  const units = useUnits()

  const groups = useMemo(() => buildGroups(units), [units])

  const totalParked  = groups.reduce((s, g) => s + g.parked.length, 0)
  const totalDriving = groups.reduce((s, g) => s + g.driving.length, 0)
  const totalCars    = totalParked + totalDriving

  return (
    <div className="max-w-[1400px] mx-auto space-y-4">
      <PageHead title="กิจกรรมพนักงานขับรถ" sub="ติดตามการเคลื่อนย้ายรถของแต่ละคนขับ — ขับคันไหน จากไหน ไปที่ไหน เมื่อไหร่" />

      {/* KPI */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { icon: <User size={18} />,        label: 'คนขับ',          value: groups.length,  color: 'var(--brand)' },
          { icon: <Car size={18} />,         label: 'รถที่ขับทั้งหมด', value: totalCars,       color: 'var(--text)' },
          { icon: <Navigation size={18} />,  label: 'กำลังขับ',       value: totalDriving,   color: 'var(--brand)' },
          { icon: <CheckCircle2 size={18} />,label: 'จอดแล้ว',        value: totalParked,    color: 'var(--st-yard)' },
        ].map(k => (
          <div key={k.label} className="panel p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: `${k.color}18`, color: k.color }}>
              {k.icon}
            </div>
            <div>
              <div className="text-[11px] font-semibold mb-0.5" style={{ color: 'var(--muted)' }}>{k.label}</div>
              <div className="font-black text-[24px] tabular leading-none" style={{ color: k.color }}>
                {k.value.toLocaleString()}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* driver cards */}
      {groups.length === 0 ? (
        <div className="panel p-14 flex flex-col items-center justify-center text-center" style={{ color: 'var(--faint)' }}>
          <User size={40} className="mb-3" style={{ color: 'var(--line-strong)' }} />
          <div className="text-[14px] font-semibold" style={{ color: 'var(--muted)' }}>ยังไม่มีกิจกรรมพนักงานขับรถ</div>
          <div className="text-[12.5px] mt-1">เมื่อพนักงานสแกน VIN และนำรถไปจอด ข้อมูลจะแสดงที่นี่</div>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => <DriverCard key={g.name} g={g} lang={lang} />)}
        </div>
      )}
    </div>
  )
}
