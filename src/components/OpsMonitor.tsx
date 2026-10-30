/**
 * มอนิเตอร์หน้างาน (แท็บแรกของหน้า Operation) — แอดมินดูคิวงานของสถานีแบบสด ตามที่หน้างานกดบันทึก
 * ด้านบน "งานหน้างาน" = หนึ่งแถวต่อรถหนึ่งคัน บอกขั้นที่อยู่ ใครทำ เมื่อไร นานเท่าไร (แบบ Point of Work ของ SPARCS)
 * ด้านล่าง "พนักงาน" = ใครกำลังขับคันไหน และวันนี้ทำอะไรไปแล้ว (แบบ Pool & Equipment)
 * กติกาสถานะ / ค้าง อยู่ใน lib/opsMonitor.ts
 */
import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Search, Truck, UserRound, X } from 'lucide-react'
import { useOps, useActiveQueues, type QueueType } from '../store/useOps'
import { useTrackingRows } from '../store/useTracking'
import { useYard, useUnits } from '../store/useYard'
import { yardLocCode, yardLocFull } from '../lib/groupingImport'
import { JOB_STATUS_META, STUCK_MS, TYPE_BADGE, fmtElapsed, isStationQueue, monitorJobs, staffCards, type MonitorJob } from '../lib/opsMonitor'
import { Segmented } from './ui'

type StatusFilter = 'all' | 'active' | 'queued' | 'done' | 'stuck'
const OFF_KEY = 'sjwd-ops-monitor-off'

const readOff = (): QueueType[] => { try { return JSON.parse(localStorage.getItem(OFF_KEY) || '[]') } catch { return [] } }
const p2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}` }
const stamp = (ms: number, dayStart: number) => {
  if (!ms) return '—'
  if (ms >= dayStart) return hhmm(ms)
  const d = new Date(ms)
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${hhmm(ms)}`
}
const midnight = (now: number) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

export function OpsMonitor({ onOpenQueue }: { onOpenQueue: (id: string) => void }) {
  const all = useActiveQueues()
  const closed = useOps((s) => s.closed)
  const currentSite = useYard((s) => s.currentSite)
  const rows = useTrackingRows()
  const units = useUnits()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  const dayStart = midnight(now)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [q, setQ] = useState('')
  const [off, setOff] = useState<QueueType[]>(readOff)
  const toggleType = (t: QueueType) => setOff((cur) => {
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    try { localStorage.setItem(OFF_KEY, JSON.stringify(next)) } catch { /* private mode — filter still works this session */ }
    return next
  })

  const queues = useMemo(() => all.filter((x) => isStationQueue(x, currentSite)), [all, currentSite])
  const jobs = useMemo(() => monitorJobs(queues, closed, dayStart, now), [queues, closed, dayStart, now])
  const staff = useMemo(() => staffCards(queues, jobs, dayStart), [queues, jobs, dayStart])
  const rowByVin = useMemo(() => new Map(rows.map((r) => [r.vin, r])), [rows])
  const unitByVin = useMemo(() => new Map(units.map((u) => [u.vin, u])), [units])

  const typeCounts = useMemo(() => {
    const m = new Map<QueueType, number>()
    for (const j of jobs) m.set(j.type, (m.get(j.type) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [jobs])
  const typed = useMemo(() => jobs.filter((j) => !off.includes(j.type)), [jobs, off])
  const counts = useMemo(() => {
    const c = { active: 0, queued: 0, done: 0, stuck: 0, driving: 0, atStation: 0, checked: 0 }
    for (const j of typed) {
      if (JOB_STATUS_META[j.status].active) c.active++
      if (j.status === 'queued') c.queued++
      if (j.status === 'done') c.done++
      if (j.stuck) c.stuck++
      if (j.status === 'driving-in' || j.status === 'driving-back') c.driving++
      if (j.status === 'at-station') c.atStation++
      if (j.status === 'checked') c.checked++
    }
    return c
  }, [typed])
  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase()
    return typed.filter((j) =>
      (status === 'all' || (status === 'active' ? JOB_STATUS_META[j.status].active : status === 'stuck' ? j.stuck : j.status === status))
      && (!needle || j.item.vin.includes(needle)))
  }, [typed, status, q])

  const locOf = (vin: string) => { const u = unitByVin.get(vin); return yardLocFull(u) || yardLocCode(u) || '' }
  /** จาก / ไป ตามขั้นที่รถอยู่ — สถานี = ชื่อประเภทคิว */
  const route = (j: MonitorJob): [string, string] => {
    const st = TYPE_BADGE[j.type].th
    switch (j.status) {
      case 'queued': case 'driving-in': return [locOf(j.item.vin) || '—', st]
      case 'at-station': return [j.item.fromSlot || '—', st]
      case 'checked': case 'driving-back': return [st, 'ช่องจอด']
      default: return [st, locOf(j.item.vin) || '—']
    }
  }

  const statusChip = (label: string, n: number, f: StatusFilter, color: string) => (
    <button onClick={() => setStatus(status === f ? 'all' : f)} data-ops-count={f}
      className="panel px-3.5 py-2.5 text-left transition-all" aria-pressed={status === f}
      style={status === f ? { outline: `2px solid ${color}`, outlineOffset: -2 } : undefined}>
      <div className="text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>{label}</div>
      <div className="display text-[24px] font-black tabular leading-tight" style={{ color }}>{n.toLocaleString()}</div>
    </button>
  )

  return (
    <div className="space-y-4" data-ops-monitor>
      {/* สรุปตามสถานะ — กดเพื่อกรองตาราง */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {statusChip('กำลังทำ', counts.active, 'active', '#b45309')}
        {statusChip('รอย้าย', counts.queued, 'queued', '#64748b')}
        {statusChip('เสร็จวันนี้', counts.done, 'done', 'var(--st-yard)')}
        {statusChip(`ค้างเกิน ${STUCK_MS / 3_600_000} ชม.`, counts.stuck, 'stuck', '#dc2626')}
        <div className="panel px-3.5 py-2.5 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          <div>กำลังขับ <b style={{ color: '#b45309' }}>{counts.driving}</b></div>
          <div>ถึงสถานี รอตรวจ <b style={{ color: '#0369a1' }}>{counts.atStation}</b></div>
          <div>ตรวจแล้ว รอขับกลับ <b style={{ color: '#15803d' }}>{counts.checked}</b></div>
        </div>
      </div>

      {/* งานหน้างาน */}
      <div className="panel overflow-hidden">
        <div className="px-3 py-2.5 flex items-center gap-2 flex-wrap border-b hairline">
          <Activity size={15} style={{ color: 'var(--brand)' }} />
          <span className="text-[13px] font-bold">งานหน้างาน</span>
          <div className="flex flex-wrap gap-1.5 ml-2">
            {typeCounts.map(([t, n]) => {
              const b = TYPE_BADGE[t], on = !off.includes(t)
              return (
                <button key={t} onClick={() => toggleType(t)} aria-pressed={on} data-ops-type={t}
                  className="px-2 py-0.5 rounded-md text-[11.5px] font-bold"
                  style={on ? { color: b.color, background: b.bg, border: `1px solid ${b.color}55` } : { color: 'var(--faint)', background: 'transparent', border: '1px dashed var(--line)' }}>
                  {b.th} · {n}
                </button>
              )
            })}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Segmented<StatusFilter> value={status} onChange={setStatus}
              options={[{ value: 'all', label: 'ทั้งหมด' }, { value: 'active', label: 'กำลังทำ' }, { value: 'queued', label: 'รอย้าย' }, { value: 'done', label: 'เสร็จวันนี้' }, { value: 'stuck', label: 'ค้าง' }]} />
            <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl" style={{ background: 'var(--chip)' }}>
              <Search size={13} style={{ color: 'var(--muted)' }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา VIN" aria-label="ค้นหา VIN"
                className="bg-transparent outline-none text-[12.5px] w-32 vin" />
              {q && <button onClick={() => setQ('')} aria-label="ล้างคำค้น"><X size={13} style={{ color: 'var(--muted)' }} /></button>}
            </label>
          </div>
        </div>
        <div className="overflow-auto" style={{ maxHeight: '62vh' }}>
          <table className="w-full text-[12px] tabular" style={{ minWidth: 1100 }} data-ops-jobs>
            <thead className="sticky top-0 z-[1]">
              <tr style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                {['#', 'ประเภท', 'VIN', 'รุ่น', 'สี', 'คิวงาน', 'จาก', 'ไป', 'สถานะ', 'คนทำ', 'เวลา', 'นาน'].map((h) => (
                  <th key={h} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={12} className="py-8 text-center" style={{ color: 'var(--faint)' }}>
                  {jobs.length ? 'ไม่มีงานตามตัวกรองนี้' : 'ยังไม่มีงานของสถานีในยาร์ดนี้ — สร้างคิวงานได้ที่แท็บ "คิวงาน"'}
                </td></tr>
              )}
              {shown.map((j, n) => {
                const meta = JOB_STATUS_META[j.status]
                const r = rowByVin.get(j.item.vin)
                const u = unitByVin.get(j.item.vin)
                const [from, to] = route(j)
                const b = TYPE_BADGE[j.type]
                const elapsed = j.status === 'done' ? '' : fmtElapsed(now - j.since)
                return (
                  <tr key={j.key} onClick={() => onOpenQueue(j.queue.id)} className="cursor-pointer hover:bg-chip"
                    data-ops-job={j.item.vin} data-ops-status={j.status} data-ops-stuck={j.stuck || undefined}
                    style={{ borderTop: '1px solid var(--line)', boxShadow: `inset 3px 0 0 ${j.stuck ? '#dc2626' : meta.color}`, background: j.stuck ? 'rgba(220,38,38,0.06)' : undefined, opacity: j.status === 'done' ? 0.62 : 1 }}>
                    <td className="px-2 py-1.5" style={{ color: 'var(--faint)' }}>{n + 1}</td>
                    <td className="px-2 py-1.5"><span className="px-1.5 py-0.5 rounded text-[11px] font-bold whitespace-nowrap" style={{ color: b.color, background: b.bg }}>{b.th}</span></td>
                    <td className="px-2 py-1.5 mono font-semibold whitespace-nowrap">{j.item.vin}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r?.cells['Model'] || r?.cells['Model name'] || u?.modelName || '—'}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r?.cells['Color'] || u?.color || '—'}</td>
                    <td className="px-2 py-1.5 max-w-[180px] truncate" title={j.queue.name} style={{ color: 'var(--muted)' }}>{j.queue.name}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-semibold">{from}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-semibold">{to}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="font-bold" style={{ color: meta.color }}>{meta.th}</span>
                      {j.item.result && (j.status === 'checked' || j.status === 'driving-back' || j.status === 'done') && (
                        <span className="ml-1.5 px-1.5 rounded text-[10.5px] font-bold" style={j.item.result === 'OK' ? { color: '#15803d', background: 'rgba(22,163,74,0.14)' } : { color: '#b91c1c', background: 'rgba(220,38,38,0.12)' }}>{j.item.result}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{j.by || '—'}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{stamp(j.since, dayStart)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap font-bold" style={{ color: j.stuck ? '#dc2626' : 'var(--muted)' }}>
                      {j.stuck && <AlertTriangle size={12} className="inline -mt-0.5 mr-1" />}{elapsed}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* พนักงาน */}
      <div className="panel p-3" data-ops-staff>
        <div className="flex items-center gap-2 mb-2.5">
          <UserRound size={15} style={{ color: 'var(--brand)' }} />
          <span className="text-[13px] font-bold">พนักงาน</span>
          <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>ใครกำลังขับคันไหน และวันนี้ทำอะไรไปแล้ว</span>
        </div>
        {staff.length === 0 ? (
          <div className="py-5 text-center text-[12.5px]" style={{ color: 'var(--faint)' }}>วันนี้ยังไม่มีการบันทึกจากหน้างาน</div>
        ) : (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {staff.map((s) => {
              const d = s.driving
              const [df, dt] = d ? route(d) : ['', '']
              return (
                <div key={s.name} className="rounded-xl p-2.5" style={{ background: 'var(--chip)' }} data-ops-person={s.name}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-[13px] truncate">{s.name}</span>
                    <span className="ml-auto text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--muted)' }}>วันนี้ {s.events.length} งาน</span>
                  </div>
                  {d && (
                    <div className="mt-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-semibold flex items-center gap-1.5 flex-wrap"
                      style={{ background: d.stuck ? 'rgba(220,38,38,0.1)' : 'rgba(217,119,6,0.12)', color: d.stuck ? '#b91c1c' : '#b45309' }} data-ops-driving={d.item.vin}>
                      <Truck size={13} /> กำลังขับ <span className="mono">{d.item.vin.slice(-6)}</span> · {df} ไป {dt} · {fmtElapsed(now - d.since)}
                    </div>
                  )}
                  <div className="mt-1.5 space-y-0.5">
                    {s.events.slice(0, 6).map((e, k) => (
                      <div key={k} className="text-[11.5px] flex gap-2" style={{ color: 'var(--muted)' }}>
                        <span className="tabular shrink-0" style={{ color: 'var(--text)' }}>{hhmm(e.at)}</span>
                        <span className="truncate">{e.text}</span>
                        <span className="mono shrink-0 ml-auto">{e.vin.slice(-6)}</span>
                      </div>
                    ))}
                    {s.events.length > 6 && <div className="text-[11px]" style={{ color: 'var(--faint)' }}>และอีก {s.events.length - 6} งาน</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
