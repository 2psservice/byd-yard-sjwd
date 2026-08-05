/**
 * Yard Ops — Mobile role-based operations portal
 * Roles: Walk (Gate In) · Driver (Park) · PDI/PM/FC (Inspect) · Mechanic (Repair)
 */
import { useEffect, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  ScanLine, Car, ShieldCheck, Wrench, ChevronLeft,
  CheckCircle2, XCircle, AlertTriangle, Navigation, Clock,
  User, RefreshCw, Plus, Trash2,
  ArrowRight, Zap, Hand, X, Camera, Pencil, Gauge, Route, Crosshair,
  LogOut, MapPin, ClipboardList, ListChecks, Copy, Check,
} from 'lucide-react'
import { useYard, useUnits, useTrips, useBlocks, useMe } from '../store/useYard'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { isDamaged, deriveCarStatus, IN_YARD_STATUSES, CAR_STATUS_META } from '../lib/carStatus'
import { useOps, useActiveQueues, activeProcess, stageOf, isSequenceQueue, seqStageOf, isQueueComplete, queueTypeOf, stampStationDate, stationProgress, drivingNow } from '../store/useOps'
import type { WorkQueue, QueueItem, QueueType, QueueStage } from '../store/useOps'
import { CarTopView } from '../components/CarTopView'
import { LogoMark } from '../components/Logo'
import { DrivingScreen } from '../components/DrivingScreen'
import { LiveTrackingMap } from '../components/LiveTrackingMap'
import { ALL_ZONES, zoneLabel } from '../components/CarDiagramMultiView'
import { MASTER_PARTS, MASTER_DEFECTS, resolvePart, resolveDefect } from '../lib/masterDefect'
import { partLabel, defectLabel, partBilingual, defectBilingual } from '../lib/damageLabel'
import { candidates } from '../lib/parkingEngine'
import { slotToLatLng } from '../lib/geo'
import { cx, PhotoLightbox } from '../components/ui'
import { rowInSite } from '../lib/siteScope'
import { compressImage } from '../lib/photo'
import StationSheet from '../components/StationSheet'
import { MasterCombo } from '../components/MasterCombo'
import { TirePressureField, TIRE_WHEELS, joinTirePressure } from '../components/MeasurementField'
import { FINAL_CHECK_TABS } from '../lib/finalCheckList'
import { yardLocCode, yardLocFull, blockCode, byYardLocation } from '../lib/groupingImport'
import { parseLane } from '../lib/laneImport'
import { LOCATION_KEY } from '../lib/trackingColumns'
import { blockTag, blockKeyOfTag, resolveBlockByName } from '../lib/format'
import { useRecentOps } from '../store/useRecentOps'

const recordRecent = (key: string, vin: string, note?: string) => useRecentOps.getState().record(key, vin, note)

/** Copy a VIN to the clipboard — falls back to a hidden textarea where the
 *  Clipboard API is unavailable (older Android WebView). */
async function copyVin(vin: string, toast: (k: 'ok' | 'err', m: string) => void) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(vin)
    else {
      const ta = document.createElement('textarea')
      ta.value = vin; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); ta.remove()
    }
    toast('ok', `คัดลอก VIN แล้ว · ${vin.slice(-6)}`)
  } catch { toast('err', 'คัดลอกไม่สำเร็จ') }
}
import { fmtSerialToDate } from '../lib/trackingColumns'
import { matchModel } from '../lib/sampleData'
import type { Damage, DamageInput, Unit } from '../types'
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

/** Tracking-sheet header for the DN / delivery grouping number (two spaces). */
const GROUP_KEY = 'Grouping  Number'
/** Compare DN numbers the way a human reads them off the Delivery Note: case and
 *  stray spaces don't matter, so "atl260804-12" and "ATL260804 -12" are one run. */
const normGroup = (s?: string) => (s ?? '').toUpperCase().replace(/\s+/g, '')

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

// ── damage config: bilingual master lists (Part + Defect) from the master Excel ──
// Field staff type Thai (English shown alongside); we store BOTH languages.
const POSITION_OPTS = MASTER_PARTS   // { id, en, th }
const TYPES = MASTER_DEFECTS         // { id, en, th }

// Repair-status ladder for a Defect — "ปลด" no longer deletes, it moves status.
const DEFECT_STATUSES = ['Waiting Repair', 'Accept', 'Acc byd', 'OK Accept', 'OK Repaired', 'Repaired'] as const
const defectStatusStyle = (s?: string): { color: string; background: string } =>
  s && s !== 'Waiting Repair'
    ? { color: '#16a34a', background: '#dcfce7' } // any resolved status → green
    : { color: '#b45309', background: '#fef3c7' } // Waiting Repair (default)

/** Colour-coded repair-status badge for one Defect. The status itself is
 *  read-only (prevents accidental taps); the ✏️ pencil opens a picker with the
 *  status options AND the change history (who changed it, from → to, when). */
function DefectStatusSelect({ d, onChange }: { d: Damage; onChange: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null) // status awaiting confirmation
  const v = d.statusRepair || 'Waiting Repair'
  const hist = d.repairHistory ?? []
  const close = () => { setOpen(false); setPending(null) }
  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className="font-bold rounded-lg px-2.5 py-1.5 whitespace-nowrap" style={{ ...defectStatusStyle(v), fontSize: 11.5 }}>{v}</span>
      <button type="button" onClick={() => setOpen(true)} title="แก้ไขสถานะ"
        className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
        <Pencil size={12} />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[95] flex items-end sm:items-center justify-center p-3" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={close}>
          <div className="panel-solid w-full pop overflow-hidden flex flex-col" style={{ maxWidth: 420, maxHeight: '82vh' }} onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b hairline flex items-center gap-2">
              <span className="font-bold text-[14px]">เปลี่ยนสถานะ Defect</span>
              <button className="ml-auto p-1.5 rounded-lg" style={{ color: 'var(--muted)' }} onClick={close}><X size={17} /></button>
            </div>
            {pending ? (
              <div className="p-4">
                <div className="text-[13px] mb-3 leading-relaxed" style={{ color: 'var(--text)' }}>
                  ยืนยันเปลี่ยนสถานะจาก{' '}
                  <b className="rounded-md px-1.5 py-0.5" style={{ ...defectStatusStyle(v), fontSize: 11.5 }}>{v}</b>{' '}
                  เป็น{' '}
                  <b className="rounded-md px-1.5 py-0.5" style={{ ...defectStatusStyle(pending), fontSize: 11.5 }}>{pending}</b>{' '}
                  ?
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setPending(null)}
                    className="flex-1 py-2.5 rounded-xl text-[12.5px] font-bold transition active:scale-95"
                    style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                    ยกเลิก
                  </button>
                  <button onClick={() => { onChange(pending); close() }}
                    className="flex-1 py-2.5 rounded-xl text-[12.5px] font-bold text-white transition active:scale-95"
                    style={{ background: 'var(--brand)' }}>
                    ยืนยัน
                  </button>
                </div>
              </div>
            ) : (
            <div className="p-3 grid grid-cols-2 gap-2">
              {DEFECT_STATUSES.map(st => (
                <button key={st} onClick={() => { if (st === v) { close() } else { setPending(st) } }}
                  className="py-2.5 rounded-xl text-[12.5px] font-bold transition active:scale-95"
                  style={{ ...defectStatusStyle(st), boxShadow: st === v ? '0 0 0 2px currentColor inset' : 'none' }}>
                  {st}
                </button>
              ))}
            </div>
            )}
            {!pending && hist.length > 0 && (
              <div className="border-t hairline p-3 overflow-auto">
                <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: 'var(--muted)' }}>ประวัติการเปลี่ยนสถานะ</div>
                <div className="space-y-1.5">
                  {[...hist].reverse().map((h, i) => (
                    <div key={i} className="text-[11.5px] flex items-start gap-1.5">
                      <Clock size={11} style={{ color: 'var(--faint)', marginTop: 2 }} />
                      <span className="flex-1">
                        {h.from ? <span style={{ color: 'var(--muted)' }}>{h.from} → </span> : null}<b style={{ color: 'var(--text)' }}>{h.status}</b>
                        <span style={{ color: 'var(--muted)' }}> · {h.by} · {new Date(h.at).toLocaleString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>, document.body)
      }
    </div>
  )
}

type RoleKey = 'walk' | 'driver' | 'pdi' | 'pm' | 'fc' | 'mechanic' | 'gateout' | 'relocation' | 'check' | 'updatedmg'
const ROLES: { key: RoleKey; th: string; en: string; icon: React.ReactNode; color: string; desc: string }[] = [
  { key: 'walk',      th: 'Gate-in',         en: 'Gate-in',         icon: <ScanLine size={28} />,      color: 'var(--brand)',   desc: 'ตรวจรับรถเข้าลาน' },
  { key: 'gateout',  th: 'Gate-out',        en: 'Gate-out',        icon: <LogOut size={28} />,        color: '#64748b',        desc: 'บันทึกรถออกจากลาน' },
  { key: 'driver',   th: 'Driver',          en: 'Driver',          icon: <Car size={28} />,           color: 'var(--st-yard)', desc: 'นำรถไปจอดตามตำแหน่ง' },
  { key: 'relocation',th:'Re-location',     en: 'Re-location',     icon: <MapPin size={28} />,        color: '#0ea5e9',        desc: 'เปลี่ยนตำแหน่งรถในลาน' },
  { key: 'pdi',      th: 'PDI',             en: 'PDI',             icon: <ShieldCheck size={28} />,   color: '#7c3aed',        desc: 'ตรวจสอบคุณภาพ OK / NG' },
  { key: 'pm',       th: 'PM',              en: 'PM',              icon: <ShieldCheck size={28} />,   color: '#2563eb',        desc: 'ตรวจสอบคุณภาพ OK / NG' },
  { key: 'fc',       th: 'FINAL CHECK',     en: 'FINAL CHECK',     icon: <ShieldCheck size={28} />,   color: '#059669',        desc: 'ตรวจสอบคุณภาพ OK / NG' },
  { key: 'updatedmg',th: 'Update Damage',   en: 'Update Damage',   icon: <AlertTriangle size={28} />, color: '#dc2626',        desc: 'บันทึก / แก้ไขความเสียหาย' },
  { key: 'check',    th: 'Check',           en: 'Check',           icon: <ClipboardList size={28} />, color: '#0891b2',        desc: 'ตรวจสอบข้อมูลรถ' },
  { key: 'mechanic', th: 'ช่าง',             en: 'Mechanic',        icon: <Wrench size={28} />,        color: '#c2680b',        desc: 'แก้ไข NG · ปลด / เพิ่ม NG' },
]

// ── shared: "not gated-in" guard ──────────────────────────────────────────────
// Car-Status values that mean the vehicle has NOT passed Gate-in yet. Anything
// else that is non-blank counts as gated-in — the app itself writes many
// post-gate-in statuses ('In Yard', 'PARKING PDI', 'PDI OK', 'Preload', lane
// labels, …), so an allow-list kept missing them and falsely blocked parked
// cars from Gate-out / Re-location / the stations.
const PRE_GATEIN_STATUSES = new Set(['pre gate-in', 'pre gatein', 'pre gate in', 'expected'])
const isGatedInStatus = (s?: string) => {
  const v = (s ?? '').trim().toLowerCase()
  return v !== '' && !PRE_GATEIN_STATUSES.has(v)
}

/** Has the car already left the yard? "Gate-out" passes isGatedInStatus (it IS
 *  past gate-in), so a station that must not touch a departed car needs this
 *  test as well. Resolved through deriveCarStatus so every gate-out signal the
 *  app knows counts — the explicit status, a bare Gate Out time stamp or Gate
 *  Out Date, a pickup plan whose date lapsed, and Pre Gate-out past the 09:30
 *  flush. A car still staged in preload (Pre Gate-out before the flush) has not
 *  left and stays movable. */
const hasGoneOut = (c?: Record<string, string>) => !!c && deriveCarStatus(c) === 'Gate-out'

/** Resolve a typed VIN for unit-based roles (Driver / PDI / Mechanic).
 *  Prefers a yard unit (exact → unique suffix); falls back to a tracking row
 *  to tell "not gated-in yet" apart from "unknown VIN". */
function resolveForUnit(v: string, units: Unit[], rows: TrackRow[]):
  | { type: 'ok'; vin: string }
  | { type: 'okPending'; vin: string } // gated-in per the tracking sheet, unit row still syncing to this device
  | { type: 'notGated'; vin: string; model: string }
  | { type: 'ambiguous'; count: number }
  | { type: 'none' } {
  // Is this VIN already gated-in according to the tracking sheet? The `units`
  // store is fetched from the cloud on every app start (not persisted) while
  // tracking rows load instantly from IndexedDB — so right after opening the
  // app the unit may not be loaded yet even though the car is long gated-in.
  // Trust the sheet's Car Status so a search during that window isn't wrongly
  // told "not Gate-in".
  const sheetGated = (vin: string) => {
    const r = rows.find(x => x.vin === vin)
    return !!r && isGatedInStatus(r.cells['Car Status'])
  }
  let u = units.find(x => x.vin === v) ?? null
  if (!u && v.length <= 8) {
    // suffix ambiguity must be checked across BOTH lists together — one unit hit
    // + one tracking-row hit for a DIFFERENT car silently picked the unit before
    const uniq = new Set<string>([...units.filter(x => x.vin.endsWith(v)).map(x => x.vin), ...rows.filter(x => x.vin.endsWith(v)).map(x => x.vin)])
    if (uniq.size > 1) return { type: 'ambiguous', count: uniq.size }
    const hits = units.filter(x => x.vin.endsWith(v))
    if (hits.length === 1) u = hits[0]
  }
  if (u) {
    if (u.status === 'EXPECTED' && !sheetGated(u.vin)) return { type: 'notGated', vin: u.vin, model: u.modelName }
    return { type: 'ok', vin: u.vin }
  }
  // no parkable unit — is it a known (pre-gate-in) tracking row?
  let r = rows.find(x => x.vin === v) ?? null
  if (!r && v.length <= 8) {
    const hits = rows.filter(x => x.vin.endsWith(v))
    if (hits.length === 1) r = hits[0]
    else if (hits.length > 1) return { type: 'ambiguous', count: hits.length }
  }
  if (r) {
    // gated-in per the sheet but the unit hasn't synced here yet → let it through
    // (the caller loads units and shows the car once it arrives)
    if (isGatedInStatus(r.cells['Car Status'])) return { type: 'okPending', vin: r.vin }
    return { type: 'notGated', vin: r.vin, model: r.cells['Model name'] ?? r.cells['Model'] ?? '' }
  }
  return { type: 'none' }
}

// ── process Car-Status strings ────────────────────────────────────────────────
// Car Status is a LIFECYCLE column, not a work log: a car sitting at the PM
// station is still In Yard. Station work is recorded on the Overview (the
// PM1…PM15 / PDI / Final-check date ladder) and in the queue itself — writing
// "PARKING PM · PM20" or "PM · PM20 OK" here dropped the car out of every
// in-yard count. These strings are display labels for the driver/station
// confirmation screens only.
const MOVING_STATUS = 'Moving'
const YARD_STATUS = 'In Yard'
const stationParkLabel = (queue: string) => `PARKING ${queue}`     // e.g. "PARKING PDI"
const stationResultLabel = (queue: string, r: 'OK' | 'NG') => `${queue} ${r}` // e.g. "PDI NG"
// Yard address, column-first: block + column(slot) + "." + row-in-column. Lane
// blocks store the LaneNo column in `slot` and the 1..8 stack position in `row`,
// so the column leads (e.g. RR38.5 = block RR, column 38, car 5).
const slotLabelOf = (u: { block?: string; row?: number; slot?: number }) =>
  u.block ? `${blockCode(u.block)}${u.slot}.${u.row}` : '—'

/**
 * Live status pill for one car in a station queue. Blue = a driver has it right
 * now (with their name, so nobody goes looking for a car that is already moving);
 * green = parked at the station / inspected; grey = still waiting for a driver.
 */
function StagePill({ stage, drivingBy, atStation }: { stage: QueueStage; drivingBy?: string; atStation: string }) {
  const s = drivingBy
    ? { text: `Driving · ${drivingBy}`, bg: 'rgba(37,99,235,0.12)', fg: '#2563eb' }
    : stage === 'at-station' ? { text: atStation, bg: 'rgba(22,163,74,0.12)', fg: '#16a34a' }
    : stage === 'checked' ? { text: 'ตรวจแล้ว', bg: 'rgba(22,163,74,0.12)', fg: '#16a34a' }
    : { text: 'รอส่ง', bg: 'var(--chip)', fg: 'var(--muted)' }
  return (
    <span className="badge text-[10px] mt-0.5 inline-block max-w-[150px] clip" style={{ background: s.bg, color: s.fg }}>
      {s.text}
    </span>
  )
}

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
function NotGatedInModal({ vin, model, title, detail, onClose }: {
  vin: string; model?: string; title?: string; detail?: React.ReactNode; onClose: () => void
}) {
  // onClose via ref + mount-only effect: the inline callback changed identity on
  // every parent render, restarting the 4.5s auto-close forever
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const t = setTimeout(() => onCloseRef.current(), 4500)
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    window.addEventListener('keydown', h)
    return () => { clearTimeout(t); window.removeEventListener('keydown', h) }
  }, [])
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="panel-solid w-full max-w-xs text-center fade-up p-6" onClick={e => e.stopPropagation()}
        style={{ borderTop: '4px solid #f59e0b' }}>
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 pop"
          style={{ background: 'rgba(245,158,11,0.15)' }}>
          <AlertTriangle size={34} style={{ color: '#f59e0b' }} />
        </div>
        <div className="display text-[21px] font-bold" style={{ color: '#b45309' }}>{title ?? 'รถยังไม่ Gate-in'}</div>
        <div className="vin text-[13px] mt-2 font-bold" style={{ color: 'var(--text)' }}>{vin}</div>
        {model && <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{model}</div>}
        <div className="text-[12.5px] mt-3 leading-relaxed" style={{ color: 'var(--muted)' }}>
          {detail ?? <>กรุณานำรถผ่าน <b style={{ color: 'var(--brand)' }}>Gate-in</b> ก่อน จึงจะดำเนินการในขั้นตอนนี้ได้</>}
        </div>
        <button className="btn btn-primary w-full mt-5 py-2.5" onClick={onClose}>เข้าใจแล้ว</button>
      </div>
    </div>
  )
}

/** Hook that owns the "scan refused" popup state for a role view. */
function useNotGatedIn() {
  const [blocked, setBlocked] = useState<{ vin: string; model?: string; title?: string; detail?: React.ReactNode } | null>(null)
  const block = (vin: string, model?: string) => setBlocked({ vin, model })
  /** Refuse a scan for a different reason than "not gated in" (same popup). */
  const blockWith = (vin: string, model: string | undefined, title: string, detail: React.ReactNode) =>
    setBlocked({ vin, model, title, detail })
  const modal = blocked
    ? <NotGatedInModal vin={blocked.vin} model={blocked.model} title={blocked.title} detail={blocked.detail}
        onClose={() => setBlocked(null)} />
    : null
  return { block, blockWith, modal }
}

// ── shared: mobile VIN input ──────────────────────────────────────────────────
/** ประวัติของสถานีนี้บนเครื่องนี้ — VIN ที่เพิ่งค้นหา + รายการที่เพิ่งบันทึก
 *  (ใหม่สุดบน, แตะเพื่อเรียกคันนั้นขึ้นมาอีกครั้ง) */
function RecentPanel({ station, accent, onPick }: { station: string; accent: string; onPick: (vin: string) => void }) {
  const searches = useRecentOps(s => s.lists[`${station}:search`])
  const saves = useRecentOps(s => s.lists[`${station}:save`])
  const clear = useRecentOps(s => s.clear)
  const fmt = (ts: number) => {
    const d = new Date(ts); const p2 = (n: number) => String(n).padStart(2, '0')
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  const section = (title: string, items: typeof searches, key: string) => !items?.length ? null : (
    <div className="panel overflow-hidden fade-up">
      <div className="px-3.5 py-2 border-b hairline flex items-center gap-1.5">
        <Clock size={12} style={{ color: accent }} />
        <span className="text-[11.5px] font-bold" style={{ color: 'var(--muted)' }}>{title} ({items.length})</span>
        <button className="ml-auto text-[11px] font-semibold" style={{ color: 'var(--faint)' }}
          onClick={() => clear(key)}>ล้าง</button>
      </div>
      <div>
        {items.map((e, i) => (
          <button key={e.vin} onClick={() => onPick(e.vin)}
            className="w-full px-3.5 py-2 flex items-center gap-2 text-left transition active:scale-[0.99]"
            style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
            <div className="min-w-0 flex-1">
              <div className="vin text-[12px] font-bold truncate">{e.vin}</div>
              {e.note && <div className="text-[11px] mt-0.5" style={{ color: accent }}>{e.note}</div>}
            </div>
            <span className="text-[10.5px] tabular shrink-0" style={{ color: 'var(--faint)' }}>{fmt(e.at)}</span>
          </button>
        ))}
      </div>
    </div>
  )
  if (!searches?.length && !saves?.length) return null
  return (
    <div className="space-y-3">
      {section('ประวัติการบันทึก', saves, `${station}:save`)}
      {section('ประวัติการค้นหา', searches, `${station}:search`)}
    </div>
  )
}

/**
 * Scan field + camera reader. Defaults read a VIN; the Gate-out station reuses
 * it verbatim for the DN (grouping) barcode by relabelling — same ZXing decode,
 * so the printed Delivery Note scans exactly like a VIN sticker.
 * `autoFocus` is opt-out: with two fields on one screen only one may grab focus.
 */
function VinInput({
  onScan, accent = 'var(--brand)',
  placeholder = 'VIN / 5 ตัวท้าย…',
  action = 'สแกน / ค้นหา',
  camTitle = 'สแกน QR / Barcode VIN',
  camHint = 'จ่อกล้องไปที่ QR Code / Barcode บนรถ',
  autoFocus = true,
}: {
  onScan: (vin: string) => void; accent?: string
  placeholder?: string; action?: string; camTitle?: string; camHint?: string; autoFocus?: boolean
}) {
  const [val, setVal] = useState('')
  const [camOpen, setCamOpen] = useState(false)
  const [camErr, setCamErr] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  // ZXing scanner controls — decodes QR + 1D barcodes (Code128/39, EAN, DataMatrix)
  // in pure JS so it works on iOS Safari too (native BarcodeDetector is missing there).
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  // live camera track — zoom / torch are applied straight onto it where the
  // device supports them (Android Chrome: both · iOS 17+: zoom only)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const [zoomCap, setZoomCap] = useState<{ min: number; max: number; step: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [torchCap, setTorchCap] = useState(false)
  const [torchOn, setTorchOn] = useState(false)

  const applyZoom = (z: number) => {
    const t = trackRef.current
    if (!t || !zoomCap) return
    const v = Math.min(zoomCap.max, Math.max(zoomCap.min, z))
    setZoom(v)
    t.applyConstraints({ advanced: [{ zoom: v } as MediaTrackConstraintSet] }).catch(() => {})
  }
  const toggleTorch = () => {
    const t = trackRef.current
    if (!t) return
    const on = !torchOn
    t.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
      .then(() => setTorchOn(on)).catch(() => {})
  }

  const go = (raw?: string) => {
    const v = (raw ?? val).trim().toUpperCase()
    if (v.length >= 3) { onScan(v); setVal('') }
  }

  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  // Fully release the camera: stop ZXing's decode loop AND every media track,
  // then detach from the <video> so the OS camera indicator turns off.
  const stopScan = () => {
    try { controlsRef.current?.stop() } catch { /* already stopped */ }
    controlsRef.current = null
    const v = videoRef.current
    const s = v?.srcObject as MediaStream | null
    s?.getTracks().forEach(t => t.stop())
    if (v) v.srcObject = null
    trackRef.current = null
    setZoomCap(null); setZoom(1); setTorchCap(false); setTorchOn(false)
  }

  const openCamera = () => { setCamErr(''); setCamOpen(true) }
  const closeCamera = () => { stopScan(); setCamOpen(false) }

  // Start the scanner whenever the overlay opens. ZXing manages getUserMedia +
  // srcObject + play() + the continuous decode loop internally, which also
  // avoids the stream-lifecycle race that left the old preview black.
  useEffect(() => {
    if (!camOpen) return
    let cancelled = false

    // ask for a real capture size: the default 640×480 left a windshield QR
    // only ~40 px wide, below what any decoder can read
    const VIDEO: MediaTrackConstraints = { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }

    // zoom + torch, where the hardware offers them. A slight starting zoom
    // (2×, capped) puts far more pixels on the small sticker code.
    const setupTrack = (video: HTMLVideoElement) => {
      const track = (video.srcObject as MediaStream | null)?.getVideoTracks?.()[0] ?? null
      trackRef.current = track
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min?: number; max?: number; step?: number }; torch?: boolean }
      if (caps.zoom && typeof caps.zoom.max === 'number' && caps.zoom.max > (caps.zoom.min ?? 1)) {
        const cap = { min: caps.zoom.min ?? 1, max: caps.zoom.max, step: caps.zoom.step || 0.1 }
        setZoomCap(cap)
        const z = Math.min(2, cap.max)
        track!.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] })
          .then(() => setZoom(z)).catch(() => setZoom(cap.min))
      }
      setTorchCap(!!caps.torch)
    }

    const hit = (text?: string | null) => {
      const t = text?.trim().toUpperCase()
      if (t) { closeCamera(); go(t) }
    }

    // Path 1 — native BarcodeDetector (Android Chrome): hardware-accelerated and
    // markedly better than JS decoding at glare / angle / focus hunting. Detects
    // straight off the <video> ~8×/sec.
    const startNative = async (): Promise<boolean> => {
      const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): { detect: (v: HTMLVideoElement) => Promise<{ rawValue?: string }[]> }; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector
      if (!BD) return false
      try {
        const supported = (await BD.getSupportedFormats?.()) ?? []
        const want = ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'].filter(f => supported.includes(f))
        if (!want.includes('qr_code')) return false
        const video = videoRef.current
        if (!video || cancelled) return false
        const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return true }
        video.srcObject = stream
        await video.play().catch(() => {})
        const det = new BD({ formats: want })
        const iv = setInterval(async () => {
          if (video.readyState < 2) return
          try {
            const codes = await det.detect(video)
            if (codes.length) hit(codes[0].rawValue)
          } catch { /* detector hiccup — next tick */ }
        }, 120)
        controlsRef.current = { stop: () => clearInterval(iv) }
        setupTrack(video)
        return true
      } catch { return false } // permission error falls through to ZXing for its message
    }

    // Path 2 — ZXing (iOS Safari + anything without BarcodeDetector)
    const startZxing = async () => {
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
      // spend more CPU per frame to catch small / skewed / low-contrast codes —
      // the VIN sticker sits BEHIND the windshield glass, tiny and full of glare
      hints.set(DecodeHintType.TRY_HARDER, true)
      // the library waits 500 ms between attempts by default — only two tries a
      // second made every scan feel like it "doesn't stick". Scan ~12×/sec.
      const reader = new BrowserMultiFormatReader(hints as never, { delayBetweenScanAttempts: 80 })
      const controls = await reader.decodeFromConstraints({ video: VIDEO }, video,
        (result) => { if (result) hit(result.getText()) })
      if (cancelled) { controls.stop(); return }
      controlsRef.current = controls
      setupTrack(video)
    }

    ;(async () => {
      try {
        if (!(await startNative())) await startZxing()
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
            <span className="text-white font-bold text-[16px]">{camTitle}</span>
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
          {/* zoom / torch — only when the camera reports the capability */}
          {(zoomCap || torchCap) && (
            <div className="px-5 py-2 flex items-center gap-3 shrink-0" style={{ touchAction: 'pan-x' }}>
              {zoomCap && (
                <>
                  <span className="text-white/70 text-[12px] shrink-0">ซูม</span>
                  <input
                    type="range" className="flex-1" style={{ accentColor: accent }}
                    min={zoomCap.min} max={zoomCap.max} step={zoomCap.step}
                    value={zoom} onChange={e => applyZoom(Number(e.target.value))}
                  />
                  <span className="text-white/70 text-[12px] tabular shrink-0" style={{ width: 36, textAlign: 'right' }}>{zoom.toFixed(1)}×</span>
                </>
              )}
              {torchCap && (
                <button onClick={toggleTorch}
                  className="shrink-0 px-3 py-1.5 rounded-full text-[12.5px] font-bold flex items-center gap-1.5"
                  style={torchOn ? { background: '#fbbf24', color: '#000' } : { background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
                  <Zap size={14} /> ไฟฉาย
                </button>
              )}
            </div>
          )}
          <div className="px-4 py-3 text-center text-white/60 text-[13px] shrink-0">
            {camHint}{zoomCap ? ' · เลื่อนซูมถ้าโค้ดเล็ก' : ''}
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
            placeholder={placeholder}
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
          <ScanLine size={20} /> {action}
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
  const hasWalkNG = walkDmgs.length > 0
  const [walkOpen, setWalkOpen] = useState(false)
  const [lightbox, setLightbox] = useState<{ photos: string[]; index: number } | null>(null)
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
            <button type="button" disabled={!hasWalkNG} onClick={() => setWalkOpen(true)}
              className="flex-1 p-3 text-center transition active:scale-95 disabled:cursor-default">
              <div className="text-[10px] font-bold uppercase" style={{ color: 'var(--muted)' }}>Walk around</div>
              <div className="font-bold mt-0.5 flex items-center justify-center gap-1" style={{ color: walkStatus.color }}>
                {walkStatus.text}{hasWalkNG && <span className="text-[11px]">· ดู Defect ›</span>}
              </div>
            </button>
          )}
          {stationStatus && (
            <div className="flex-1 p-3 text-center">
              <div className="text-[10px] font-bold uppercase" style={{ color: 'var(--muted)' }}>{stationStatus.queue}</div>
              <div className="font-bold mt-0.5" style={{ color: stationStatus.color }}>{stationStatus.text}</div>
            </div>
          )}
        </div>
      )}

      {/* walk-around Defect popup — so the driver sees what's wrong with the car */}
      {walkOpen && createPortal(
        <div className="fixed inset-0 z-[95] flex items-end sm:items-center justify-center p-3" style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(3px)' }} onClick={() => setWalkOpen(false)}>
          <div className="panel-solid w-full pop overflow-hidden flex flex-col" style={{ maxWidth: 460, maxHeight: '85vh' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b hairline shrink-0" style={{ background: '#fff8f8' }}>
              <AlertTriangle size={16} style={{ color: 'var(--st-damage)' }} />
              <span className="font-bold text-[14px]" style={{ color: 'var(--st-damage)' }}>Walk around · Defect ({walkDmgs.length})</span>
              <button className="ml-auto p-1.5 rounded-lg" style={{ color: 'var(--muted)' }} onClick={() => setWalkOpen(false)}><X size={17} /></button>
            </div>
            <div className="overflow-auto p-3 space-y-2.5">
              {walkDmgs.map(d => <DefectCard key={d.id} d={d} />)}
            </div>
          </div>
        </div>, document.body)
      }
      {lightbox && <PhotoLightbox photos={lightbox.photos} index={lightbox.index} onClose={() => setLightbox(null)} />}
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

/** A Defect is tagged ACC BYD when its category label says so, or its status is Acc byd. */
const isAccByd = (d: { categoryNG?: string; statusRepair?: string }) =>
  /acc\s*byd/i.test(d.categoryNG || '') || d.statusRepair === 'Acc byd'

/** Shared Defect card — identical look on every gate-in / ops-scan station.
 *  Green "ACC BYD" when tagged. `right` is the per-station control (edit pencil
 *  or tap-status badge). Self-contained photo lightbox. */
function DefectCard({ d, right }: { d: Damage; right?: React.ReactNode }) {
  const [lb, setLb] = useState<number | null>(null)
  const photos = d.photos?.length ? d.photos : (d.photo ? [d.photo] : [])
  // resolved (Accept / Repaired / ACC BYD / any status ≠ Waiting Repair) → green
  // card; only a defect still waiting for repair stays red
  const resolved = !!d.statusRepair && d.statusRepair !== 'Waiting Repair'
  const tint = resolved
    ? { bg: 'rgba(22,163,74,0.06)', border: '1px solid rgba(22,163,74,0.2)', fg: '#15803d' }
    : { bg: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.14)', fg: 'var(--st-damage)' }
  return (
    <>
      <div className="rounded-xl overflow-hidden" style={{ background: tint.bg, border: tint.border }}>
        <div className="p-3 space-y-2">
          <div className="flex items-start gap-2">
            {resolved
              ? <CheckCircle2 size={14} style={{ color: tint.fg, marginTop: 2, flexShrink: 0 }} />
              : <AlertTriangle size={14} style={{ color: tint.fg, marginTop: 2, flexShrink: 0 }} />}
            <div className="flex-1 min-w-0">
              {(() => {
                // English on top, Thai underneath — Thai wording comes from the
                // master list, i.e. the same words the +ADD DEFECT dropdowns show
                const p = partBilingual(d), q = defectBilingual(d)
                const thLine = (p.th !== p.en || q.th !== q.en) ? `${p.th} // ${q.th || '—'}` : ''
                return (
                  <div className="text-[12.5px] leading-snug">
                    <span className="font-bold" style={{ color: tint.fg }}>{p.en}</span>
                    <span className="font-semibold" style={{ color: tint.fg }}> // {q.en || '—'}</span>
                    {isAccByd(d) && <span className="font-extrabold" style={{ color: '#16a34a' }}> · ACC BYD</span>}
                    {(d.remark || d.note) && <span className="font-semibold" style={{ color: 'var(--text)' }}> · {d.remark || d.note}</span>}
                    {thLine && <div className="text-[11.5px] font-normal mt-0.5" style={{ color: 'var(--muted)' }}>{thLine}</div>}
                  </div>
                )
              })()}
            </div>
            {right && <div className="shrink-0">{right}</div>}
          </div>
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px]" style={{ color: 'var(--text)' }}>
            <span className="flex items-center gap-1"><User size={11} /> {d.by || '—'}</span>
            <span className="flex items-center gap-1"><Clock size={11} /> {fmtDateTime(d.at).date} {fmtDateTime(d.at).time}</span>
          </div>
          {photos.length > 0 && <DamagePhotoThumbs photos={photos} onOpen={i => setLb(i)} />}
        </div>
      </div>
      {lb != null && <PhotoLightbox photos={photos} index={lb} onClose={() => setLb(null)} />}
    </>
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
type DmgRow = { rid: string; area: string; detail: string; remark: string; severity: 'minor' | 'major'; photos: string[] }

// Maps display text → stored ID (for known entries)
const TYPE_TEXT_MAP = Object.fromEntries(TYPES.map(t => [t.th, t.id]))
const AREA_TEXT_MAP = Object.fromEntries(POSITION_OPTS.map(p => [p.th, p.id]))

const mkRow = (): DmgRow => ({
  rid: `r${Date.now()}${Math.random().toString(36).slice(2)}`,
  area: '',    // blank — operator types the position (datalist still suggests)
  detail: '',  // blank — operator types the defect
  remark: '',
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
  const [armed, setArmed] = useState<string | null>(null) // rid whose delete is armed (2-tap guard)
  const [accByd, setAccByd] = useState(false) // ACC BYD label (defect is always HEAVY NG)
  const upd = (rid: string, k: keyof DmgRow, v: string) =>
    setRows(r => r.map(x => x.rid === rid ? { ...x, [k]: v } : x))
  const del = (rid: string) => { setRows(r => r.length > 1 ? r.filter(x => x.rid !== rid) : r); setArmed(null) }

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

  // every defect must carry at least one photo before it can be saved
  const allPhotographed = rows.every(row => row.photos.length > 0)
  const lastSaveRef = useRef(0) // double-tap guard — each save mints new damage ids
  const save = () => {
    if (Date.now() - lastSaveRef.current < 1500) return
    if (busyRid) { toast('err', 'รอรูปอัปโหลดเสร็จก่อนบันทึก'); return }
    if (!allPhotographed) { toast('err', 'กรุณาถ่ายรูป Defect อย่างน้อย 1 รูปต่อรายการ'); return }
    lastSaveRef.current = Date.now()
    onSaveAll(rows.map(row => {
    const part = resolvePart(row.area)     // { en, th } from the master Part list
    const def = resolveDefect(row.detail)  // { en, th } from the master Defect list
    return {
      area:   part.en,          // English part — primary (admin/report)
      areaTh: part.th,          // Thai part — shown below in admin
      item:   def.en,           // English defect — primary
      itemTh: def.th,           // Thai defect — shown below in admin
      type:   'scratch',        // legacy field kept for back-compat
      severity: 'major' as const,                          // gate-in Defect is always HEAVY NG
      categoryNG: accByd ? 'HEAVY NG · ACC BYD' : 'HEAVY NG',
      statusRepair: 'Waiting Repair' as const,             // opens waiting for repair
      remark: row.remark.trim() || undefined,
      photos: row.photos.length ? row.photos : undefined,
      photo: row.photos[0],
    }
  }))
  }

  return (
    <div className="panel fade-up" style={{ overflow: 'visible' }}>
      <div className="p-3 text-[13px] font-semibold flex items-center gap-2 border-b hairline rounded-t-2xl" style={{ background: '#fff8f8' }}>
        <AlertTriangle size={15} style={{ color: 'var(--st-damage)' }} />
        <span style={{ color: 'var(--st-damage)' }}>+ADD DEFECT</span>
      </div>
      <div className="p-4 space-y-2">
        {/* column headers */}
        <div className="grid gap-2 px-0.5 text-[10.5px] font-bold uppercase" style={{ gridTemplateColumns: '1fr 1fr 32px', color: 'var(--muted)' }}>
          <span>ตำแหน่ง</span><span>รายละเอียด Defect</span><span />
        </div>

        {/* damage rows — each field is a combobox: type freely or pick from list */}
        {rows.map(row => (
          <div key={row.rid} className="space-y-1.5 pb-1.5 border-b hairline last:border-b-0">
            <div className="grid gap-1.5 items-start" style={{ gridTemplateColumns: '1fr 1fr 32px' }}>
              <MasterCombo options={POSITION_OPTS} placeholder="ตำแหน่ง…"
                value={row.area} onChange={v => upd(row.rid, 'area', v)} />
              <MasterCombo options={TYPES} placeholder="รายละเอียด…"
                value={row.detail} onChange={v => upd(row.rid, 'detail', v)} />

              {/* delete guard: first tap arms (pencil → trash), second tap deletes */}
              <button
                onClick={() => (armed === row.rid ? del(row.rid) : setArmed(row.rid))}
                title={armed === row.rid ? 'กดอีกครั้งเพื่อลบ' : 'แก้ไข / ลบ'}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition"
                style={armed === row.rid
                  ? { color: '#fff', background: '#dc2626' }
                  : { color: 'var(--muted)', background: 'var(--chip)' }}
              >
                {armed === row.rid ? <Trash2 size={12} /> : <Pencil size={12} />}
              </button>
            </div>

            {/* remark — free text (e.g. "Move From Main yard") */}
            <input
              className="input text-[12.5px] w-full"
              style={{ padding: '7px 8px' }}
              placeholder="Remark (หมายเหตุ)…"
              value={row.remark}
              onChange={e => upd(row.rid, 'remark', e.target.value)}
            />

            <PhotoStrip
              photos={row.photos}
              busy={busyRid === row.rid}
              onAdd={files => addPhotos(row.rid, files)}
              onRemove={i => removePhoto(row.rid, i)}
            />
          </div>
        ))}

        {/* Defect is always HEAVY NG · optional ACC BYD label */}
        <div className="flex gap-2 pt-0.5">
          <div className="flex-1 py-2 rounded-xl text-[12px] font-bold text-center" style={{ background: '#dc2626', color: '#fff' }}>
            HEAVY NG
          </div>
          <button onClick={() => setAccByd(v => !v)}
            className="flex-1 py-2 rounded-xl text-[12px] font-bold transition flex items-center justify-center gap-1.5"
            style={accByd
              ? { background: '#1d4ed8', color: '#fff' }
              : { background: 'var(--chip)', color: 'var(--muted)', border: '1px dashed var(--line-strong)' }}>
            {accByd ? <CheckCircle2 size={14} /> : <XCircle size={14} style={{ opacity: 0.5 }} />} ACC BYD
          </button>
        </div>

        {/* add row */}
        <button
          onClick={() => setRows(r => [...r, mkRow()])}
          className="w-full py-2.5 rounded-xl text-[13px] font-semibold flex items-center justify-center gap-1.5 border-2 border-dashed transition"
          style={{ color: 'var(--st-damage)', borderColor: '#fca5a5' }}
        >
          <Plus size={14} /> เพิ่มแผล
        </button>

        {/* photo requirement hint */}
        {!allPhotographed && (
          <div className="text-[11.5px] flex items-center gap-1.5 pt-0.5" style={{ color: 'var(--st-damage)' }}>
            <Camera size={13} /> ต้องถ่ายรูป Defect อย่างน้อย 1 รูปต่อรายการก่อนบันทึก
          </div>
        )}

        {/* actions */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button className="btn py-3 text-[13.5px]" onClick={onCancel}>ยกเลิก</button>
          <button className="btn py-3 text-[13.5px] font-bold"
            onClick={save} disabled={!allPhotographed}
            style={{ background: allPhotographed ? 'var(--st-damage)' : 'var(--chip)', color: allPhotographed ? '#fff' : 'var(--faint)', border: 'none' }}>
            <Plus size={14} /> บันทึก HEAVY NG{rows.length > 1 ? ` (${rows.length})` : ''}
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
  const [vin, setVin] = useState<string | null>(null)
  const [trackingVin, setTrackingVin] = useState<string | null>(null)
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)
  const [showDmg, setShowDmg] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editArea, setEditArea] = useState('')
  const [editDetail, setEditDetail] = useState('')
  const [editRemark, setEditRemark] = useState('')
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
    // completed queues drop off the live Ops-Scan list (they've filed under their day)
    queues.filter(q => isPreGateInQueue(q.name) && !isQueueComplete(q)),
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
    if (!selectedQueue) return [] as { vin: string; model: string; color: string; grouping: string; location: string; done: boolean; ng: boolean; doneAt?: number; doneBy?: string }[]
    return selectedQueue.items.map(i => {
      const row = trackingRows.find(r => r.vin === i.vin)
      const u = allUnits.find(x => x.vin === i.vin)
      // when the car was gate-in scanned: the queue item's doneAt, or the
      // "Gate In Time" cell that doTrackingGateIn stamps on the tracking row
      const gitCell = row?.cells['Gate In Time']
      return {
        vin: i.vin,
        model: row?.cells['Model'] ?? row?.cells['Model name'] ?? u?.modelName ?? '—',
        color: row?.cells['Color'] ?? u?.color ?? '—',
        grouping: row?.cells['Grouping  Number'] || '—',
        location: yardLocCode(u) || '—',
        done: i.done,
        ng: ngVins.has(i.vin),
        doneAt: i.doneAt ?? (gitCell ? parseInt(gitCell) || undefined : undefined),
        doneBy: i.doneBy ?? row?.cells['Gate In Inspector'] ?? '',
      }
    }).sort((a, b) => Number(a.done) - Number(b.done)) // ยังไม่สแกน ขึ้นก่อน
  }, [selectedQueue, trackingRows, allUnits, ngVins])

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
    // register as yard unit so Driver can find it for parking assignment. ALWAYS
    // (re)register — a car that had a placeholder unit (e.g. a manual defect added
    // pre-gate-in, model '') would otherwise keep an empty model, and the parking
    // policy is keyed by model, so it would be allowed in ANY block instead of its
    // configured ones. importUnits refreshes model/modelName from the sheet.
    importUnits([{
      vin:     trackRow.vin,
      model:   trackRow.cells['Model name'] ?? trackRow.cells['Model'] ?? '',
      color:   trackRow.cells['Color'] ?? '',
      lot:     trackRow.cells['Lot transfer'] ?? undefined,
      trailer: parseInt(trackRow.cells['Grouping  Number'] ?? '0') || 0,
    }])
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
                  <div className="border-t hairline max-h-[65vh] overflow-y-auto divide-y" style={{ borderColor: 'var(--line)' }}>
                    {queueCars.map(c => (
                      <button key={c.vin} onClick={() => setTrackingVin(c.vin)}
                        className="w-full px-4 py-2.5 flex items-center gap-3 text-left transition active:bg-chip"
                        style={c.done ? { opacity: 0.62 } : undefined}>
                        <div className="min-w-0 flex-1">
                          <div className="vin text-[12.5px] font-bold clip">{c.vin}</div>
                          <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: 'var(--muted)' }}>
                            <span>{c.model}</span><span>· {c.color}</span><span>· {c.grouping}</span>
                          </div>
                          {c.done && c.doneAt && (
                            <div className="text-[10.5px] mt-0.5 flex items-center gap-1" style={{ color: 'var(--faint)' }}>
                              <Clock size={10} />
                              <span>ตรวจ {new Date(c.doneAt).toLocaleString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                              {c.doneBy && <span>· {c.doneBy}</span>}
                            </div>
                          )}
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
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Tax Payment Date</div>
                  <div className="font-semibold">{fmtSerialToDate(trackRow.cells['Tax Payment Date']) || '—'}</div>
                </div>
                <div>
                  <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Tax Payment (STATUS)</div>
                  {(() => {
                    const st = (trackRow.cells['Tax Payment (STATUS)'] ?? trackRow.cells['Status Tax'] ?? '').trim()
                    if (!st) return <div className="font-semibold">—</div>
                    const t = st.toLowerCase()
                    const paid = /yes|already|paid|ชำระแล้ว|เสียแล้ว/.test(t)
                    const no   = /^no|ยังไม่|not/.test(t)
                    const color = paid ? '#16a34a' : no ? '#dc2626' : '#d97706'
                    const bg    = paid ? 'rgba(22,163,74,0.12)' : no ? 'rgba(220,38,38,0.1)' : 'rgba(217,119,6,0.12)'
                    return <span className="badge font-bold" style={{ fontSize: 10.5, background: bg, color }}>{st}</span>
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
                      key={trackRow.vin}
                      onSaveAll={damages => {
                        const valid = damages.filter(d => (d.area ?? '').trim())
                        if (!valid.length) { toast('err', 'กรุณาใส่ตำแหน่ง Defect อย่างน้อย 1 จุด'); return }
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
                                      <span className="font-bold" style={{ color: 'var(--st-damage)' }}>{partLabel(d, 'th')}</span>
                                      <span className="font-semibold" style={{ color: 'var(--st-damage)' }}> // {defectLabel(d, 'th') || '—'}</span>
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
                key={unit.vin}
                onSaveAll={damages => {
                  damages.forEach(d => addDamage(unit.vin, { ...d, source: 'walkaround', station: 'Gate-in' }))
                  toast('ok', damages.length > 1 ? `บันทึก Defect ${damages.length} รายการ` : 'บันทึก Defect แล้ว')
                  setShowDmg(false)
                }}
                onCancel={() => setShowDmg(false)}
              />
            )}
            {unit.damages.map(d => (
              editId === d.id ? (
                <div key={d.id} className="rounded-xl mb-2 overflow-hidden" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.14)' }}>
                  <div className="p-3 space-y-2">
                    <div className="grid gap-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <div>
                        <div className="text-[10px] font-bold mb-1" style={{ color: 'var(--muted)' }}>Position</div>
                        <MasterCombo options={POSITION_OPTS} placeholder="ตำแหน่ง…" value={editArea} onChange={setEditArea} />
                      </div>
                      <div>
                        <div className="text-[10px] font-bold mb-1" style={{ color: 'var(--muted)' }}>Defect/NG</div>
                        <MasterCombo options={TYPES} placeholder="รายละเอียด…" value={editDetail} onChange={setEditDetail} />
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold mb-1" style={{ color: 'var(--muted)' }}>Remark (หมายเหตุ)</div>
                      <input className="input text-[12px] w-full" style={{ padding: '6px 8px' }}
                        placeholder="หมายเหตุ…" value={editRemark} onChange={e => setEditRemark(e.target.value)} />
                    </div>
                    <div className="flex gap-1.5">
                      <button className="btn flex-1 text-[12px] py-1.5" onClick={() => setEditId(null)}>ยกเลิก</button>
                      <button className="btn flex-1 text-[12px] py-1.5 font-bold"
                        style={{ background: 'var(--brand)', color: '#fff', border: 'none' }}
                        onClick={() => {
                          const p = resolvePart(editArea), df = resolveDefect(editDetail)
                          updateDamage(unit.vin, d.id, {
                            area: p.en || d.area, areaTh: p.th || d.areaTh,
                            item: df.en || d.item, itemTh: df.th || d.itemTh,
                            remark: editRemark.trim() || undefined,
                          })
                          setEditId(null)
                        }}>บันทึก</button>
                    </div>
                  </div>
                </div>
              ) : (
                <div key={d.id} className="mb-2">
                  <DefectCard d={d} right={
                    <button
                      onClick={() => { setEditId(d.id); setEditArea(partLabel(d, 'th')); setEditDetail(defectLabel(d, 'th')); setEditRemark(d.remark ?? '') }}
                      className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                      style={{ background: 'rgba(255,255,255,0.8)', color: 'var(--muted)' }}>
                      <Pencil size={11} />
                    </button>
                  } />
                </div>
              )
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

/** Browsable list of every station work queue (PDI / PM / FINAL CHECK / งานพิเศษ).
 *  Driver-only: a driver moves cars for all stations, so they need to see them
 *  all — the stations themselves stay strictly scoped to their own type. */
function AllQueuesBrowser({ queues, units, trackingRows, onPick }: {
  queues: WorkQueue[]; units: Unit[]; trackingRows: TrackRow[]; onPick: (vin: string) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  if (!queues.length) return null
  return (
    <div className="space-y-2.5 fade-up">
      <div className="text-[10.5px] font-bold uppercase tracking-wider px-1" style={{ color: 'var(--muted)' }}>คิวงานสถานี · ทุกประเภท</div>
      {queues.map(q => {
        const { done, total } = stationProgress(q)
        const isOpen = q.id === openId
        const cars = q.items.filter(i => !i.done).map(i => {
          const u = units.find(x => x.vin === i.vin)
          const row = trackingRows.find(r => r.vin === i.vin)
          return {
            vin: i.vin,
            model: u?.modelName ?? row?.cells['Model name'] ?? row?.cells['Model'] ?? '—',
            location: yardLocCode(u) || '—',
            stage: stageOf(i),
            drivingBy: drivingNow(i),
          }
        }).sort((a, b) => byYardLocation(a.location, b.location))
        return (
          <div key={q.id} className="panel overflow-hidden">
            <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setOpenId(isOpen ? null : q.id)}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--chip)', color: 'var(--st-yard)' }}>
                <ClipboardList size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-[12.5px] clip">{q.name}</div>
                <div className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--muted)' }}>
                  <span className="badge text-[9.5px] font-bold" style={{ background: 'rgba(22,163,74,0.1)', color: 'var(--st-yard)' }}>{queueTypeOf(q)}</span>
                  {total === 0
                    ? <span style={{ color: '#d97706' }}>ยังไม่มีรถในคิว</span>
                    : <span><b style={{ color: 'var(--text)' }}>{done}/{total}</b> คัน · เหลือ <b style={{ color: total - done > 0 ? '#d97706' : '#16a34a' }}>{total - done}</b></span>}
                </div>
              </div>
              <ChevronLeft size={16} style={{ color: 'var(--muted)', transform: isOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
            </button>
            {isOpen && (cars.length > 0 ? (
              <div className="border-t hairline max-h-[60vh] overflow-y-auto divide-y" style={{ borderColor: 'var(--line)' }}>
                {cars.map(item => (
                  <button key={item.vin} onClick={() => onPick(item.vin)}
                    className="flex items-center gap-3 px-4 py-2.5 w-full text-left transition active:bg-chip">
                    <div className="flex-1 min-w-0">
                      <div className="vin text-[12.5px] font-bold clip">{item.vin}</div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{item.model}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="tabular text-[12px] font-bold">{item.location}</div>
                      <StagePill stage={item.stage} drivingBy={item.drivingBy} atStation="Parking" />
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-4 py-3 border-t hairline text-[12px] font-semibold" style={{ color: total === 0 ? '#d97706' : '#16a34a' }}>
                {total === 0 ? 'ยังไม่มีรถในคิวนี้' : '✓ ส่งครบแล้ว'}
              </div>
            ))}
          </div>
        )
      })}
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
  const { assign, confirmParked, resetParking, toast, currentUser, policies, groupModelsInRow, laneDepth, planMode, startTrip, endTrip, sites, currentSite, loadFromSupabase } = useYard()
  const blocks = useBlocks()
  const { deliverToStation, returnToSlot, markAtWash, markAtLane, setDriving } = useOps()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  useEffect(() => { loadFromIdb() }, [loadFromIdb])
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
  const seqQueues = useMemo(() => queues.filter(q => isSequenceQueue(q) && !isQueueComplete(q)), [queues])
  // the driver moves cars for EVERY station, so they see all work queues
  // (PDI / PM / FINAL CHECK / งานพิเศษ) — unlike the stations, which are
  // strictly scoped to their own type.
  const allWorkQueues = useMemo(
    () => queues.filter(q => !isSequenceQueue(q) && !isPreGateInQueue(q.name) && !isQueueComplete(q)),
    [queues],
  )

  // the car's current station task (PDI / PM / Wash …), if any — Pre Gate-in
  // queues are NOT stations: matching them offered "ส่งเข้าสถานี · (Rayong·…)"
  // and wrote a bogus "PARKING (…)" Car Status
  const activeProc = useMemo(() => (unit ? activeProcess(unit.vin, queues.filter(q => !isPreGateInQueue(q.name))) : null), [unit, queues])
  const procStage = activeProc ? stageOf(activeProc.item) : null
  // a slot proposal is needed both for the gate-in first-park AND for returning a checked car
  const needsSlot = !!unit && (unit.status === 'GATE_IN' || (unit.status === 'PARKED' && procStage === 'checked'))
  // Resolve the model the parking policy is keyed by. ALWAYS run it through
  // matchModel (the same way the Rules page keys each policy) — trusting the
  // stored unit.model is unreliable: it can be empty (placeholder unit) OR a
  // non-canonical value ("BYD ATTO 2" instead of the id "ATTO2"), which makes
  // getPolicy fall back to "any block" and offer disallowed blocks.
  const unitForSlot = useMemo(() => {
    if (!unit) return null
    const cells = trackingRows.find(r => r.vin === unit.vin)?.cells
    const nm = unit.modelName || cells?.['Model name'] || cells?.['Model'] || unit.model || ''
    const model = matchModel(nm).id
    return model === unit.model ? unit : { ...unit, model }
  }, [unit, trackingRows])
  const cands = useMemo(
    () => (needsSlot && unitForSlot ? candidates(unitForSlot, blocks, policies, units, groupModelsInRow, laneDepth) : []),
    [needsSlot, unitForSlot, blocks, policies, units, groupModelsInRow, laneDepth],
  )
  const proposal = cands[Math.min(altIdx, Math.max(0, cands.length - 1))] ?? null

  const onScan = (v: string) => {
    const res = resolveForUnit(v, units, trackingRows)
    if (res.type === 'ambiguous') { toast('err', `พบ ${res.count} คัน — พิมพ์ให้ยาวขึ้น`); return }
    if (res.type === 'none') { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (res.type === 'notGated') { blockGate(res.vin, res.model); return }
    if (res.type === 'okPending') { toast('ok', 'กำลังโหลดข้อมูลรถ…'); loadFromSupabase() } // unit not synced yet
    setVin(res.vin)
  }
  const doAssign = (slot: { block: string; row: number; slot: number }) => {
    if (!unit) return
    assign(unit.vin, slot, driverName, planMode)
    startTrip(unit.vin, driverName, 'Gate', `${blockCode(slot.block)}${slot.slot}.${slot.row}`)
    toast('ok', `${unit.vin.slice(-6)} → ${blockCode(slot.block)}${slot.slot}.${slot.row}`)
  }
  const doPark = () => {
    if (!unit) return
    const since = unit.drivingStartedAt
    const elapsed = since ? Math.floor((Date.now() - since) / 1000) : 0
    endTrip(unit.vin)
    confirmParked(unit.vin)
    // parked in a lane ⇒ the car is now In Yard. The physical slot shows in the
    // Location column (derived from block/slot/row) — Car Status must stay a
    // lifecycle status, not the slot code.
    updateCell(unit.vin, 'Car Status', 'In Yard')
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
    // only a real lifecycle status is worth restoring on cancel — a legacy
    // "PARKING PM · PM20" would just be written straight back
    const cur = trackingRows.find(r => r.vin === unit.vin)?.cells['Car Status'] ?? ''
    const prevStatus = CAR_STATUS_META[cur] ? cur : YARD_STATUS
    const fromLabel = kind === 'to-station' ? slotLabelOf(unit) : activeProc.queue.name
    const destLabel = kind === 'to-station' ? activeProc.queue.name : `${blockCode(slot!.block)}${slot!.slot}.${slot!.row}`
    const dest = kind === 'to-slot' && slot ? slotToLatLng(slot.block, slot.row, slot.slot) : null
    updateCell(unit.vin, 'Car Status', MOVING_STATUS)
    startTrip(unit.vin, driverName, fromLabel, destLabel)
    // publish the driver on the queue item so every other phone can see who has
    // this car right now (cleared the moment it arrives)
    setDriving(activeProc.queue.id, unit.vin, driverName)
    setProc({ kind, queueId: activeProc.queue.id, queueName: activeProc.queue.name, fromLabel, destLabel, dest, slot, prevStatus })
  }
  const arriveProc = () => {
    if (!unit || !proc) return
    endTrip(unit.vin)
    // the car never leaves the yard on a station run — Car Status goes back to
    // In Yard either way; the station work itself lands on the Overview
    if (proc.kind === 'to-station') {
      deliverToStation(proc.queueId, unit.vin, proc.fromLabel, driverName)
      updateCell(unit.vin, 'Car Status', YARD_STATUS)
      setProcDone({ label: stationParkLabel(proc.queueName), sub: `ส่งเข้าสถานี ${proc.queueName} แล้ว · รอตรวจ`, accent: '#0ea5e9' })
    } else {
      if (proc.slot) { assign(unit.vin, proc.slot, driverName, planMode); confirmParked(unit.vin) }
      returnToSlot(proc.queueId, unit.vin, driverName)
      updateCell(unit.vin, 'Car Status', YARD_STATUS)
      setProcDone({ label: proc.destLabel, sub: `${proc.queueName} เสร็จ · จอดที่ ${proc.destLabel}`, accent: 'var(--st-yard)' })
    }
    setProc(null)
  }
  const cancelProc = () => {
    if (unit && proc) {
      endTrip(unit.vin)
      updateCell(unit.vin, 'Car Status', proc.prevStatus)
      setDriving(proc.queueId, unit.vin, undefined) // nobody is driving it now
    }
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
            {blockCode(unit.block ?? '')}{unit.slot}.{unit.row}
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>Block {blockCode(unit.block ?? '')} · ช่อง {unit.slot} · แถว {unit.row}</div>
        </div>

        {/* driving summary */}
        <div className="panel overflow-hidden">
          <div className="px-4 py-2.5 border-b hairline flex items-center gap-2">
            <Gauge size={15} style={{ color: 'var(--st-yard)' }} />
            <span className="font-semibold text-[13.5px]">สรุปการขับขี่</span>
            <span className="ml-auto text-[11px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
              <Navigation size={11} /> Gate → {blockCode(unit.block ?? '')}{unit.slot}.{unit.row}
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
                  markers={[{ vin: unit.vin, lat: lastPt.lat, lng: lastPt.lng, color: 'var(--brand)', label: `${blockCode(unit.block ?? '')}${unit.slot}.${unit.row}` }]}
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
        <SeqQueuePicker queues={seqQueues} units={units} trackingRows={trackingRows} />
      )}

      {/* ── every station work queue — the driver serves them all ── */}
      {!unit && !seqHit && (
        <AllQueuesBrowser queues={allWorkQueues} units={units} trackingRows={trackingRows}
          onPick={v => setVin(v)} />
      )}

      {/* ── delivery-sequence step (takes over from the normal parking flow) ── */}
      {unit && seqHit && (() => {
        const st = seqStageOf(seqHit.item)
        const curSlot = unit.block ? `${blockCode(unit.block)}${unit.slot}.${unit.row}` : '—'
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
          {/* AUTO PLAN card first (top) — car detail card below it */}
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
                      {blockCode(proposal.block)}{proposal.slot}.{proposal.row}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>Block {blockCode(proposal.block)} · ช่อง {proposal.slot} · แถว {proposal.row}</div>
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
                  <Navigation size={20} /> เริ่มขับ → {blockCode(proposal.block)}{proposal.slot}.{proposal.row}
                </button>
                <button onClick={() => setAltIdx(i => (i + 1) % Math.max(1, cands.length))}
                  disabled={cands.length < 2}
                  className="w-full h-11 rounded-xl text-[13.5px] font-semibold btn">
                  <RefreshCw size={15} /> ขอตำแหน่งอื่น
                </button>
              </div>
            </div>
          )}

          <UnitCard unit={unit} accent="var(--st-yard)" />

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
              destLabel={`${blockCode(unit.block ?? '')}${unit.slot}.${unit.row}`}
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
              toLabel={`${blockCode(proposal.block)}${proposal.slot}.${proposal.row}`}
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

// compressToDataUrl / compressImage moved to lib/photo.ts (shared, no circular import)

type NgEntry = { item: string; pos: string; remark: string; photo?: string }

/** One measurement input (SOC / Mileage / Voltage). Defined at module scope —
 *  NOT inside FinalCheckPanel — so it doesn't remount and drop focus on every
 *  keystroke (that let you type only one digit at a time). */
function Meas({ label, value, onChange, unit: u, lastVal }: { label: string; value: string; onChange: (v: string) => void; unit?: string; lastVal: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>{label}</div>
      <div className="flex items-center gap-2">
        <input className="input flex-1 text-[13px]" inputMode="decimal" placeholder="กรอกค่า…" value={value} onChange={e => onChange(e.target.value)} />
        {u && <span className="text-[11px] shrink-0" style={{ color: 'var(--faint)' }}>{u}</span>}
        <span className="text-[11px] shrink-0 px-2 py-1 rounded-md" style={{ background: 'var(--chip)', color: 'var(--muted)', minWidth: 56, textAlign: 'center' }}>{lastVal}</span>
      </div>
    </div>
  )
}

function FinalCheckPanel({ unit, row, activeProc, canRecord, onSaved, stationTitle, accent }: {
  unit: Unit
  row: TrackRow | null
  activeProc: { queue: WorkQueue; item: QueueItem } | null
  canRecord: boolean
  onSaved: (label: string, result: 'OK' | 'NG') => void
  stationTitle: string   // the station menu this panel is on — PDI / PM / FINAL CHECK
  accent: string
}) {
  const { addDamage, updateRepairStatus, setInspected, currentUser, toast } = useYard()
  const { updateCell } = useTracking()
  const { recordCheck } = useOps()
  const [soc, setSoc] = useState('')
  const [mileage, setMileage] = useState('')
  const [voltage, setVoltage] = useState('')
  const [tire, setTire] = useState<Record<string, string>>({}) // per-wheel FL/FR/RL/RR
  const [showNgForm, setShowNgForm] = useState(false)

  const last = (k: string) => (row?.cells[k]?.trim() ? row.cells[k] : '—')
  // tag the defect with the actual queue when the car is in one, else the station menu
  const stationName = activeProc?.queue.name ?? stationTitle
  // NG found at THIS station — match the exact queue name OR any queue of this
  // station's type (NGs recorded while in queue "FINAL CHECK 2" must still show
  // after that queue completes and the car is re-scanned station-only)
  const matchStation = (st?: string) => !!st && (st === stationName || st.toUpperCase().includes(stationTitle.toUpperCase()))
  const stationDmgs = unit.damages.filter(d => d.source === 'pdi' && matchStation(d.station))
  // the OK/NG verdict counts only UNRESOLVED defects — a repaired NG must not
  // force this car to save NG forever
  const openDmgs = stationDmgs.filter(d => !d.statusRepair || d.statusRepair === 'Waiting Repair')

  const clearAll = () => { setSoc(''); setMileage(''); setVoltage(''); setTire({}); setShowNgForm(false) }

  const savedRef = useRef(false) // double-tap guard — a 2nd save burns another PM/RE-PDI date slot
  const save = () => {
    if (savedRef.current) return
    savedRef.current = true
    // measurements → tracking cells
    if (row) {
      if (soc.trim())     updateCell(row.vin, '% SOC', soc.trim())
      if (mileage.trim()) updateCell(row.vin, 'Mileage', mileage.trim())
      if (voltage.trim()) updateCell(row.vin, 'Voltage of 12V', voltage.trim())
      // per-wheel readings + the combined cell, same as the PDI / Final Check sheet
      const wheels = TIRE_WHEELS.filter(w => (tire[w.key] ?? '').trim())
      for (const w of wheels) updateCell(row.vin, w.key, tire[w.key].trim())
      if (wheels.length) updateCell(row.vin, 'Tire Pressure', joinTirePressure(tire))
    }
    const result: 'OK' | 'NG' = openDmgs.length > 0 ? 'NG' : 'OK'
    if (activeProc) {
      // record even when the item was already checked — a corrected re-save must
      // update the queue's result (recordCheck's `stamped` guard prevents a
      // second date stamp), else the queue said OK while the sheet said NG
      recordCheck(activeProc.queue.id, unit.vin, result, currentUser)
    } else {
      setInspected(unit.vin, result === 'OK')
      // no queue → still stamp the date ladder (PM → PM1/PM2…, FINAL → Final check date)
      stampStationDate(unit.vin, stationTitle === 'PM' ? 'PM' : stationTitle === 'FINAL CHECK' ? 'FINAL' : 'PDI')
    }
    // Car Status stays a lifecycle value — the inspection itself is recorded on
    // the Overview date ladder and in the queue. Only heal a row still carrying
    // a legacy station string ("PARKING PM · PM20", "PM · PM20 OK"), which no
    // in-yard count recognises.
    if (row && !CAR_STATUS_META[(row.cells['Car Status'] || '').trim()]) updateCell(row.vin, 'Car Status', YARD_STATUS)
    onSaved(stationResultLabel(stationName, result), result)
  }

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 border-b hairline flex items-center gap-2" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
        <ShieldCheck size={15} color="#fff" />
        <span className="font-bold text-[13.5px] text-white">{stationTitle}</span>
      </div>

      {/* measurements */}
      <div className="p-4 space-y-3 border-b hairline">
        <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>ค่าที่วัดได้ <span style={{ color: 'var(--faint)' }}>· ล่าสุดทางขวา</span></div>
        <Meas label="% SOC" value={soc} onChange={setSoc} unit="%" lastVal={last('% SOC')} />
        <Meas label="Mileage" value={mileage} onChange={setMileage} unit="กม." lastVal={last('Mileage')} />
        <Meas label="Voltage of 12V" value={voltage} onChange={setVoltage} unit="V" lastVal={last('Voltage of 12V')} />
        <TirePressureField label="Tire Pressure (310–340 Kpal)" row={row} values={tire}
          onChange={(k, v) => setTire(s => ({ ...s, [k]: v }))} />
      </div>

      {/* NG entry — same Defect form as Gate-in (bilingual dropdowns / photos / remark) */}
      <div className="p-4 space-y-2.5 border-b hairline" style={{ background: '#fbfaff' }}>
        <div className="flex items-center justify-between">
          <div className="badge text-[11px]" style={{ background: `${accent}1a`, color: accent }}>NG · เพิ่มรายการตรวจพบ{stationDmgs.length ? ` (${stationDmgs.length})` : ''}</div>
          <button onClick={() => setShowNgForm(v => !v)} className="btn btn-ghost text-[12px] py-1 px-2.5" style={{ color: '#dc2626' }}>
            <Plus size={13} /> เพิ่ม NG
          </button>
        </div>
        {showNgForm && (
          <DamageForm
            onSaveAll={dmgs => {
              dmgs.forEach(dg => addDamage(unit.vin, { ...dg, source: 'pdi', station: stationName }))
              setShowNgForm(false)
              toast('ok', dmgs.length > 1 ? `บันทึก Defect ${dmgs.length} รายการ` : 'บันทึก Defect แล้ว')
            }}
            onCancel={() => setShowNgForm(false)}
          />
        )}
        {stationDmgs.length === 0 && !showNgForm
          ? <div className="py-6 text-center text-[12.5px]" style={{ color: 'var(--faint)' }}>— ยังไม่มีรายการ NG —</div>
          : stationDmgs.map(d => (
              <DefectCard key={d.id} d={d}
                right={<DefectStatusSelect d={d} onChange={s => updateRepairStatus(unit.vin, d.id, s)} />} />
            ))}
      </div>

      {/* actions */}
      <div className="p-3 grid grid-cols-2 gap-2">
        <button onClick={clearAll} className="btn py-3 text-[13.5px]">Clear</button>
        <button onClick={save} className="btn py-3 text-[13.5px] font-bold" style={{ background: openDmgs.length ? '#dc2626' : 'var(--st-yard)', color: '#fff', border: 'none' }}>
          <CheckCircle2 size={16} /> Save {openDmgs.length ? `· NG (${openDmgs.length})` : '· OK'}
        </button>
      </div>
    </div>
  )
}

// ── pdi view ──────────────────────────────────────────────────────────────────
function PdiView({ types, accent, title }: { types: QueueType[]; accent: string; title: string }) {
  const units = useSiteUnits()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const allQueues = useSiteQueues()
  const sites = useYard(s => s.sites)
  const currentSite = useYard(s => s.currentSite)
  const { loadFromIdb } = useTracking()
  const { setInspected, removeDamage, updateRepairStatus, toast, loadFromSupabase } = useYard()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  // pull tracking rows (IDB) AND units (cloud) on entry so a scan right after
  // opening the station finds the car instead of racing the initial load.
  useEffect(() => { loadFromIdb(); loadFromSupabase() }, [loadFromIdb, loadFromSupabase])
  const [vin, setVin] = useState<string | null>(null)
  const [justOk, setJustOk] = useState(false)
  const [okLabel, setOkLabel] = useState('OK')
  const [okResult, setOkResult] = useState<'OK' | 'NG'>('OK')
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)

  // STRICTLY this station's own queues. Delivery-sequence (Grouping) runs and
  // every other work type belong to their own screens — a station must never
  // list another station's work.
  const typeKey = types.join(',')
  const queues = useMemo(
    () => allQueues.filter(q => !isSequenceQueue(q) && types.includes(queueTypeOf(q))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allQueues, typeKey],
  )
  // completed queues drop off the live list (they've filed under their day).
  // A just-created queue with no cars yet IS shown (it used to vanish, so an
  // operator who had just created it thought the queue never arrived).
  const procQueues = useMemo(() => queues.filter(q => !isPreGateInQueue(q.name) && !isQueueComplete(q)), [queues])
  const selectedQueue = selectedQueueId ? queues.find(q => q.id === selectedQueueId) ?? null : null
  const queueCars = useMemo(() => {
    if (!selectedQueue) return []
    return selectedQueue.items.filter(i => !i.done).map(i => {
      const u = units.find(x => x.vin === i.vin)
      const row = trackingRows.find(r => r.vin === i.vin)
      return {
        vin: i.vin,
        model: u?.modelName ?? row?.cells['Model name'] ?? row?.cells['Model'] ?? '—',
        color: row?.cells['Color'] ?? u?.color ?? '—',
        grouping: row?.cells['Grouping  Number'] || '—',
        location: yardLocCode(u) || '—',
        stage: stageOf(i),
        drivingBy: drivingNow(i),
      }
    }).sort((a, b) => byYardLocation(a.location, b.location))
  }, [selectedQueue, units, trackingRows])

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
    if (res.type === 'okPending') loadFromSupabase() // unit not synced yet — hurry the fetch
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
      {/* VIN input sits ABOVE the queues (same order as the Gate-in station) */}
      <VinInput onScan={onScan} accent={accent} />
      {gateModal}

      {/* ── process queues (PDI / FINAL PM / Wash …) — vertical stacked cards
             that expand into their car list, same shape as the Gate-out runs ── */}
      {procQueues.length > 0 && !unit && (
        <div className="space-y-2.5 fade-up">
          {procQueues.map(q => {
            // the station's own progress: counted at OK/NG, not at the driver's
            // return trip (which is a different person's job)
            const { done, total, remaining } = stationProgress(q)
            const isOpen = q.id === selectedQueueId
            return (
              <div key={q.id} className="panel overflow-hidden">
                <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setSelectedQueueId(isOpen ? null : q.id)}>
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--brand-soft,#eef4ff)', color: '#7c3aed' }}>
                    <ClipboardList size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-[12.5px] clip">{q.name}</div>
                    <div className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--muted)' }}>
                      <span className="badge text-[9.5px] font-bold" style={{ background: `${accent}1a`, color: accent }}>{queueTypeOf(q)}</span>
                      {total === 0
                        ? <span style={{ color: '#d97706' }}>ยังไม่มีรถในคิว</span>
                        : <span><b style={{ color: 'var(--text)' }}>{done}/{total}</b> คัน · เหลือ <b style={{ color: remaining > 0 ? '#d97706' : '#16a34a' }}>{remaining}</b></span>}
                    </div>
                  </div>
                  <ChevronLeft size={16} style={{ color: 'var(--muted)', transform: isOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
                </button>
                {isOpen && (queueCars.length > 0 ? (
                  <div className="border-t hairline max-h-[65vh] overflow-y-auto divide-y" style={{ borderColor: 'var(--line)' }}>
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
                          <StagePill stage={item.stage} drivingBy={item.drivingBy} atStation="พร้อมตรวจ" />
                        </div>
                      </button>
                    ))}
                  </div>
                ) : total === 0 ? (
                  <div className="px-4 py-3 border-t hairline text-[12px] font-semibold" style={{ color: '#d97706' }}>
                    ยังไม่มีรถในคิวนี้ — เพิ่มรถได้ที่หน้า Operation (คิวงาน)
                  </div>
                ) : (
                  <div className="px-4 py-3 border-t hairline text-[12px] font-semibold" style={{ color: '#16a34a' }}>✓ เสร็จครบแล้ว!</div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* VIN chosen but the unit row is still syncing from the cloud (fresh app
          load) — show a loader instead of a blank screen; it fills in on arrival. */}
      {vin && !unit && !justOk && (
        <div className="panel p-5 fade-up text-center" style={{ color: 'var(--muted)' }}>
          <div className="flex items-center justify-center gap-2.5">
            <RefreshCw size={16} className="animate-spin" />
            <span className="text-[13px] font-semibold">กำลังโหลดข้อมูลรถ {vin.slice(-6)}…</span>
          </div>
          <button onClick={() => loadFromSupabase()} className="btn btn-ghost mt-3 text-[12px] py-1.5 px-3">
            โหลดช้า? กดลองใหม่
          </button>
        </div>
      )}

      {unit && (
        <div className="space-y-3 fade-up">
          <UnitCard unit={unit} accent={accent} />

          {/* station context — which queue this scan records into (one compact card:
              label · queue name that wraps normally · status pill on the right) */}
          {activeProc && (
            <div className="panel p-3" style={{ borderLeft: '4px solid #7c3aed' }}>
              <div className="flex items-start gap-2.5">
                <ClipboardList size={16} className="shrink-0" style={{ color: '#7c3aed', marginTop: 2 }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: '#7c3aed' }}>สถานี</div>
                  <div className="font-bold text-[13px] leading-snug break-words mt-0.5">{activeProc.queue.name}</div>
                </div>
                {procStage === 'checked' ? (
                  <span className="badge shrink-0 font-bold text-[11px] flex items-center gap-1"
                    style={{ background: activeProc.item.result === 'NG' ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.12)', color: activeProc.item.result === 'NG' ? 'var(--st-damage)' : 'var(--st-yard)' }}>
                    {activeProc.item.result === 'NG' ? <XCircle size={13} /> : <ShieldCheck size={13} />}{activeProc.item.result}
                  </span>
                ) : drivingNow(activeProc.item) ? (
                  <span className="badge shrink-0 font-bold text-[11px] flex items-center gap-1"
                    style={{ background: 'rgba(37,99,235,0.12)', color: '#2563eb' }}>
                    <Navigation size={12} />Driving
                  </span>
                ) : (
                  <span className="badge shrink-0 font-bold text-[11px] flex items-center gap-1"
                    style={{ background: 'rgba(217,119,6,0.12)', color: '#d97706' }}>
                    <Clock size={12} />Waiting
                  </span>
                )}
              </div>
              <div className="text-[11.5px] mt-2 pl-[26px]" style={{ color: 'var(--muted)' }}>
                {procStage === 'checked'
                  ? <>บันทึกแล้ว · ผล <b style={{ color: activeProc.item.result === 'NG' ? '#dc2626' : 'var(--st-yard)' }}>{activeProc.item.result}</b></>
                  : drivingNow(activeProc.item)
                    ? <>กำลังขับโดย <b style={{ color: '#2563eb' }}>{drivingNow(activeProc.item)}</b></>
                    : procStage === 'at-station' ? 'รถถึงสถานีแล้ว · พร้อมบันทึก OK / NG' : 'ยังไม่ได้นำรถเข้าสถานี (บันทึกได้)'}
              </div>
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
              <div className="p-3 space-y-2">
                {walkDmgs.map(d => (
                  <DefectCard key={d.id} d={d}
                    right={<DefectStatusSelect d={d} onChange={s => updateRepairStatus(unit.vin, d.id, s)} />} />
                ))}
              </div>
            </div>
          )}

          {/* Inspection form — PDI and FINAL CHECK share the full station sheet
              AND the same checklist tabs (Overall inspection · Control Stock
              Sheet · Additional Accessories · NG); PM keeps the lighter panel. */}
          {/* key={vin} — the panels hold local form state (checklist ticks,
              measurements); without a key, scanning the next car keeps the
              previous car's entries and saves them onto the wrong VIN. */}
          {types.includes('PDI') || types.includes('FINAL') ? (
            <StationSheet
              key={unit.vin}
              unit={unit}
              row={trackingRows.find(r => r.vin === unit.vin) ?? null}
              activeProc={activeProc}
              onSaved={onSaved}
              stationTitle={title}
              accent={accent}
              tabs={FINAL_CHECK_TABS}
              stationType={types.includes('PDI') ? 'PDI' : 'FINAL'}
            />
          ) : (
            <FinalCheckPanel
              key={unit.vin}
              unit={unit}
              row={trackingRows.find(r => r.vin === unit.vin) ?? null}
              activeProc={activeProc}
              canRecord={canRecord}
              onSaved={onSaved}
              stationTitle={title}
              accent={accent}
            />
          )}

          {/* NG added later at PDI / by mechanic (walk-around NG is shown above) */}
          {otherDmgs.length > 0 && (
            <div className="panel overflow-hidden">
              <div className="px-4 py-2.5 border-b hairline text-[12px] font-semibold flex items-center gap-2"
                style={{ background: '#fff8f8', color: 'var(--st-damage)' }}>
                <AlertTriangle size={13} /> NG เพิ่มเติม · PDI / ช่าง ({otherDmgs.length})
              </div>
              <div className="p-3 space-y-2">
                {otherDmgs.map(d => (
                  <DefectCard key={d.id} d={d}
                    right={<DefectStatusSelect d={d} onChange={s => updateRepairStatus(unit.vin, d.id, s)} />} />
                ))}
              </div>
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
  const allQueues = useSiteQueues()
  const { loadFromIdb } = useTracking()
  const { addDamage, removeDamage, updateRepairStatus, setInspected, toast, loadFromSupabase } = useYard()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  const sites = useYard(s => s.sites)
  const currentSite = useYard(s => s.currentSite)
  useEffect(() => { loadFromIdb() }, [loadFromIdb])
  const [vin, setVin] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [listOpen, setListOpen] = useState(true)

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null

  // repair queue — cars still IN YARD with at least one defect that is actually
  // waiting for repair. Two things used to inflate this list far past the
  // Dashboard's "Damage" figure: it keyed off `!repairDate`, which counts an
  // Accept / Acc byd / OK Accept defect (resolved, but nothing was repaired, so
  // it has no repair date) as outstanding; and it never excluded cars that have
  // already left the yard.
  const ngCars = useMemo(() => {
    const inYard = new Set<string>()
    for (const r of trackingRows) if (IN_YARD_STATUSES.has(deriveCarStatus(r.cells))) inYard.add(r.vin)
    const isOpen = (d: Damage) => !d.statusRepair || d.statusRepair === 'Waiting Repair'
    return units
      .filter(u => inYard.has(u.vin))
      .map(u => ({ u, open: u.damages.filter(isOpen).length }))
      .filter(x => x.open > 0)
      .map(({ u, open }) => ({
        vin: u.vin,
        model: u.modelName || '—',
        color: u.color || '—',
        grouping: trackingRows.find(r => r.vin === u.vin)?.cells['Grouping  Number'] || '—',
        location: yardLocCode(u) || '—',
        open,
      }))
      .sort((a, b) => byYardLocation(a.location, b.location))
  }, [units, trackingRows])

  // assigned repair queues created on the Operation page (type "ช่าง (ซ่อม)") —
  // same behaviour as the PDI / PM / FINAL CHECK stations
  const repairQueues = useMemo(
    () => allQueues.filter(q =>
      !isSequenceQueue(q) && !isPreGateInQueue(q.name) &&
      queueTypeOf(q) === 'REPAIR' && !isQueueComplete(q)),
    [allQueues],
  )

  const onScan = (v: string) => {
    const res = resolveForUnit(v, units, trackingRows)
    if (res.type === 'ambiguous') { toast('err', `พบ ${res.count} คัน — พิมพ์ให้ยาวขึ้น`); return }
    if (res.type === 'none') { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (res.type === 'notGated') { blockGate(res.vin, res.model); return }
    if (res.type === 'okPending') { toast('ok', 'กำลังโหลดข้อมูลรถ…'); loadFromSupabase() } // unit not synced yet
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

      {/* assigned repair queues from the Operation page — listed first, above the
          auto-generated "every car with an open NG" list */}
      {!unit && repairQueues.length > 0 && (
        <AllQueuesBrowser queues={repairQueues} units={units} trackingRows={trackingRows}
          onPick={v => { setVin(v); setShowForm(false) }} />
      )}

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
                รอซ่อม <b style={{ color: '#c2680b' }}>{ngCars.length}</b> คัน · Defect รอซ่อม <b style={{ color: 'var(--st-damage)' }}>{ngCars.reduce((n, c) => n + c.open, 0)}</b> รายการ
              </div>
            </div>
            <ChevronLeft size={16} style={{ color: 'var(--muted)', transform: listOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
          </button>
          {listOpen && (
            <div className="border-t hairline max-h-[65vh] overflow-y-auto divide-y" style={{ borderColor: 'var(--line)' }}>
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
              <div className="p-3 space-y-2">
                {unit.damages.map(d => (
                  <DefectCard key={d.id} d={d}
                    right={<DefectStatusSelect d={d} onChange={s => updateRepairStatus(unit.vin, d.id, s)} />} />
                ))}
              </div>
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
              key={unit.vin}
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

/** Tick box for the DN car list — drawn, not a native <input>, so it matches
 *  the app's touch targets and never inherits the browser's blue. */
function CheckBox({ on }: { on: boolean }) {
  return (
    <span className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center shrink-0 transition-all"
      style={on
        ? { background: '#f59e0b', border: '2px solid #f59e0b' }
        : { background: '#fff', border: '2px solid var(--line)' }}>
      {on && <Check size={12} color="#fff" strokeWidth={3.5} />}
    </span>
  )
}

// ── Gate-out view ────────────────────────────────────────────────────────────
function GateOutView() {
  const trackingRows = useSiteRows()
  const units = useSiteUnits()
  const wrongSite = useWrongSiteHint()
  const queues = useSiteQueues()
  const { loadFromIdb, updateCell, bulkUpdate } = useTracking()
  const { toast, currentUser, sites, currentSite, markDeparted, markDepartedMany } = useYard()
  const { confirmSeqGateOut, confirmSeqGateOutMany } = useOps()
  const { block: blockGate, blockWith, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [dn, setDn] = useState<string | null>(null)      // scanned DN / grouping number
  const [picked, setPicked] = useState<string[]>([])     // VINs ticked inside that DN
  const [askBulk, setAskBulk] = useState(false)
  const [done, setDone] = useState<{ vin: string; label: string } | null>(null)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const seqQueues = useMemo(() => queues.filter(q => isSequenceQueue(q) && !isQueueComplete(q)), [queues])
  const row = vin ? (trackingRows.find(r => r.vin === vin) ?? null) : null
  const seqHit = useMemo(() => findSeqItem(vin, queues), [vin, queues])
  // where the car actually stands, so the gate can go fetch it — the yard name
  // alone ("NYB2 Phase 2") never told anyone which lane to walk to
  const parked = vin ? units.find(u => u.vin === vin) : undefined
  const parkedAt = parked?.block && parked.row && parked.slot
    ? `${blockCode(parked.block)}${String(parked.slot).padStart(2, '0')}.${parked.row}`
    : ''

  // ── DN (grouping) scan → every car on that Delivery Note ──────────────────
  // The DN's Trip No barcode carries the grouping number, so one scan of the
  // printed sheet lists the whole run and the gate ticks off what actually left.
  const dnCars = useMemo(() => {
    if (!dn) return []
    return trackingRows
      .filter(r => normGroup(r.cells[GROUP_KEY]) === dn)
      .map(r => {
        const u = units.find(x => x.vin === r.vin)
        const status = (r.cells['Car Status'] ?? '').trim()
        const gone = status === 'Gate-out' || status === 'Pre Gate-out'
        const inSeq = !!findSeqItem(r.vin, queues)
        // same rule as the single-VIN scan: only a car planned in an open
        // Grouping-to-Dealer queue, and actually gated in, may leave
        const reason = gone ? '' : !inSeq ? 'ไม่มีคิวงาน' : !isGatedInStatus(status) ? 'ยังไม่ Gate-in' : ''
        return {
          vin: r.vin,
          model: r.cells['Model name'] || r.cells['Model'] || u?.modelName || '—',
          color: r.cells['Color'] || u?.color || '—',
          location: yardLocFull(u) || r.cells['Location yard'] || '—',
          status: status || '—',
          gone,
          ready: !gone && !reason,
          reason,
        }
      })
      .sort((a, b) => byYardLocation(a.location, b.location))
  }, [dn, trackingRows, units, queues])

  const dnReady = dnCars.filter(c => c.ready)
  const dnPicked = picked.filter(v => dnReady.some(c => c.vin === v))
  const allPicked = dnReady.length > 0 && dnPicked.length === dnReady.length

  // a fresh DN starts with every eligible car ticked — the normal case is that
  // the whole Note leaves together; untick the ones that stayed behind
  useEffect(() => { setPicked(dnCars.filter(c => c.ready).map(c => c.vin)) }, [dn]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScanDn = (raw: string) => {
    const g = normGroup(raw)
    if (!g) return
    const n = trackingRows.filter(r => normGroup(r.cells[GROUP_KEY]) === g).length
    if (!n) { toast('err', `ไม่พบ DN / เลข Grouping: ${raw}`); return }
    setVin(null); setDn(g)
  }

  const onScan = (v: string) => {
    // the DN barcode may be shot into the VIN field too — a grouping number is
    // never a VIN, so an exact grouping hit routes straight to the DN list
    if (trackingRows.some(r => normGroup(r.cells[GROUP_KEY]) === normGroup(v))) { onScanDn(v); return }
    let r = trackingRows.find(x => x.vin === v)
    if (!r && v.length <= 8) {
      const hits = trackingRows.filter(x => x.vin.endsWith(v))
      if (hits.length === 1) r = hits[0]
      else if (hits.length > 1) { toast('err', `พบ ${hits.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
    }
    if (!r) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    // Gate-out follows the delivery run: only a car listed in an open
    // Grouping-to-Dealer queue may leave, so nothing walks out of the yard
    // without being planned. (A car already Pre Gate-out stays scannable — its
    // Preload still has to be confirmable before the 09:30 flush.)
    const model = r.cells['Model name'] ?? r.cells['Model'] ?? ''
    const status = (r.cells['Car Status'] ?? '').trim()
    const inSeq = !!findSeqItem(r.vin, queues)
    // a car that already left keeps its scan, so the panel can say so plainly
    const alreadyOut = status === 'Pre Gate-out' || status === 'Gate-out'
    if (!inSeq && !alreadyOut) {
      blockWith(r.vin, model, 'ไม่มีคิวงาน Gate-out',
        <>รถคันนี้ไม่อยู่ในคิวงานส่งมอบ (<b style={{ color: 'var(--brand)' }}>Grouping to Dealer</b>)<br />
          ต้องเพิ่มรถเข้าคิวงานที่หน้า Operation ก่อน จึงจะ Gate-out ได้</>)
      return
    }
    // cars in a delivery sequence may sit at Wash/lane statuses that aren't in
    // the generic "gated-in" set — those are fine; a car that never gated in is not
    if (!isGatedInStatus(status) && !alreadyOut) { blockGate(r.vin, model); return }
    setDn(null); setVin(r.vin)
  }

  // Ops-scan gate-out → "Pre Gate-out": the car is staged in preload, NOT gone
  // yet. deriveCarStatus finalises it to a real Gate-out at the next 09:30 flush
  // (see pastGateOutFlush) unless it is confirmed Preload first.
  const stamp = (now: Date) =>
    `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

  const doGateOut = () => {
    if (!row) return
    const now = new Date()
    const ts = stamp(now)
    updateCell(row.vin, 'Car Status', 'Pre Gate-out')
    updateCell(row.vin, 'Gate Out time stamp', ts)
    updateCell(row.vin, 'Gate Out Time', String(now.getTime())) // epoch → 09:30 flush calc
    markDeparted(row.vin) // release the parking slot — the car left it for the preload lane
    // close the delivery-sequence item too, if this car belongs to one
    if (seqHit) confirmSeqGateOut(seqHit.queue.id, row.vin, currentUser)
    setDone({ vin: row.vin, label: 'Pre Gate-out' }); setVin(null)
  }

  // Gate-out every ticked car of the scanned DN in one action. Identical writes
  // to the single-car path, but batched: one tracking write per column, one
  // queue push per sequence, one unit update for the whole run.
  const doBulkGateOut = () => {
    const vins = dnPicked
    if (!vins.length) return
    const now = new Date()
    bulkUpdate(vins, 'Car Status', 'Pre Gate-out')
    bulkUpdate(vins, 'Gate Out time stamp', stamp(now))
    bulkUpdate(vins, 'Gate Out Time', String(now.getTime())) // epoch → 09:30 flush calc
    markDepartedMany(vins) // release the parking slots
    // close the delivery-sequence items, grouped by the queue they belong to
    const byQueue = new Map<string, string[]>()
    for (const v of vins) {
      const hit = findSeqItem(v, queues)
      if (!hit) continue
      const list = byQueue.get(hit.queue.id)
      if (list) list.push(v); else byQueue.set(hit.queue.id, [v])
    }
    for (const [qid, list] of byQueue) confirmSeqGateOutMany(qid, list, currentUser)
    setAskBulk(false)
    setDone({ vin: `DN ${dn} · ${vins.length} คัน`, label: 'Gate-out' })
    setDn(null); setPicked([])
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

      {/* DN scan — one grouping number brings up the whole Delivery Note */}
      {!row && (
        <div className="panel p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <ClipboardList size={15} style={{ color: '#f59e0b' }} />
            <span className="text-[12.5px] font-bold">สแกน DN · เลข Grouping</span>
            <span className="text-[11px] ml-auto" style={{ color: 'var(--muted)' }}>เช่น ATL260804-12</span>
          </div>
          <VinInput
            onScan={onScanDn}
            accent="#f59e0b"
            autoFocus={false}
            placeholder="เลข Grouping / DN…"
            action="เรียกรถทั้ง DN"
            camTitle="สแกน Barcode DN"
            camHint="จ่อกล้องไปที่ barcode Trip No บนใบ DN"
          />
        </div>
      )}

      {/* the scanned DN: every car on it, tick one by one or all at once */}
      {!row && dn && (
        <div className="panel overflow-hidden fade-up">
          <div className="px-4 py-3 flex items-center gap-3" style={{ background: 'rgba(245,158,11,0.10)' }}>
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>DN · Grouping</div>
              <div className="vin text-[14px] font-extrabold clip" style={{ color: '#b45309' }}>{dn}</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                ทั้งหมด <b style={{ color: 'var(--text)' }}>{dnCars.length}</b> คัน
                {' · '}พร้อม Gate-out <b style={{ color: '#d97706' }}>{dnReady.length}</b>
                {dnCars.some(c => c.gone) && <> · ออกแล้ว <b>{dnCars.filter(c => c.gone).length}</b></>}
              </div>
            </div>
            <button onClick={() => { setDn(null); setPicked([]) }}
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{ background: 'rgba(0,0,0,0.06)', color: 'var(--muted)' }}>
              <X size={16} />
            </button>
          </div>

          {dnReady.length > 0 && (
            <button onClick={() => setPicked(allPicked ? [] : dnReady.map(c => c.vin))}
              className="w-full px-4 py-2.5 flex items-center gap-2.5 border-t hairline text-left"
              style={{ borderColor: 'var(--line)' }}>
              <CheckBox on={allPicked} />
              <span className="text-[12.5px] font-bold">{allPicked ? 'ล้างการเลือกทั้งหมด' : 'เลือกทั้งหมด'}</span>
              <span className="text-[11.5px] ml-auto tabular font-bold" style={{ color: '#d97706' }}>
                เลือก {dnPicked.length}/{dnReady.length}
              </span>
            </button>
          )}

          <div className="border-t hairline divide-y" style={{ borderColor: 'var(--line)' }}>
            {dnCars.map(c => {
              const on = picked.includes(c.vin)
              return (
                <button key={c.vin} disabled={!c.ready}
                  onClick={() => setPicked(p => p.includes(c.vin) ? p.filter(x => x !== c.vin) : [...p, c.vin])}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-left"
                  style={c.ready ? undefined : { opacity: 0.55 }}>
                  {c.ready ? <CheckBox on={on} /> : <span className="w-[18px] shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="vin text-[12.5px] font-bold clip">{c.vin}</div>
                    <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2" style={{ color: 'var(--muted)' }}>
                      <span>{c.model}</span><span>· {c.color}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="tabular text-[12px] font-bold">{c.location}</div>
                    <span className="badge mt-0.5 inline-block" style={c.gone
                      ? { background: 'rgba(100,116,139,0.16)', color: '#64748b', fontSize: 10 }
                      : c.reason
                        ? { background: '#fee2e2', color: '#b91c1c', fontSize: 10 }
                        : { background: 'rgba(245,158,11,0.15)', color: '#b45309', fontSize: 10 }}>
                      {c.gone ? c.status : c.reason || 'พร้อม'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="p-3 border-t hairline" style={{ borderColor: 'var(--line)' }}>
            <button onClick={() => setAskBulk(true)} disabled={!dnPicked.length}
              className="w-full py-3 rounded-2xl text-[15px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
              style={{ background: dnPicked.length ? '#f59e0b' : '#cbd5e1' }}>
              <LogOut size={18} /> ยืนยัน Gate-out {dnPicked.length ? `(${dnPicked.length} คัน)` : ''}
            </button>
            <div className="text-[10.5px] text-center leading-snug mt-2" style={{ color: 'var(--muted)' }}>
              เลือกได้ทีละคันหรือทั้งหมด · รถจะออกจริงตอน 09:30
            </div>
          </div>
        </div>
      )}

      {/* bulk gate-out is many cars at once — confirm before writing */}
      {askBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}
          onClick={() => setAskBulk(false)}>
          <div className="panel p-6 w-full max-w-xs text-center fade-up" onClick={e => e.stopPropagation()}>
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
              style={{ background: 'rgba(245,158,11,0.15)' }}>
              <LogOut size={28} style={{ color: '#f59e0b' }} />
            </div>
            <div className="text-[17px] font-extrabold mb-1">Gate-out {dnPicked.length} คัน?</div>
            <div className="text-[12.5px] mb-5" style={{ color: 'var(--muted)' }}>DN {dn}</div>
            <button onClick={doBulkGateOut}
              className="w-full py-3 rounded-2xl text-[15px] font-bold text-white active:scale-95 transition-all"
              style={{ background: '#f59e0b' }}>ยืนยัน Gate-out</button>
            <button onClick={() => setAskBulk(false)}
              className="w-full py-2.5 mt-2 rounded-2xl text-[14px] font-bold active:scale-95 transition-all"
              style={{ background: 'rgba(0,0,0,0.05)', color: 'var(--muted)' }}>ยกเลิก</button>
          </div>
        </div>
      )}

      {/* delivery-sequence runs — see remaining cars to gate-out (before scanning) */}
      {!row && !dn && (
        <SeqQueuePicker queues={seqQueues} units={units} trackingRows={trackingRows} />
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
              ['Location', parkedAt || row.cells['Location yard'] || row.cells['storage Yard'] || '—'],
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
  const siteUnits = useSiteUnits()
  const blocks = useBlocks()
  const wrongSite = useWrongSiteHint()
  const { loadFromIdb, appendHistory } = useTracking()
  const { toast, sites, currentSite, currentUser, updateLocations } = useYard()
  const { block: blockGate, blockWith: blockGate2, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [fLoc, setFLoc] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const siteName = sites.find(s => s.id === currentSite)?.name ?? ''
  const row = vin ? (trackingRows.find(r => r.vin === vin) ?? null) : null
  const unit = vin ? siteUnits.find(u => u.vin === vin) : undefined
  // the yard the car is in (a site name — "NYB2 Phase 2") vs. where it stands
  // inside that yard (block + slot + row). The card used to show only the first.
  const curYard = row ? (row.cells['Location yard'] || row.cells['storage Yard'] || siteName || '—') : ''
  const placed = !!(unit?.block && unit.row && unit.slot)

  // every relocation this car has been through — updateCell logs who/when/where
  // under the Location column, so the station sees the same trail the admin does
  const moves = useMemo(() =>
    [...(row?.history ?? [])].filter(e => e.field === 'Location' || e.field === LOCATION_KEY).reverse(),
  [row])

  // one field, written the way the upload file writes a lane: "R14" (block +
  // column). The token resolves to the block it NAMES — name-first, so an
  // internal id can never hijack another block's letter.
  const parsed = parseLane(fLoc.trim())
  const blk = useMemo(
    () => (parsed ? resolveBlockByName(parsed.block, blocks) : null),
    [parsed?.block, blocks], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // the canonical tag stamped on the car — the block's name, one letter
  const blockId = parsed ? (blk ? blockTag(blk) : blockKeyOfTag(parsed.block)) : ''

  // the digits after the block letter are the COLUMN — the numbers across the
  // top of the plan, 1…cols. Depth down the column is assigned automatically.
  const slotNo = parsed?.row ?? 0
  const slotOk = slotNo >= 1 && (!blk || slotNo <= blk.cols)

  /** Which space down that column: the first free one, exactly how the Update
   *  Location import stacks cars into a lane. */
  const nextRow = useMemo(() => {
    if (!blockId || !slotOk) return null
    const depth = blk?.rows ?? 8
    const taken = new Set(
      siteUnits
        .filter(u => u.vin !== vin && u.block && u.slot === slotNo && blockKeyOfTag(u.block) === blockId)
        .map(u => u.row),
    )
    for (let r = 1; r <= depth; r++) if (!taken.has(r)) return r
    return null // column full
  }, [blockId, slotNo, slotOk, blk, siteUnits, vin])

  const laneFull = !!blockId && slotOk && nextRow === null
  // a block this plan does not draw has no grid to land in, so refuse it rather
  // than park the car somewhere that only exists in the typo
  const blockOk = !!blockId && (blocks.length === 0 || !!blk)
  const canSave = !!row && blockOk && slotOk && nextRow !== null && !saved

  const onScan = (v: string) => {
    setSaved(false); setFLoc('')
    let r = trackingRows.find(x => x.vin === v)
    if (!r && v.length <= 8) {
      const hits = trackingRows.filter(x => x.vin.endsWith(v))
      if (hits.length === 1) r = hits[0]
      else if (hits.length > 1) { toast('err', `พบ ${hits.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
    }
    if (!r) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    // "has left" is tested BEFORE "never arrived": a row whose Car Status cell is
    // blank but whose Gate-Out stamp is set is a departed car, and the
    // not-gated-in popup would name the wrong reason
    if (hasGoneOut(r.cells)) {
      blockGate2(r.vin, r.cells['Model name'] ?? r.cells['Model'] ?? '', 'รถออกจากลานแล้ว',
        <>รถคันนี้ <b style={{ color: '#dc2626' }}>Gate-out</b> ไปแล้ว จึงไม่มีตำแหน่งในลานให้ย้าย<br />
          หากรถกลับเข้าลาน ต้องทำ <b>Gate-in</b> ใหม่ก่อน</>)
      return
    }
    if (!isGatedInStatus(r.cells['Car Status'])) { blockGate(r.vin, r.cells['Model name'] ?? r.cells['Model'] ?? ''); return }
    setVin(r.vin)
    recordRecent('reloc:search', r.vin)
  }

  /** "T1201" — block name + column + which car down it, the yard's own form. */
  const codeOf = (b: string, col: number, depth: number) =>
    `${blockCode(b)}${String(col).padStart(2, '0')}${String(depth).padStart(2, '0')}`

  const doSave = () => {
    if (!canSave || !row || nextRow === null) return
    // move the CAR, not the "Location yard" cell — that cell names the yard and
    // is what scopes a row to its site, so a slot code written into it used to
    // drop the car out of its own yard
    updateLocations([{
      vin: row.vin, block: blockId, row: nextRow, slot: slotNo,
      modelName: row.cells['Model name'] || row.cells['Model'] || undefined,
      color: row.cells['Color'] || undefined,
    }])
    // log the move under the Location column: from → to, who, when — the same
    // trail this screen and the admin's Event tab show
    appendHistory(row.vin, {
      at: Date.now(), by: currentUser, field: 'Location',
      from: placed ? yardLocFull(unit) : '',
      to: codeOf(blockId, slotNo, nextRow),
    })
    recordRecent('reloc:save', row.vin, `ย้ายไป ${codeOf(blockId, slotNo, nextRow)}`)
    setSaved(true)
    toast('ok', `ย้ายไป ${codeOf(blockId, slotNo, nextRow)} · ${row.vin.slice(-6)}`)
    setTimeout(() => { setVin(null); setSaved(false) }, 1600)
  }

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent="#0ea5e9" />
      {gateModal}
      {!row && <RecentPanel station="reloc" accent="#0ea5e9" onPick={onScan} />}
      {row && (
        <div className="panel p-4 space-y-4 fade-up">
          <div className="flex items-center gap-2">
            <span className="vin text-[13.5px] font-bold">{row.vin}</span>
            <span className="ml-auto text-[12px]" style={{ color: 'var(--muted)' }}>{row.cells['Model name'] ?? ''}</span>
          </div>

          <div className="rounded-2xl p-3.5" style={{ background: 'var(--chip)' }}>
            <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>ตำแหน่งปัจจุบัน</div>
            {placed ? (
              <>
                <div className="font-bold text-[20px] leading-tight tabular">{yardLocFull(unit)}</div>
                <div className="text-[11.5px] mt-0.5 font-semibold" style={{ color: 'var(--muted)' }}>
                  Block {blockCode(unit!.block ?? '')} · ช่อง {unit!.slot} · คันที่ {unit!.row} ในช่อง
                </div>
              </>
            ) : (
              <div className="font-bold text-[15px]" style={{ color: 'var(--faint)' }}>ยังไม่ระบุตำแหน่งในลาน</div>
            )}
            <div className="text-[11.5px] mt-1.5 flex items-center gap-1" style={{ color: 'var(--muted)' }}>
              <MapPin size={11} /> {curYard}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--muted)' }}>ตำแหน่งใหม่</div>
            {/* one field, written the way the upload file writes a lane: "R14" */}
            <input
              className="input w-full font-bold text-center text-[17px] uppercase tabular"
              placeholder="R14" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              value={fLoc}
              onChange={e => setFLoc(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && doSave()}
            />
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--faint)' }}>
              Block + เลขช่อง เช่น R14 · รถจะต่อท้ายคันที่มีอยู่ในช่องนั้นอัตโนมัติ
            </div>

            {/* say exactly where it will land — the order down the column is
                assigned for them, R1401 → R1402 → R1403 … */}
            {canSave && (
              <div className="mt-2.5 text-[12px] font-semibold flex items-center gap-1.5" style={{ color: '#0284c7' }}>
                <ArrowRight size={13} /> {codeOf(blockId, slotNo, nextRow!)}
                <span style={{ color: 'var(--muted)', fontWeight: 500 }}>· คันที่ {nextRow} ในช่อง {slotNo}</span>
              </div>
            )}
            {laneFull && (
              <div className="mt-2.5 text-[12px] font-semibold flex items-center gap-1.5" style={{ color: '#dc2626' }}>
                <AlertTriangle size={13} /> Block {blockId} ช่อง {slotNo} เต็มแล้ว ({blk?.rows ?? 8} คัน)
              </div>
            )}
            {!!parsed && blockOk && !slotOk && (
              <div className="mt-2.5 text-[12px] font-semibold flex items-center gap-1.5" style={{ color: '#dc2626' }}>
                <AlertTriangle size={13} /> {blk ? `Block ${blockTag(blk)} มีช่อง 1–${blk.cols}` : 'เลขช่องไม่ถูกต้อง'}
              </div>
            )}
            {/* a block the plan has no grid for → the car would sit off-plan */}
            {!!parsed && !blk && blocks.length > 0 && (
              <div className="mt-2.5 text-[12px] font-semibold flex items-center gap-1.5" style={{ color: '#dc2626' }}>
                <AlertTriangle size={13} /> ไม่มี Block {parsed.block} ในผังลานนี้
              </div>
            )}
            {!!fLoc.trim() && !parsed && (
              <div className="mt-2.5 text-[12px] font-semibold flex items-center gap-1.5" style={{ color: '#dc2626' }}>
                <AlertTriangle size={13} /> รูปแบบไม่ถูกต้อง — พิมพ์ Block ตามด้วยเลขช่อง เช่น R14
              </div>
            )}
          </div>

          <button
            onClick={doSave}
            disabled={!canSave}
            className="w-full py-3 rounded-2xl text-[15px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-40"
            style={{ background: saved ? '#16a34a' : '#0ea5e9' }}>
            {saved ? <><CheckCircle2 size={18} /> บันทึกแล้ว!</> : <><MapPin size={18} /> บันทึกตำแหน่งใหม่</>}
          </button>

          {/* every move this car has made: where, by whom, when */}
          {moves.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
                <Clock size={11} /> ประวัติการย้าย ({moves.length})
              </div>
              <div className="space-y-1.5">
                {moves.map((m, i) => {
                  const d = new Date(m.at)
                  const p2 = (n: number) => String(n).padStart(2, '0')
                  return (
                    <div key={i} className="rounded-xl px-3 py-2 text-[12px] flex items-center gap-2"
                      style={{ background: 'var(--chip)' }}>
                      <span className="tabular font-semibold" style={{ color: 'var(--muted)' }}>{m.from || '—'}</span>
                      <ArrowRight size={11} className="shrink-0" style={{ color: 'var(--faint)' }} />
                      <span className="tabular font-bold">{m.to}</span>
                      <span className="ml-auto text-right text-[11px] leading-tight shrink-0" style={{ color: 'var(--muted)' }}>
                        {m.by}<br />{p2(d.getDate())}/{p2(d.getMonth() + 1)}/{d.getFullYear()} {p2(d.getHours())}:{p2(d.getMinutes())}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Check view ────────────────────────────────────────────────────────────────
// ── Update Damage ─────────────────────────────────────────────────────────────
function UpdateDamageView() {
  const units = useSiteUnits()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const { loadFromIdb } = useTracking()
  const { addDamage, removeDamage, updateRepairStatus, toast, loadFromSupabase } = useYard()
  const me = useMe()
  const isAdmin = me?.role === 'admin'
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const SEV_COLOR = { minor: '#2563eb', major: '#dc2626' }

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
    recordRecent('damage:search', found)
  }

  const fmt = (ts: number) => {
    const d = new Date(ts)
    return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
  }

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent="#dc2626" />
      {gateModal}
      {!vin && <RecentPanel station="damage" accent="#dc2626" onPick={onScan} />}

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
            <div className="p-3 space-y-2">
              {damages.map(d => (
                <DefectCard key={d.id} d={d} right={
                  <div className="flex items-center gap-1.5">
                    <DefectStatusSelect d={d} onChange={s => updateRepairStatus(vin, d.id, s)} />
                    {isAdmin ? (
                      <button onClick={() => { if (confirm('ลบรายการนี้?')) removeDamage(vin, d.id) }}
                        className="btn p-1" style={{ color: '#dc2626' }}>
                        <Trash2 size={13} />
                      </button>
                    ) : (
                      <button onClick={() => toast('err', 'ต้องเป็นแอดมินเท่านั้นถึงจะลบได้')}
                        title="ต้องเป็นแอดมินเท่านั้นถึงจะลบได้"
                        className="btn p-1" style={{ color: 'var(--faint)', cursor: 'not-allowed' }}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                } />
              ))}
            </div>
          )}

          {/* add new damage form — same dropdowns / photos / remark as Gate-in */}
          {showAdd ? (
            <div className="border-t hairline p-3" style={{ background: 'rgba(220,38,38,0.03)' }}>
              <DamageForm
                key={vin ?? 'none'}
                onSaveAll={dmgs => {
                  if (!unit) {
                    // the car exists only as a tracking row (unit not synced yet) —
                    // keep the filled form open, tell the operator, and hurry the fetch
                    // instead of silently discarding their photos and entries.
                    toast('err', 'ข้อมูลรถยังโหลดไม่เสร็จ — รอสักครู่แล้วกดบันทึกอีกครั้ง')
                    loadFromSupabase()
                    return
                  }
                  dmgs.forEach(d => addDamage(unit.vin, { ...d, source: 'update', station: 'Update Damage' }))
                  recordRecent('damage:save', unit.vin, dmgs.length > 1 ? `บันทึก Defect ${dmgs.length} รายการ` : 'บันทึก Defect 1 รายการ')
                  setShowAdd(false)
                  toast('ok', dmgs.length > 1 ? `บันทึก Defect ${dmgs.length} รายการ` : 'บันทึก Defect แล้ว')
                }}
                onCancel={() => setShowAdd(false)}
              />
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
  const { toast, loadFromSupabase } = useYard()
  const [vin, setVin] = useState<string | null>(null)

  // pull units + damages from the cloud too — Check is read-only and often sits
  // open while OTHER devices record PDI defects; local state alone showed
  // "NG — มี Defect" (from the sheet) with no defect cards under it
  useEffect(() => { loadFromIdb(); loadFromSupabase() }, [loadFromIdb, loadFromSupabase])

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
    recordRecent('check:search', found)
    // refresh from the cloud so defects recorded moments ago on another
    // device (PDI tablet) appear on this scan, not the next app restart
    loadFromSupabase().catch(() => {})
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
      {!vin && <RecentPanel station="check" accent="#0891b2" onPick={onScan} />}

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
              {/* where the car stands, in the yard's lane code (e.g. R0502) */}
              {unit?.block && unit.row && unit.slot && (
                <span className="badge text-[11px] font-bold px-2.5 py-1 tabular flex items-center gap-1"
                  style={{ background: '#0f172a', color: '#fff' }}>
                  <MapPin size={10} /> {yardLocFull(unit)}
                </span>
              )}
              <span className="vin text-[12.5px] font-bold">{vin}</span>
              <button onClick={() => copyVin(vin, toast)} title="คัดลอก VIN"
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition active:scale-90"
                style={{ background: 'rgba(8,145,178,0.12)', color: '#0891b2' }}>
                <Copy size={13} />
              </button>
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
            {(unit?.block || row?.cells['Location yard'] || row?.cells['storage Yard']) && (
              <Row label="Location" value={yardLocFull(unit) || row?.cells['Location yard'] || row?.cells['storage Yard'] || '—'} />
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
            <Row label="Damage" value={damaged ? 'NG — มี Defect' : 'OK — ปกติ'} accent={damaged ? '#dc2626' : '#16a34a'} />
            {/* same DefectCard as Gate-in: bilingual labels, photo strip with
                full-screen lightbox, and a read-only repair-status badge */}
            {unit && unit.damages.length > 0 && (
              <div className="p-3 space-y-2">
                {unit.damages.map(d => (
                  <DefectCard key={d.id} d={d} right={
                    <span className="font-bold rounded-lg px-2.5 py-1.5 whitespace-nowrap shrink-0"
                      style={{ ...defectStatusStyle(d.statusRepair || 'Waiting Repair'), fontSize: 11.5 }}>
                      {d.statusRepair || 'Waiting Repair'}
                    </span>
                  } />
                ))}
              </div>
            )}
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
// The open station survives a page reload: field tablets reload every time the
// operator app-switches (LINE → back), and losing the screen mid-shift meant
// re-navigating for every chat reply. Stored per device; the back button clears it.
const STATION_KEY = 'sjwd-ops-station'
const savedStation = (): RoleKey | null => {
  try {
    const v = localStorage.getItem(STATION_KEY)
    return v && ROLES.some(r => r.key === v) ? (v as RoleKey) : null
  } catch { return null }
}

export function YardOps() {
  const { currentUser } = useYard()
  const [role, setRoleState] = useState<RoleKey | null>(savedStation)
  const setRole = (r: RoleKey | null) => {
    setRoleState(r)
    try { r ? localStorage.setItem(STATION_KEY, r) : localStorage.removeItem(STATION_KEY) } catch { /* private mode */ }
  }

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
      {role === 'pdi'        && <PdiView types={['PDI']} accent="#7c3aed" title="PDI" />}
      {role === 'pm'         && <PdiView types={['PM']} accent="#2563eb" title="PM" />}
      {role === 'fc'         && <PdiView types={['FINAL']} accent="#059669" title="FINAL CHECK" />}
      {role === 'check'      && <CheckView />}
      {role === 'mechanic'   && <MechanicView />}
    </div>
  )
}
