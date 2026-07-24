import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  X, Car, Clock, MapPin, ShieldCheck, ClipboardList, Navigation, Truck,
  Download, User, AlertTriangle, CheckCircle2, Hourglass, PackageCheck,
} from 'lucide-react'
import { useYard } from '../store/useYard'
import { CarTopView } from './CarTopView'
import { clock, pos, tState, CATEGORY_META, STATUS_META } from '../lib/format'
import { modelById } from '../lib/sampleData'
import { zoneLabel } from '../pages/GateIn'
import type { Unit, UnitStatus } from '../types'

const GLOW: Record<UnitStatus, string> = {
  EXPECTED: '#eab308', GATE_IN: '#22d3ee', ASSIGNED: '#3b82f6',
  PARKED: '#22c55e', LOADED: '#a855f7', DEPARTED: '#64748b',
}

type Tab = 'overview' | 'timeline' | 'location' | 'damages'

export function UnitDetail({ vin, onClose }: { vin: string | null; onClose: () => void }) {
  const lang = useYard((s) => s.lang)
  const unit = useYard((s) => (vin ? s.units[vin] : undefined))
  const [tab, setTab] = useState<Tab>('overview')

  useEffect(() => { setTab('overview') }, [vin])
  useEffect(() => {
    if (!vin) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [vin, onClose])

  const events = useMemo(() => buildEvents(unit, lang), [unit, lang])

  if (!vin || !unit) return null
  const glow = GLOW[unit.status]
  const ts = tState(unit.status)
  const cat = CATEGORY_META[unit.category ?? 'EXPORT']

  const tabs: { id: Tab; label: string; icon: ReactNode; badge?: number }[] = [
    { id: 'overview', label: 'Overview', icon: <Car size={15} /> },
    { id: 'timeline', label: lang === 'th' ? 'ไทม์ไลน์' : 'Timeline', icon: <Clock size={15} />, badge: events.length },
    { id: 'location', label: lang === 'th' ? 'ประวัติตำแหน่ง' : 'Location History', icon: <MapPin size={15} /> },
    { id: 'damages', label: lang === 'th' ? 'ตำหนิ' : 'Damages', icon: <ShieldCheck size={15} />, badge: unit.damages.length || undefined },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 md:p-6"
      style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid glow-ring pop w-full overflow-hidden flex flex-col"
        style={{ maxWidth: 940, maxHeight: '94vh' }} onClick={(e) => e.stopPropagation()}>

        {/* ---- header (dark) ---- */}
        <div className="flex items-center gap-3 px-5 py-3.5 shrink-0"
          style={{ background: 'linear-gradient(120deg, #0c1a2e, #122845)' }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
            <Car size={20} style={{ color: '#cfe0f5' }} />
          </div>
          <div className="min-w-0">
            <div className="vin font-bold text-[18px] leading-tight clip" style={{ color: '#f3f8ff' }}>{unit.vin}</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[12.5px]" style={{ color: '#9fb4d0' }}>{unit.modelName.replace('BYD ', '')} ·</span>
              <span className="badge" style={{ color: ts.color, background: '#ffffff', borderColor: 'transparent' }}>{lang === 'th' ? ts.th : ts.key}</span>
            </div>
          </div>
          <button className="ml-auto p-2 rounded-lg transition" style={{ color: '#9fb4d0' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={onClose}><X size={19} /></button>
        </div>

        {/* ---- tabs ---- */}
        <div className="flex items-center gap-1 px-3 border-b hairline shrink-0" style={{ background: '#fff' }}>
          {tabs.map((tb) => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className="flex items-center gap-1.5 px-3.5 py-3 text-[13.5px] font-medium relative transition"
              style={tab === tb.id ? { color: 'var(--brand)' } : { color: 'var(--muted)' }}>
              {tb.icon} {tb.label}
              {tb.badge != null && (
                <span className="text-[10.5px] font-bold px-1.5 rounded-full tabular"
                  style={{ background: tab === tb.id ? 'var(--brand-soft)' : 'var(--chip)', color: tab === tb.id ? 'var(--brand)' : 'var(--muted)' }}>{tb.badge}</span>
              )}
              {tab === tb.id && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: 'var(--brand)' }} />}
            </button>
          ))}
        </div>

        {/* ---- body ---- */}
        <div className="overflow-auto p-4 md:p-5 flex-1" style={{ background: 'var(--app-bg)' }}>
          {tab === 'overview' && <Overview unit={unit} glow={glow} cat={cat} lang={lang} />}
          {tab === 'timeline' && <TimelineTab events={events} />}
          {tab === 'location' && <LocationTab unit={unit} lang={lang} />}
          {tab === 'damages' && <DamagesTab unit={unit} lang={lang} />}
        </div>

        {/* ---- footer ---- */}
        <div className="flex items-center justify-between px-5 py-2 border-t hairline shrink-0 text-[11.5px]" style={{ background: '#fff', color: 'var(--muted)' }}>
          <span className="flex items-center gap-1.5"><ClipboardList size={12} /> {lang === 'th' ? `บันทึกการตรวจสอบ: ${events.length} เหตุการณ์` : `Audit log: ${events.length} events tracked`}</span>
          <span>VIN: <span className="vin">{unit.vin}</span></span>
        </div>
      </div>
    </div>
  )
}

/* ========================= Overview ========================= */
function Overview({ unit, glow, cat, lang }: { unit: Unit; glow: string; cat: { th: string; en: string; color: string; bg: string }; lang: 'th' | 'en' }) {
  const sm = STATUS_META[unit.status]
  return (
    <div className="space-y-4 fade-up">
      {/* hero (dark) */}
      <div className="rounded-2xl p-5 relative overflow-hidden"
        style={{ background: '#0a1626', border: '1px solid #16273f' }}>
        <div className="absolute pointer-events-none" style={{ right: -40, top: -30, width: 360, height: 360, background: `radial-gradient(circle, ${glow}40, transparent 65%)` }} />
        <div className="flex items-start justify-between gap-4 relative">
          {/* fields */}
          <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 min-w-0">
            <HeroRow label="MODEL" value={unit.modelName} />
            <HeroRow label="CATEGORY" value={lang === 'th' ? cat.th : cat.en} color={glowText(cat.color)} />
            <HeroRow label="COLOR" value={unit.color} swatch={unit.colorHex} />
            <HeroRow label="VARIANT" value={unit.variant ?? '—'} />
            <HeroRow label={lang === 'th' ? 'หาง / TRAILER' : 'TRAILER'} value={`#${unit.trailer}`} />
            <HeroRow label="LOT" value={unit.lot ?? '—'} color="#7fb4ff" />
            <HeroRow label="DRIVER" value={unit.driver ?? '—'} />
            <HeroRow label="RECORDED BY" value={unit.gateInBy ?? '—'} />
            <HeroRow label="GATE-IN" value={unit.gateInAt ? clock(unit.gateInAt) : '—'} />
            <HeroRow label="PARKED" value={unit.parkedAt ? clock(unit.parkedAt) : '—'} />
          </div>

          {/* car + pills */}
          <div className="flex flex-col items-end shrink-0">
            <div className="vin text-[12px] mb-1" style={{ color: '#9fb4d0' }}>{unit.vin}</div>
            <span className="badge mb-2" style={{ color: glowText(glow), background: `${glow}1f`, borderColor: `${glow}55` }}>
              <span className="dot live" style={{ background: glow }} /> {unit.status}
            </span>
            <div style={{ width: 132 }}><CarTopView color={unit.colorHex ?? '#cfd6dd'} width={132} /></div>
            <span className="badge mt-1" style={{ color: '#eaf1fb', background: 'rgba(0,0,0,0.35)', borderColor: `${glow}66` }}>
              <MapPin size={11} style={{ color: glow }} /> {unit.block ? pos(unit) : (lang === 'th' ? 'ยังไม่จอด' : 'unparked')}
            </span>
          </div>
        </div>
      </div>

      {/* quick stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="STATUS" value={lang === 'th' ? sm.th : sm.en} active accent={sm.color} />
        <StatCard label="POSITION" value={unit.block ? pos(unit) : '—'} mono />
        <StatCard label="DRIVER" value={unit.driver ?? '—'} />
      </div>

      {/* vehicle info */}
      <Section icon={<ClipboardList size={15} />} title={lang === 'th' ? 'ข้อมูลรถ (Manifest)' : 'Vehicle Information'}>
        <Field label="MODEL" value={unit.modelName} />
        <Field label="COLOR" value={unit.color} swatch={unit.colorHex} />
        <Field label="CATEGORY" value={lang === 'th' ? cat.th : cat.en} color={cat.color} />
        <Field label={lang === 'th' ? 'รุ่นย่อย / VARIANT' : 'VARIANT'} value={unit.variant ?? '—'} />
        <Field label={lang === 'th' ? 'หาง / LOT' : 'TRAILER / LOT'} value={`#${unit.trailer}${unit.lot ? ` · ${unit.lot}` : ''}`} />
        <Field label="GROSS WEIGHT" value={unit.weightKg ? `${unit.weightKg} kg` : '—'} />
      </Section>

      {/* yard movement */}
      <Section icon={<Navigation size={15} />} title={lang === 'th' ? 'การจัดจอด & เคลื่อนย้าย' : 'Yard Movement'}>
        <Field label="BLOCK" value={unit.block ?? '—'} />
        <Field label={lang === 'th' ? 'แถว / ช่อง' : 'ROW / SLOT'} value={unit.block ? `${unit.row} / ${unit.slot}` : '—'} />
        <Field label={lang === 'th' ? 'โหมดแผน' : 'PLAN MODE'} value={unit.planMode ?? '—'} />
        <Field label="DRIVER" value={unit.driver ?? '—'} />
        <Field label="GATE-IN" value={unit.gateInAt ? clock(unit.gateInAt) : '—'} />
        <Field label="RECORDED BY" value={unit.gateInBy ?? '—'} />
      </Section>
    </div>
  )
}

function HeroRow({ label, value, color, swatch }: { label: string; value: string; color?: string; swatch?: string }) {
  return (
    <>
      <div className="text-[11px] font-semibold tracking-wide self-center" style={{ color: '#7e96b5' }}>{label}</div>
      <div className="text-[13.5px] font-semibold flex items-center gap-1.5 clip" style={{ color: color ?? '#eaf1fb' }}>
        {swatch && <span className="w-3 h-3 rounded-full border shrink-0" style={{ background: swatch, borderColor: 'rgba(255,255,255,0.3)' }} />}
        {value}
      </div>
    </>
  )
}

function StatCard({ label, value, active, mono, accent }: { label: string; value: string; active?: boolean; mono?: boolean; accent?: string }) {
  return (
    <div className="rounded-xl px-4 py-3" style={active
      ? { background: 'var(--brand-soft)', border: '1px solid #bcd4fb' }
      : { background: '#fff', border: '1px solid var(--line)' }}>
      <div className="text-[11px] font-semibold mb-1" style={{ color: active ? 'var(--brand)' : 'var(--muted)' }}>{label}</div>
      <div className={`text-[18px] font-bold display clip ${mono ? 'mono' : ''}`} style={{ color: accent ?? 'var(--text)' }}>{value}</div>
    </div>
  )
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3 font-semibold text-[14px]"><span style={{ color: 'var(--brand)' }}>{icon}</span> {title}</div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-3.5">{children}</div>
    </div>
  )
}

function Field({ label, value, swatch, color }: { label: string; value: string; swatch?: string; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--faint)' }}>{label}</div>
      <div className="text-[13.5px] font-semibold flex items-center gap-1.5 clip" style={{ color: color ?? 'var(--text)' }}>
        {swatch && <span className="w-3 h-3 rounded-full border shrink-0" style={{ background: swatch, borderColor: 'rgba(0,0,0,0.15)' }} />}
        {value}
      </div>
    </div>
  )
}

/* ========================= Timeline ========================= */
interface Ev { t: number; label: string; sub?: string; icon: ReactNode; color: string }

function buildEvents(unit: Unit | undefined, lang: 'th' | 'en'): Ev[] {
  if (!unit) return []
  const evs: Ev[] = []
  evs.push({ t: unit.importedAt, label: lang === 'th' ? 'นำเข้าระบบ' : 'Imported to system', sub: lang === 'th' ? `หาง #${unit.trailer}` : `Trailer #${unit.trailer}`, icon: <Download size={13} />, color: '#c2870b' })
  if (unit.gateInAt) evs.push({ t: unit.gateInAt, label: lang === 'th' ? 'เข้าลาน (Gate-in)' : 'Gate-in', sub: unit.gateInBy, icon: <CheckCircle2 size={13} />, color: '#2563eb' })
  if (unit.assignedAt) evs.push({ t: unit.assignedAt, label: lang === 'th' ? `รับตำแหน่ง ${pos(unit)}` : `Assigned ${pos(unit)}`, sub: unit.driver, icon: <Navigation size={13} />, color: '#0891b2' })
  if (unit.parkedAt) evs.push({ t: unit.parkedAt, label: lang === 'th' ? `จอดสำเร็จ ${pos(unit)}` : `Parked ${pos(unit)}`, sub: unit.driver, icon: <PackageCheck size={13} />, color: '#16a34a' })
  unit.damages.forEach((d) => evs.push({ t: d.at, label: lang === 'th' ? `พบตำหนิ · ${zoneLabel(d.area, lang)}` : `Damage · ${zoneLabel(d.area, lang)}`, sub: d.by, icon: <AlertTriangle size={13} />, color: '#dc2626' }))
  return evs.sort((a, b) => a.t - b.t)
}

function TimelineTab({ events }: { events: Ev[] }) {
  return (
    <div className="panel p-5 fade-up">
      <div className="relative pl-1">
        {events.map((e, i) => (
          <div key={i} className="flex gap-3.5 pb-5 relative last:pb-0">
            {i < events.length - 1 && <div className="absolute left-[13px] top-7 bottom-0 w-px" style={{ background: 'var(--line-strong)' }} />}
            <div className="w-[27px] h-[27px] rounded-full flex items-center justify-center shrink-0" style={{ background: `${e.color}18`, color: e.color, border: `1px solid ${e.color}40` }}>{e.icon}</div>
            <div className="flex-1 min-w-0 pt-0.5">
              <div className="text-[14px] font-semibold">{e.label}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{clock(e.t)}{e.sub ? ` · ${e.sub}` : ''}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ========================= Location History ========================= */
function LocationTab({ unit, lang }: { unit: Unit; lang: 'th' | 'en' }) {
  const stops: { t?: number; place: string; note: string; icon: ReactNode; color: string }[] = []
  if (unit.gateInAt) stops.push({ t: unit.gateInAt, place: lang === 'th' ? 'ประตูเข้า (Gate)' : 'Gate-in', note: unit.gateInBy ?? '', icon: <Truck size={14} />, color: '#2563eb' })
  if (unit.assignedAt && unit.block) stops.push({ t: unit.assignedAt, place: pos(unit), note: lang === 'th' ? `รับตำแหน่ง · ${unit.driver ?? ''}` : `assigned · ${unit.driver ?? ''}`, icon: <Navigation size={14} />, color: '#0891b2' })
  if (unit.parkedAt && unit.block) stops.push({ t: unit.parkedAt, place: pos(unit), note: lang === 'th' ? 'จอดถาวร' : 'parked', icon: <MapPin size={14} />, color: '#16a34a' })

  if (stops.length === 0) return <Empty text={lang === 'th' ? 'ยังไม่มีประวัติตำแหน่ง' : 'No location history yet'} />

  return (
    <div className="panel overflow-hidden fade-up">
      {stops.map((s, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5 border-b hairline last:border-0">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${s.color}14`, color: s.color }}>{s.icon}</div>
          <div className="flex-1 min-w-0">
            <div className="mono font-semibold text-[14px]">{s.place}</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{s.note}</div>
          </div>
          <div className="text-[12px] text-right shrink-0" style={{ color: 'var(--faint)' }}>{clock(s.t)}</div>
        </div>
      ))}
    </div>
  )
}

/* ========================= Damages ========================= */
function DamagesTab({ unit, lang }: { unit: Unit; lang: 'th' | 'en' }) {
  if (unit.damages.length === 0)
    return (
      <div className="panel p-10 flex flex-col items-center justify-center text-center fade-up">
        <div className="w-14 h-14 rounded-full flex items-center justify-center mb-3" style={{ background: '#e7f6ec' }}>
          <ShieldCheck size={26} style={{ color: 'var(--st-yard)' }} />
        </div>
        <div className="font-semibold">{lang === 'th' ? 'ไม่พบตำหนิ' : 'No damage recorded'}</div>
        <div className="text-[12.5px] mt-1" style={{ color: 'var(--muted)' }}>{lang === 'th' ? 'รถผ่านการตรวจ walk-around เรียบร้อย' : 'Vehicle passed walk-around inspection'}</div>
      </div>
    )
  const SOURCE_LABEL: Record<string, string> = { walkaround: 'Walk-around', pdi: 'PDI', mechanic: 'ช่าง', update: 'Update' }
  const DRow = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <div className="flex gap-2 text-[12.5px]">
      <span className="shrink-0" style={{ color: 'var(--muted)', width: 92 }}>{label}</span>
      <span className="font-semibold flex-1 min-w-0" style={color ? { color } : undefined}>{value}</span>
    </div>
  )
  return (
    <div className="space-y-2.5 fade-up">
      {unit.damages.map((d) => {
        const repaired = !!d.repairDate
        return (
          <div key={d.id} className="panel overflow-hidden">
            <div className="flex items-stretch">
              {d.photo
                ? <img src={d.photo} className="w-24 object-cover shrink-0" style={{ borderRight: '1px solid var(--line)' }} />
                : <div className="w-20 shrink-0 flex items-center justify-center" style={{ background: '#fef2f2', borderRight: '1px solid var(--line)' }}><AlertTriangle size={24} style={{ color: 'var(--st-damage)' }} /></div>}
              <div className="flex-1 min-w-0 p-3 space-y-1">
                <DRow label="Position" value={zoneLabel(d.area, lang)} />
                <DRow label="Defect/NG" value={(d.item ?? d.type) + (d.note ? ` · ${d.note}` : '')} />
                {d.remark && <DRow label="Remark" value={d.remark} />}
                <DRow label="Record date" value={`${fullDT(d.at)} · ${d.by}`} />
                <DRow label="Repair date" value={repaired ? `${fullDT(d.repairDate!)} · ${d.repairedBy ?? '—'}` : '—'} color={repaired ? '#16a34a' : 'var(--faint)'} />
              </div>
              <div className="p-2 flex flex-col items-end gap-1.5 shrink-0">
                <span className="badge" style={repaired ? { color: '#16a34a', background: '#dcfce7' } : { color: '#dc2626', background: '#fee2e2' }}>{repaired ? (lang === 'th' ? 'ซ่อมแล้ว' : 'Repaired') : 'NG'}</span>
                <span className="badge" style={d.severity === 'major' ? { color: '#b91c1c', background: '#fee2e2' } : { color: '#a16207', background: '#fef9c3' }}>{d.severity === 'major' ? 'Heavy NG' : 'NG'}</span>
                {d.source && <span className="text-[10px]" style={{ color: 'var(--faint)' }}>{SOURCE_LABEL[d.source] ?? d.source}</span>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Full date-time "DD/MM/YYYY HH:MM" for defect / repair history. */
function fullDT(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function Empty({ text }: { text: string }) {
  return <div className="panel p-10 text-center" style={{ color: 'var(--faint)' }}>— {text} —</div>
}

/** lighten a hex slightly for readable text on dark */
function glowText(hex: string): string {
  return hex
}
