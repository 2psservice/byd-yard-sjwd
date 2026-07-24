import { useEffect, useMemo, useRef, useState } from 'react'
import { Car, Hourglass, AlertTriangle, Truck, Activity, X, Search, LogOut } from 'lucide-react'
import { useYard, useUnits, useBlocks } from '../store/useYard'
import { useTrackingRows, useTracking } from '../store/useTracking'
import { makeT } from '../i18n'
import { modelById, matchModel, ZONE_COLOR } from '../lib/sampleData'
import { deriveCarStatus, CAR_STATUS_META, CAR_STATUS_ORDER, PARKED_STATUSES, isWaitingRepair } from '../lib/carStatus'
import { rowInSite } from '../lib/siteScope'
import { pct, pos, timeAgo } from '../lib/format'
import { defectLabel } from '../lib/damageLabel'
import { PageHead, ProgressBar, Stat } from '../components/ui'
import { YardSummary } from '../components/YardSummary'
import { STATUS_META } from '../lib/format'
import type { Unit } from '../types'

// ── VIN list popup ────────────────────────────────────────────────────────────
type PopupDef = { label: string; accent: string; units: Unit[] }

function VinPopup({ def, onClose }: { def: PopupDef; onClose: () => void }) {
  const lang = useYard(s => s.lang)
  const { setView, setFocus } = useYard()
  const [q, setQ] = useState('')

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const filtered = useMemo(() => {
    const qs = q.trim().toUpperCase()
    if (!qs) return def.units
    return def.units.filter(u =>
      u.vin.includes(qs) || u.modelName.toUpperCase().includes(qs) || (u.color ?? '').toUpperCase().includes(qs)
    )
  }, [def.units, q])

  const goUnit = (vin: string) => { setFocus(vin); setView('units'); onClose() }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="panel-solid glow-ring pop flex flex-col overflow-hidden w-full"
        style={{ maxWidth: 560, maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b hairline shrink-0"
          style={{ borderLeft: `4px solid ${def.accent}` }}>
          <div>
            <div className="font-bold display text-[16px]" style={{ color: def.accent }}>{def.label}</div>
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>{def.units.length} รายการ</div>
          </div>
          <button className="btn btn-ghost p-2" onClick={onClose}><X size={17} /></button>
        </div>

        {/* search */}
        <div className="px-4 py-3 border-b hairline shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
            <input
              autoFocus
              className="w-full h-9 pl-8 pr-3 rounded-lg text-[13px] outline-none"
              style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--text)' }}
              placeholder="ค้นหา VIN / รุ่น / สี…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
          </div>
        </div>

        {/* list */}
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-[13px]" style={{ color: 'var(--faint)' }}>ไม่พบรายการ</div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr style={{ background: 'var(--panel-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                  {['VIN', 'รุ่น', 'สี', 'สถานะ', 'ตำแหน่ง'].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 font-semibold" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line-strong)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((u, i) => {
                  const m = STATUS_META[u.status]
                  return (
                    <tr
                      key={u.vin}
                      onClick={() => goUnit(u.vin)}
                      className="cursor-pointer transition-colors"
                      style={{ background: i % 2 === 1 ? 'var(--panel-2)' : '#fff' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--brand-soft)')}
                      onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 1 ? 'var(--panel-2)' : '#fff')}
                    >
                      <td className="px-4 py-2.5 font-mono text-[12px] font-semibold" style={{ color: 'var(--brand)', letterSpacing: '0.04em' }}>
                        {u.vin}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--text)' }}>{u.modelName}</td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-1.5">
                          {u.colorHex && <span className="w-3 h-3 rounded-full border border-white/30 shrink-0" style={{ background: u.colorHex, boxShadow: '0 0 0 1px var(--line)' }} />}
                          <span style={{ color: 'var(--muted)' }}>{u.color ?? '—'}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="badge text-[11px]" style={{ color: m.color, background: m.bg, border: 'none' }}>
                          {lang === 'th' ? m.th : m.en}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11.5px]" style={{ color: 'var(--muted)' }}>
                        {u.block ? `${u.block}-${u.row}-${u.slot}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t hairline shrink-0 text-[11.5px]" style={{ color: 'var(--faint)' }}>
          คลิกแถวเพื่อไปที่ Unit List · กด Esc เพื่อปิด
        </div>
      </div>
    </div>
  )
}

// ── count-up hook ─────────────────────────────────────────────────────────────
function useCountUp(target: number, ms = 700) {
  const [v, setV] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms)
      const e = 1 - Math.pow(1 - p, 3)
      setV(a + (target - a) * e)
      if (p < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return Math.round(v)
}

function Num({ n }: { n: number }) {
  return <>{useCountUp(n).toLocaleString()}</>
}

export function Dashboard() {
  const lang = useYard((s) => s.lang)
  const setView = useYard((s) => s.setView)
  const setUnitPreset = useYard((s) => s.setUnitPreset)
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const allUnits = useUnits()
  const blocks = useBlocks()
  const allTrackingRows = useTrackingRows()
  const loadFromIdb = useTracking((st) => st.loadFromIdb)
  useEffect(() => { loadFromIdb() }, [loadFromIdb])
  // per-yard separation: the whole dashboard reflects only the active site
  const trackingRows = useMemo(
    () => (currentSite ? allTrackingRows.filter((r) => rowInSite(r, currentSite, sites)) : allTrackingRows),
    [allTrackingRows, currentSite, sites],
  )
  const units = useMemo(
    () => (currentSite ? allUnits.filter((u) => u.site === currentSite) : allUnits),
    [allUnits, currentSite],
  )
  const fromTracking = trackingRows.length > 0
  const t = makeT(lang)
  const [popup, setPopup] = useState<PopupDef | null>(null)

  const s = useMemo(() => {
    // ── real imported data (tracking rows) — driven by Car Status ──
    if (fromTracking) {
      let inYard = 0, parked = 0, gatein = 0, expected = 0, preGateOut = 0, preload = 0, damaged = 0
      const byStatus = new Map<string, number>()
      const byModel = new Map<string, number>()
      for (const r of trackingRows) {
        const cs = deriveCarStatus(r.cells)
        byStatus.set(cs, (byStatus.get(cs) ?? 0) + 1)
        const mod = (r.cells['Model'] || r.cells['Model name'] || '—').trim() || '—'
        byModel.set(mod, (byModel.get(mod) ?? 0) + 1)
        if (cs === 'Pre Gate-in') expected++
        else if (cs === 'Pre Gate-out') preGateOut++   // ops-scan gate-out, awaiting 09:30 flush
        else if (cs === 'Preload') preload++            // confirmed still on-site in preload lane
        else if (cs !== 'Gate-out') {                   // actively in the yard
          inYard++
          if (cs === 'Gate-in') gatein++
          if (PARKED_STATUSES.has(cs)) parked++
          // "Damage" KPI counts cars waiting repair that are IN YARD only — so it
          // matches the Summary table's "Waiting Repair" column (also in-yard scoped)
          if (isWaitingRepair(r.cells)) damaged++
        }
      }
      const mix = [...byModel.entries()].map(([m, n]) => ({ m, n })).sort((a, b) => b.n - a.n).slice(0, 8)
      const statusBreakdown = CAR_STATUS_ORDER.map((st) => ({ st, n: byStatus.get(st) ?? 0 })).filter((x) => x.n > 0)
      return { total: trackingRows.length, inYard, parked, gatein, expected, preGateOut, preload, damaged, occupied: parked, cap: inYard, mix, byZone: [] as [string, { used: number; cap: number }][], statusBreakdown }
    }

    // ── sample / operational fallback ──
    const inYard = units.filter((u) => ['GATE_IN', 'ASSIGNED', 'PARKED'].includes(u.status))
    const occupied = units.filter((u) => ['ASSIGNED', 'PARKED', 'LOADED'].includes(u.status) && u.block)
    const cap = blocks.reduce((a, b) => a + b.rows * b.cols, 0)
    const byModel = new Map<string, number>()
    inYard.forEach((u) => byModel.set(u.model, (byModel.get(u.model) ?? 0) + 1))
    const mix = [...byModel.entries()].map(([m, n]) => ({ m, n })).sort((a, b) => b.n - a.n)
    const byZone = new Map<string, { used: number; cap: number }>()
    blocks.forEach((b) => {
      const z = byZone.get(b.zone) ?? { used: 0, cap: 0 }
      z.cap += b.rows * b.cols
      byZone.set(b.zone, z)
    })
    occupied.forEach((u) => {
      const b = blocks.find((x) => x.id === u.block)
      if (!b) return
      const z = byZone.get(b.zone)!
      z.used += 1
    })
    return {
      total: units.length,
      inYard: inYard.length,
      parked: units.filter((u) => u.status === 'PARKED').length,
      gatein: units.filter((u) => u.status === 'GATE_IN').length,
      expected: units.filter((u) => u.status === 'EXPECTED').length,
      preGateOut: 0,
      preload: units.filter((u) => u.status === 'LOADED').length,
      damaged: units.filter((u) => u.damages.length > 0).length,
      occupied: occupied.length,
      cap,
      mix,
      byZone: [...byZone.entries()],
      statusBreakdown: [] as { st: string; n: number }[],
    }
  }, [fromTracking, trackingRows, units, blocks])

  // VINs that are real (from Excel) — used to exclude sample units from live events
  const trackingVins = useMemo(() => new Set(trackingRows.map(r => r.vin)), [trackingRows])

  const events = useMemo(() => {
    type Ev = { ts: number; vin: string; kind: string; text: string; color: string }
    const evs: Ev[] = []
    if (fromTracking) {
      // Gate-in events from tracking rows (Gate In Time = epoch ms saved at scan)
      for (const r of trackingRows) {
        const gateTs = parseInt(r.cells['Gate In Time'] ?? '0')
        if (gateTs > 0) {
          const insp = r.cells['Gate In Inspector'] ?? ''
          evs.push({ ts: gateTs, vin: r.vin, kind: 'gate', text: `เข้าลาน (Gate-in)${insp ? ` · ${insp}` : ''}`, color: 'var(--brand-2)' })
        }
      }
      // Parked / assigned / damage only for real VINs (not sample)
      for (const u of units) {
        if (!trackingVins.has(u.vin)) continue
        if (u.parkedAt) evs.push({ ts: u.parkedAt, vin: u.vin, kind: 'park', text: `จอดสำเร็จ · ${pos(u)}`, color: 'var(--st-yard)' })
        else if (u.assignedAt) evs.push({ ts: u.assignedAt, vin: u.vin, kind: 'assign', text: `รับตำแหน่ง · ${pos(u)}`, color: 'var(--st-driving)' })
        u.damages.forEach(d => evs.push({ ts: d.at, vin: u.vin, kind: 'dmg', text: `พบ Defect · ${defectLabel(d, 'th')}`, color: 'var(--st-damage)' }))
      }
    } else {
      for (const u of units) {
        if (u.parkedAt) evs.push({ ts: u.parkedAt, vin: u.vin, kind: 'park', text: `จอดสำเร็จ · ${pos(u)}`, color: 'var(--st-yard)' })
        else if (u.assignedAt) evs.push({ ts: u.assignedAt, vin: u.vin, kind: 'assign', text: `รับตำแหน่ง · ${pos(u)}`, color: 'var(--st-driving)' })
        if (u.gateInAt && !u.parkedAt && !u.assignedAt) evs.push({ ts: u.gateInAt, vin: u.vin, kind: 'gate', text: `เข้าลาน (Gate-in)`, color: 'var(--brand-2)' })
        u.damages.forEach(d => evs.push({ ts: d.at, vin: u.vin, kind: 'dmg', text: `พบ Defect · ${defectLabel(d, 'th')}`, color: 'var(--st-damage)' }))
      }
    }
    return evs.sort((a, b) => b.ts - a.ts).slice(0, 9)
  }, [fromTracking, trackingRows, units, trackingVins])

  const fill = fromTracking ? pct(s.inYard, s.total) : pct(s.occupied, s.cap)

  const openPopup = (label: string, accent: string, filter: (u: Unit) => boolean) =>
    setPopup({ label, accent, units: units.filter(filter) })
  // imported data is row-based (not Unit) → jump to the Unit List, pre-filtered by
  // the card's preset (setView clears it first, so we set it right after)
  const kpiClick = (label: string, accent: string, filter: (u: Unit) => boolean, preset: string) =>
    fromTracking ? () => { setView('units'); setUnitPreset(preset) } : () => openPopup(label, accent, filter)

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHead
        title={t('dashboard')}
        sub={`${new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`}
        right={<LiveClock />}
      />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
        <Stat label={t('inYard')} value={<Num n={s.inYard} />} accent="var(--brand)" icon={<Car size={17} />}
          sub={`${t('total')} ${s.total}`} image="/side.png" imageVariant="side"
          onClick={kpiClick(t('inYard'), 'var(--brand)', u => ['GATE_IN','ASSIGNED','PARKED'].includes(u.status), 'inYard')} />
        <Stat label={t('expected')} value={<Num n={s.expected} />} accent="var(--st-pending)" icon={<Hourglass size={17} />}
          sub={lang === 'th' ? 'ยังไม่เข้าลาน' : 'not arrived'} image="/car-top.png" imageVariant="top"
          onClick={kpiClick(t('expected'), 'var(--st-pending)', u => u.status === 'EXPECTED', 'expected')} />
        <Stat label="Pre Gate-out" value={<Num n={s.preGateOut} />} accent="#f59e0b" icon={<LogOut size={17} />}
          sub={lang === 'th' ? 'รอออก (flush 09:30)' : 'awaiting 09:30'} image="/car-top.png" imageVariant="top"
          onClick={kpiClick('Pre Gate-out', '#f59e0b', () => false, 'preGateOut')} />
        <Stat label="Preload" value={<Num n={s.preload} />} accent="#0d9488" icon={<Truck size={17} />}
          sub={lang === 'th' ? 'จอดรอรถมารับ' : 'in preload'} image="/side.png" imageVariant="side"
          onClick={kpiClick('Preload', '#0d9488', u => u.status === 'LOADED', 'preload')} />
        <Stat label={t('damaged')} value={<Num n={s.damaged} />} accent="var(--st-damage)" icon={<AlertTriangle size={17} />}
          sub={lang === 'th' ? 'รอซ่อม' : 'waiting repair'} image="/wrench.png" imageVariant="top"
          onClick={kpiClick(t('damaged'), 'var(--st-damage)', u => u.damages.length > 0, 'damage')} />
      </div>

      {popup && <VinPopup def={popup} onClose={() => setPopup(null)} />}

      {/* ── Summary: Model × Final Status (คลิกตัวเลขเพื่อดู VIN) ── */}
      <YardSummary />

      <div className="grid lg:grid-cols-3 gap-4">
        {/* yard fill / car-status breakdown */}
        <div className="panel p-5 fade-up">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold display">{fromTracking ? (lang === 'th' ? 'สถานะรถ' : 'Car Status') : t('yardFill')}</h3>
            <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
              {fromTracking ? `${s.inYard.toLocaleString()} / ${s.total.toLocaleString()}` : `${s.occupied.toLocaleString()} / ${s.cap.toLocaleString()}`}
            </span>
          </div>
          <div className="flex items-center justify-center gap-3 my-3">
            {fromTracking && (
              <div className="relative flex flex-col items-center shrink-0">
                <img src="/front.png" alt="" style={{ width: 88, filter: 'drop-shadow(0 5px 7px rgba(20,40,80,0.22))' }} />
                {/* ground shadow */}
                <span style={{ width: 60, height: 6, marginTop: -1, borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(20,40,80,0.18), transparent 70%)' }} />
              </div>
            )}
            <Ring value={fill} label={fromTracking ? (lang === 'th' ? 'อยู่ในลาน' : 'in yard') : 'capacity used'} />
          </div>
          <div className="space-y-2.5 mt-2">
            {fromTracking
              ? s.statusBreakdown.map(({ st, n }) => {
                  const meta = CAR_STATUS_META[st] || { bg: 'var(--muted)' }
                  return (
                    <div key={st}>
                      <div className="flex items-center justify-between text-[12px] mb-1">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: meta.bg }} /> {st}</span>
                        <span className="tabular" style={{ color: 'var(--muted)' }}>{n.toLocaleString()}</span>
                      </div>
                      <div className="track"><div className="fill" style={{ width: `${(n / s.total) * 100}%`, background: meta.bg }} /></div>
                    </div>
                  )
                })
              : s.byZone.map(([z, d]) => (
                  <div key={z}>
                    <div className="flex items-center justify-between text-[12px] mb-1">
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: ZONE_COLOR[z as 'Y'] }} /> Zone {z}</span>
                      <span className="tabular" style={{ color: 'var(--muted)' }}>{d.used}/{d.cap}</span>
                    </div>
                    <ProgressBar value={d.used} max={d.cap} color={ZONE_COLOR[z as 'Y']} />
                  </div>
                ))}
          </div>
        </div>

        {/* model mix */}
        <div className="panel p-5 fade-up">
          <h3 className="font-semibold display mb-3">{t('modelMix')}</h3>
          <div className="space-y-2.5">
            {s.mix.length === 0 && <Empty />}
            {s.mix.map(({ m, n }) => {
              const md = fromTracking ? matchModel(m) : modelById(m)
              const max = s.mix[0]?.n || 1
              return (
                <div key={m}>
                  <div className="flex items-center justify-between text-[12.5px] mb-1">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: md?.color }} /> {fromTracking ? m : (md?.name ?? m)}</span>
                    <span className="tabular font-semibold">{n}</span>
                  </div>
                  <div className="track"><div className="fill" style={{ width: `${(n / max) * 100}%`, background: md?.color }} /></div>
                </div>
              )
            })}
          </div>
        </div>

        {/* live activity */}
        <div className="flex flex-col gap-4">
          <div className="panel p-5 fade-up flex-1">
            <h3 className="font-semibold display flex items-center gap-2 mb-3"><Activity size={16} style={{ color: 'var(--brand)' }} /> {t('liveActivity')}</h3>
            <div className="space-y-2.5">
              {events.length === 0 && <Empty />}
              {events.map((e, i) => (
                <div key={i} className="flex items-center gap-2.5 text-[12.5px]">
                  <span className="dot mt-0.5" style={{ background: e.color }} />
                  <span className="vin" style={{ color: 'var(--text)' }}>{e.vin.slice(-6)}</span>
                  <span style={{ color: 'var(--muted)' }} className="clip flex-1">{e.text}</span>
                  <span className="tabular shrink-0" style={{ color: 'var(--faint)' }}>{timeAgo(e.ts, lang)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Ring({ value, label = 'capacity used' }: { value: number; label?: string }) {
  const r = 64
  const c = 2 * Math.PI * r
  const off = c - (value / 100) * c
  return (
    <div className="relative" style={{ width: 168, height: 168 }}>
      <svg width="168" height="168" className="-rotate-90">
        <circle cx="84" cy="84" r={r} fill="none" stroke="#e5e8ee" strokeWidth="13" />
        <circle cx="84" cy="84" r={r} fill="none" stroke="url(#g)" strokeWidth="13" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} style={{ transition: 'stroke-dashoffset 0.9s cubic-bezier(.22,1,.36,1)' }} />
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--brand-2)" /><stop offset="1" stopColor="var(--brand)" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="display text-[34px] font-bold tabular"><Num n={value} />%</span>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{label}</span>
      </div>
    </div>
  )
}

function LiveClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const i = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(i) }, [])
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    <div className="text-right">
      <div className="display text-[26px] font-bold tabular leading-none">{p(now.getHours())}:{p(now.getMinutes())}<span style={{ color: 'var(--faint)' }}>:{p(now.getSeconds())}</span></div>
      <div className="text-[11px] mt-1 flex items-center gap-1.5 justify-end" style={{ color: 'var(--st-yard)' }}><span className="live">●</span> SJWD Yard Control</div>
    </div>
  )
}

function Empty() {
  return <div className="text-[13px] py-6 text-center" style={{ color: 'var(--faint)' }}>— ยังไม่มีข้อมูล · โหลดตัวอย่างที่หน้า Import —</div>
}

export type { Unit }
