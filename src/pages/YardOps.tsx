/**
 * Yard Ops — Mobile role-based operations portal
 * Roles: Walk (Gate In) · Driver (Park) · PDI/PM/FC (Inspect) · Mechanic (Repair)
 */
import { useEffect, useRef, useState, useMemo } from 'react'
import {
  ScanLine, Car, ShieldCheck, Wrench, ChevronLeft,
  CheckCircle2, XCircle, AlertTriangle, Navigation, Clock,
  User, RefreshCw, Plus, Trash2,
  ArrowRight, Zap, Hand, X, Camera, Pencil, Gauge, Route, Crosshair,
  LogOut, MapPin, ClipboardList, ListChecks,
} from 'lucide-react'
import { useYard, useUnits, useTrips, useBlocks } from '../store/useYard'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { isDamaged } from '../lib/carStatus'
import { useOps, useActiveQueues, activeProcess, stageOf, isSequenceQueue, seqStageOf } from '../store/useOps'
import type { WorkQueue, QueueItem } from '../store/useOps'
import { CarTopView } from '../components/CarTopView'
import { LogoMark } from '../components/Logo'
import { DrivingScreen } from '../components/DrivingScreen'
import { LiveTrackingMap } from '../components/LiveTrackingMap'
import { ALL_ZONES, zoneLabel } from '../components/CarDiagramMultiView'
import { candidates } from '../lib/parkingEngine'
import { slotToLatLng } from '../lib/geo'
import { cx, PhotoLightbox } from '../components/ui'
import { rowInSite } from '../lib/siteScope'
import { storePhoto } from '../lib/photoStore'
import { siteGroupingConfig, yardLocCode, byYardLocation } from '../lib/groupingImport'
import type { DamageInput, Unit } from '../types'
import type { TrackRow } from '../lib/excelTracking'
import { SeqQueuePicker } from '../components/SeqQueueList'

// ── per-yard scoping ──────────────────────────────────────────────────────────
// Every station reads through these hooks so an operator stamped into site A
// can neither see nor record vehicles that belong to site B — the work site
// must match the vehicle's site for any scan to resolve.
function useSiteRows(): TrackRow[] {
  const all = useTrackingRows()
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  return useMemo(() => (currentSite ? all.filter((r) => rowInSite(r, currentSite, sites)) : all), [all, currentSite, sites])
}
function useSiteUnits(): Unit[] {
  const all = useUnits()
  const currentSite = useYard((s) => s.currentSite)
  // untagged units (mid-migration) count as the active site rather than vanishing
  return useMemo(() => (currentSite ? all.filter((u) => !u.site || u.site === currentSite) : all), [all, currentSite])
}
function useSiteQueues(): WorkQueue[] {
  const all = useActiveQueues() // already excludes gated-out cars; then scope to this yard
  const currentSite = useYard((s) => s.currentSite)
  return useMemo(() => (currentSite ? all.filter((q) => !q.site || q.site === currentSite) : all), [all, currentSite])
}
/** Explains a failed scan: if the VIN exists but belongs to another yard,
 *  name that yard instead of the misleading "ไม่พบ VIN". */
function useWrongSiteHint(): (v: string) => string | null {
  const allRows = useTrackingRows()
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  return (v: string) => {
    if (!currentSite) return null
    let r = allRows.find((x) => x.vin === v)
    if (!r && v.length <= 8) {
      const hits = allRows.filter((x) => x.vin.endsWith(v))
      if (hits.length === 1) r = hits[0]
    }
    if (!r || rowInSite(r, currentSite, sites)) return null
    const owner = sites.find((s) => s.id === r!.site)?.name ?? (r.cells['Location yard'] || 'site อื่น')
    const cur = sites.find((s) => s.id === currentSite)?.name ?? ''
    return `VIN …${r.vin.slice(-8)} อยู่ site "${owner}" — ไม่ตรงกับ site งานปัจจุบัน (${cur})`
  }
}

/** The first ACTIVE delivery-sequence (Grouping-to-Dealer) queue + item holding
 *  this VIN and not yet done — drives the Driver Wash→lane steps + Gate-out. */
function findSeqItem(vin: string | null, queues: WorkQueue[]): { queue: WorkQueue; item: QueueItem } | null {
  if (!vin) return null
  for (const q of queues) {
    if (!isSequenceQueue(q)) continue
    const item = q.items.find((i) => i.vin === vin && !i.done)
    if (item) return { queue: q, item }
  }
  return null
}

// ── damage config ─────────────────────────────────────────────────────────────
const TYPES = [
  { id: 'scratch', th: 'รอยขีดข่วน', en: 'Scratch' },
  { id: 'dent', th: 'บุบ', en: 'Dent' },
  { id: 'chip', th: 'สีกระเทาะ', en: 'Paint chip' },
  { id: 'crack', th: 'แตก/ร้าว', en: 'Crack' },
  { id: 'missing', th: 'ชิ้นส่วนหาย', en: 'Missing part' },
]

// Deduplicated zone list for dropdown (order: top-view first, then front/rear/sides)
const POSITION_OPTS = (() => {
  const seen = new Set<string>()
  return ALL_ZONES.reduce<{ id: string; th: string }[]>((acc, z) => {
    if (!seen.has(z.th)) { seen.add(z.th); acc.push({ id: z.id, th: z.th }) }
    return acc
  }, [])
})()

type RoleKey = 'walk' | 'driver' | 'pdi' | 'mechanic' | 'gateout' | 'relocation' | 'check' | 'updatedmg'
const ROLES: { key: RoleKey; th: string; en: string; icon: React.ReactNode; color: string; desc: string }[] = [
  { key: 'walk',      th: 'Gate-in',         en: 'Gate-in',         icon: <ScanLine size={28} />,      color: 'var(--brand)',   desc: 'ตรวจรับรถเข้าลาน' },
  { key: 'gateout',  th: 'Gate-out',        en: 'Gate-out',        icon: <LogOut size={28} />,        color: '#64748b',        desc: 'บันทึกรถออกจากลาน' },
  { key: 'driver',   th: 'Driver',          en: 'Driver',          icon: <Car size={28} />,           color: 'var(--st-yard)', desc: 'นำรถไปจอดตามตำแหน่ง' },
  { key: 'relocation',th:'Re-location',     en: 'Re-location',     icon: <MapPin size={28} />,        color: '#0ea5e9',        desc: 'เปลี่ยนตำแหน่งรถในลาน' },
  { key: 'pdi',      th: 'PDI / PM / FC',   en: 'PDI / PM / FC',   icon: <ShieldCheck size={28} />,   color: '#7c3aed',        desc: 'ตรวจสอบคุณภาพ OK / NG' },
  { key: 'updatedmg',th: 'Update Damage',   en: 'Update Damage',   icon: <AlertTriangle size={28} />, color: '#dc2626',        desc: 'บันทึก / แก้ไขความเสียหาย' },
  { key: 'check',    th: 'Check',           en: 'Check',           icon: <ClipboardList size={28} />, color: '#0891b2',        desc: 'ตรวจสอบข้อมูลรถ' },
  { key: 'mechanic', th: 'ช่าง',             en: 'Mechanic',        icon: <Wrench size={28} />,        color: '#c2680b',        desc: 'แก้ไข NG · ปลด / เพิ่ม NG' },
]

// ── shared: "not gated-in" guard ──────────────────────────────────────────────
// Car-Status values that mean the vehicle has already passed Gate-in
const POST_GATEIN_STATUSES = new Set(
  ['gate-in', 'gate in', 'parked', 'moving', 'pdi', 'pm', 'fc', 'ready', 'loaded', 'gate-out', 'gate out'],
)
const isGatedInStatus = (s?: string) => POST_GATEIN_STATUSES.has((s ?? '').trim().toLowerCase())

/** Resolve a typed VIN for unit-based roles (Driver / PDI / Mechanic).
 *  Prefers a yard unit (exact → unique suffix); falls back to a tracking row
 *  to tell "not gated-in yet" apart from "unknown VIN". */
function resolveForUnit(v: string, units: Unit[], rows: TrackRow[]):
  | { type: 'ok'; vin: string }
  | { type: 'notGated'; vin: string; model: string }
  | { type: 'ambiguous'; count: number }
  | { type: 'none' } {
  let u = units.find(x => x.vin === v) ?? null
  if (!u && v.length <= 8) {
    const hits = units.filter(x => x.vin.endsWith(v))
    if (hits.length === 1) u = hits[0]
    else if (hits.length > 1) return { type: 'ambiguous', count: hits.length }
  }
  if (u) {
    if (u.status === 'EXPECTED') return { type: 'notGated', vin: u.vin, model: u.modelName }
    return { type: 'ok', vin: u.vin }
  }
  // no parkable unit — is it a known (pre-gate-in) tracking row?
  let r = rows.find(x => x.vin === v) ?? null
  if (!r && v.length <= 8) {
    const hits = rows.filter(x => x.vin.endsWith(v))
    if (hits.length === 1) r = hits[0]
    else if (hits.length > 1) return { type: 'ambiguous', count: hits.length }
  }
  if (r) return { type: 'notGated', vin: r.vin, model: r.cells['Model name'] ?? r.cells['Model'] ?? '' }
  return { type: 'none' }
}

// ── process Car-Status strings ────────────────────────────────────────────────
const MOVING_STATUS = 'Moving'
const stationParkStatus = (queue: string) => `PARKING ${queue}`     // e.g. "PARKING PDI"
const stationResultStatus = (queue: string, r: 'OK' | 'NG') => `${queue} ${r}` // e.g. "PDI NG"
// Yard address, column-first: block + column(slot) + "." + row-in-column. Lane
// blocks store the LaneNo column in `slot` and the 1..8 stack position in `row`,
// so the column leads (e.g. RR38.5 = block RR, column 38, car 5).
const slotLabelOf = (u: { block?: string; row?: number; slot?: number }) =>
  u.block ? `${u.block}${u.slot}.${u.row}` : '—'

// Pre Gate-in queues are auto-named "(M-D-N)" (start with "("); admin process
// queues (PDI / FINAL PM / WASHFORSALE …) are plain names — keep the two apart
// so each shows under its own role and they don't get mixed up.
const isPreGateInQueue = (name: string) => name.trim().startsWith('(')

/** car colour name → swatch hex (for the Gate-in card Color chip) */
const COLOR_SWATCH: Record<string, string> = {
  BLACK: '#1a1a1a', WHITE: '#f5f5f5', 'WHITE(CREAM)': '#f5f0e1', CREAM: '#f5f0e1',
  GREY: '#9ca3af', GRAY: '#9ca3af', SILVER: '#c0c0c0', BLUE: '#3b82f6', GREEN: '#22c55e', RED: '#ef4444',
}
const colorSwatch = (c: string | undefined): string | null =>
  COLOR_SWATCH[String(c ?? '').toUpperCase().replace(/\s/g, '')] ?? null

/** PDI / station inspection status for a VIN, derived from its process queues
 *  (NOT the generic gate-in `inspected` flag). null = car is in no station queue.
 *  Prefers an active (not-done) queue; "Waiting" until the station records OK/NG. */
function stationStatusOf(vin: string, queues: WorkQueue[]): { queue: string; text: string; color: string } | null {
  let target: { name: string; item: QueueItem } | null = null
  for (const q of queues) {
    if (isPreGateInQueue(q.name)) continue
    const item = q.items.find(i => i.vin === vin)
    if (!item) continue
    if (!item.done) { target = { name: q.name, item }; break } // active queue wins
    target = { name: q.name, item }                            // else remember last completed
  }
  if (!target) return null
  if (stageOf(target.item) !== 'checked') return { queue: target.name, text: 'Waiting', color: '#d97706' }
  const ng = target.item.result === 'NG'
  return { queue: target.name, text: ng ? 'NG' : 'OK ✓', color: ng ? '#dc2626' : 'var(--st-yard)' }
}

/** Center-screen popup shown when an operator scans a vehicle that has not
 *  passed Gate-in yet. Used by every role except Gate-in itself. */
function NotGatedInModal({ vin, model, onClose }: { vin: string; model?: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4500)
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => { clearTimeout(t); window.removeEventListener('keydown', h) }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="panel-solid w-full max-w-xs text-center fade-up p-6" onClick={e => e.stopPropagation()}
        style={{ borderTop: '4px solid #f59e0b' }}>
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 pop"
          style={{ background: 'rgba(245,158,11,0.15)' }}>
          <AlertTriangle size={34} style={{ color: '#f59e0b' }} />
        </div>
        <div className="display text-[21px] font-bold" style={{ color: '#b45309' }}>รถยังไม่ Gate-in</div>
        <div className="vin text-[13px] mt-2 font-bold" style={{ color: 'var(--text)' }}>{vin}</div>
        {model && <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{model}</div>}
        <div className="text-[12.5px] mt-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
          กรุณานำรถผ่าน <b style={{ color: 'var(--brand)' }}>Gate-in</b> ก่อน จึงจะดำเนินการในขั้นตอนนี้ได้
        </div>
        <button className="btn btn-primary w-full mt-5 py-2.5" onClick={onClose}>เข้าใจแล้ว</button>
      </div>
    </div>
  )
}

/** Hook that owns the not-gated-in popup state for a role view. */
function useNotGatedIn() {
  const [blocked, setBlocked] = useState<{ vin: string; model?: string } | null>(null)
  const block = (vin: string, model?: string) => setBlocked({ vin, model })
  const modal = blocked
    ? <NotGatedInModal vin={blocked.vin} model={blocked.model} onClose={() => setBlocked(null)} />
    : null
  return { block, modal }
}

// ── shared: mobile VIN input ──────────────────────────────────────────────────
function VinInput({ onScan, accent = 'var(--brand)' }: { onScan: (vin: string) => void; accent?: string }) {
  const [val, setVal] = useState('')
  const [camOpen, setCamOpen] = useState(false)
  const [camErr, setCamErr] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  // ZXing scanner controls — decodes QR + 1D barcodes (Code128/39, EAN, DataMatrix)
  // in pure JS so it works on iOS Safari too (native BarcodeDetector is missing there).
  const controlsRef = useRef<{ stop: () => void } | null>(null)

  const go = (raw?: string) => {
    const v = (raw ?? val).trim().toUpperCase()
    if (v.length >= 3) { onScan(v); setVal('') }
  }

  useEffect(() => { ref.current?.focus() }, [])

  // Fully release the camera: stop ZXing's decode loop AND every media track,
  // then detach from the <video> so the OS camera indicator turns off.
  const stopScan = () => {
    try { controlsRef.current?.stop() } catch { /* already stopped */ }
    controlsRef.current = null
    const v = videoRef.current
    const s = v?.srcObject as MediaStream | null
    s?.getTracks().forEach(t => t.stop())
    if (v) v.srcObject = null
  }

  const openCamera = () => { setCamErr(''); setCamOpen(true) }
  const closeCamera = () => { stopScan(); setCamOpen(false) }

  // Start the scanner whenever the overlay opens. ZXing manages getUserMedia +
  // srcObject + play() + the continuous decode loop internally, which also
  // avoids the stream-lifecycle race that left the old preview black.
  useEffect(() => {
    if (!camOpen) return
    let cancelled = false
    ;(async () => {
      try {
        const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
          import('@zxing/browser'),
          import('@zxing/library'),
        ])
        const video = videoRef.current
        if (!video || cancelled) return
        const hints = new Map<number, unknown>()
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
          BarcodeFormat.EAN_13, BarcodeFormat.DATA_MATRIX,
        ])
        const reader = new BrowserMultiFormatReader(hints as never)
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          video,
          (result) => {
            if (!result) return
            const text = result.getText()?.trim().toUpperCase()
            if (text) { closeCamera(); go(text) }
          },
        )
        if (cancelled) { controls.stop(); return }
        controlsRef.current = controls
      } catch (e) {
        console.error('[scan] camera', e)
        if (!cancelled) setCamErr('เปิดกล้องไม่สำเร็จ — โปรดอนุญาตสิทธิ์กล้องในเบราว์เซอร์ แล้วลองใหม่')
      }
    })()
    return () => { cancelled = true; stopScan() }
  }, [camOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Camera overlay */}
      {camOpen && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col" style={{ touchAction: 'none' }}>
          <div className="flex items-center justify-between px-4 py-3 shrink-0">
            <span className="text-white font-bold text-[16px]">สแกน QR / Barcode VIN</span>
            <button onClick={closeCamera} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.15)' }}>
              <X size={20} color="#fff" />
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              playsInline
              muted
              autoPlay
            />
            {/* scan frame */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="relative w-60 h-44">
                {/* corners */}
                {[['top-0 left-0','border-t-2 border-l-2'],['top-0 right-0','border-t-2 border-r-2'],
                  ['bottom-0 left-0','border-b-2 border-l-2'],['bottom-0 right-0','border-b-2 border-r-2']].map(([pos, brd], i) => (
                  <span key={i} className={`absolute w-7 h-7 ${pos} ${brd} rounded-sm`} style={{ borderColor: accent }} />
                ))}
                <div className="absolute inset-0 border border-white/10 rounded" />
              </div>
            </div>
            {camErr && (
              <div className="absolute bottom-8 left-4 right-4 text-center text-[13px] py-2 px-4 rounded-xl" style={{ background: 'rgba(0,0,0,0.7)', color: '#fca5a5' }}>
                {camErr}
              </div>
            )}
          </div>
          <div className="px-4 py-4 text-center text-white/60 text-[13px] shrink-0">
            จ่อกล้องไปที่ QR Code / Barcode บนรถ
          </div>
        </div>
      )}

      {/* Input row */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            ref={ref}
            className="flex-1 h-[54px] text-[18px] text-center rounded-2xl outline-none uppercase"
            style={{
              background: '#fff', border: `2px solid ${accent}`,
              color: 'var(--text)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.06em',
              boxShadow: `0 0 0 4px ${accent}22`,
            }}
            placeholder="VIN / 5 ตัวท้าย…"
            value={val}
            onChange={e => setVal(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && go()}
          />
          <button
            onClick={openCamera}
            className="w-[54px] h-[54px] rounded-2xl flex items-center justify-center shrink-0 transition-all active:scale-95"
            style={{ background: accent + '18', border: `2px solid ${accent}`, color: accent }}
          >
            <Camera size={22} />
          </button>
        </div>
        <button
          onClick={() => go()}
          className="w-full h-14 rounded-2xl text-[16px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
          style={{ background: accent, boxShadow: `0 6px 20px -4px ${accent}80` }}
        >
          <ScanLine size={20} /> สแกน / ค้นหา
        </button>
        {camErr && !camOpen && (
          <div className="text-[12px] text-center py-1" style={{ color: '#ef4444' }}>{camErr}</div>
        )}
      </div>
    </>
  )
}

// ── shared: unit hero card ────────────────────────────────────────────────────
// damages found during the gate-in walk-around (undefined source = legacy walk-around)
const walkAroundDamages = (u: Unit) => u.damages.filter(d => d.source === 'walkaround' || d.source === undefined)

function UnitCard({ unit, accent = 'var(--brand)' }: { unit: Unit; accent?: string }) {
  const queues = useSiteQueues()
  const stationStatus = stationStatusOf(unit.vin, queues)
  const walkDmgs = walkAroundDamages(unit)
  const walkStatus = (unit.inspected || walkDmgs.length > 0)
    ? (walkDmgs.length > 0 ? { text: 'NG', color: 'var(--st-damage)' } : { text: 'OK ✓', color: 'var(--st-yard)' })
    : null
  const carColor = unit.colorHex ?? '#cfd6dd'
  const statusLabel: Record<string, string> = {
    EXPECTED: 'รอเข้า Yard', GATE_IN: 'อยู่ที่ Gate in', ASSIGNED: 'กำลังนำจอด',
    PARKED: 'จอดแล้ว', LOADED: 'โหลดแล้ว', DEPARTED: 'ออกไปแล้ว',
  }
  const statusColor: Record<string, string> = {
    EXPECTED: '#c2870b', GATE_IN: 'var(--brand)', ASSIGNED: 'var(--st-driving)',
    PARKED: 'var(--st-yard)', LOADED: 'var(--st-loaded)', DEPARTED: 'var(--st-departed)',
  }
  const sColor = statusColor[unit.status] ?? '#888'
  const sLabel = statusLabel[unit.status] ?? unit.status
  return (
    <div className="panel overflow-hidden">
      {/* Status banner — top, centered, no pill (status + position) */}
      <div className="px-4 pt-3 pb-2 flex justify-center items-baseline gap-2.5" style={{ background: 'linear-gradient(135deg,#0c1a2e,#1e3a5f)' }}>
        <span className="text-[18px] font-extrabold tracking-wide" style={{ color: sColor }}>
          {sLabel}
        </span>
        {unit.block && <span className="text-[18px] font-extrabold tracking-wide" style={{ color: 'rgba(255,255,255,0.95)' }}>{slotLabelOf(unit)}</span>}
      </div>

      {/* Car image + VIN / Model / Color / inspector / time */}
      <div className="px-4 pb-4 flex items-center gap-4" style={{ background: 'linear-gradient(135deg,#0c1a2e,#1e3a5f)' }}>
        <CarTopView color={carColor} width={80} />
        <div className="flex-1 min-w-0 space-y-1.5">
          {([
            { label: 'VIN',      value: unit.vin,          mono: true },
            { label: 'Model',    value: unit.modelName,     mono: false },
            { label: 'Color',    value: unit.color ?? '—',  mono: false, swatch: unit.colorHex },
            ...(unit.gateInBy ? [{ label: 'ผู้ตรวจ', value: unit.gateInBy, mono: false }] : []),
            ...(unit.gateInAt  ? [{ label: 'เวลา',   value: new Date(unit.gateInAt).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }), mono: false }] : []),
          ] as { label: string; value: string; mono: boolean; swatch?: string }[]).map(({ label, value, mono, swatch }) => (
            <div key={label} className="flex items-center gap-3">
              <span className="text-[13px] font-semibold shrink-0" style={{ color: 'rgba(255,255,255,0.45)', width: 46 }}>{label}</span>
              <div className="flex items-center gap-1.5 min-w-0">
                {swatch && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: swatch, boxShadow: '0 0 0 1px rgba(255,255,255,0.25)' }} />}
                <span className={`text-[13px] font-bold text-white leading-tight break-all${mono ? ' vin' : ''}`}>{value}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {(unit.block || walkStatus || stationStatus) && (
        <div className="flex divide-x hairline text-[12px]" style={{ borderTop: '1px solid var(--line)' }}>
          {unit.block && (
            <div className="flex-1 p-3 text-center">
              <div className="text-[10px] font-bold uppercase" style={{ color: 'var(--muted)' }}>ตำแหน่ง</div>
              <div className="font-bold mt-0.5" style={{ color: accent }}>{slotLabelOf(unit)}</div>
            </div>
          )}
          {walkStatus && (
            <div className="flex-1 p-3 text-center">
              <div className="text-[10px] font-bold uppercase" style={{ color: 'var(--muted)' }}>Walk around</div>
              <div className="font-bold mt-0.5" style={{ color: walkStatus.color }}>{walkStatus.text}</div>
            </div>
          )}
          {stationStatus && (
            <div className="flex-1 p-3 text-center">
              <div className="text-[10px] font-bold uppercase" style={{ color: 'var(--muted)' }}>{stationStatus.queue}</div>
              <div className="font-bold mt-0.5" style={{ color: stationStatus.color }}>{stationStatus.text}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Small tappable thumbnail row for a damage's photo(s) — opens the shared PhotoLightbox. */
function DamagePhotoThumbs({ photos, onOpen }: { photos: string[]; onOpen: (i: number) => void }) {
  if (!photos.length) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {photos.map((p, i) => (
        <img key={i} src={p} alt="" onClick={() => onOpen(i)}
          className="rounded-lg object-cover cursor-pointer transition active:scale-95"
          style={{ width: 44, height: 44, border: '1px solid var(--line)' }} />
      ))}
    </div>
  )
}

// legacy fallback when a damage predates the `station` field (derived from `source`)
const SOURCE_STATION_LABEL: Partial<Record<string, string>> = {
  walkaround: 'Gate-in', pdi: 'PDI', mechanic: 'ช่าง (Mechanic)', update: 'Update Damage',
  yardDefect: 'Co-Inspection (Yard)', factoryDefect: 'Co-Inspection (Factory)', whaleDefect: 'Co-Inspection (Whale)',
  manual: 'เพิ่มเอง (Manual)',
}
const stationLabel = (d: { station?: string; source?: string }) =>
  d.station || SOURCE_STATION_LABEL[d.source ?? 'walkaround'] || 'Gate-in'

const fmtDateTime = (ts: number) => {
  const d = new Date(ts)
  return {
    date: d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }),
    time: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
  }
}

// ── shared: quick multi-row damage form ──────────────────────────────────────
type DmgRow = { rid: string; area: string; detail: string; severity: 'minor' | 'major'; photos: string[] }

// Maps display text → stored ID (for known entries)
const TYPE_TEXT_MAP = Object.fromEntries(TYPES.map(t => [t.th, t.id]))
const AREA_TEXT_MAP = Object.fromEntries(POSITION_OPTS.map(p => [p.th, p.id]))

const mkRow = (): DmgRow => ({
  rid: `r${Date.now()}${Math.random().toString(36).slice(2)}`,
  area: POSITION_OPTS[0].th,   // display text (กันชนหน้า)
  detail: TYPES[0].th,         // display text (รอยขีดข่วน)
  severity: 'minor',
  photos: [],
})

/** Thumbnail strip: existing photos (tap × to remove) + an "add photo" tile.
 *  The file input accepts multiple images at once (gallery) or one shot at a time (camera). */
function PhotoStrip({ photos, onAdd, onRemove, busy }: {
  photos: string[]; onAdd: (files: FileList) => void; onRemove: (i: number) => void; busy: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
      {photos.map((p, i) => (
        <div key={i} className="relative shrink-0" style={{ width: 44, height: 44 }}>
          <img src={p} alt="" className="w-full h-full rounded-lg object-cover" style={{ border: '1px solid var(--line)' }} />
          <button onClick={() => onRemove(i)}
            className="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 rounded-full flex items-center justify-center"
            style={{ width: 18, height: 18, background: '#0f172a', color: '#fff' }}>
            <X size={10} />
          </button>
        </div>
      ))}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="shrink-0 rounded-lg flex items-center justify-center border-2 border-dashed transition disabled:opacity-50"
        style={{ width: 44, height: 44, borderColor: 'var(--line-strong)', color: 'var(--muted)' }}>
        <Camera size={16} />
      </button>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
        onChange={e => { if (e.target.files?.length) onAdd(e.target.files); e.target.value = '' }} />
    </div>
  )
}

function DamageForm({ onSaveAll, onCancel }: {
  onSaveAll: (damages: DamageInput[]) => void
  onCancel: () => void
}) {
  const { toast } = useYard()
  const [rows, setRows] = useState<DmgRow[]>([mkRow()])
  const [busyRid, setBusyRid] = useState<string | null>(null)
  const upd = (rid: string, k: keyof DmgRow, v: string) =>
    setRows(r => r.map(x => x.rid === rid ? { ...x, [k]: v } : x))
  const del = (rid: string) => setRows(r => r.length > 1 ? r.filter(x => x.rid !== rid) : r)

  const addPhotos = async (rid: string, files: FileList) => {
    setBusyRid(rid)
    try {
      const compressed = await Promise.all(Array.from(files).map(f => compressImage(f)))
      setRows(r => r.map(x => x.rid === rid ? { ...x, photos: [...x.photos, ...compressed] } : x))
    } catch { toast('err', 'อ่านรูปไม่สำเร็จ') }
    setBusyRid(null)
  }
  const removePhoto = (rid: string, i: number) =>
    setRows(r => r.map(x => x.rid === rid ? { ...x, photos: x.photos.filter((_, pi) => pi !== i) } : x))

  const save = () => onSaveAll(rows.map(row => ({
    area: AREA_TEXT_MAP[row.area] ?? row.area,              // known → id, custom → raw text
    type: TYPE_TEXT_MAP[row.detail] ?? 'scratch',           // known → id, custom → default type
    severity: row.severity,
    note: TYPE_TEXT_MAP[row.detail] ? undefined : (row.detail || undefined), // custom text → note
    photos: row.photos.length ? row.photos : undefined,
    photo: row.photos[0],
  })))

  return (
    <div className="panel overflow-hidden fade-up">
      <div className="p-3 text-[13px] font-semibold flex items-center gap-2 border-b hairline" style={{ background: '#fff8f8' }}>
        <AlertTriangle size={15} style={{ color: 'var(--st-damage)' }} />
        <span style={{ color: 'var(--st-damage)' }}>บันทึกตำหนิ</span>
      </div>
      <div className="p-4 space-y-2">
        {/* column headers */}
        <div className="grid gap-2 px-0.5 text-[10.5px] font-bold uppercase" style={{ gridTemplateColumns: '1fr 1fr 32px', color: 'var(--muted)' }}>
          <span>ตำแหน่ง</span><span>รายละเอียด Defect</span><span />
        </div>

        {/* damage rows — each field is a combobox: type freely or pick from list */}
        {rows.map(row => (
          <div key={row.rid} className="space-y-1.5 pb-1.5 border-b hairline last:border-b-0">
            <div className="grid gap-1.5 items-center" style={{ gridTemplateColumns: '1fr 1fr 32px' }}>
              <input
                className="input text-[12.5px]"
                style={{ padding: '7px 8px' }}
                list={`pos-${row.rid}`}
                placeholder="ตำแหน่ง…"
                value={row.area}
                onChange={e => upd(row.rid, 'area', e.target.value)}
              />
              <datalist id={`pos-${row.rid}`}>
                {POSITION_OPTS.map(p => <option key={p.id} value={p.th} />)}
              </datalist>

              <input
                className="input text-[12.5px]"
                style={{ padding: '7px 8px' }}
                list={`def-${row.rid}`}
                placeholder="รายละเอียด…"
                value={row.detail}
                onChange={e => upd(row.rid, 'detail', e.target.value)}
              />
              <datalist id={`def-${row.rid}`}>
                {TYPES.map(t => <option key={t.id} value={t.th} />)}
              </datalist>

              <button
                onClick={() => del(row.rid)}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition hover:bg-red-50"
                style={{ color: 'var(--muted)', background: 'var(--chip)' }}
              >
                <Trash2 size={12} />
              </button>
            </div>

            <PhotoStrip
              photos={row.photos}
              busy={busyRid === row.rid}
              onAdd={files => addPhotos(row.rid, files)}
              onRemove={i => removePhoto(row.rid, i)}
            />
          </div>
        ))}

        {/* severity — shared toggle (applies to all rows at once) */}
        <div className="flex gap-2 pt-0.5">
          {(['minor', 'major'] as const).map(sv => (
            <button key={sv}
              onClick={() => setRows(r => r.map(x => ({ ...x, severity: sv })))}
              className="flex-1 py-2 rounded-xl text-[12px] font-bold transition"
              style={rows[0].severity === sv
                ? { background: sv === 'major' ? '#dc2626' : '#d97706', color: '#fff' }
                : { background: 'var(--chip)', color: 'var(--muted)' }}>
              {sv === 'minor' ? 'NG' : 'HEAVY NG'}
            </button>
          ))}
        </div>

        {/* add row */}
        <button
          onClick={() => setRows(r => [...r, mkRow()])}
          className="w-full py-2.5 rounded-xl text-[13px] font-semibold flex items-center justify-center gap-1.5 border-2 border-dashed transition"
          style={{ color: 'var(--st-damage)', borderColor: '#fca5a5' }}
        >
          <Plus size={14} /> เพิ่มแผล
        </button>

        {/* actions */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button className="btn py-3 text-[13.5px]" onClick={onCancel}>ยกเลิก</button>
          <button className="btn py-3 text-[13.5px] font-bold"
            onClick={save}
            style={{ background: 'var(--st-damage)', color: '#fff', border: 'none' }}>
            <Plus size={14} /> บันทึก NG{rows.length > 1 ? ` (${rows.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── walk view ─────────────────────────────────────────────────────────────────
function WalkView() {
  const units = useSiteUnits()
  const allUnits = useUnits() // global (all sites) — for pulling a car's Defect list even if its unit lives in another site
  const { gateIn, importUnits, addDamage, updateDamage, markTrailerArrived, toast, currentUser } = useYard()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const { loadFromIdb, updateCell } = useTracking()
  const { toggleDone } = useOps()
  const queues = useSiteQueues()
  const sites = useYard(s => s.sites)
  const currentSite = useYard(s => s.currentSite)
  const locPrefix = siteGroupingConfig(sites.find(s => s.id === currentSite)?.name ?? '').prefix
  const [vin, setVin] = useState<string | null>(null)
  const [trackingVin, setTrackingVin] = useState<string | null>(null)
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)
  const [showDmg, setShowDmg] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editArea, setEditArea] = useState('')
  const [editDetail, setEditDetail] = useState('')
  const [doneUnit, setDoneUnit] = useState<{ vin: string; modelName: string; color: string; colorHex?: string; inspector: string; gateInAt: number } | null>(null)
  const [lightbox, setLightbox] = useState<{ photos: string[]; index: number } | null>(null)
  // mandatory damage check at gate-in — must pick OK or NG before confirming
  const [dmgResult, setDmgResult] = useState<'OK' | 'NG' | null>(null)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])
  useEffect(() => { setDmgResult(null) }, [trackingVin]) // reset the check per scanned car

  // Pre Gate-in queues "(M-D-N)" — process queues (PDI / PM / Wash) live under the
  // PDI role, not here. Completed queues stay listed so the station can still read
  // its own progress ("17/17 · เหลือ 0"), same as the Driver's delivery-run cards.
  const gateInQueues = useMemo(() =>
    queues.filter(q => isPreGateInQueue(q.name)),
    [queues],
  )
  const selectedQueue = selectedQueueId ? queues.find(q => q.id === selectedQueueId) ?? null : null
  // NG ⟺ the gate-in walk-around recorded damage on this car (what the operator
  // pressed OK / NG on) — not the imported "Status" column.
  const ngVins = useMemo(() => {
    const s = new Set<string>()
    for (const u of allUnits) if (walkAroundDamages(u).length > 0) s.add(u.vin)
    return s
  }, [allUnits])
  const queueCars = useMemo(() => {
    if (!selectedQueue) return [] as { vin: string; model: string; color: string; grouping: string; location: string; done: boolean; ng: boolean }[]
    return selectedQueue.items.map(i => {
      const row = trackingRows.find(r => r.vin === i.vin)
      const u = allUnits.find(x => x.vin === i.vin)
      return {
        vin: i.vin,
        model: row?.cells['Model'] ?? row?.cells['Model name'] ?? u?.modelName ?? '—',
        color: row?.cells['Color'] ?? u?.color ?? '—',
        grouping: row?.cells['Grouping  Number'] || '—',
        location: yardLocCode(u, locPrefix) || '—',
        done: i.done,
        ng: ngVins.has(i.vin),
      }
    }).sort((a, b) => Number(a.done) - Number(b.done)) // ยังไม่สแกน ขึ้นก่อน
  }, [selectedQueue, trackingRows, allUnits, ngVins, locPrefix])

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null
  const trackRow = trackingVin ? (trackingRows.find(r => r.vin === trackingVin) ?? null) : null
  const recent = useMemo(() => {
    // keyed by VIN so a vehicle that lives in BOTH stores (gate-in registers it
    // as a yard unit too) only shows once — prefer the tracking row (richer info)
    const byVin = new Map<string, { vin: string; time: number; inspector: string; modelName: string; isTracking: boolean }>()
    // tracking rows gate-in'd with a real timestamp (stamped by doTrackingGateIn)
    for (const r of trackingRows) {
      if (r.cells['Car Status'] !== 'Gate-in' || !r.cells['Gate In Time']) continue
      byVin.set(r.vin, {
        vin: r.vin,
        time: parseInt(r.cells['Gate In Time']!),
        inspector: r.cells['Gate In Inspector'] ?? '',
        modelName: r.cells['Model name'] ?? r.cells['Model'] ?? '',
        isTracking: true,
      })
    }
    // yard units — only add if the VIN isn't already represented by a tracking row
    for (const u of units) {
      if (!u.gateInAt || byVin.has(u.vin)) continue
      byVin.set(u.vin, {
        vin: u.vin,
        time: u.gateInAt,
        inspector: u.gateInBy ?? '',
        modelName: u.modelName,
        isTracking: false,
      })
    }
    return [...byVin.values()].sort((a, b) => b.time - a.time).slice(0, 8)
  }, [trackingRows, units])

  const onScan = (v: string) => {
    setTrackingVin(null)
    // 1. exact yard unit
    let u = units.find(x => x.vin === v)
    if (u) { setVin(u.vin); setShowDmg(false); return }
    setVin(null)
    // 2. exact tracking row
    const et = trackingRows.find(r => r.vin === v)
    if (et) { setTrackingVin(et.vin); return }
    // 3. suffix match (≤ 8 chars) — yard units first, then tracking
    if (v.length <= 8) {
      const unitHits = units.filter(x => x.vin.toUpperCase().endsWith(v))
      if (unitHits.length === 1) { setVin(unitHits[0].vin); setShowDmg(false); return }
      if (unitHits.length > 1) { toast('err', `พบ ${unitHits.length} คัน ที่ลงท้าย ${v} — กรอกให้ยาวขึ้น`); return }
      const trackHits = trackingRows.filter(r => r.vin.endsWith(v))
      if (trackHits.length === 1) { setTrackingVin(trackHits[0].vin); return }
      if (trackHits.length > 1) { toast('err', `พบ ${trackHits.length} คัน ที่ลงท้าย ${v} — กรอกให้ยาวขึ้น`); return }
    }
    toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`)
  }

  const doGateIn = () => {
    if (!unit) return
    const snap = { vin: unit.vin, modelName: unit.modelName, color: unit.color ?? '', colorHex: unit.colorHex, inspector: currentUser, gateInAt: Date.now() }
    gateIn(unit.vin)
    markTrailerArrived(unit.trailer)
    setVin(null)
    setDoneUnit(snap)
  }

  const doTrackingGateIn = (damages?: DamageInput[]) => {
    if (!trackRow) return
    const now = new Date()
    const d = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`
    updateCell(trackRow.vin, 'Car Status', 'Gate-in')
    updateCell(trackRow.vin, 'Gate In (Rayong yard)', d)
    updateCell(trackRow.vin, 'Gate In Inspector', currentUser)
    updateCell(trackRow.vin, 'Gate In Time', String(now.getTime()))
    // register as yard unit so Driver can find it for parking assignment
    if (!units.find(u => u.vin === trackRow.vin)) {
      importUnits([{
        vin:     trackRow.vin,
        model:   trackRow.cells['Model name'] ?? trackRow.cells['Model'] ?? '',
        color:   trackRow.cells['Color'] ?? '',
        lot:     trackRow.cells['Lot transfer'] ?? undefined,
        trailer: parseInt(trackRow.cells['Grouping  Number'] ?? '0') || 0,
      }])
    }
    gateIn(trackRow.vin)
    // NG walk-around damages captured during the gate-in inspection
    if (damages?.length) {
      damages.forEach(d => addDamage(trackRow.vin, { ...d, source: 'walkaround', station: 'Gate-in' }))
      updateCell(trackRow.vin, 'Status', 'NG')
    }
    setDoneUnit({
      vin: trackRow.vin,
      modelName: trackRow.cells['Model name'] ?? trackRow.cells['Model'] ?? '—',
      color: trackRow.cells['Color'] ?? '—',
      colorHex: undefined,
      inspector: currentUser,
      gateInAt: Date.now(),
    })
    // mark done in every queue that contains this VIN (whether or not a chip is selected)
    queues.forEach(q => {
      if (q.items.some(i => i.vin === trackRow.vin && !i.done)) {
        toggleDone(q.id, trackRow.vin, currentUser)
      }
    })
    setTrackingVin(null)
  }

  return (
    <div className="space-y-4">
      {/* Gate-in success popup */}
      {doneUnit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}
          onClick={() => setDoneUnit(null)}
        >
          <div className="panel p-6 w-full max-w-xs text-center fade-up" onClick={e => e.stopPropagation()}>
            {/* Car image */}
            <div className="flex justify-center mb-1">
              <CarTopView color={doneUnit.colorHex ?? '#cfd6dd'} width={110} />
            </div>
            <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-2"
              style={{ background: 'rgba(22,163,74,0.14)' }}>
              <CheckCircle2 size={28} style={{ color: '#16a34a' }} />
            </div>
            <div className="text-[20px] font-extrabold mb-0.5" style={{ color: '#16a34a' }}>เข้า Yard สำเร็จ!</div>
            <div className="text-[13px] mb-4" style={{ color: 'var(--muted)' }}>ตรวจรับรถเรียบร้อยแล้ว</div>
            <div className="rounded-xl p-4 text-left space-y-2 mb-5" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              {([
                ['VIN',    doneUnit.vin],
                ['Model',  doneUnit.modelName],
                ['Color',  doneUnit.color],
                ['ผู้ตรวจ', doneUnit.inspector],
                ['เวลา',   new Date(doneUnit.gateInAt).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })],
              ] as [string, string][]).map(([lbl, val]) => (
                <div key={lbl} className="flex items-baseline gap-3">
                  <span className="text-[11px] font-bold shrink-0" style={{ color: '#16a34a', width: 46 }}>{lbl}</span>
                  <span className={`text-[12.5px] font-bold break-all${lbl === 'VIN' ? ' vin' : ''}`} style={{ color: '#166534' }}>{val}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => setDoneUnit(null)}
              className="w-full py-3 rounded-xl text-[15px] font-bold text-white transition active:scale-95"
              style={{ background: '#16a34a' }}
            >
              ตกลง
            </button>
          </div>
        </div>
      )}

      <VinInput onScan={onScan} accent="var(--brand)" />

      {/* ── Pre Gate-in work queues — same card shape as the Driver's delivery runs:
             name · done/total · เหลือ N, expand to see every VIN and its OK / NG / รอ ── */}
      {gateInQueues.length > 0 && !unit && !trackRow && (
        <div className="space-y-2.5 fade-up">
          <div className="flex items-center gap-2 px-1">
            <ClipboardList size={14} style={{ color: 'var(--brand)' }} />
            <span className="text-[12.5px] font-bold">คิวงาน Pre Gate-in</span>
            <span className="badge ml-auto" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--brand)' }}>{gateInQueues.length} คิว</span>
          </div>
          {gateInQueues.map(q => {
            const total = q.items.length
            const done  = q.items.filter(i => i.done).length
            const ng    = q.items.filter(i => i.done && ngVins.has(i.vin)).length
            const isOpen = q.id === selectedQueueId
            return (
              <div key={q.id} className="panel overflow-hidden">
                <button className="w-full px-4 py-3 flex items-center gap-3 text-left"
                  onClick={() => setSelectedQueueId(isOpen ? null : q.id)}>
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>
                    <ClipboardList size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-[12.5px] clip">{q.name}</div>
                    <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-1.5" style={{ color: 'var(--muted)' }}>
                      <span><b style={{ color: 'var(--text)' }}>{done}/{total}</b> คัน</span>
                      <span>· เหลือ <b style={{ color: total - done > 0 ? '#d97706' : '#16a34a' }}>{total - done}</b></span>
                      <span>· OK <b style={{ color: '#16a34a' }}>{done - ng}</b></span>
                      <span>· NG <b style={{ color: 'var(--st-damage)' }}>{ng}</b></span>
                    </div>
                  </div>
                  <ChevronLeft size={16} style={{ color: 'var(--muted)', transform: isOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
                </button>
                {isOpen && (
                  <div className="border-t hairline max-h-72 overflow-y-auto divide-y" style={{ borderColor: 'var(--line)' }}>
                    {queueCars.map(c => (
                      <button key={c.vin} onClick={() => setTrackingVin(c.vin)}
                        className="w-full px-4 py-2.5 flex items-center gap-3 text-left transition active:bg-chip"
                        style={c.done ? { opacity: 0.62 } : undefined}>
                        <div className="min-w-0 flex-1">
                          <div className="vin text-[12.5px] font-bold clip">{c.vin}</div>
                          <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: 'var(--muted)' }}>
                            <span>{c.model}</span><span>· {c.color}</span><span>· {c.grouping}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="tabular text-[12px] font-bold">{c.location}</div>
                          <span className="badge mt-0.5 inline-block" style={{ fontSize: 10, ...(!c.done
                            ? { background: '#fef9c3', color: '#854d0e' }
                            : c.ng
                              ? { background: 'rgba(255,59,48,0.12)', color: 'var(--st-damage)' }
                              : { background: 'rgba(22,163,74,0.12)', color: '#16a34a' }) }}>
                            {!c.done ? 'รอ' : c.ng ? 'NG' : 'OK'}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* tracking row (imported from Excel) gate-in card */}
      {trackRow && !unit && (() => {
        const damaged = isDamaged(trackRow.cells)
        return (
          <div className="panel overflow-hidden fade-up">
            {/* ── row 1: status badge + VIN ── */}
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
              <span className="badge text-[11.5px] font-bold px-2.5 py-1"
                style={{ background: '#facc15', color: '#5b4a00' }}>
                {trackRow.cells['Car Status'] ?? 'Pre Gate-in'}
              </span>
              <span className="vin text-[13px] font-bold flex-1 min-w-0 truncate">{trackRow.vin}</span>
            </div>

            {/* ── row 2: car image LEFT + info RIGHT ── */}
            <div className="flex gap-3 px-4 pb-3">
              {/* car image */}
              <div className="rounded-2xl flex items-center justify-center shrink-0"
                style={{ width: 118, minHeight: 118, background: 'linear-gradient(160deg,#e8f4fd,#f0f7ff)' }}>
                <CarTopView color="#4d8fdc" width={108} />
              </div>
              {/* info stack */}
              <div className="flex-1 min-w-0 space-y-2 text-[12px]">
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Model</div>
                  <div className="font-bold leading-tight">{trackRow.cells['Model name'] ?? trackRow.cells['Model'] ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Sub-Model</div>
                  <div className="font-semibold leading-tight truncate">{trackRow.cells['Sub-Model'] ?? trackRow.cells['SubModel'] ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Color</div>
                  {(() => { const col = trackRow.cells['Color'] ?? ''; const sw = colorSwatch(col); return (
                    <div className="font-semibold truncate flex items-center gap-1.5">
                      {sw && <span className="rounded-full shrink-0" style={{ width: 11, height: 11, background: sw, border: '1px solid rgba(0,0,0,0.15)' }} />}
                      {col || '—'}
                    </div>
                  ) })()}
                </div>
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Company</div>
                  <div className="font-semibold truncate">{trackRow.cells['company'] ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Lot</div>
                  <div className="font-semibold leading-tight truncate">{trackRow.cells['Lot transfer'] ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Remark</div>
                  <div className="font-semibold">{trackRow.cells['Remark'] ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Tax</div>
                  {(() => {
                    const st = (trackRow.cells['Tax Payment (STATUS)'] ?? trackRow.cells['Status Tax'] ?? '').trim()
                    const date = (trackRow.cells['Tax Payment Date'] ?? '').trim()
                    if (!st && !date) return <div className="font-semibold">—</div>
                    const t = st.toLowerCase()
                    const paid = /yes|already|paid|ชำระแล้ว|เสียแล้ว/.test(t)
                    const no   = /^no|ยังไม่|not/.test(t)
                    const color = paid ? '#16a34a' : no ? '#dc2626' : '#d97706'
                    const bg    = paid ? 'rgba(22,163,74,0.12)' : no ? 'rgba(220,38,38,0.1)' : 'rgba(217,119,6,0.12)'
                    return (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {st && <span className="badge font-bold" style={{ fontSize: 10.5, background: bg, color }}>{st}</span>}
                        {date && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{date}</span>}
                      </div>
                    )
                  })()}
                </div>
              </div>
            </div>

            {/* ── row 3: From → To ── */}
            {(trackRow.cells['From'] || trackRow.cells['To']) && (
              <div className="mx-4 mb-3 flex items-center gap-2 rounded-2xl px-3.5 py-2.5"
                style={{ background: 'rgba(37,99,235,0.07)', border: '1px solid rgba(37,99,235,0.14)' }}>
                <MapPin size={13} style={{ color: '#2563eb', flexShrink: 0 }} />
                <span className="text-[12.5px] font-bold" style={{ color: '#1d4ed8' }}>
                  {trackRow.cells['From'] ?? '—'}
                </span>
                <ArrowRight size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <span className="text-[12.5px] font-bold flex-1 truncate" style={{ color: '#1d4ed8' }}>
                  {trackRow.cells['To'] ?? '—'}
                </span>
              </div>
            )}

            {/* ── row 4: mandatory damage check + gate-in ── */}
            <div className="px-4 pb-4">
              {(trackRow.cells['Car Status'] ?? 'Pre Gate-in') === 'Pre Gate-in' ? (
                <div className="space-y-3">
                  {/* required OK / NG */}
                  <div>
                    <div className="text-[11.5px] font-semibold mb-1.5 flex items-center gap-1.5">
                      <AlertTriangle size={13} style={{ color: 'var(--st-damage)' }} /> ตรวจสภาพรถ (บังคับเลือก)
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => setDmgResult('NG')}
                        className="py-3 rounded-2xl text-[15px] font-bold transition active:scale-95"
                        style={dmgResult === 'NG' ? { background: '#dc2626', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
                        NG
                      </button>
                      <button onClick={() => setDmgResult('OK')}
                        className="py-3 rounded-2xl text-[15px] font-bold transition active:scale-95"
                        style={dmgResult === 'OK' ? { background: '#16a34a', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
                        OK
                      </button>
                    </div>
                  </div>

                  {dmgResult === 'NG' ? (
                    // NG → ต้องใส่ตำแหน่ง + แผล ก่อนถึงจะ Gate In ได้
                    <DamageForm
                      onSaveAll={damages => {
                        const valid = damages.filter(d => (d.area ?? '').trim())
                        if (!valid.length) { toast('err', 'กรุณาใส่ตำแหน่งตำหนิอย่างน้อย 1 จุด'); return }
                        doTrackingGateIn(valid)
                      }}
                      onCancel={() => setDmgResult(null)}
                    />
                  ) : (
                    <button
                      onClick={() => doTrackingGateIn()}
                      disabled={dmgResult !== 'OK'}
                      className="w-full h-14 rounded-2xl text-[16px] font-bold flex items-center justify-center gap-2 active:scale-95 transition-all"
                      style={dmgResult === 'OK'
                        ? { background: '#16a34a', color: '#fff', boxShadow: '0 8px 24px -6px #16a34a80' }
                        : { background: 'var(--chip)', color: 'var(--faint)', cursor: 'not-allowed' }}>
                      <CheckCircle2 size={20} /> {dmgResult === 'OK' ? 'ยืนยัน (Gate In)' : 'เลือก OK / NG ก่อน'}
                    </button>
                  )}
                </div>
              ) : (() => {
                // already gated-in — show the confirmation banner AND this car's Defect list
                const gatedUnit = allUnits.find(u => u.vin === trackRow.vin)
                const defects = gatedUnit?.damages ?? []
                return (
                  <div className="space-y-3">
                    <div className="rounded-2xl p-3 flex items-center gap-2 text-[13px] font-semibold"
                      style={{ background: 'rgba(22,163,74,0.09)', color: 'var(--st-yard)' }}>
                      <CheckCircle2 size={16} /> รถเข้าลานแล้ว
                    </div>

                    {/* ── Defect list ── */}
                    <div>
                      <div className="flex items-center gap-1.5 mb-2 text-[13px] font-semibold">
                        <AlertTriangle size={14} style={{ color: 'var(--st-damage)' }} />
                        รายการ Defect
                        {defects.length > 0 && <span className="badge" style={{ color: 'var(--st-damage)', background: '#fef2f2' }}>{defects.length}</span>}
                      </div>
                      {defects.length === 0 ? (
                        <div className="rounded-xl p-3 text-[12.5px] flex items-center gap-2" style={{ background: 'rgba(22,163,74,0.06)', color: 'var(--st-yard)' }}>
                          <CheckCircle2 size={14} /> ไม่มี Defect
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {defects.map(d => {
                            const photos = d.photos?.length ? d.photos : (d.photo ? [d.photo] : [])
                            return (
                              <div key={d.id} className="rounded-xl overflow-hidden p-3 space-y-2" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.14)' }}>
                                <div className="flex items-start gap-2">
                                  <AlertTriangle size={14} style={{ color: 'var(--st-damage)', marginTop: 2, flexShrink: 0 }} />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[12.5px] leading-snug">
                                      <span className="font-bold" style={{ color: 'var(--st-damage)' }}>{zoneLabel(d.area)}</span>
                                      <span className="font-semibold" style={{ color: 'var(--st-damage)' }}> // {d.item || TYPES.find(t => t.id === d.type)?.th || d.type || '—'}</span>
                                      {d.note && <span className="font-semibold" style={{ color: 'var(--text)' }}> · {d.note}</span>}
                                    </div>
                                  </div>
                                  {d.severity === 'major' && <span className="badge shrink-0" style={{ fontSize: 10, background: '#fee2e2', color: '#b91c1c' }}>HEAVY NG</span>}
                                </div>
                                <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px]" style={{ color: 'var(--text)' }}>
                                  <span className="flex items-center gap-1"><User size={11} /> {d.by || '—'}</span>
                                  <span className="flex items-center gap-1"><Clock size={11} /> {fmtDateTime(d.at).date} {fmtDateTime(d.at).time}</span>
                                  {d.statusRepair && <span className="badge" style={{ fontSize: 10, background: '#eef2ff', color: '#4338ca' }}>{d.statusRepair}</span>}
                                </div>
                                {photos.length > 0 && <DamagePhotoThumbs photos={photos} onOpen={i => setLightbox({ photos, index: i })} />}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        )
      })()}

      {unit && (
        <div className="space-y-3 fade-up">
          <UnitCard unit={unit} accent="var(--brand)" />

          {unit.status === 'EXPECTED' ? (
            <button
              onClick={doGateIn}
              className="w-full h-16 rounded-2xl text-[17px] font-bold text-white flex items-center justify-center gap-2 active:scale-95 transition-all"
              style={{ background: '#16a34a', boxShadow: '0 8px 24px -6px #16a34a80' }}
            >
              <CheckCircle2 size={22} /> ยืนยันเข้าลาน (Gate In)
            </button>
          ) : (
            <div className="panel p-3 flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--st-yard)' }}>
              <CheckCircle2 size={16} /> รถเข้าลานแล้ว — บันทึก walk-around ได้
            </div>
          )}

          {/* damage section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-semibold flex items-center gap-1.5">
                <AlertTriangle size={14} style={{ color: 'var(--st-damage)' }} />
                Damage {unit.damages.length > 0 && <span className="badge" style={{ color: 'var(--st-damage)', background: '#fef2f2' }}>{unit.damages.length}</span>}
              </span>
              <button onClick={() => setShowDmg(v => !v)}
                className="btn btn-ghost text-[12px] py-1 px-2.5" style={{ color: 'var(--st-damage)' }}>
                <Plus size={13} /> add damage
              </button>
            </div>
            {showDmg && (
              <DamageForm
                onSaveAll={damages => {
                  damages.forEach(d => addDamage(unit.vin, { ...d, source: 'walkaround', station: 'Gate-in' }))
                  toast('ok', damages.length > 1 ? `บันทึกตำหนิ ${damages.length} รายการ` : 'บันทึกตำหนิแล้ว')
                  setShowDmg(false)
                }}
                onCancel={() => setShowDmg(false)}
              />
            )}
            {unit.damages.map(d => (
              <div key={d.id} className="rounded-xl mb-2 overflow-hidden" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.14)' }}>
                {editId === d.id ? (
                  /* ── inline edit: position + defect text ── */
                  <div className="p-3 space-y-2">
                    <div className="grid gap-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <div>
                        <div className="text-[10px] font-bold mb-1" style={{ color: 'var(--muted)' }}>Position</div>
                        <input className="input text-[12px] w-full" style={{ padding: '6px 8px' }}
                          list={`ep-${d.id}`} placeholder="ตำแหน่ง…" value={editArea}
                          onChange={e => setEditArea(e.target.value)} />
                        <datalist id={`ep-${d.id}`}>{POSITION_OPTS.map(p => <option key={p.id} value={p.th} />)}</datalist>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold mb-1" style={{ color: 'var(--muted)' }}>Defect/NG</div>
                        <input className="input text-[12px] w-full" style={{ padding: '6px 8px' }}
                          list={`ed-${d.id}`} placeholder="รายละเอียด…" value={editDetail}
                          onChange={e => setEditDetail(e.target.value)} />
                        <datalist id={`ed-${d.id}`}>{TYPES.map(t => <option key={t.id} value={t.th} />)}</datalist>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button className="btn flex-1 text-[12px] py-1.5" onClick={() => setEditId(null)}>ยกเลิก</button>
                      <button className="btn flex-1 text-[12px] py-1.5 font-bold"
                        style={{ background: 'var(--brand)', color: '#fff', border: 'none' }}
                        onClick={() => {
                          updateDamage(unit.vin, d.id, {
                            area: (AREA_TEXT_MAP[editArea] ?? editArea) || d.area,
                            type: TYPE_TEXT_MAP[editDetail] ?? d.type,
                            note: TYPE_TEXT_MAP[editDetail] ? d.note : (editDetail || d.note),
                          })
                          setEditId(null)
                        }}>บันทึก</button>
                    </div>
                  </div>
                ) : (
                  /* ── display + interactive chip rows ── */
                  <div className="p-3 space-y-2">
                    {/* Header row */}
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={14} style={{ color: 'var(--st-damage)', marginTop: 2, flexShrink: 0 }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] leading-snug">
                          <span className="font-bold" style={{ color: 'var(--st-damage)' }}>{zoneLabel(d.area)}</span>
                          <span className="font-semibold" style={{ color: 'var(--st-damage)' }}> // {d.item || TYPES.find(t => t.id === d.type)?.th || '—'}</span>
                          {d.note && <span className="font-semibold" style={{ color: 'var(--text)' }}> · {d.note}</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => { setEditId(d.id); setEditArea(POSITION_OPTS.find(p => p.id === d.area)?.th ?? d.area); setEditDetail(d.note || (TYPES.find(t => t.id === d.type)?.th ?? '')) }}
                        className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                        style={{ background: 'rgba(255,255,255,0.8)', color: 'var(--muted)' }}>
                        <Pencil size={11} />
                      </button>
                    </div>
                    {/* สถานี / ผู้ตรวจ / วันที่ / เวลา */}
                    <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px]" style={{ color: 'var(--text)' }}>
                      <span className="flex items-center gap-1"><User size={11} /> {d.by || '—'}</span>
                      <span className="flex items-center gap-1"><Clock size={11} /> {fmtDateTime(d.at).date} {fmtDateTime(d.at).time}</span>
                    </div>
                    {/* รูปภาพ — คลิกเพื่อขยาย */}
                    {(() => {
                      const photos = d.photos?.length ? d.photos : (d.photo ? [d.photo] : [])
                      return photos.length > 0
                        ? <DamagePhotoThumbs photos={photos} onOpen={i => setLightbox({ photos, index: i })} />
                        : null
                    })()}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* recent gate-in list */}
      {recent.length > 0 && !unit && !trackRow && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2.5 border-b hairline text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>
            ตรวจรับล่าสุด
          </div>
          {recent.map(item => {
            const dt = new Date(item.time)
            const dateStr = `${dt.getDate().toString().padStart(2, '0')}/${(dt.getMonth() + 1).toString().padStart(2, '0')} ${dt.getHours().toString().padStart(2, '0')}:${dt.getMinutes().toString().padStart(2, '0')}`
            return (
              <button key={item.vin}
                onClick={() => item.isTracking ? setTrackingVin(item.vin) : setVin(item.vin)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#f8f9fb] transition-colors border-b hairline">
                <ScanLine size={14} style={{ color: 'var(--brand)', flexShrink: 0 }} />
                <div className="flex-1 min-w-0 text-left">
                  <div className="vin text-[12.5px] font-semibold">{item.vin}</div>
                  {item.modelName && (
                    <div className="text-[10.5px] truncate" style={{ color: 'var(--muted)' }}>{item.modelName}</div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{dateStr}</div>
                  {item.inspector && (
                    <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>{item.inspector}</div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
      {lightbox && <PhotoLightbox photos={lightbox.photos} index={lightbox.index} onClose={() => setLightbox(null)} />}
    </div>
  )
}

// ── driver view ───────────────────────────────────────────────────────────────
function DriveTimer({ since }: { since?: number }) {
  const [, tick] = useState(0)
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(i) }, [])
  if (!since) return null
  const s = Math.floor((Date.now() - since) / 1000)
  const m = Math.floor(s / 60)
  return (
    <span className="flex items-center gap-1 tabular font-mono text-[15px]">
      <Clock size={15} /> {m}:{String(s % 60).padStart(2, '0')}
    </span>
  )
}

// FROM → TO routing card for a process move (to a station or back to a slot)
function ProcRouteCard({ fromLabel, toLabel, result, badge, reason, accent, onStart, onAlt, altCount = 0 }: {
  fromLabel: string; toLabel: string; result?: 'OK' | 'NG'; badge: string; reason?: string
  accent: string; onStart: () => void; onAlt?: () => void; altCount?: number
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="p-5" style={{ background: 'linear-gradient(135deg,#0d1f2c,#15324a)' }}>
        <div className="text-[11px] font-bold uppercase tracking-wider mb-4 flex items-center gap-1" style={{ color: 'rgba(255,255,255,0.5)' }}>
          <Route size={11} /> {badge}
          {result && <span className="ml-auto badge text-[10px]" style={{ color: result === 'OK' ? '#4ade80' : '#f87171', background: 'rgba(255,255,255,0.08)' }}>{result}</span>}
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="text-center">
            <div className="text-[10.5px] font-bold uppercase mb-1" style={{ color: 'rgba(255,255,255,0.45)' }}>FROM</div>
            <div className="text-[18px] font-bold text-white">{fromLabel}</div>
          </div>
          <ArrowRight size={24} style={{ color: 'rgba(255,255,255,0.3)', flexShrink: 0 }} />
          <div className="text-center">
            <div className="text-[10.5px] font-bold uppercase mb-1" style={{ color: 'rgba(255,255,255,0.45)' }}>TO</div>
            <div className="display text-[28px] font-black leading-none" style={{ color: accent }}>{toLabel}</div>
          </div>
        </div>
        {reason && <div className="mt-3 text-[11.5px] text-center" style={{ color: 'rgba(255,255,255,0.4)' }}>{reason}</div>}
      </div>
      <div className="p-4 space-y-2">
        <button onClick={onStart}
          className="w-full h-14 rounded-2xl text-[16px] font-bold flex items-center justify-center gap-2 transition-all active:scale-95"
          style={{ background: accent, color: '#fff', boxShadow: `0 6px 20px -4px ${accent}88` }}>
          <Navigation size={20} /> เริ่มขับ → {toLabel}
        </button>
        {onAlt && (
          <button onClick={onAlt} disabled={altCount < 2} className="w-full h-11 rounded-xl text-[13.5px] font-semibold btn">
            <RefreshCw size={15} /> ขอตำแหน่งอื่น
          </button>
        )}
      </div>
    </div>
  )
}

function DriverView() {
  const units = useSiteUnits()
  const trips = useTrips()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const queues = useSiteQueues()
  const { loadFromIdb, updateCell } = useTracking()
  const { assign, confirmParked, resetParking, toast, currentUser, policies, groupModelsInRow, planMode, startTrip, endTrip, sites, currentSite } = useYard()
  const blocks = useBlocks()
  const { deliverToStation, returnToSlot, markAtWash, markAtLane } = useOps()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  useEffect(() => { loadFromIdb() }, [loadFromIdb])
  const siteName = sites.find((s) => s.id === currentSite)?.name ?? ''
  const locPrefix = siteGroupingConfig(siteName).prefix
  const [vin, setVin] = useState<string | null>(null)
  const [altIdx, setAltIdx] = useState(0)
  const [justParked, setJustParked] = useState<{ vin: string; sec: number } | null>(null)
  const [seqDone, setSeqDone] = useState<{ vin: string; label: string; sub: string } | null>(null)
  const driverName = currentUser // the logged-in employee IS the driver — no picker
  // active process drive (to a station or back to a slot) — runs on a PARKED car
  const [proc, setProc] = useState<{
    kind: 'to-station' | 'to-slot'; queueId: string; queueName: string
    fromLabel: string; destLabel: string; dest: { lat: number; lng: number } | null
    slot?: { block: string; row: number; slot: number }; prevStatus: string
  } | null>(null)
  const [procDone, setProcDone] = useState<{ label: string; sub: string; accent: string } | null>(null)

  // the trip that was just recorded (latest for the parked vin)
  const lastTrip = useMemo(() => {
    if (!justParked) return null
    for (let i = trips.length - 1; i >= 0; i--) if (trips[i].vin === justParked.vin) return trips[i]
    return null
  }, [trips, justParked])

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null
  useEffect(() => setAltIdx(0), [vin])

  // delivery-sequence step (Grouping to Dealer): scan #1 → Wash for sale, scan
  // #2 → the loading lane (laneLoad). Takes priority over the normal parking flow.
  const seqHit = useMemo(() => findSeqItem(vin, queues), [vin, queues])
  const doSeqWash = () => {
    if (!seqHit || !vin) return
    markAtWash(seqHit.queue.id, vin, driverName)
    updateCell(vin, 'Car Status', 'Wash for sale')
    setSeqDone({ vin, label: 'Wash for sale', sub: `${seqHit.item.dest || seqHit.queue.name} · สแกนอีกครั้งเพื่อส่งเข้า preload ${seqHit.item.laneLoad || ''}` })
    setVin(null)
  }
  const doSeqLane = () => {
    if (!seqHit || !vin) return
    const lane = seqHit.item.laneLoad || 'Loading lane'
    markAtLane(seqHit.queue.id, vin, driverName)
    updateCell(vin, 'Car Status', lane)
    setSeqDone({ vin, label: lane, sub: `ส่งถึง preload ${lane} แล้ว · รอ Gate-out` })
    setVin(null)
  }

  // ── delivery-sequence queues visible to the driver (browse + progress) ──
  const seqQueues = useMemo(() => queues.filter(isSequenceQueue), [queues])

  // the car's current station task (PDI / PM / Wash …), if any
  const activeProc = useMemo(() => (unit ? activeProcess(unit.vin, queues) : null), [unit, queues])
  const procStage = activeProc ? stageOf(activeProc.item) : null
  // a slot proposal is needed both for the gate-in first-park AND for returning a checked car
  const needsSlot = !!unit && (unit.status === 'GATE_IN' || (unit.status === 'PARKED' && procStage === 'checked'))
  const cands = useMemo(
    () => (needsSlot && unit ? candidates(unit, blocks, policies, units, groupModelsInRow) : []),
    [needsSlot, unit, blocks, policies, units, groupModelsInRow],
  )
  const proposal = cands[Math.min(altIdx, Math.max(0, cands.length - 1))] ?? null

  const onScan = (v: string) => {
    const res = resolveForUnit(v, units, trackingRows)
    if (res.type === 'ambiguous') { toast('err', `พบ ${res.count} คัน — พิมพ์ให้ยาวขึ้น`); return }
    if (res.type === 'none') { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (res.type === 'notGated') { blockGate(res.vin, res.model); return }
    setVin(res.vin)
  }
  const doAssign = (slot: { block: string; row: number; slot: number }) => {
    if (!unit) return
    assign(unit.vin, slot, driverName, planMode)
    startTrip(unit.vin, driverName, 'Gate', `${slot.block}${slot.slot}.${slot.row}`)
    toast('ok', `${unit.vin.slice(-6)} → ${slot.block}-${slot.row}-${slot.slot}`)
  }
  const doPark = () => {
    if (!unit) return
    const since = unit.drivingStartedAt
    const elapsed = since ? Math.floor((Date.now() - since) / 1000) : 0
    endTrip(unit.vin)
    confirmParked(unit.vin)
    updateCell(unit.vin, 'Car Status', `${unit.block}${unit.slot}.${unit.row}`)
    setJustParked({ vin: unit.vin, sec: elapsed })
    toast('ok', `จอดสำเร็จ · ${unit.vin}`)
  }
  const finishPark = () => { setJustParked(null); setVin(null) }
  const cancelDrive = () => {
    if (!unit) return
    endTrip(unit.vin)
    resetParking(unit.vin)
  }

  // ── process drive (PARKED car → station, or station → new slot) ──
  const startProc = (kind: 'to-station' | 'to-slot', slot?: { block: string; row: number; slot: number }) => {
    if (!unit || !activeProc) return
    const prevStatus = trackingRows.find(r => r.vin === unit.vin)?.cells['Car Status'] ?? slotLabelOf(unit)
    const fromLabel = kind === 'to-station' ? slotLabelOf(unit) : activeProc.queue.name
    const destLabel = kind === 'to-station' ? activeProc.queue.name : `${slot!.block}${slot!.slot}.${slot!.row}`
    const dest = kind === 'to-slot' && slot ? slotToLatLng(slot.block, slot.row, slot.slot) : null
    updateCell(unit.vin, 'Car Status', MOVING_STATUS)
    startTrip(unit.vin, driverName, fromLabel, destLabel)
    setProc({ kind, queueId: activeProc.queue.id, queueName: activeProc.queue.name, fromLabel, destLabel, dest, slot, prevStatus })
  }
  const arriveProc = () => {
    if (!unit || !proc) return
    endTrip(unit.vin)
    if (proc.kind === 'to-station') {
      deliverToStation(proc.queueId, unit.vin, proc.fromLabel, driverName)
      updateCell(unit.vin, 'Car Status', stationParkStatus(proc.queueName))
      setProcDone({ label: stationParkStatus(proc.queueName), sub: `ส่งเข้าสถานี ${proc.queueName} แล้ว · รอตรวจ`, accent: '#0ea5e9' })
    } else {
      if (proc.slot) { assign(unit.vin, proc.slot, driverName, planMode); confirmParked(unit.vin) }
      returnToSlot(proc.queueId, unit.vin, driverName)
      updateCell(unit.vin, 'Car Status', proc.destLabel)
      setProcDone({ label: proc.destLabel, sub: `${proc.queueName} เสร็จ · จอดที่ ${proc.destLabel}`, accent: 'var(--st-yard)' })
    }
    setProc(null)
  }
  const cancelProc = () => {
    if (unit && proc) { endTrip(unit.vin); updateCell(unit.vin, 'Car Status', proc.prevStatus) }
    setProc(null)
  }
  const finishProc = () => { setProcDone(null); setVin(null) }

  // summary after park
  if (justParked && unit) {
    const m = Math.floor(justParked.sec / 60)
    const s = String(justParked.sec % 60).padStart(2, '0')
    const color = unit.colorHex ?? '#cfd6dd'
    const path = lastTrip?.path ?? []
    const dist = lastTrip?.distanceM ?? 0
    const pts = path.length
    const maxSpeed = pts ? Math.max(0, ...path.map(p => p.speed ?? 0)) : 0
    const avgSpeed = justParked.sec > 0 ? Math.round((dist / justParked.sec) * 3.6) : 0
    const lastPt = path[pts - 1]
    return (
      <div className="fade-up space-y-3.5 pb-6">
        {/* hero — car .png + success badge */}
        <div className="flex flex-col items-center text-center pt-1">
          <div className="relative">
            <CarTopView color={color} width={118} />
            <div className="absolute bottom-1 right-0 w-9 h-9 rounded-full flex items-center justify-center pop"
              style={{ background: '#16a34a', border: '3px solid var(--app-bg)' }}>
              <CheckCircle2 size={18} color="#fff" />
            </div>
          </div>
          <div className="display text-[26px] font-bold mt-1.5">จอดสำเร็จ!</div>
          <div className="vin text-[12.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{unit.vin}</div>
        </div>

        {/* parked slot */}
        <div className="panel p-4 text-center">
          <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>ตำแหน่งจอด</div>
          <div className="display text-[36px] font-black leading-none mt-1" style={{ color: 'var(--brand)' }}>
            {unit.block}{unit.row}.{unit.slot}
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>Block {unit.block} · Row {unit.row} · Slot {unit.slot}</div>
        </div>

        {/* driving summary */}
        <div className="panel overflow-hidden">
          <div className="px-4 py-2.5 border-b hairline flex items-center gap-2">
            <Gauge size={15} style={{ color: 'var(--st-yard)' }} />
            <span className="font-semibold text-[13.5px]">สรุปการขับขี่</span>
            <span className="ml-auto text-[11px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
              <Navigation size={11} /> Gate → {unit.block}{unit.row}.{unit.slot}
            </span>
          </div>
          <div className="grid grid-cols-4 divide-x" style={{ borderColor: 'var(--line)' }}>
            {[
              { ic: <Clock size={14} />, label: 'เวลา', val: `${m}:${s}` },
              { ic: <Route size={14} />, label: 'ระยะทาง', val: dist >= 1000 ? `${(dist / 1000).toFixed(2)}กม.` : `${dist} ม.` },
              { ic: <Gauge size={14} />, label: 'เฉลี่ย', val: `${avgSpeed}`, unit: 'km/h' },
              { ic: <Zap size={14} />, label: 'สูงสุด', val: `${maxSpeed}`, unit: 'km/h' },
            ].map(x => (
              <div key={x.label} className="py-3 px-1 text-center">
                <div className="flex items-center justify-center gap-1 text-[10px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>
                  {x.ic}{x.label}
                </div>
                <div className="text-[17px] font-bold tabular leading-none" style={{ color: 'var(--text)' }}>{x.val}</div>
                {x.unit && <div className="text-[9px] mt-0.5" style={{ color: 'var(--faint)' }}>{x.unit}</div>}
              </div>
            ))}
          </div>

          {/* GPS path map */}
          {path.length > 1 && lastPt && (
            <div className="p-2 pt-0">
              <div className="relative">
                <LiveTrackingMap
                  markers={[{ vin: unit.vin, lat: lastPt.lat, lng: lastPt.lng, color: 'var(--brand)', label: `${unit.block}${unit.slot}.${unit.row}` }]}
                  path={path} focusVin={unit.vin} height={140} compact
                />
                <div className="absolute top-2.5 left-2.5 px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 z-[500]"
                  style={{ background: 'rgba(6,10,20,0.7)', color: '#fff', backdropFilter: 'blur(4px)' }}>
                  <Route size={11} /> เส้นทางที่ขับ · {pts} จุด GPS
                </div>
              </div>
            </div>
          )}
        </div>

        {/* driver + model + accuracy */}
        <div className="panel p-4 space-y-2.5 text-[13px]">
          <div className="flex items-center justify-between">
            <span style={{ color: 'var(--muted)' }}>คนขับ</span>
            <span className="font-semibold flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: 'var(--st-yard)' }}>{driverName.slice(0, 1)}</span>
              {driverName}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span style={{ color: 'var(--muted)' }}>รุ่น / สี</span>
            <span className="font-semibold">{unit.modelName} · {unit.color}</span>
          </div>
          {lastPt && (
            <div className="flex items-center justify-between">
              <span style={{ color: 'var(--muted)' }}>พิกัดล่าสุด</span>
              <span className="font-semibold vin text-[12px] flex items-center gap-1">
                <Crosshair size={12} style={{ color: 'var(--brand)' }} />
                {lastPt.lat.toFixed(5)}, {lastPt.lng.toFixed(5)}
              </span>
            </div>
          )}
        </div>

        <button onClick={finishPark}
          className="w-full h-14 rounded-2xl text-[15px] font-bold flex items-center justify-center gap-2 transition-all active:scale-95"
          style={{ background: 'var(--st-yard)', color: '#fff', boxShadow: '0 8px 24px -6px rgba(22,163,74,0.5)' }}>
          <CheckCircle2 size={20} /> เสร็จสิ้น · ขับคันต่อไป
        </button>
      </div>
    )
  }

  // process-move success (delivered to station / parked back at a slot)
  if (procDone && unit) {
    return (
      <div className="fade-up space-y-4 pb-6 text-center pt-2">
        <div className="relative inline-block">
          <CarTopView color={unit.colorHex ?? '#cfd6dd'} width={112} />
          <div className="absolute bottom-1 right-0 w-9 h-9 rounded-full flex items-center justify-center pop"
            style={{ background: procDone.accent, border: '3px solid var(--app-bg)' }}>
            <CheckCircle2 size={18} color="#fff" />
          </div>
        </div>
        <div>
          <div className="display text-[24px] font-bold">สำเร็จ!</div>
          <div className="vin text-[12.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{unit.vin}</div>
        </div>
        <div className="panel p-5">
          <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Car Status</div>
          <div className="display text-[30px] font-black leading-none mt-1" style={{ color: procDone.accent }}>{procDone.label}</div>
          <div className="text-[12px] mt-2" style={{ color: 'var(--muted)' }}>{procDone.sub}</div>
        </div>
        <button onClick={finishProc}
          className="w-full h-14 rounded-2xl text-[15px] font-bold flex items-center justify-center gap-2 transition-all active:scale-95"
          style={{ background: 'var(--st-yard)', color: '#fff', boxShadow: '0 8px 24px -6px rgba(22,163,74,0.5)' }}>
          <CheckCircle2 size={20} /> เสร็จสิ้น · ขับคันต่อไป
        </button>
      </div>
    )
  }

  // process drive screen (reuses the Tesla-style HUD; dest may be null for a station)
  if (proc && unit) {
    return (
      <DrivingScreen
        unit={unit}
        driverName={driverName}
        dest={proc.dest}
        destLabel={proc.destLabel}
        fromLabel={proc.fromLabel}
        onArrive={arriveProc}
        onCancel={cancelProc}
      />
    )
  }

  // delivery-sequence step confirmed → success, ready to scan the next car
  if (seqDone) {
    return (
      <div className="fade-up space-y-4 pb-6 text-center pt-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: 'rgba(22,163,74,0.14)' }}>
          <CheckCircle2 size={32} style={{ color: 'var(--st-yard)' }} />
        </div>
        <div>
          <div className="display text-[24px] font-bold">ยืนยันแล้ว!</div>
          <div className="vin text-[12.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{seqDone.vin}</div>
        </div>
        <div className="panel p-5">
          <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>ตำแหน่งใหม่</div>
          <div className="display text-[30px] font-black leading-none mt-1" style={{ color: 'var(--st-yard)' }}>{seqDone.label}</div>
          <div className="text-[12px] mt-2" style={{ color: 'var(--muted)' }}>{seqDone.sub}</div>
        </div>
        <button onClick={() => setSeqDone(null)}
          className="w-full h-14 rounded-2xl text-[15px] font-bold flex items-center justify-center gap-2 transition-all active:scale-95"
          style={{ background: 'var(--st-yard)', color: '#fff', boxShadow: '0 8px 24px -6px rgba(22,163,74,0.5)' }}>
          <CheckCircle2 size={20} /> เสร็จสิ้น · สแกนคันต่อไป
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* driver = the logged-in employee (recorded automatically) */}
      <div className="panel px-4 py-2.5 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-white text-[12px] shrink-0"
          style={{ background: 'var(--st-yard)' }}>{driverName.slice(0, 1)}</div>
        <div className="min-w-0">
          <div className="text-[10.5px] font-bold uppercase" style={{ color: 'var(--muted)' }}>คนขับ</div>
          <div className="text-[14px] font-semibold clip">{driverName}</div>
        </div>
        <User size={16} style={{ color: 'var(--muted)' }} className="ml-auto shrink-0" />
      </div>

      <VinInput onScan={onScan} accent="var(--st-yard)" />
      {gateModal}

      {/* ── delivery-sequence queues (browse the run + car details before scanning) ── */}
      {!unit && !seqHit && (
        <SeqQueuePicker queues={seqQueues} units={units} trackingRows={trackingRows} locPrefix={locPrefix} />
      )}

      {/* ── delivery-sequence step (takes over from the normal parking flow) ── */}
      {unit && seqHit && (() => {
        const st = seqStageOf(seqHit.item)
        const curSlot = unit.block ? `${unit.block}${unit.slot}.${unit.row}` : '—'
        const lane = seqHit.item.laneLoad || 'preload'
        const from = st === 'queued' ? curSlot : 'Wash for sale'
        const to = st === 'queued' ? 'Wash for sale' : `Preload ${lane}`
        const waiting = st === 'lane' || st === 'gateout'
        return (
          <div className="space-y-3 fade-up">
            <UnitCard unit={unit} accent="var(--st-yard)" />
            <div className="panel overflow-hidden">
              <div className="px-4 py-2.5 border-b hairline flex items-center gap-2">
                <ListChecks size={15} style={{ color: 'var(--brand)' }} />
                <span className="font-semibold text-[12.5px] clip">{seqHit.queue.name}</span>
                {seqHit.item.laneLoad && <span className="badge ml-auto shrink-0" style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>{seqHit.item.laneLoad}</span>}
              </div>
              {waiting ? (
                <div className="p-6 text-center">
                  <div className="text-[13.5px] font-semibold" style={{ color: 'var(--st-yard)' }}>ส่งถึง preload {lane} แล้ว</div>
                  <div className="text-[12px] mt-1" style={{ color: 'var(--muted)' }}>รอ Gate-out เพื่อปิดงาน</div>
                </div>
              ) : (
                <>
                  <div className="p-5" style={{ background: 'linear-gradient(135deg,#0d1f0f,#1a3b1d)' }}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-center">
                        <div className="text-[10.5px] font-bold uppercase mb-1" style={{ color: 'rgba(255,255,255,0.45)' }}>FROM</div>
                        <div className="text-[18px] font-bold text-white">{from}</div>
                      </div>
                      <ArrowRight size={24} style={{ color: 'rgba(255,255,255,0.3)', flexShrink: 0 }} />
                      <div className="text-center">
                        <div className="text-[10.5px] font-bold uppercase mb-1" style={{ color: 'rgba(255,255,255,0.45)' }}>TO</div>
                        <div className="text-[26px] font-black leading-none" style={{ color: '#4ade80' }}>{to}</div>
                      </div>
                    </div>
                    {seqHit.item.dest && <div className="mt-3 text-[11.5px] text-center clip" style={{ color: 'rgba(255,255,255,0.45)' }}>ปลายทาง: {seqHit.item.dest}</div>}
                  </div>
                  <div className="p-4">
                    <button onClick={st === 'queued' ? doSeqWash : doSeqLane}
                      className="w-full h-14 rounded-2xl text-[15px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                      style={{ background: 'var(--st-yard)', boxShadow: '0 6px 20px -4px rgba(22,163,74,0.55)' }}>
                      <CheckCircle2 size={20} /> ยืนยัน · ส่งไป {to}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {unit && !seqHit && (
        <div className="space-y-3 fade-up">
          <UnitCard unit={unit} accent="var(--st-yard)" />

          {unit.status === 'GATE_IN' && proposal && (
            <div className="panel overflow-hidden">
              {/* FROM → TO */}
              <div className="p-5" style={{ background: 'linear-gradient(135deg,#0d1f0f,#1a3b1d)' }}>
                <div className="text-[11px] font-bold uppercase tracking-wider mb-4" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {planMode === 'AUTO' ? <span className="flex items-center gap-1"><Zap size={11} /> AUTO PLAN</span> : <span className="flex items-center gap-1"><Hand size={11} /> SEMI PLAN</span>}
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-center">
                    <div className="text-[10.5px] font-bold uppercase mb-1" style={{ color: 'rgba(255,255,255,0.45)' }}>FROM</div>
                    <div className="text-[16px] font-bold text-white">Preload</div>
                    <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.45)' }}>บริเวณ Gate</div>
                  </div>
                  <ArrowRight size={24} style={{ color: 'rgba(255,255,255,0.3)', flexShrink: 0 }} />
                  <div className="text-center">
                    <div className="text-[10.5px] font-bold uppercase mb-1" style={{ color: 'rgba(255,255,255,0.45)' }}>TO</div>
                    <div className="text-[28px] font-black leading-none" style={{ color: '#4ade80' }}>
                      {proposal.block}{proposal.row}.{proposal.slot}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>Block {proposal.block} · Row {proposal.row} · Slot {proposal.slot}</div>
                  </div>
                </div>
                {proposal.reason && (
                  <div className="mt-3 text-[11.5px] text-center" style={{ color: 'rgba(255,255,255,0.4)' }}>{proposal.reason}</div>
                )}
              </div>
              <div className="p-4 space-y-2">
                <button onClick={() => doAssign(proposal)}
                  className="w-full h-14 rounded-2xl text-[16px] font-bold flex items-center justify-center gap-2 transition-all active:scale-95"
                  style={{ background: 'var(--st-yard)', color: '#fff', boxShadow: '0 6px 20px -4px rgba(22,163,74,0.5)' }}>
                  <Navigation size={20} /> เริ่มขับ → {proposal.block}{proposal.row}.{proposal.slot}
                </button>
                <button onClick={() => setAltIdx(i => (i + 1) % Math.max(1, cands.length))}
                  disabled={cands.length < 2}
                  className="w-full h-11 rounded-xl text-[13.5px] font-semibold btn">
                  <RefreshCw size={15} /> ขอตำแหน่งอื่น
                </button>
              </div>
            </div>
          )}

          {unit.status === 'GATE_IN' && !proposal && (
            <div className="panel p-6 text-center" style={{ color: 'var(--st-damage)' }}>
              ไม่มีตำแหน่งว่างตามกฎ
            </div>
          )}

          {unit.status === 'ASSIGNED' && (
            <DrivingScreen
              unit={unit}
              driverName={unit.driver ?? driverName}
              dest={slotToLatLng(unit.block, unit.row, unit.slot)}
              destLabel={`${unit.block}${unit.slot}.${unit.row}`}
              onArrive={doPark}
              onCancel={cancelDrive}
            />
          )}

          {/* ── process: deliver a parked car to its station (PDI / PM / Wash …) ── */}
          {unit.status === 'PARKED' && activeProc && procStage === 'queued' && (
            <ProcRouteCard
              badge={`ส่งเข้าสถานี · ${activeProc.queue.name}`}
              fromLabel={slotLabelOf(unit)}
              toLabel={activeProc.queue.name}
              accent="#0ea5e9"
              reason={`นำรถจาก ${slotLabelOf(unit)} ไปสถานี ${activeProc.queue.name}`}
              onStart={() => startProc('to-station')}
            />
          )}

          {/* ── process: car is at the station, waiting for staff to record ── */}
          {unit.status === 'PARKED' && activeProc && procStage === 'at-station' && (
            <div className="panel p-6 text-center" style={{ borderColor: '#0ea5e9' }}>
              <Clock size={30} className="mx-auto mb-2" style={{ color: '#0ea5e9' }} />
              <div className="font-bold text-[15px]">อยู่ที่สถานี {activeProc.queue.name}</div>
              <div className="text-[12.5px] mt-1" style={{ color: 'var(--muted)' }}>รอพนักงาน {activeProc.queue.name} สแกนบันทึก OK / NG</div>
            </div>
          )}

          {/* ── process: car checked → drive it back to a parking slot ── */}
          {unit.status === 'PARKED' && activeProc && procStage === 'checked' && proposal && (
            <ProcRouteCard
              badge={`${activeProc.queue.name} เสร็จ · นำกลับไปจอด`}
              fromLabel={activeProc.queue.name}
              toLabel={`${proposal.block}${proposal.slot}.${proposal.row}`}
              result={activeProc.item.result}
              reason={proposal.reason}
              accent="var(--st-yard)"
              onStart={() => startProc('to-slot', proposal)}
              onAlt={() => setAltIdx(i => (i + 1) % Math.max(1, cands.length))}
              altCount={cands.length}
            />
          )}
          {unit.status === 'PARKED' && activeProc && procStage === 'checked' && !proposal && (
            <div className="panel p-6 text-center" style={{ color: 'var(--st-damage)' }}>ไม่มีตำแหน่งว่างตามกฎ</div>
          )}

          {/* ── parked, no pending station task ── */}
          {unit.status === 'PARKED' && !activeProc && (
            <div className="panel p-6 text-center" style={{ borderColor: 'var(--st-yard)' }}>
              <CheckCircle2 size={32} className="mx-auto mb-2" style={{ color: 'var(--st-yard)' }} />
              <div className="font-bold text-[15px]">จอดแล้ว · {slotLabelOf(unit)}</div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--muted)' }}>ไม่มีคิวงานค้าง</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Final Check / PDI inspection form ─────────────────────────────────────────
const FINAL_CHECK_ITEMS = [
  'ภายนอกตัวถัง', 'สี / พื้นผิว', 'ภายในห้องโดยสาร', 'ไฟส่องสว่าง', 'ยาง / ล้อ',
  'ระบบเบรก', 'ระบบไฟฟ้า', 'แบตเตอรี่ / การชาร์จ', 'ระบบปรับอากาศ', 'การทำงานทั่วไป', 'อื่นๆ',
]

/** Read an image File, downscale to maxW, and return a compressed JPEG dataURL. */
function compressToDataUrl(file: File, maxW = 900): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width)
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.7))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

/** Compress, then push to R2 — every photo-capture path funnels through here.
 *  Returns the short R2 URL, or the data-URL itself when upload isn't possible. */
async function compressImage(file: File, maxW = 900): Promise<string> {
  return storePhoto(await compressToDataUrl(file, maxW))
}

type NgEntry = { item: string; pos: string; remark: string; photo?: string }

function FinalCheckPanel({ unit, row, activeProc, canRecord, onSaved }: {
  unit: Unit
  row: TrackRow | null
  activeProc: { queue: WorkQueue; item: QueueItem } | null
  canRecord: boolean
  onSaved: (label: string, result: 'OK' | 'NG') => void
}) {
  const { addDamage, setInspected, currentUser, toast } = useYard()
  const { updateCell } = useTracking()
  const { recordCheck } = useOps()
  const [soc, setSoc] = useState('')
  const [mileage, setMileage] = useState('')
  const [voltage, setVoltage] = useState('')
  const [ngItem, setNgItem] = useState('')
  const [ngPos, setNgPos] = useState('')
  const [ngRemark, setNgRemark] = useState('')
  const [ngPhoto, setNgPhoto] = useState<string | undefined>(undefined)
  const [ngList, setNgList] = useState<NgEntry[]>([])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const last = (k: string) => (row?.cells[k]?.trim() ? row.cells[k] : '—')
  const stationName = activeProc?.queue.name ?? 'PDI'

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setBusy(true)
    try { setNgPhoto(await compressImage(f)) } catch { toast('err', 'อ่านรูปไม่สำเร็จ') }
    setBusy(false)
  }
  const addNg = () => {
    const item = ngItem.trim(), posRaw = ngPos.trim()
    if (!item || !posRaw) { toast('err', 'เลือกรายการตรวจสอบและตำแหน่ง'); return }
    // dropdown shows Thai zone labels — map a matched label back to its zone id
    // (so it pins on the car diagram); a free-typed value passes through as-is.
    const pos = POSITION_OPTS.find(p => p.th === posRaw)?.id ?? posRaw
    setNgList(l => [...l, { item, pos, remark: ngRemark.trim(), photo: ngPhoto }])
    setNgItem(''); setNgPos(''); setNgRemark(''); setNgPhoto(undefined)
  }
  const removeNg = (i: number) => setNgList(l => l.filter((_, idx) => idx !== i))
  const clearAll = () => {
    setSoc(''); setMileage(''); setVoltage('')
    setNgItem(''); setNgPos(''); setNgRemark(''); setNgPhoto(undefined); setNgList([])
  }

  const save = () => {
    // measurements → tracking cells
    if (row) {
      if (soc.trim())     updateCell(row.vin, '% SOC', soc.trim())
      if (mileage.trim()) updateCell(row.vin, 'Mileage', mileage.trim())
      if (voltage.trim()) updateCell(row.vin, 'Voltage of 12V', voltage.trim())
    }
    // NG findings → damages (with photo + inspection item)
    ngList.forEach(n => addDamage(unit.vin, {
      area: n.pos, type: 'inspection', severity: 'major',
      note: n.remark || undefined, photo: n.photo, item: n.item, source: 'pdi', station: stationName,
    }))
    const result: 'OK' | 'NG' = ngList.length > 0 ? 'NG' : 'OK'
    if (canRecord && activeProc) recordCheck(activeProc.queue.id, unit.vin, result, currentUser)
    else setInspected(unit.vin, result === 'OK')
    if (row) updateCell(row.vin, 'Car Status', stationResultStatus(stationName, result))
    onSaved(stationResultStatus(stationName, result), result)
  }

  const Meas = ({ label, value, onChange, unit: u, lastVal }: { label: string; value: string; onChange: (v: string) => void; unit?: string; lastVal: string }) => (
    <div>
      <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>{label}</div>
      <div className="flex items-center gap-2">
        <input className="input flex-1 text-[13px]" inputMode="decimal" placeholder="กรอกค่า…" value={value} onChange={e => onChange(e.target.value)} />
        {u && <span className="text-[11px] shrink-0" style={{ color: 'var(--faint)' }}>{u}</span>}
        <span className="text-[11px] shrink-0 px-2 py-1 rounded-md" style={{ background: 'var(--chip)', color: 'var(--muted)', minWidth: 56, textAlign: 'center' }}>{lastVal}</span>
      </div>
    </div>
  )

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 border-b hairline flex items-center gap-2" style={{ background: 'linear-gradient(135deg,#5b21b6,#7c3aed)' }}>
        <ShieldCheck size={15} color="#fff" />
        <span className="font-bold text-[13.5px] text-white">Final Check · {stationName}</span>
      </div>

      {/* measurements */}
      <div className="p-4 space-y-3 border-b hairline">
        <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>ค่าที่วัดได้ <span style={{ color: 'var(--faint)' }}>· ล่าสุดทางขวา</span></div>
        <Meas label="% SOC" value={soc} onChange={setSoc} unit="%" lastVal={last('% SOC')} />
        <Meas label="Mileage" value={mileage} onChange={setMileage} unit="กม." lastVal={last('Mileage')} />
        <Meas label="Voltage of 12V" value={voltage} onChange={setVoltage} unit="V" lastVal={last('Voltage of 12V')} />
      </div>

      {/* NG entry */}
      <div className="p-4 space-y-2.5 border-b hairline" style={{ background: '#fbfaff' }}>
        <div className="badge text-[11px] w-fit" style={{ background: 'rgba(124,58,237,0.1)', color: '#7c3aed' }}>NG · เพิ่มรายการตรวจพบ</div>
        <div>
          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>รายการตรวจสอบ</div>
          <input list="fc-check-items" className="input w-full text-[13px]" placeholder="พิมพ์หรือเลือก…" value={ngItem} onChange={e => setNgItem(e.target.value)} />
          <datalist id="fc-check-items">{FINAL_CHECK_ITEMS.map(it => <option key={it} value={it} />)}</datalist>
        </div>
        <div>
          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>ตำแหน่ง</div>
          <input list="fc-check-pos" className="input w-full text-[13px]" placeholder="พิมพ์หรือเลือก…" value={ngPos} onChange={e => setNgPos(e.target.value)} />
          <datalist id="fc-check-pos">{POSITION_OPTS.map(p => <option key={p.id} value={p.th} />)}</datalist>
        </div>
        <div>
          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>หมายเหตุ (Remark)</div>
          <input className="input w-full text-[13px]" placeholder="รายละเอียด…" value={ngRemark} onChange={e => setNgRemark(e.target.value)} />
        </div>
        <div className="flex items-center gap-2.5">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={pickPhoto} />
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            className="btn px-3 py-2 text-[12.5px] font-semibold" style={{ background: 'var(--chip)' }}>
            <Camera size={15} /> {busy ? 'กำลังอ่าน…' : ngPhoto ? 'เปลี่ยนรูป' : 'เพิ่มรูปภาพ'}
          </button>
          {ngPhoto && <img src={ngPhoto} alt="" className="w-10 h-10 rounded-lg object-cover" style={{ border: '1px solid var(--line)' }} />}
          <button onClick={addNg} className="btn btn-primary px-4 py-2 text-[13px] ml-auto"><Plus size={15} /> Add</button>
        </div>
      </div>

      {/* NG table */}
      <div className="border-b hairline">
        {ngList.length === 0 ? (
          <div className="py-8 text-center text-[12.5px]" style={{ color: 'var(--faint)' }}>— ยังไม่มีรายการ NG —</div>
        ) : (
          <div className="divide-y">
            {ngList.map((n, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-[11px] font-bold shrink-0 w-5 text-center" style={{ color: 'var(--muted)' }}>{i + 1}</span>
                {n.photo
                  ? <img src={n.photo} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                  : <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--chip)' }}><Camera size={14} style={{ color: 'var(--faint)' }} /></div>}
                <div className="flex-1 min-w-0 text-[12px]">
                  <div className="font-semibold truncate">{n.item} · {zoneLabel(n.pos)}</div>
                  <div style={{ color: 'var(--muted)' }} className="truncate">
                    <span style={{ color: '#dc2626', fontWeight: 700 }}>NG</span>{n.remark ? ` · ${n.remark}` : ''}
                  </div>
                </div>
                <button onClick={() => removeNg(i)} className="btn p-1.5 shrink-0" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* actions */}
      <div className="p-3 grid grid-cols-2 gap-2">
        <button onClick={clearAll} className="btn py-3 text-[13.5px]">Clear</button>
        <button onClick={save} className="btn py-3 text-[13.5px] font-bold" style={{ background: ngList.length ? '#dc2626' : 'var(--st-yard)', color: '#fff', border: 'none' }}>
          <CheckCircle2 size={16} /> Save {ngList.length ? `· NG (${ngList.length})` : '· OK'}
        </button>
      </div>
    </div>
  )
}

// ── pdi view ──────────────────────────────────────────────────────────────────
function PdiView() {
  const units = useSiteUnits()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const queues = useSiteQueues()
  const sites = useYard(s => s.sites)
  const currentSite = useYard(s => s.currentSite)
  const locPrefix = siteGroupingConfig(sites.find(s => s.id === currentSite)?.name ?? '').prefix
  const { loadFromIdb } = useTracking()
  const { setInspected, removeDamage, toast } = useYard()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  useEffect(() => { loadFromIdb() }, [loadFromIdb])
  const [vin, setVin] = useState<string | null>(null)
  const [justOk, setJustOk] = useState(false)
  const [okLabel, setOkLabel] = useState('PDI OK')
  const [okResult, setOkResult] = useState<'OK' | 'NG'>('OK')
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)

  // admin process queues (PDI / FINAL PM / Wash …) — NOT the Pre Gate-in ones
  const procQueues = useMemo(() => queues.filter(q => !isPreGateInQueue(q.name) && q.items.length > 0), [queues])
  const selectedQueue = selectedQueueId ? queues.find(q => q.id === selectedQueueId) ?? null : null
  const queueCars = useMemo(() => {
    if (!selectedQueue) return [] as { vin: string; model: string; color: string; grouping: string; location: string; stage: string }[]
    return selectedQueue.items.filter(i => !i.done).map(i => {
      const u = units.find(x => x.vin === i.vin)
      const row = trackingRows.find(r => r.vin === i.vin)
      return {
        vin: i.vin,
        model: u?.modelName ?? row?.cells['Model name'] ?? row?.cells['Model'] ?? '—',
        color: row?.cells['Color'] ?? u?.color ?? '—',
        grouping: row?.cells['Grouping  Number'] || '—',
        location: yardLocCode(u, locPrefix) || '—',
        stage: stageOf(i),
      }
    }).sort((a, b) => byYardLocation(a.location, b.location))
  }, [selectedQueue, units, trackingRows, locPrefix])

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null
  // the station task this car is currently in (PDI / FINAL PM / Wash …)
  const activeProc = useMemo(() => (unit ? activeProcess(unit.vin, queues) : null), [unit, queues])
  const procStage = activeProc ? stageOf(activeProc.item) : null
  const canRecord = !!activeProc && procStage !== 'checked'   // station task not yet recorded
  const walkDmgs = unit ? walkAroundDamages(unit) : []                              // found at gate-in
  const otherDmgs = unit ? unit.damages.filter(d => d.source && d.source !== 'walkaround') : [] // PDI / ช่าง

  const onScan = (v: string) => {
    const res = resolveForUnit(v, units, trackingRows)
    if (res.type === 'ambiguous') { toast('err', `พบ ${res.count} คัน — พิมพ์ให้ยาวขึ้น`); return }
    if (res.type === 'none') { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (res.type === 'notGated') { blockGate(res.vin, res.model); return }
    setVin(res.vin); setJustOk(false)
  }
  // called by FinalCheckPanel after it records the inspection (OK / NG)
  const onSaved = (label: string, result: 'OK' | 'NG') => {
    setOkLabel(label); setOkResult(result)
    toast(result === 'NG' ? 'err' : 'ok', `${label} · ${vin ?? ''}`)
    setJustOk(true)
    setTimeout(() => { setJustOk(false); setVin(null) }, 2600)
  }
  const doReleaseNg = (id: string) => {
    if (!unit) return
    removeDamage(unit.vin, id)
    if (unit.damages.length === 1) setInspected(unit.vin, true)
    toast('ok', 'ปลด NG แล้ว')
  }

  if (justOk && unit) {
    const ng = okResult === 'NG'
    return (
      <div className="flex flex-col items-center gap-5 py-10 fade-up text-center">
        <div className="w-24 h-24 rounded-full flex items-center justify-center pop" style={{ background: ng ? 'rgba(220,38,38,0.14)' : 'rgba(22,163,74,0.15)' }}>
          {ng ? <XCircle size={44} style={{ color: 'var(--st-damage)' }} /> : <ShieldCheck size={44} style={{ color: 'var(--st-yard)' }} />}
        </div>
        <div>
          <div className="display text-[28px] font-bold" style={{ color: ng ? 'var(--st-damage)' : 'var(--st-yard)' }}>{okLabel} {ng ? '' : '✓'}</div>
          <div className="text-[14px] mt-1" style={{ color: 'var(--muted)' }}>{unit.vin.slice(-8)} · {unit.modelName}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── process queues (PDI / FINAL PM / Wash …) — vertical stacked cards
             that expand into their car list, same shape as the Gate-out runs ── */}
      {procQueues.length > 0 && !unit && (
        <div className="space-y-2.5 fade-up">
          {procQueues.map(q => {
            const done = q.items.filter(i => i.done).length
            const total = q.items.length
            const remaining = total - done
            const isOpen = q.id === selectedQueueId
            return (
              <div key={q.id} className="panel overflow-hidden">
                <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setSelectedQueueId(isOpen ? null : q.id)}>
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--brand-soft,#eef4ff)', color: '#7c3aed' }}>
                    <ClipboardList size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-[12.5px] clip">{q.name}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                      <b style={{ color: 'var(--text)' }}>{done}/{total}</b> คัน · เหลือ <b style={{ color: remaining > 0 ? '#d97706' : '#16a34a' }}>{remaining}</b>
                    </div>
                  </div>
                  <ChevronLeft size={16} style={{ color: 'var(--muted)', transform: isOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
                </button>
                {isOpen && (queueCars.length > 0 ? (
                  <div className="border-t hairline max-h-72 overflow-y-auto divide-y" style={{ borderColor: 'var(--line)' }}>
                    {queueCars.map(item => (
                      <button key={item.vin} onClick={() => { setVin(item.vin); setJustOk(false) }}
                        className="flex items-center gap-3 px-4 py-2.5 w-full text-left transition active:bg-chip">
                        <div className="flex-1 min-w-0">
                          <div className="vin text-[12.5px] font-bold clip">{item.vin}</div>
                          <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: 'var(--muted)' }}>
                            <span>{item.model}</span><span>· {item.color}</span><span>· {item.grouping}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="tabular text-[12px] font-bold">{item.location}</div>
                          <span className="badge text-[10px] mt-0.5 inline-block" style={item.stage === 'at-station'
                            ? { background: 'rgba(14,165,233,0.12)', color: '#0ea5e9' }
                            : item.stage === 'checked' ? { background: 'rgba(22,163,74,0.12)', color: '#16a34a' }
                            : { background: 'var(--chip)', color: 'var(--muted)' }}>
                            {item.stage === 'at-station' ? 'พร้อมตรวจ' : item.stage === 'checked' ? 'ตรวจแล้ว' : 'รอส่ง'}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-4 py-3 border-t hairline text-[12px] font-semibold" style={{ color: '#16a34a' }}>✓ เสร็จครบแล้ว!</div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      <VinInput onScan={onScan} accent="#7c3aed" />
      {gateModal}

      {unit && (
        <div className="space-y-3 fade-up">
          <UnitCard unit={unit} accent="#7c3aed" />

          {/* station context — which queue this scan records into */}
          {activeProc && (
            <div className="panel p-3 flex items-center gap-2.5" style={{ borderLeft: '4px solid #7c3aed' }}>
              <ClipboardList size={16} style={{ color: '#7c3aed' }} />
              <div className="flex-1 min-w-0">
                <div className="font-bold text-[13.5px]">สถานี: {activeProc.queue.name}</div>
                <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                  {procStage === 'checked'
                    ? <>บันทึกแล้ว · ผล <b style={{ color: activeProc.item.result === 'NG' ? '#dc2626' : 'var(--st-yard)' }}>{activeProc.item.result}</b></>
                    : procStage === 'at-station' ? 'รถถึงสถานีแล้ว · พร้อมบันทึก OK / NG' : 'ยังไม่ได้นำรถเข้าสถานี (บันทึกได้)'}
                </div>
              </div>
              <span className="badge text-[11px]" style={{ background: 'rgba(124,58,237,0.1)', color: '#7c3aed' }}>{activeProc.queue.name}</span>
            </div>
          )}

          {/* PDI status — reflects the station queue, not the gate-in flag */}
          {activeProc && procStage !== 'checked' && (
            <div className="panel p-3 flex items-center gap-2 font-semibold text-[13.5px]" style={{ color: '#d97706' }}>
              <Clock size={17} /> รอตรวจ {activeProc.queue.name} (Waiting)
            </div>
          )}
          {activeProc && procStage === 'checked' && (
            <div className="panel p-3 flex items-center gap-2 font-semibold text-[13.5px]"
              style={{ color: activeProc.item.result === 'NG' ? 'var(--st-damage)' : 'var(--st-yard)' }}>
              {activeProc.item.result === 'NG' ? <XCircle size={17} /> : <ShieldCheck size={17} />}
              {activeProc.queue.name} · {activeProc.item.result}
            </div>
          )}
          {!activeProc && unit.inspected && unit.damages.length === 0 && (
            <div className="panel p-3 flex items-center gap-2 font-semibold text-[13.5px]" style={{ color: 'var(--st-yard)' }}>
              <ShieldCheck size={17} /> ผ่านการตรวจแล้ว (OK)
            </div>
          )}

          {/* ── Walk around (gate-in) result — so PDI sees the damages found ── */}
          {walkDmgs.length === 0 ? (
            <div className="panel p-3 flex items-center gap-2 font-semibold text-[13.5px]" style={{ color: 'var(--st-yard)' }}>
              <ShieldCheck size={17} /> Walk around · OK
            </div>
          ) : (
            <div className="panel overflow-hidden">
              <div className="px-4 py-2.5 border-b hairline text-[12.5px] font-bold flex items-center gap-2"
                style={{ background: '#fff8f8', color: 'var(--st-damage)' }}>
                <AlertTriangle size={14} /> Walk around · NG ({walkDmgs.length})
              </div>
              {walkDmgs.map(d => (
                <div key={d.id} className="flex items-center gap-2.5 px-4 py-2.5 border-b hairline last:border-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.severity === 'major' ? '#dc2626' : '#d97706' }} />
                  <div className="flex-1 min-w-0 text-[12.5px]">
                    <span className="font-semibold">{zoneLabel(d.area)}</span>
                    <span style={{ color: 'var(--muted)' }}> · {TYPES.find(t => t.id === d.type)?.th ?? d.type}</span>
                    {d.note ? <span style={{ color: 'var(--muted)' }}> · {d.note}</span> : null}
                  </div>
                  <span className="badge text-[10px] shrink-0" style={{ color: d.severity === 'major' ? '#dc2626' : '#d97706', background: d.severity === 'major' ? 'rgba(220,38,38,0.1)' : 'rgba(217,119,6,0.1)' }}>
                    {d.severity === 'major' ? 'Heavy NG' : 'NG'}
                  </span>
                  <button onClick={() => doReleaseNg(d.id)} className="px-2.5 py-1 rounded-lg text-[11px] font-bold shrink-0" style={{ background: 'var(--st-yard)', color: '#fff' }}>ปลด</button>
                </div>
              ))}
            </div>
          )}

          {/* Final Check inspection form (measurements + NG + photos) */}
          <FinalCheckPanel
            unit={unit}
            row={trackingRows.find(r => r.vin === unit.vin) ?? null}
            activeProc={activeProc}
            canRecord={canRecord}
            onSaved={onSaved}
          />

          {/* NG added later at PDI / by mechanic (walk-around NG is shown above) */}
          {otherDmgs.length > 0 && (
            <div className="panel overflow-hidden">
              <div className="px-4 py-2.5 border-b hairline text-[12px] font-semibold flex items-center gap-2"
                style={{ background: '#fff8f8', color: 'var(--st-damage)' }}>
                <AlertTriangle size={13} /> NG เพิ่มเติม · PDI / ช่าง ({otherDmgs.length})
              </div>
              {otherDmgs.map(d => (
                <div key={d.id} className="flex items-center gap-3 px-4 py-3 border-b hairline">
                  {d.photo ? <img src={d.photo} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" /> :
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: '#fef2f2' }}>
                      <AlertTriangle size={16} style={{ color: 'var(--st-damage)' }} />
                    </div>}
                  <div className="flex-1 min-w-0 text-[12.5px]">
                    <div className="font-semibold">{zoneLabel(d.area)} · {d.item ?? TYPES.find(t => t.id === d.type)?.th ?? d.type}</div>
                    <div style={{ color: d.severity === 'major' ? '#dc2626' : '#d97706' }}>
                      {d.severity === 'major' ? 'Heavy NG' : 'NG'}{d.note ? ` · ${d.note}` : ''}
                    </div>
                  </div>
                  <button onClick={() => doReleaseNg(d.id)}
                    className="px-3 py-1.5 rounded-xl text-[12px] font-bold transition-all"
                    style={{ background: 'var(--st-yard)', color: '#fff' }}>
                    ปลด NG
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── mechanic view ─────────────────────────────────────────────────────────────
function MechanicView() {
  const units = useSiteUnits()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const { loadFromIdb } = useTracking()
  const { addDamage, removeDamage, setInspected, toast } = useYard()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  const sites = useYard(s => s.sites)
  const currentSite = useYard(s => s.currentSite)
  const locPrefix = siteGroupingConfig(sites.find(s => s.id === currentSite)?.name ?? '').prefix
  useEffect(() => { loadFromIdb() }, [loadFromIdb])
  const [vin, setVin] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [listOpen, setListOpen] = useState(true)

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null

  // repair queue — every car in this yard with an unrepaired NG, so the mechanic
  // can browse the outstanding list (same card style as the other stations) and
  // tap one to work on it, instead of only scanning one at a time
  const ngCars = useMemo(() => units
    .map(u => ({ u, open: u.damages.filter(d => !d.repairDate).length }))
    .filter(x => x.open > 0)
    .map(({ u, open }) => ({
      vin: u.vin,
      model: u.modelName || '—',
      color: u.color || '—',
      grouping: trackingRows.find(r => r.vin === u.vin)?.cells['Grouping  Number'] || '—',
      location: yardLocCode(u, locPrefix) || '—',
      open,
    }))
    .sort((a, b) => byYardLocation(a.location, b.location)),
    [units, trackingRows, locPrefix])

  const onScan = (v: string) => {
    const res = resolveForUnit(v, units, trackingRows)
    if (res.type === 'ambiguous') { toast('err', `พบ ${res.count} คัน — พิมพ์ให้ยาวขึ้น`); return }
    if (res.type === 'none') { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (res.type === 'notGated') { blockGate(res.vin, res.model); return }
    setVin(res.vin); setShowForm(false)
  }
  const doRelease = (id: string) => {
    if (!unit) return
    removeDamage(unit.vin, id)
    toast('ok', 'ปลด NG · แก้ไขแล้ว')
    if (unit.damages.length === 1) {
      setInspected(unit.vin, true)
      setTimeout(() => setVin(null), 1500)
    }
  }

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent="#c2680b" />
      {gateModal}

      {/* repair queue — cars in this yard with unrepaired NG (card + list, tap to fix) */}
      {!unit && ngCars.length > 0 && (
        <div className="panel overflow-hidden fade-up">
          <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setListOpen(v => !v)}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#fff3e0', color: '#c2680b' }}>
              <Wrench size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold text-[12.5px] clip">คิวงานซ่อม (NG)</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                รอซ่อม <b style={{ color: '#c2680b' }}>{ngCars.length}</b> คัน · NG รวม <b style={{ color: 'var(--st-damage)' }}>{ngCars.reduce((n, c) => n + c.open, 0)}</b>
              </div>
            </div>
            <ChevronLeft size={16} style={{ color: 'var(--muted)', transform: listOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
          </button>
          {listOpen && (
            <div className="border-t hairline max-h-72 overflow-y-auto divide-y" style={{ borderColor: 'var(--line)' }}>
              {ngCars.map(c => (
                <button key={c.vin} onClick={() => { setVin(c.vin); setShowForm(false) }}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-left transition active:bg-chip">
                  <div className="min-w-0 flex-1">
                    <div className="vin text-[12.5px] font-bold clip">{c.vin}</div>
                    <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: 'var(--muted)' }}>
                      <span>{c.model}</span><span>· {c.color}</span><span>· {c.grouping}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="tabular text-[12px] font-bold">{c.location}</div>
                    <span className="badge mt-0.5 inline-block" style={{ fontSize: 10, background: 'rgba(255,59,48,0.12)', color: 'var(--st-damage)' }}>NG {c.open}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {unit && (
        <div className="space-y-3 fade-up">
          <UnitCard unit={unit} accent="#c2680b" />

          {unit.damages.length === 0 ? (
            <div className="panel p-5 text-center" style={{ color: 'var(--st-yard)' }}>
              <CheckCircle2 size={28} className="mx-auto mb-2" />
              <div className="font-semibold text-[13.5px]">ไม่มี NG — รถสภาพดี</div>
            </div>
          ) : (
            <div className="panel overflow-hidden">
              <div className="px-4 py-3 border-b hairline flex items-center justify-between"
                style={{ background: '#fff8f0' }}>
                <span className="text-[12.5px] font-semibold flex items-center gap-1.5" style={{ color: '#c2680b' }}>
                  <Wrench size={14} /> รายการ NG ที่ต้องแก้ ({unit.damages.length})
                </span>
              </div>
              {unit.damages.map(d => (
                <div key={d.id} className="flex items-center gap-3 px-4 py-3.5 border-b hairline">
                  {d.photo ? <img src={d.photo} alt="" className="w-11 h-11 rounded-xl object-cover shrink-0" /> :
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#fff3e0' }}>
                      <Wrench size={18} style={{ color: '#c2680b' }} />
                    </div>}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[13px]">
                      {zoneLabel(d.area)} · {TYPES.find(t => t.id === d.type)?.th}
                    </div>
                    <div className="text-[11.5px] mt-0.5" style={{ color: d.severity === 'major' ? '#dc2626' : '#d97706' }}>
                      {d.severity === 'major' ? 'Heavy NG' : 'NG'}{d.note ? ` · ${d.note}` : ''}
                    </div>
                  </div>
                  <button onClick={() => doRelease(d.id)}
                    className="shrink-0 px-3 py-2 rounded-xl text-[12.5px] font-bold transition-all active:scale-95"
                    style={{ background: 'var(--st-yard)', color: '#fff', boxShadow: '0 4px 12px -4px rgba(22,163,74,0.4)' }}>
                    ✓ แก้แล้ว
                  </button>
                </div>
              ))}
            </div>
          )}

          {!showForm ? (
            <button onClick={() => setShowForm(true)}
              className="w-full h-12 rounded-2xl text-[14px] font-bold flex items-center justify-center gap-2 transition-all active:scale-95"
              style={{ background: '#dc2626', color: '#fff' }}>
              <Plus size={17} /> เพิ่ม NG ใหม่
            </button>
          ) : (
            <DamageForm
              onSaveAll={damages => {
                damages.forEach(d => addDamage(unit.vin, { ...d, source: 'mechanic', station: 'ช่าง (Mechanic)' }))
                setInspected(unit.vin, false)
                toast('err', `เพิ่ม NG ${damages.length} รายการ · ${unit.vin}`)
                setShowForm(false)
              }}
              onCancel={() => setShowForm(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Gate-out view ────────────────────────────────────────────────────────────
function GateOutView() {
  const trackingRows = useSiteRows()
  const units = useSiteUnits()
  const wrongSite = useWrongSiteHint()
  const queues = useSiteQueues()
  const { loadFromIdb, updateCell } = useTracking()
  const { toast, currentUser, sites, currentSite } = useYard()
  const { confirmSeqGateOut } = useOps()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [done, setDone] = useState<{ vin: string; label: string } | null>(null)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const siteName = sites.find((s) => s.id === currentSite)?.name ?? ''
  const locPrefix = siteGroupingConfig(siteName).prefix
  const seqQueues = useMemo(() => queues.filter(isSequenceQueue), [queues])
  const row = vin ? (trackingRows.find(r => r.vin === vin) ?? null) : null
  const seqHit = useMemo(() => findSeqItem(vin, queues), [vin, queues])

  const onScan = (v: string) => {
    let r = trackingRows.find(x => x.vin === v)
    if (!r && v.length <= 8) {
      const hits = trackingRows.filter(x => x.vin.endsWith(v))
      if (hits.length === 1) r = hits[0]
      else if (hits.length > 1) { toast('err', `พบ ${hits.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
    }
    if (!r) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    // cars in a delivery sequence may sit at Wash/lane statuses that aren't in
    // the generic "gated-in" set — allow gate-out for them regardless. A car
    // already Pre Gate-out is also scannable (to Confirm Preload before 09:30).
    const inSeq = !!findSeqItem(r.vin, queues)
    if (!inSeq && !isGatedInStatus(r.cells['Car Status']) && r.cells['Car Status'] !== 'Pre Gate-out') { blockGate(r.vin, r.cells['Model name'] ?? r.cells['Model'] ?? ''); return }
    setVin(r.vin)
  }

  // Ops-scan gate-out → "Pre Gate-out": the car is staged in preload, NOT gone
  // yet. deriveCarStatus finalises it to a real Gate-out at the next 09:30 flush
  // (see pastGateOutFlush) unless it is confirmed Preload first.
  const doGateOut = () => {
    if (!row) return
    const now = new Date()
    const ts = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
    updateCell(row.vin, 'Car Status', 'Pre Gate-out')
    updateCell(row.vin, 'Gate Out time stamp', ts)
    updateCell(row.vin, 'Gate Out Time', String(now.getTime())) // epoch → 09:30 flush calc
    // close the delivery-sequence item too, if this car belongs to one
    if (seqHit) confirmSeqGateOut(seqHit.queue.id, row.vin, currentUser)
    setDone({ vin: row.vin, label: 'Pre Gate-out' }); setVin(null)
  }

  // Confirm Preload (before 09:30) → the Pre-Gate-out car has NOT left; it stays
  // parked in the preload lane waiting for its truck, so it never auto-flushes.
  const doPreload = () => {
    if (!row) return
    updateCell(row.vin, 'Car Status', 'Preload')
    setDone({ vin: row.vin, label: 'Preload' }); setVin(null)
  }

  return (
    <div className="space-y-4">
      {done && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}
          onClick={() => setDone(null)}>
          <div className="panel p-6 w-full max-w-xs text-center fade-up" onClick={e => e.stopPropagation()}>
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
              style={{ background: 'rgba(100,116,139,0.15)' }}>
              <LogOut size={28} style={{ color: '#64748b' }} />
            </div>
            <div className="text-[20px] font-extrabold mb-1" style={{ color: '#475569' }}>{done.label} สำเร็จ!</div>
            <div className="vin text-[14px] font-bold mb-5" style={{ color: 'var(--muted)' }}>{done.vin}</div>
            <button onClick={() => setDone(null)}
              className="w-full py-3 rounded-2xl text-[15px] font-bold text-white active:scale-95 transition-all"
              style={{ background: '#64748b' }}>ตกลง</button>
          </div>
        </div>
      )}
      <VinInput onScan={onScan} accent="#64748b" />
      {gateModal}

      {/* delivery-sequence runs — see remaining cars to gate-out (before scanning) */}
      {!row && (
        <SeqQueuePicker queues={seqQueues} units={units} trackingRows={trackingRows} locPrefix={locPrefix} />
      )}

      {row && (
        <div className="panel p-4 space-y-4 fade-up">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge text-[12px] font-semibold px-2.5 py-1"
              style={{ background: '#e2e8f0', color: '#475569' }}>
              {row.cells['Car Status'] ?? '—'}
            </span>
            <span className="vin text-[13.5px] font-bold">{row.vin}</span>
            {seqHit && (
              <span className="badge ml-auto shrink-0" style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>
                <ListChecks size={11} /> ลำดับงาน{seqHit.item.laneLoad ? ` · ${seqHit.item.laneLoad}` : ''}
              </span>
            )}
          </div>
          {seqHit && (
            <div className="text-[11.5px] rounded-lg px-3 py-2" style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>
              {seqHit.queue.name}
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12.5px]">
            {([
              ['Model',    row.cells['Model name'] ?? row.cells['Model'] ?? '—'],
              ['Company',  row.cells['company'] ?? '—'],
              ['Location', row.cells['Location yard'] ?? row.cells['storage Yard'] ?? '—'],
              ['Lot',      row.cells['Lot transfer'] ?? '—'],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k}>
                <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{k}</div>
                <div className="font-semibold mt-0.5">{v}</div>
              </div>
            ))}
          </div>
          {(row.cells['Car Status'] ?? '') === 'Gate-out' ? (
            <div className="text-center py-3 text-[13.5px] font-semibold" style={{ color: '#64748b' }}>
              รถ Gate-out แล้ว
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={doGateOut}
                className="w-full py-3 rounded-2xl text-[15px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                style={{ background: '#f59e0b' }}>
                <LogOut size={18} /> ยืนยัน Gate-out
              </button>
              <button onClick={doPreload}
                className="w-full py-2.5 rounded-2xl text-[14px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                style={{ background: '#0d9488' }}>
                <Clock size={16} /> Confirm Preload · จอดต่อรอรับ
              </button>
              <div className="text-[10.5px] text-center leading-snug" style={{ color: 'var(--muted)' }}>
                Gate-out → รถจะออกจริงตอน 09:30 · Preload → ยังจอดอยู่รอรถมารับ
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Re-location view ──────────────────────────────────────────────────────────
function RelocationView() {
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const { loadFromIdb, updateCell } = useTracking()
  const { toast } = useYard()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [newLoc, setNewLoc] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const row = vin ? (trackingRows.find(r => r.vin === vin) ?? null) : null
  const curLoc = row ? (row.cells['Location yard'] || row.cells['storage Yard'] || '—') : ''

  const onScan = (v: string) => {
    setSaved(false); setNewLoc('')
    let r = trackingRows.find(x => x.vin === v)
    if (!r && v.length <= 8) {
      const hits = trackingRows.filter(x => x.vin.endsWith(v))
      if (hits.length === 1) r = hits[0]
      else if (hits.length > 1) { toast('err', `พบ ${hits.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
    }
    if (!r) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (!isGatedInStatus(r.cells['Car Status'])) { blockGate(r.vin, r.cells['Model name'] ?? r.cells['Model'] ?? ''); return }
    setVin(r.vin)
  }

  const doSave = () => {
    if (!row || !newLoc.trim()) return
    updateCell(row.vin, 'Location yard', newLoc.trim())
    setSaved(true)
    toast('ok', `ย้ายตำแหน่งแล้ว · ${row.vin}`)
    setTimeout(() => { setVin(null); setSaved(false) }, 1600)
  }

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent="#0ea5e9" />
      {gateModal}
      {row && (
        <div className="panel p-4 space-y-4 fade-up">
          <div className="flex items-center gap-2">
            <span className="vin text-[13.5px] font-bold">{row.vin}</span>
            <span className="ml-auto text-[12px]" style={{ color: 'var(--muted)' }}>{row.cells['Model name'] ?? ''}</span>
          </div>
          <div className="rounded-2xl p-3.5" style={{ background: 'var(--chip)' }}>
            <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>ตำแหน่งปัจจุบัน</div>
            <div className="font-bold text-[15px]">{curLoc}</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--muted)' }}>ตำแหน่งใหม่</div>
            <input
              className="input w-full font-semibold"
              placeholder="เช่น Zone A Row 3 Slot 05…"
              value={newLoc}
              onChange={e => setNewLoc(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSave()}
            />
          </div>
          <button
            onClick={doSave}
            disabled={!newLoc.trim() || saved}
            className="w-full py-3 rounded-2xl text-[15px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-40"
            style={{ background: saved ? '#16a34a' : '#0ea5e9' }}>
            {saved ? <><CheckCircle2 size={18} /> บันทึกแล้ว!</> : <><MapPin size={18} /> บันทึกตำแหน่งใหม่</>}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Check view ────────────────────────────────────────────────────────────────
// ── Update Damage ─────────────────────────────────────────────────────────────
// Position / Defect options — combobox suggestions (operator can also type freely)
const UPD_POS_OPTS = POSITION_OPTS.map(o => ({ id: o.id, label: o.th }))
const UPD_DEF_OPTS = [
  { id: 'scratch', label: 'รอยขีดข่วน' }, { id: 'dent', label: 'บุบ' }, { id: 'chip', label: 'สีกระเทาะ' },
  { id: 'crack', label: 'แตก / ร้าว' }, { id: 'stain', label: 'คราบ' }, { id: 'rust', label: 'สนิม' },
]
const UPD_POS_TO_ID: Record<string, string> = Object.fromEntries(UPD_POS_OPTS.map(o => [o.label, o.id]))

function UpdateDamageView() {
  const units = useSiteUnits()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const { loadFromIdb } = useTracking()
  const { addDamage, updateDamage, removeDamage, toast, currentUser } = useYard()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newArea, setNewArea] = useState(UPD_POS_OPTS[0].label)
  const [newType, setNewType] = useState(UPD_DEF_OPTS[0].label)
  const [newSev, setNewSev] = useState<'minor' | 'major'>('minor')
  const [newNote, setNewNote] = useState('')
  const [newPhoto, setNewPhoto] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null
  const trackRow = vin ? trackingRows.find(r => r.vin === vin) ?? null : null
  const damages = unit?.damages ?? []

  const onScan = (v: string) => {
    let found: string | null = null
    const eu = units.find(u => u.vin === v); if (eu) found = eu.vin
    const et = trackingRows.find(r => r.vin === v); if (et && !found) found = et.vin
    if (!found && v.length <= 8) {
      const uh = units.filter(u => u.vin.endsWith(v))
      if (uh.length === 1) found = uh[0].vin
      else if (uh.length > 1) { toast('err', `พบ ${uh.length} คัน`); return }
      if (!found) {
        const th = trackingRows.filter(r => r.vin.endsWith(v))
        if (th.length === 1) found = th[0].vin
        else if (th.length > 1) { toast('err', `พบ ${th.length} คัน`); return }
      }
    }
    if (!found) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    const fu = units.find(u => u.vin === found)
    const fr = trackingRows.find(r => r.vin === found)
    const gated = (fu && fu.status !== 'EXPECTED') || (fr && isGatedInStatus(fr.cells['Car Status']))
    if (!gated) { blockGate(found, fu?.modelName ?? fr?.cells['Model name'] ?? fr?.cells['Model'] ?? ''); return }
    setVin(found); setShowAdd(false)
  }

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setBusy(true)
    try { setNewPhoto(await compressImage(f)) } catch { toast('err', 'อ่านรูปไม่สำเร็จ') }
    setBusy(false)
  }
  const saveNew = () => {
    if (!unit) return
    // Position → zone id when it matches a known label (keeps diagrams working);
    // Defect/NG kept as the typed/selected text so the exact wording shows everywhere
    const area = UPD_POS_TO_ID[newArea.trim()] ?? newArea.trim()
    const type = newType.trim()
    if (!area || !type) { toast('err', 'กรอก Position และ Defect/NG'); return }
    addDamage(unit.vin, { area, type, severity: newSev, note: newNote.trim() || undefined, photo: newPhoto, source: 'update', station: 'Update Damage' })
    setShowAdd(false); setNewNote(''); setNewPhoto(undefined)
    toast('ok', 'บันทึกความเสียหายแล้ว')
  }

  const SEV_COLOR = { minor: '#2563eb', major: '#dc2626' }

  const fmt = (ts: number) => {
    const d = new Date(ts)
    return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
  }

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent="#dc2626" />
      {gateModal}

      {(unit || trackRow) && vin && (
        <div className="panel overflow-hidden fade-up">
          {/* header */}
          <div className="px-4 py-3 border-b hairline flex items-center gap-2" style={{ background: 'rgba(220,38,38,0.05)' }}>
            <AlertTriangle size={15} style={{ color: '#dc2626' }} />
            <div className="flex-1 min-w-0">
              <div className="vin text-[13px] font-bold truncate">{vin}</div>
              <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                {unit?.modelName ?? trackRow?.cells['Model name'] ?? '—'}
              </div>
            </div>
            <span className="badge font-bold" style={{ background: damages.length > 0 ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.1)', color: damages.length > 0 ? '#dc2626' : '#16a34a' }}>
              {damages.length > 0 ? `${damages.length} damage` : 'OK'}
            </span>
          </div>

          {/* existing damages */}
          {damages.length > 0 && (
            <div className="divide-y">
              {damages.map(d => (
                <div key={d.id} className="flex items-start gap-3 px-4 py-3">
                  {d.photo
                    ? <img src={d.photo} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" style={{ border: `2px solid ${SEV_COLOR[d.severity]}` }} />
                    : <div className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: SEV_COLOR[d.severity] }} />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold">{zoneLabel(d.area)} · <span className="capitalize">{d.item ?? d.type}</span></div>
                    {d.note && <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{d.note}</div>}
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--faint)' }}>บันทึก {fmt(d.at)} · {d.by}</div>
                    {d.repairDate && (
                      <div className="text-[11px]" style={{ color: '#16a34a' }}>✓ ซ่อม {fmt(d.repairDate)}{d.repairedBy ? ` · ${d.repairedBy}` : ''}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!d.repairDate ? (
                      <button
                        onClick={() => updateDamage(vin, d.id, { statusRepair: 'Repaired', repairDate: Date.now(), repairedBy: currentUser })}
                        className="text-[11px] font-bold px-2 py-1 rounded-lg transition"
                        style={{ background: 'rgba(22,163,74,0.1)', color: '#16a34a', border: '1px solid rgba(22,163,74,0.25)' }}>
                        Mark Fixed
                      </button>
                    ) : (
                      <button
                        onClick={() => updateDamage(vin, d.id, { statusRepair: undefined, repairDate: undefined, repairedBy: undefined })}
                        className="text-[11px] font-bold px-2 py-1 rounded-lg transition"
                        style={{ background: 'var(--chip)', color: 'var(--muted)', border: '1px solid var(--line-strong)' }}>
                        Unfix
                      </button>
                    )}
                    <button onClick={() => { if (confirm('ลบรายการนี้?')) removeDamage(vin, d.id) }}
                      className="btn p-1" style={{ color: '#dc2626' }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* add new damage form */}
          {showAdd ? (
            <div className="border-t hairline px-4 py-3 space-y-2.5" style={{ background: 'rgba(220,38,38,0.03)' }}>
              <div className="text-[12px] font-bold" style={{ color: '#dc2626' }}>+ เพิ่มความเสียหายใหม่</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>Position</div>
                  <input className="input w-full text-[12px]" list="upd-pos-opts" placeholder="เลือก / พิมพ์เอง…"
                    value={newArea} onChange={e => setNewArea(e.target.value)} />
                  <datalist id="upd-pos-opts">{UPD_POS_OPTS.map(o => <option key={o.id} value={o.label} />)}</datalist>
                </div>
                <div>
                  <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>Defect/NG</div>
                  <input className="input w-full text-[12px]" list="upd-def-opts" placeholder="เลือก / พิมพ์เอง…"
                    value={newType} onChange={e => setNewType(e.target.value)} />
                  <datalist id="upd-def-opts">{UPD_DEF_OPTS.map(o => <option key={o.id} value={o.label} />)}</datalist>
                </div>
              </div>
              <div className="flex gap-2">
                {(['minor','major'] as const).map(s => (
                  <button key={s} onClick={() => setNewSev(s)}
                    className="flex-1 py-1.5 rounded-lg text-[12px] font-bold border transition"
                    style={newSev === s ? { background: SEV_COLOR[s], color: '#fff', borderColor: 'transparent' } : { background: 'var(--chip)', borderColor: 'var(--line-strong)' }}>
                    {s === 'minor' ? 'Minor' : 'Major'}
                  </button>
                ))}
              </div>
              <input className="input w-full text-[12px]" placeholder="หมายเหตุ (ถ้ามี)" value={newNote} onChange={e => setNewNote(e.target.value)} />
              {/* photo capture */}
              <div className="flex items-center gap-2.5">
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={pickPhoto} />
                <button onClick={() => fileRef.current?.click()} disabled={busy}
                  className="btn px-3 py-2 text-[12px] font-semibold" style={{ background: 'var(--chip)' }}>
                  <Camera size={15} /> {busy ? 'กำลังอ่าน…' : newPhoto ? 'เปลี่ยนรูป' : 'ถ่ายรูป / แนบรูป'}
                </button>
                {newPhoto && (
                  <div className="relative">
                    <img src={newPhoto} alt="" className="w-11 h-11 rounded-lg object-cover" style={{ border: '1px solid var(--line)' }} />
                    <button onClick={() => setNewPhoto(undefined)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: '#dc2626', color: '#fff' }}><X size={11} /></button>
                  </div>
                )}
              </div>
              <div className="flex gap-2 pt-1">
                <button className="btn flex-1 text-[12px]" onClick={() => { setShowAdd(false); setNewPhoto(undefined) }}>ยกเลิก</button>
                <button className="btn btn-primary flex-1 text-[12px]" onClick={saveNew} disabled={!unit}>บันทึก</button>
              </div>
            </div>
          ) : (
            <div className="px-4 py-3 border-t hairline">
              <button onClick={() => setShowAdd(true)}
                className="w-full py-2.5 rounded-xl text-[13px] font-bold transition active:scale-95 flex items-center justify-center gap-2"
                style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626', border: '1px dashed rgba(220,38,38,0.3)' }}>
                <Plus size={15} /> เพิ่มความเสียหาย
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CheckView() {
  const trackingRows = useSiteRows()
  const units = useSiteUnits()
  const wrongSite = useWrongSiteHint()
  const allTrips = useTrips()
  const queues = useSiteQueues()
  const { loadFromIdb } = useTracking()
  const { toast } = useYard()
  const [vin, setVin] = useState<string | null>(null)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const row  = vin ? (trackingRows.find(r => r.vin === vin) ?? null) : null
  const unit = vin ? (units.find(u => u.vin === vin) ?? null)        : null

  const onScan = (v: string) => {
    let found: string | null = null
    const et = trackingRows.find(r => r.vin === v); if (et) found = et.vin
    const eu = units.find(u => u.vin === v);         if (eu && !found) found = eu.vin
    if (!found && v.length <= 8) {
      const th = trackingRows.filter(r => r.vin.endsWith(v))
      if (th.length === 1) { found = th[0].vin }
      else if (th.length > 1) { toast('err', `พบ ${th.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
      if (!found) {
        const uh = units.filter(u => u.vin.endsWith(v))
        if (uh.length === 1) { found = uh[0].vin }
        else if (uh.length > 1) { toast('err', `พบ ${uh.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
      }
    }
    if (!found) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    setVin(found)
  }

  // derived data
  const vinTrips   = vin ? allTrips.filter(t => t.vin === vin).sort((a, b) => b.startedAt - a.startedAt) : []
  const vinQueues  = vin ? queues.map(q => ({ q, item: q.items.find(i => i.vin === vin) })).filter(x => x.item) : []
  const damaged    = row ? isDamaged(row.cells) : (unit ? unit.damages.length > 0 : false)
  const carStatus  = row?.cells['Car Status'] ?? (unit ? unit.status : null)
  const model      = row?.cells['Model name'] ?? row?.cells['Model'] ?? unit?.modelName ?? '—'
  const colorHex   = unit?.colorHex ?? '#cfd6dd'

  const fmt = (ts: number) => {
    const d = new Date(ts)
    return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
  }

  // Section helper
  const Sec = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <div className="px-4 py-2 text-[10.5px] font-bold uppercase tracking-wider"
        style={{ background: 'var(--chip)', color: 'var(--muted)' }}>{title}</div>
      {children}
    </div>
  )
  const Row = ({ label, value, accent }: { label: string; value: string; accent?: string }) => (
    <div className="flex items-center px-4 py-2.5 gap-3 border-b hairline">
      <span className="text-[11.5px] shrink-0" style={{ color: 'var(--muted)', width: 96 }}>{label}</span>
      <span className="text-[12.5px] font-semibold flex-1 text-right" style={accent ? { color: accent } : {}}>{value}</span>
    </div>
  )
  // one line in a station's driver/inspector timeline
  const HistLine = ({ icon, label, who, time, color }: { icon: React.ReactNode; label: string; who: string; time?: number; color: string }) => (
    <div className="flex items-center gap-2 text-[11.5px]">
      <span style={{ color }} className="shrink-0 flex">{icon}</span>
      <span className="shrink-0" style={{ color: 'var(--muted)', width: 82 }}>{label}</span>
      <span className="font-semibold flex-1 truncate">{who}</span>
      {time != null && <span className="text-[10.5px] shrink-0" style={{ color: 'var(--faint)' }}>{fmt(time)}</span>}
    </div>
  )

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent="#0891b2" />

      {(row || unit) && vin && (
        <div className="panel overflow-hidden fade-up">

          {/* ── Car image header ── */}
          <div className="flex flex-col items-center pt-5 pb-3 gap-2"
            style={{ background: 'linear-gradient(180deg,#e0f2fe,#f0f9ff)' }}>
            <CarTopView color={colorHex} width={140} />
            <div className="flex items-center gap-2 mt-1">
              {carStatus && (
                <span className="badge text-[11px] font-bold px-2.5 py-1"
                  style={{ background: '#0891b2', color: '#fff' }}>{carStatus}</span>
              )}
              <span className="vin text-[12.5px] font-bold">{vin}</span>
            </div>
          </div>

          {/* ── Identity ── */}
          <Sec title="ข้อมูลรถ">
            <Row label="Model"       value={model} />
            {row?.cells['company']   && <Row label="Company"  value={row.cells['company']} />}
            {(unit?.color || row?.cells['Color']) && <Row label="Color" value={unit?.color ?? row?.cells['Color'] ?? '—'} />}
            {row?.cells['Lot transfer'] && <Row label="Lot" value={row.cells['Lot transfer']} />}
            {row?.cells['moving date']  && <Row label="Moving Date" value={row.cells['moving date']} />}
            {row?.cells['Grouping  Number'] && <Row label="Group No." value={row.cells['Grouping  Number']} />}
          </Sec>

          {/* ── Route ── */}
          {(row?.cells['From'] || row?.cells['To']) && (
            <Sec title="เส้นทาง">
              <div className="flex items-center gap-2 mx-4 my-2.5 rounded-2xl px-3.5 py-2.5"
                style={{ background: 'rgba(37,99,235,0.07)', border: '1px solid rgba(37,99,235,0.14)' }}>
                <MapPin size={13} style={{ color: '#2563eb', flexShrink: 0 }} />
                <span className="text-[12.5px] font-bold" style={{ color: '#1d4ed8' }}>{row?.cells['From'] ?? '—'}</span>
                <ArrowRight size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <span className="text-[12.5px] font-bold flex-1 truncate" style={{ color: '#1d4ed8' }}>{row?.cells['To'] ?? '—'}</span>
              </div>
            </Sec>
          )}

          {/* ── Gate-in / Location ── */}
          <Sec title="Gate-in / ตำแหน่ง">
            {row?.cells['Gate In (Rayong yard)'] && <Row label="Gate In Date" value={row.cells['Gate In (Rayong yard)']} />}
            {row?.cells['Gate In Inspector']      && <Row label="ผู้ตรวจรับ"  value={row.cells['Gate In Inspector']} />}
            {row?.cells['Gate Out time stamp']     && <Row label="Gate Out"    value={row.cells['Gate Out time stamp']} />}
            {(row?.cells['Location yard'] || row?.cells['storage Yard'] || unit?.block) && (
              <Row label="Location" value={row?.cells['Location yard'] ?? row?.cells['storage Yard'] ?? `${unit?.block ?? ''}-${unit?.row ?? ''}-${unit?.slot ?? ''}`} />
            )}
            {unit?.lastPos && (
              <div className="flex items-center px-4 py-2.5 gap-3 border-b hairline">
                <span className="text-[11.5px] shrink-0" style={{ color: 'var(--muted)', width: 96 }}>GPS ล่าสุด</span>
                <div className="flex-1 text-right">
                  <div className="text-[12px] font-semibold">{unit.lastPos.lat.toFixed(5)}, {unit.lastPos.lng.toFixed(5)}</div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>{fmt(unit.lastPos.t)}</div>
                </div>
              </div>
            )}
          </Sec>

          {/* ── Status / Damage ── */}
          <Sec title="สถานะ / ความเสียหาย">
            {row?.cells['Final Status'] && <Row label="Final Status" value={row.cells['Final Status']} />}
            {row?.cells['Status']       && <Row label="Status (Excel)" value={row.cells['Status']} />}
            {row?.cells['PIC (PDI)']    && <Row label="PIC (PDI)" value={row.cells['PIC (PDI)']} />}
            <Row label="Damage" value={damaged ? 'NG — มีตำหนิ' : 'OK — ปกติ'} accent={damaged ? '#dc2626' : '#16a34a'} />
            {unit && unit.damages.length > 0 && unit.damages.map((d, i) => (
              <div key={d.id} className="flex items-start gap-3 px-4 py-2.5 border-b hairline">
                {d.photo
                  ? <img src={d.photo} alt="" onClick={() => window.open(d.photo, '_blank')}
                      className="w-14 h-14 rounded-lg object-cover shrink-0 cursor-pointer"
                      style={{ border: `2px solid ${d.severity === 'major' ? '#dc2626' : 'var(--line)'}` }} />
                  : <AlertTriangle size={13} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />}
                <div className="flex-1 text-[12px]">
                  <div className="font-semibold">{zoneLabel(d.area)}</div>
                  <div style={{ color: 'var(--muted)' }}>{d.note || d.type}{d.severity === 'major' ? ' · Heavy NG' : ''}</div>
                  {d.photo && <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--brand)' }}>แตะเพื่อดูรูปเต็ม</div>}
                </div>
                <span className="text-[10.5px]" style={{ color: 'var(--faint)' }}>#{i+1}</span>
              </div>
            ))}
          </Sec>

          {/* ── Station work + driver history (per station) ── */}
          {vinQueues.length > 0 && (
            <Sec title="งานสถานี · ประวัติคนขับ">
              {vinQueues.map(({ q, item }) => item && (
                <div key={q.id} className="px-4 py-3 border-b hairline">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[12.5px] font-bold">{q.name}</span>
                    {item.fromSlot && <span className="text-[10.5px]" style={{ color: 'var(--faint)' }}>· จาก {item.fromSlot}</span>}
                    <span className="ml-auto badge text-[10px]" style={
                      item.done ? { color: '#16a34a', background: 'rgba(22,163,74,0.12)' }
                      : item.result === 'NG' ? { color: '#dc2626', background: 'rgba(220,38,38,0.1)' }
                      : item.result === 'OK' ? { color: '#16a34a', background: 'rgba(22,163,74,0.12)' }
                      : { color: '#d97706', background: 'rgba(217,119,6,0.12)' }}>
                      {item.done ? 'เสร็จ' : item.result ?? (stageOf(item) === 'at-station' ? 'อยู่สถานี' : 'รอ')}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {item.deliveredBy && <HistLine icon={<Car size={13} />} label="ส่งเข้าสถานี" who={item.deliveredBy} time={item.deliveredAt} color="var(--st-yard)" />}
                    {item.checkedBy && <HistLine icon={<ShieldCheck size={13} />} label={`ตรวจ · ${item.result ?? ''}`} who={item.checkedBy} time={item.checkedAt} color="#7c3aed" />}
                    {item.returnedBy && <HistLine icon={<Car size={13} />} label="นำกลับไปจอด" who={item.returnedBy} time={item.returnedAt} color="var(--st-yard)" />}
                    {!item.deliveredBy && !item.checkedBy && !item.returnedBy && (
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                        {item.done ? <>✓ เสร็จแล้ว{item.doneBy ? ` · ${item.doneBy}` : ''}</> : '⏳ ยังไม่เริ่ม'}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </Sec>
          )}

          {/* ── Driver Trips ── */}
          {vinTrips.length > 0 && (
            <Sec title={`ประวัติการขับ (${vinTrips.length} ครั้ง)`}>
              {vinTrips.slice(0, 5).map((trip, i) => (
                <div key={trip.id} className="flex items-start gap-3 px-4 py-2.5 border-b hairline">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white mt-0.5"
                    style={{ background: '#0891b2' }}>{i + 1}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold">{trip.driver}</div>
                    {(trip.from || trip.to) && (
                      <div className="text-[11px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                        {trip.from ?? '?'} <ArrowRight size={10} /> {trip.to ?? '?'}
                      </div>
                    )}
                    <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>{fmt(trip.startedAt)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    {trip.distanceM != null && (
                      <div className="text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>{trip.distanceM}m</div>
                    )}
                    {trip.sim && <div className="text-[10px]" style={{ color: 'var(--faint)' }}>sim</div>}
                  </div>
                </div>
              ))}
            </Sec>
          )}

        </div>
      )}
    </div>
  )
}

// ── main: role selector + router ──────────────────────────────────────────────
export function YardOps() {
  const { currentUser } = useYard()
  const [role, setRole] = useState<RoleKey | null>(null)

  const activeRole = ROLES.find(r => r.key === role)

  return (
    <div className="max-w-md mx-auto pb-10">

      {/* header */}
      <div className="flex items-center gap-3 mb-5">
        {role ? (
          <button onClick={() => setRole(null)}
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-all hover:bg-[var(--chip)]"
            style={{ border: '1px solid var(--line)' }}>
            <ChevronLeft size={18} />
          </button>
        ) : (
          <LogoMark size={36} />
        )}
        <div>
          <div className="display text-[19px] font-bold leading-tight">
            {activeRole ? activeRole.th : 'Yard Ops'}
          </div>
          <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
            {activeRole ? activeRole.desc : `Mobile Station · ${currentUser}`}
          </div>
        </div>
        {activeRole && (
          <div className="ml-auto w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: activeRole.color + '18', color: activeRole.color }}>
            {activeRole.icon && <span style={{ transform: 'scale(0.7)' }}>{activeRole.icon}</span>}
          </div>
        )}
      </div>

      {/* role picker */}
      {!role && (
        <div className="space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--muted)' }}>
            เลือกตำแหน่งงาน
          </div>
          <div className="grid grid-cols-2 gap-3">
            {ROLES.map(r => (
              <button
                key={r.key}
                onClick={() => setRole(r.key)}
                className="panel p-5 text-left flex flex-col gap-3 transition-all hover:shadow-md active:scale-95"
                style={{ touchAction: 'manipulation' }}
              >
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{ background: r.color + '18', color: r.color }}>
                  {r.icon}
                </div>
                <div>
                  <div className="font-bold text-[15px] leading-tight">{r.th}</div>
                  <div className="text-[11.5px] mt-1" style={{ color: 'var(--muted)' }}>{r.desc}</div>
                </div>
              </button>
            ))}
          </div>

          {/* status strip */}
          <div className="panel p-4 mt-2 flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium"
              style={{ color: 'var(--st-yard)' }}>
              <span className="live">●</span> Live
            </div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>SJWD Yard Control · {currentUser}</div>
          </div>
        </div>
      )}

      {/* role views */}
      {role === 'walk'       && <WalkView />}
      {role === 'gateout'    && <GateOutView />}
      {role === 'updatedmg'  && <UpdateDamageView />}
      {role === 'driver'     && <DriverView />}
      {role === 'relocation' && <RelocationView />}
      {role === 'pdi'        && <PdiView />}
      {role === 'check'      && <CheckView />}
      {role === 'mechanic'   && <MechanicView />}
    </div>
  )
}
