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
import { useYard, useUnits, useTrips, useBlocks } from '../store/useYard'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { isDamaged, deriveCarStatus, IN_YARD_STATUSES, CAR_STATUS_META } from '../lib/carStatus'
import { useOps, useActiveQueues, activeProcess, stageOf, isSequenceQueue, seqStageOf, isQueueComplete, isStationWorkComplete, queueTypeOf, stampStationDate, stationProgress, drivingNow } from '../store/useOps'
import type { WorkQueue, QueueItem, QueueType, QueueStage } from '../store/useOps'
import { CarTopView } from '../components/CarTopView'
import { LogoMark } from '../components/Logo'
import { DrivingScreen } from '../components/DrivingScreen'
import { LiveTrackingMap } from '../components/LiveTrackingMap'
import { ALL_ZONES, zoneLabel } from '../components/CarDiagramMultiView'
import { MASTER_PARTS, MASTER_DEFECTS, resolvePart, resolveDefect } from '../lib/masterDefect'
import { partLabel, defectLabel, partBilingual, defectBilingual, openDefectsFirst } from '../lib/damageLabel'
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
import { fetchUnitsByVins, isConfigured } from '../lib/db'
import { useRecentOps } from '../store/useRecentOps'
import { buildWorkRows, buildEventLog, fmtHistAt, histOf } from '../lib/carHistory'

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
import type { Damage, DamageInput, DamageSource, Unit } from '../types'
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

type RoleKey = 'walk' | 'driver' | 'pdi' | 'pm' | 'fc' | 'mechanic' | 'gateout' | 'relocation' | 'check' | 'updatedmg' | 'walkcheck'
const ROLES: { key: RoleKey; th: string; en: string; icon: React.ReactNode; color: string; desc: string }[] = [
  { key: 'walk',      th: 'Gate-in',         en: 'Gate-in',         icon: <ScanLine size={28} />,      color: 'var(--brand)',   desc: 'ตรวจรับรถเข้าลาน' },
  { key: 'gateout',  th: 'Gate-out',        en: 'Gate-out',        icon: <LogOut size={28} />,        color: '#64748b',        desc: 'บันทึกรถออกจากลาน' },
  { key: 'driver',   th: 'Driver',          en: 'Driver',          icon: <Car size={28} />,           color: 'var(--st-yard)', desc: 'นำรถไปจอดตามตำแหน่ง' },
  { key: 'relocation',th:'Re-location',     en: 'Re-location',     icon: <MapPin size={28} />,        color: '#0ea5e9',        desc: 'เปลี่ยนตำแหน่งรถในลาน' },
  { key: 'pdi',      th: 'PDI',             en: 'PDI',             icon: <ShieldCheck size={28} />,   color: '#7c3aed',        desc: 'ตรวจสอบคุณภาพ OK / NG' },
  { key: 'pm',       th: 'PM',              en: 'PM',              icon: <ShieldCheck size={28} />,   color: '#2563eb',        desc: 'ตรวจสอบคุณภาพ OK / NG' },
  { key: 'fc',       th: 'FINAL CHECK',     en: 'FINAL CHECK',     icon: <ShieldCheck size={28} />,   color: '#059669',        desc: 'ตรวจสอบคุณภาพ OK / NG' },
  { key: 'walkcheck',th: 'Walk Around Check', en: 'Walk Around Check', icon: <Hand size={28} />,      color: '#0d9488',        desc: 'สแกน / เพิ่ม Defect ระหว่างเดินตรวจ' },
  { key: 'updatedmg',th: 'Update Damage',   en: 'Update Damage',   icon: <AlertTriangle size={28} />, color: '#dc2626',        desc: 'บันทึก / แก้ไขความเสียหาย' },
  { key: 'check',    th: 'Check',           en: 'Check',           icon: <ClipboardList size={28} />, color: '#0891b2',        desc: 'ตรวจสอบข้อมูลรถ' },
  { key: 'mechanic', th: 'ช่าง',             en: 'Mechanic',        icon: <Wrench size={28} />,        color: '#c2680b',        desc: 'คิวงานซ่อม / งานพิเศษ · แก้ไข NG' },
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

// A scanned VIN the tracking sheet says is gated in, but whose `units` row
// hasn't landed on this device yet, used to "hurry" the WHOLE site's units —
// every car, every damage — on a station that only needs ONE row. On a slow
// yard connection (or a car whose status made it fall outside the in-yard
// fetch filter, e.g. mid-transition) that full re-fetch could take a long
// time or never resolve the one car being waited on, leaving "กำลังโหลด
// ข้อมูลรถ…" stuck. A direct per-VIN lookup answers in one small request
// regardless of yard size or the car's exact status.
async function fetchUnitFallback(vin: string): Promise<boolean> {
  if (!isConfigured()) return false
  try {
    const [u] = await fetchUnitsByVins([vin])
    if (!u) return false
    useYard.setState((s) => (s.units[u.vin] ? s : { units: { ...s.units, [u.vin]: u } }))
    return true
  } catch (e) { console.error('[db] fetchUnitFallback', e); return false }
}

// A saved defect always carries ≥1 photo (the add-Defect form requires one
// before Save is even enabled) — a damage with NEITHER `photo` NOR `photos`
// on screen is proof this unit's local copy is the IndexedDB boot-cache stub
// (photos are stripped before persisting there to keep it small; see
// useYard's IDB write-through) that hasn't yet been replaced by the real
// cloud fetch. Devices whose cloud pull is still in flight showed defect
// cards with no photo at all until something else happened to reload them.
const hasPhotolessDamage = (u: Unit) => u.damages.some((d) => !d.photo && !d.photos?.length)
const vinsHealingPhotos = new Set<string>()
/** Force-refresh one VIN from the cloud even though a local copy already
 *  exists — fetchUnitFallback() above deliberately no-ops in that case, which
 *  is right for "missing entirely" but wrong for "present but a photo-less
 *  stub". Skips a car whose local copy still has an unsynced pending defect
 *  (useYard.pendingDamages) so this doesn't race and clobber it. */
async function fetchUnitPhotoHeal(vin: string): Promise<void> {
  if (!isConfigured() || vinsHealingPhotos.has(vin)) return
  if (Object.values(useYard.getState().pendingDamages).some((p) => p.vin === vin)) return
  vinsHealingPhotos.add(vin)
  try {
    const [u] = await fetchUnitsByVins([vin])
    if (u) useYard.setState((s) => ({ units: { ...s.units, [u.vin]: u } }))
  } catch (e) { console.error('[db] fetchUnitPhotoHeal', e) }
  finally { vinsHealingPhotos.delete(vin) }
}

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

/** "07/08 14:32" — when a station check was recorded (queue-item timestamp) */
const fmtCheckedAt = (ts?: number): string => {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** ผู้ตรวจ + วันเวลา under the ตรวจแล้ว pill — who recorded the check and when. */
function CheckedByLine({ by, at }: { by?: string; at?: number }) {
  if (!by && !at) return null
  return (
    <div className="text-[10px] mt-0.5 clip" style={{ color: 'var(--muted)', maxWidth: 150 }}>
      {by && <b style={{ color: '#16a34a' }}>{by}</b>}
      {by && at ? ' · ' : ''}
      {fmtCheckedAt(at)}
    </div>
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
// keyboard-wedge dedupe: two VinInputs on one screen both hear the burst —
// only the first may fire it
let lastWedgeAt = 0

// the worker's preferred scanner zoom, remembered across scans/app restarts —
// whoever always needs 4× on the windshield sticker sets it once
const SCAN_ZOOM_KEY = 'sjwd-scan-zoom'
function savedScanZoom(): number {
  try {
    const v = parseFloat(localStorage.getItem(SCAN_ZOOM_KEY) ?? '')
    return Number.isFinite(v) && v >= 1 ? v : 2
  } catch { return 2 }
}
const rememberScanZoom = (v: number) => { try { localStorage.setItem(SCAN_ZOOM_KEY, String(v)) } catch { /* full */ } }

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
  // digital zoom — iPhones whose Safari can't drive the lens zoom get a slider
  // that crops the DECODED frame instead (and scales the preview to match), so
  // a tiny windshield QR still fills the decoder's view
  const [digitalZoom, setDigitalZoom] = useState(false)
  const [dz, setDz] = useState(() => Math.min(3, savedScanZoom()))
  const dzRef = useRef(dz)
  const opticalRef = useRef(false)

  const applyZoom = (z: number) => {
    const t = trackRef.current
    if (!t || !zoomCap) return
    const v = Math.min(zoomCap.max, Math.max(zoomCap.min, z))
    setZoom(v)
    rememberScanZoom(v) // next scan starts at this zoom
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

  // ── handheld (keyboard-wedge) scanners: the SCAN trigger types the code as a
  // rapid keystroke burst + Enter. When focus is NOT in any text field, catch
  // the burst here and feed it straight into this station's search — the VIN
  // lands without the worker ever tapping the input first.
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  useEffect(() => {
    let buf = ''
    let last = 0
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { buf = ''; return } // fields handle their own keys
      const now = Date.now()
      if (/^[a-zA-Z0-9]$/.test(e.key)) {
        if (now - last > 250) buf = '' // human-speed gap → not a scanner burst
        buf += e.key.toUpperCase()
        last = now
      } else if (e.key === 'Enter') {
        if (buf.length >= 8 && now - last < 600 && now - lastWedgeAt > 400) {
          lastWedgeAt = now
          e.preventDefault()
          const v = buf
          buf = ''
          onScanRef.current(v)
        } else buf = ''
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

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
    const z0 = Math.min(3, savedScanZoom())
    setDigitalZoom(false); setDz(z0); dzRef.current = z0; opticalRef.current = false
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
    // only ~40 px wide, below what any decoder can read. 2560 gives iPhones
    // (which clamp to what the sensor pipeline allows) every pixel available.
    const VIDEO: MediaTrackConstraints = { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }

    // zoom + torch, where the hardware offers them. A slight starting zoom
    // (2×, capped) puts far more pixels on the small sticker code.
    // `allowDigital`: the ZXing path can crop-decode, so when the lens zoom is
    // NOT drivable (most iPhones on Safari) it falls back to a digital zoom.
    const setupTrack = (video: HTMLVideoElement, allowDigital: boolean) => {
      const track = (video.srcObject as MediaStream | null)?.getVideoTracks?.()[0] ?? null
      trackRef.current = track
      // nudge continuous autofocus — ignored where unsupported, but stops some
      // devices from locking focus at the wrong distance
      track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min?: number; max?: number; step?: number }; torch?: boolean }
      if (caps.zoom && typeof caps.zoom.max === 'number' && caps.zoom.max > (caps.zoom.min ?? 1)) {
        opticalRef.current = true
        const cap = { min: caps.zoom.min ?? 1, max: caps.zoom.max, step: caps.zoom.step || 0.1 }
        setZoomCap(cap)
        // start at the zoom the worker used LAST time (remembered), capped
        const z = Math.min(Math.max(savedScanZoom(), cap.min), cap.max)
        track!.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] })
          .then(() => setZoom(z)).catch(() => setZoom(cap.min))
      } else if (allowDigital) {
        setDigitalZoom(true) // slider drives the crop-decode + preview scale
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
        setupTrack(video, false) // native detector reads the full frame — no crop zoom
        return true
      } catch { return false } // permission error falls through to ZXing for its message
    }

    // Path 2 — ZXing (iOS Safari + anything without BarcodeDetector).
    // Instead of decoding the whole frame (where a windshield QR is a few dozen
    // pixels), each tick decodes a CENTER CROP of the frame — the aiming box —
    // which multiplies the code's effective size. Every 3rd tick decodes the
    // full frame too, so a large/off-center code still hits.
    const startZxing = async () => {
      const video = videoRef.current
      if (!video || cancelled) return
      const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO })
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
      video.srcObject = stream
      await video.play().catch(() => {})

      // ── decoder: zxing-wasm (the C++ engine compiled to WebAssembly) — near
      // Android-native accuracy and speed on tiny / glarey windshield codes.
      // Falls back to the pure-JS @zxing/library if the wasm fails to load.
      let wasmRead: ((img: ImageData) => Promise<string | null>) | null = null
      try {
        const [{ readBarcodes, prepareZXingModule }, wasmUrlMod] = await Promise.all([
          import('zxing-wasm/reader'),
          import('zxing-wasm/reader/zxing_reader.wasm?url'),
        ])
        const wasmUrl = (wasmUrlMod as { default: string }).default
        prepareZXingModule({ overrides: { locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? wasmUrl : prefix + p) } })
        const OPTS = { formats: ['QRCode', 'Code128', 'Code39', 'EAN13', 'DataMatrix'], tryHarder: true, maxNumberOfSymbols: 1 } as const
        // warm the module now so the first real frame doesn't pay the load
        await readBarcodes(new ImageData(2, 2), OPTS as never).catch(() => {})
        wasmRead = async (img) => (await readBarcodes(img, OPTS as never))[0]?.text ?? null
      } catch (e) { console.warn('[scan] wasm decoder unavailable — JS fallback', e) }

      let jsReader: { decodeFromCanvas: (c: HTMLCanvasElement) => { getText: () => string } } | null = null
      if (!wasmRead) {
        const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
          import('@zxing/browser'),
          import('@zxing/library'),
        ])
        const hints = new Map<number, unknown>()
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
          BarcodeFormat.EAN_13, BarcodeFormat.DATA_MATRIX,
        ])
        hints.set(DecodeHintType.TRY_HARDER, true)
        jsReader = new BrowserMultiFormatReader(hints as never)
      }
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      let tick = 0
      let busy = false
      const iv = setInterval(() => {
        if (busy || !ctx || video.readyState < 2) return
        const vw = video.videoWidth, vh = video.videoHeight
        if (!vw || !vh) return
        // crop factor: with lens zoom the frame is already magnified → a mild
        // 1.6× aim-box crop; without it the slider's digital zoom drives it
        const factor = opticalRef.current ? 1.6 : Math.max(1.6, dzRef.current)
        const full = ++tick % 3 === 0
        const cw = full ? vw : Math.round(vw / factor)
        const ch = full ? vh : Math.round(vh / factor)
        // cap the decode surface at ~1024 px wide — plenty for the wasm engine,
        // and each frame decodes in tens of ms instead of hundreds on iPhone
        const scale = Math.min(1, 1024 / cw)
        canvas.width = Math.max(2, Math.round(cw * scale))
        canvas.height = Math.max(2, Math.round(ch * scale))
        ctx.drawImage(video, (vw - cw) >> 1, (vh - ch) >> 1, cw, ch, 0, 0, canvas.width, canvas.height)
        busy = true
        void (async () => {
          try {
            let text: string | null = null
            if (wasmRead) text = await wasmRead(ctx.getImageData(0, 0, canvas.width, canvas.height))
            else { try { text = jsReader!.decodeFromCanvas(canvas).getText() } catch { /* none */ } }
            if (text) hit(text)
          } catch { /* decoder hiccup — next tick */ }
          finally { busy = false }
        })()
      }, 90)
      controlsRef.current = { stop: () => clearInterval(iv) }
      setupTrack(video, true)
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
      {/* Camera overlay — PORTALED to <body>: rendered in place, an ancestor
          with a transform (e.g. the fade-up animation Safari keeps as a
          containing block) traps position:fixed and squeezes the scanner into
          the panel instead of the full screen. 100dvh covers the iOS URL bar. */}
      {camOpen && createPortal(
        <div className="fixed inset-0 z-[90] bg-black flex flex-col" style={{ touchAction: 'none', height: '100dvh' }}>
          {/* header sits BELOW the iPhone notch / Dynamic Island (safe-area),
              with a big RED close button that can't be missed */}
          <div className="flex items-center justify-between px-4 pb-2 shrink-0"
            style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)' }}>
            <span className="text-white font-bold text-[16px]">{camTitle}</span>
            <button onClick={closeCamera} className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
              style={{ background: '#dc2626' }}>
              <X size={24} color="#fff" strokeWidth={3} />
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              style={digitalZoom && dz > 1 ? { transform: `scale(${dz})` } : undefined}
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
          {/* zoom / torch — lens zoom where the camera drives it, digital
              (crop-decode) zoom where it doesn't (iPhone Safari) */}
          {(zoomCap || digitalZoom || torchCap) && (
            <div className="px-5 py-2 flex items-center gap-3 shrink-0" style={{ touchAction: 'pan-x' }}>
              {zoomCap ? (
                <>
                  <span className="text-white/70 text-[12px] shrink-0">ซูม</span>
                  <input
                    type="range" className="flex-1" style={{ accentColor: accent }}
                    min={zoomCap.min} max={zoomCap.max} step={zoomCap.step}
                    value={zoom} onChange={e => applyZoom(Number(e.target.value))}
                  />
                  <span className="text-white/70 text-[12px] tabular shrink-0" style={{ width: 36, textAlign: 'right' }}>{zoom.toFixed(1)}×</span>
                </>
              ) : digitalZoom && (
                <>
                  <span className="text-white/70 text-[12px] shrink-0">ซูม</span>
                  <input
                    type="range" className="flex-1" style={{ accentColor: accent }}
                    min={1} max={3} step={0.1}
                    value={dz} onChange={e => { const v = Number(e.target.value); setDz(v); dzRef.current = v; rememberScanZoom(v) }}
                  />
                  <span className="text-white/70 text-[12px] tabular shrink-0" style={{ width: 36, textAlign: 'right' }}>{dz.toFixed(1)}×</span>
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
          <div className="px-4 pt-2 pb-1 text-center text-white/60 text-[13px] shrink-0">
            {camHint}{zoomCap || digitalZoom ? ' · เลื่อนซูมถ้าโค้ดเล็ก' : ''}
          </div>
          {/* thumb-reach close bar — one tap to leave, no stretching to the top */}
          <div className="px-4 pt-1 shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}>
            <button onClick={closeCamera}
              className="w-full py-3.5 rounded-2xl text-[15px] font-bold text-white flex items-center justify-center gap-2"
              style={{ background: '#dc2626' }}>
              <X size={18} strokeWidth={3} /> ปิดกล้อง
            </button>
          </div>
        </div>,
        document.body,
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
              {openDefectsFirst(walkDmgs).map(d => <DefectCard key={d.id} d={d} />)}
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
            <span className="badge font-bold" style={{ fontSize: 10, background: 'rgba(37,99,235,0.1)', color: '#2563eb' }}>
              {stationLabel(d)}
            </span>
            <span className="flex items-center gap-1"><User size={11} /> {d.by || '—'}</span>
            <span className="flex items-center gap-1"><Clock size={11} /> {fmtDateTime(d.at).date} {fmtDateTime(d.at).time}</span>
            {(() => {
              // when it was actually repaired: the stamped repairDate, else the
              // Status-Repair audit trail's switch to Repaired
              const rd = d.repairDate
                ?? (d.repairHistory ?? []).filter((h) => h.status === 'Repaired').map((h) => h.at).pop()
              return rd
                ? <span className="flex items-center gap-1 font-semibold" style={{ color: '#15803d' }}>
                    <Wrench size={11} /> ซ่อมเสร็จ {fmtDateTime(rd).date}
                  </span>
                : null
            })()}
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
  walkcheck: 'Walk Around Check',
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
  const [heavy, setHeavy] = useState(true) // NG / HEAVY NG choice (HEAVY NG default, as before)
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
      severity: (heavy ? 'major' : 'minor') as 'major' | 'minor',
      categoryNG: heavy ? 'HEAVY NG' : 'NG',
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

        {/* severity choice: NG or HEAVY NG (pick one) */}
        <div className="flex gap-2 pt-0.5">
          <button onClick={() => setHeavy(false)}
            className="flex-1 py-2 rounded-xl text-[12px] font-bold transition flex items-center justify-center gap-1.5"
            style={!heavy
              ? { background: '#d97706', color: '#fff' }
              : { background: 'var(--chip)', color: 'var(--muted)', border: '1px dashed var(--line-strong)' }}>
            {!heavy && <CheckCircle2 size={14} />} NG
          </button>
          <button onClick={() => setHeavy(true)}
            className="flex-1 py-2 rounded-xl text-[12px] font-bold transition flex items-center justify-center gap-1.5"
            style={heavy
              ? { background: '#dc2626', color: '#fff' }
              : { background: 'var(--chip)', color: 'var(--muted)', border: '1px dashed var(--line-strong)' }}>
            {heavy && <CheckCircle2 size={14} />} HEAVY NG
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
            <Plus size={14} /> บันทึก {heavy ? 'HEAVY NG' : 'NG'}{rows.length > 1 ? ` (${rows.length})` : ''}
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
  const { blockWith, modal: gateModal } = useNotGatedIn()
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

  // safety net: a Pre Gate-in car this station doesn't cover with any queue —
  // same fix as the admin Gate In/Out board's virtual card (PR #263). A device
  // that deletes its data and re-uploads a fresh file can end up with NEW Pre
  // Gate-in rows and no matching queue for them (the old queue for a prior
  // batch stays visible), so this station's own "เหลือ" undercounted against
  // the Dashboard's sitewide Pre Gate-in tally — collect every uncovered row
  // into one virtual entry so the two numbers can never disagree.
  const uncoveredPreGateIn = useMemo(() => {
    const queuedVins = new Set<string>()
    for (const q of queues) if (isPreGateInQueue(q.name)) for (const i of q.items) queuedVins.add(i.vin)
    return trackingRows.filter(r => !queuedVins.has(r.vin) && deriveCarStatus(r.cells) === 'Pre Gate-in')
  }, [queues, trackingRows])
  // Pre Gate-in queues "(M-D-N)" — process queues (PDI / PM / Wash) live under the
  // PDI role, not here. Completed queues stay listed so the station can still read
  // its own progress ("17/17 · เหลือ 0"), same as the Driver's delivery-run cards.
  const gateInQueues = useMemo(() => {
    // completed queues drop off the live Ops-Scan list (they've filed under their day)
    const real = queues.filter(q => isPreGateInQueue(q.name) && !isQueueComplete(q))
    if (!uncoveredPreGateIn.length) return real
    const virtual: WorkQueue = {
      id: '__uncovered_pregatein', name: '(รอ Gate-in · ยังไม่มีคิวงาน)', createdAt: 0,
      items: uncoveredPreGateIn.map(r => ({ vin: r.vin, addedAt: 0, done: false })),
    }
    return [...real, virtual]
  }, [queues, uncoveredPreGateIn])
  // gateInQueues (not queues) — the selected card may be the virtual uncovered one
  const selectedQueue = selectedQueueId ? gateInQueues.find(q => q.id === selectedQueueId) ?? null : null
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

  // A locally-cached unit can still read `status: 'EXPECTED'` after another
  // device already gated the car in (the `units` store only refreshes via the
  // cloud, unlike tracking rows which sync instantly through IndexedDB) — that
  // staleness let this station show the Gate-in confirm button for a car
  // that's already in the yard, so a second gate-in got recorded on top of the
  // first. The tracking sheet is the fast-syncing source of truth: if it says
  // this VIN already gated in and hasn't gone out since, refuse the scan here
  // instead of trusting the stale local unit, and self-heal the cache.
  const blockIfAlreadyGated = (u: Unit): boolean => {
    if (u.status !== 'EXPECTED') return false
    const row = trackingRows.find(r => r.vin === u.vin)
    if (!row || !isGatedInStatus(row.cells['Car Status']) || hasGoneOut(row.cells)) return false
    fetchUnitFallback(u.vin) // correct the stale local cache in the background
    const gitCell = row.cells['Gate In Time']
    const at = gitCell ? new Date(parseInt(gitCell)) : null
    blockWith(u.vin, u.modelName, 'รถคันนี้ Gate-in แล้ว', (
      <>
        {at && <>เข้าลาน {at.toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}<br /></>}
        {row.cells['Gate In Inspector'] && <>โดย {row.cells['Gate In Inspector']}<br /></>}
        ไม่สามารถ Gate-in ซ้ำได้ — รถต้อง <b style={{ color: 'var(--brand)' }}>Gate-out</b> ก่อน จึงจะ Gate-in ใหม่ได้
      </>
    ))
    return true
  }

  const onScan = (v: string) => {
    setTrackingVin(null)
    // 1. exact yard unit
    let u = units.find(x => x.vin === v)
    if (u) { if (blockIfAlreadyGated(u)) return; setVin(u.vin); setShowDmg(false); return }
    setVin(null)
    // 2. exact tracking row
    const et = trackingRows.find(r => r.vin === v)
    if (et) { setTrackingVin(et.vin); return }
    // 3. suffix match (≤ 8 chars) — yard units first, then tracking
    if (v.length <= 8) {
      const unitHits = units.filter(x => x.vin.toUpperCase().endsWith(v))
      if (unitHits.length === 1) { if (blockIfAlreadyGated(unitHits[0])) return; setVin(unitHits[0].vin); setShowDmg(false); return }
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
    // straight to "In Yard" — no separate "Gate-in" stage anymore; gateIn()
    // (called below) auto-parks the unit at the WCL staging block, so the
    // car really is in the yard the moment this scan completes
    updateCell(trackRow.vin, 'Car Status', 'In Yard')
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
      {gateModal}

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
                    <div className="font-bold text-[12.5px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{q.name}</div>
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
            {openDefectsFirst(unit.damages).map(d => (
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
            checkedBy: i.checkedBy ?? i.doneBy,
            checkedAt: i.checkedAt ?? i.doneAt,
          }
        }).sort((a, b) => byYardLocation(a.location, b.location))
        return (
          <div key={q.id} className="panel overflow-hidden">
            <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setOpenId(isOpen ? null : q.id)}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--chip)', color: 'var(--st-yard)' }}>
                <ClipboardList size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-[12.5px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{q.name}</div>
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
                      {item.stage === 'checked' && <CheckedByLine by={item.checkedBy} at={item.checkedAt} />}
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
    // finished station work (every car done or checked) leaves the driver's
    // browser too — a "เหลือ 0" queue only blocked the screen
    () => queues.filter(q => !isSequenceQueue(q) && !isPreGateInQueue(q.name) && !isQueueComplete(q) && !isStationWorkComplete(q)),
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
    if (res.type === 'okPending') { toast('ok', 'กำลังโหลดข้อมูลรถ…'); fetchUnitFallback(res.vin) } // unit not synced yet
    setVin(res.vin)
  }
  const doAssign = (slot: { block: string; row: number; slot: number }) => {
    if (!unit) return
    const from = unit.block && unit.row && unit.slot ? yardLocFull(unit) : ''
    assign(unit.vin, slot, driverName, planMode)
    startTrip(unit.vin, driverName, 'Gate', `${blockCode(slot.block)}${slot.slot}.${slot.row}`)
    // the parking assignment IS a position edit — log it like any relocation,
    // so no screen can ever hold a position that no history line explains
    useTracking.getState().appendHistory(unit.vin, {
      at: Date.now(), by: driverName, field: 'Location', src: 'scan',
      from, to: yardLocFull({ block: slot.block, slot: slot.slot, row: slot.row }),
    })
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
      if (proc.slot) {
        const from = unit.block && unit.row && unit.slot ? yardLocFull(unit) : ''
        assign(unit.vin, proc.slot, driverName, planMode); confirmParked(unit.vin)
        useTracking.getState().appendHistory(unit.vin, {
          at: Date.now(), by: driverName, field: 'Location', src: 'scan',
          from, to: yardLocFull({ block: proc.slot.block, slot: proc.slot.slot, row: proc.slot.row }),
        })
      }
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
                <span className="font-semibold text-[12.5px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{seqHit.queue.name}</span>
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
          : openDefectsFirst(stationDmgs).map(d => (
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
  // completed queues drop off the live list (they've filed under their day) —
  // including queues whose STATION work is finished (every car done/checked)
  // while some cars still wait for the drive back to a slot ("เหลือ 0" cards).
  // A just-created queue with no cars yet IS shown (it used to vanish, so an
  // operator who had just created it thought the queue never arrived).
  const procQueues = useMemo(() => queues.filter(q => !isPreGateInQueue(q.name) && !isQueueComplete(q) && !isStationWorkComplete(q)), [queues])
  // scan should resolve against the queue(s) already on screen first — a
  // handful of VINs, not the whole site's units/tracking rows — so it's
  // instant for the common case (the car being worked is in this station's
  // own queue); falls back to a full search only when the scan misses here
  const queueVins = useMemo(() => {
    const s = new Set<string>()
    for (const q of procQueues) for (const it of q.items) if (!it.done) s.add(it.vin)
    return s
  }, [procQueues])
  const queueUnits = useMemo(() => units.filter(u => queueVins.has(u.vin)), [units, queueVins])
  const queueRows = useMemo(() => trackingRows.filter(r => queueVins.has(r.vin)), [trackingRows, queueVins])
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
        // ผู้ตรวจ + เวลา — recorded when the station saved OK/NG
        checkedBy: i.checkedBy ?? i.doneBy,
        checkedAt: i.checkedAt ?? i.doneAt,
      }
    }).sort((a, b) => byYardLocation(a.location, b.location))
  }, [selectedQueue, units, trackingRows])

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null
  // a scanned car whose unit row hasn't landed yet: keep trying the light,
  // one-VIN fetch on its own — no need to wait for the operator to notice the
  // spinner and tap "ลองใหม่" themselves, and no need to hurry the entire
  // site's units for one car
  useEffect(() => {
    if (!vin || unit) return
    let cancelled = false
    let tries = 0
    const attempt = () => {
      if (cancelled) return
      tries++
      fetchUnitFallback(vin).then((found) => {
        if (!found && !cancelled && tries < 4) setTimeout(attempt, 1500 * tries)
      })
    }
    attempt()
    return () => { cancelled = true }
  }, [vin, unit])
  // the station task this car is currently in (PDI / FINAL PM / Wash …)
  const activeProc = useMemo(() => (unit ? activeProcess(unit.vin, queues) : null), [unit, queues])
  const procStage = activeProc ? stageOf(activeProc.item) : null
  const canRecord = !!activeProc && procStage !== 'checked'   // station task not yet recorded
  const walkDmgs = unit ? walkAroundDamages(unit) : []                              // found at gate-in
  const otherDmgs = unit ? unit.damages.filter(d => d.source && d.source !== 'walkaround') : [] // PDI / ช่าง

  const onScan = (v: string) => {
    // fast path: match against this station's own queue(s) first
    let res = resolveForUnit(v, queueUnits, queueRows)
    if (res.type === 'none') res = resolveForUnit(v, units, trackingRows) // not in a queue here — full site search
    if (res.type === 'ambiguous') { toast('err', `พบ ${res.count} คัน — พิมพ์ให้ยาวขึ้น`); return }
    if (res.type === 'none') { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (res.type === 'notGated') { blockGate(res.vin, res.model); return }
    if (res.type === 'okPending') fetchUnitFallback(res.vin) // unit not synced yet — hurry just this one car
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
                    <div className="font-bold text-[12.5px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{q.name}</div>
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
                          {item.stage === 'checked' && <CheckedByLine by={item.checkedBy} at={item.checkedAt} />}
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
          <button onClick={() => fetchUnitFallback(vin)} className="btn btn-ghost mt-3 text-[12px] py-1.5 px-3">
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
                {openDefectsFirst(walkDmgs).map(d => (
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
                {openDefectsFirst(otherDmgs).map(d => (
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

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null

  // ONLY assigned queues from the Operation page appear here — ช่าง (ซ่อม) and
  // งานพิเศษ both land at this station. The old auto-generated "every in-yard
  // car with an open NG" list flooded the screen with hundreds of VINs nobody
  // was assigned to fix today; scanning a car still opens its NG list directly.
  const repairQueues = useMemo(
    () => allQueues.filter(q => {
      if (isSequenceQueue(q) || isPreGateInQueue(q.name) || isQueueComplete(q)) return false
      const t = queueTypeOf(q)
      return t === 'REPAIR' || t === 'SPECIAL'
    }),
    [allQueues],
  )
  // scan should resolve against this station's own assigned queue(s) first —
  // a handful of VINs, not the whole site — falling back to a full search
  // only when the scan misses here
  const repairQueueVins = useMemo(() => {
    const s = new Set<string>()
    for (const q of repairQueues) for (const it of q.items) if (!it.done) s.add(it.vin)
    return s
  }, [repairQueues])
  const repairQueueUnits = useMemo(() => units.filter(u => repairQueueVins.has(u.vin)), [units, repairQueueVins])
  const repairQueueRows = useMemo(() => trackingRows.filter(r => repairQueueVins.has(r.vin)), [trackingRows, repairQueueVins])

  const onScan = (v: string) => {
    let res = resolveForUnit(v, repairQueueUnits, repairQueueRows)
    if (res.type === 'none') res = resolveForUnit(v, units, trackingRows) // not in a queue here — full site search
    if (res.type === 'ambiguous') { toast('err', `พบ ${res.count} คัน — พิมพ์ให้ยาวขึ้น`); return }
    if (res.type === 'none') { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (res.type === 'notGated') { blockGate(res.vin, res.model); return }
    if (res.type === 'okPending') { toast('ok', 'กำลังโหลดข้อมูลรถ…'); fetchUnitFallback(res.vin) } // unit not synced yet
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

      {/* assigned queues from the Operation page — ช่าง (ซ่อม) + งานพิเศษ */}
      {!unit && (repairQueues.length > 0 ? (
        <AllQueuesBrowser queues={repairQueues} units={units} trackingRows={trackingRows}
          onPick={v => { setVin(v); setShowForm(false) }} />
      ) : (
        <div className="panel p-6 text-center fade-up" style={{ color: 'var(--faint)' }}>
          <Wrench size={26} className="mx-auto mb-2" style={{ color: 'var(--line-strong)' }} />
          <div className="text-[13px] font-semibold" style={{ color: 'var(--muted)' }}>ยังไม่มีคิวงานซ่อม / งานพิเศษ</div>
          <div className="text-[12px] mt-1">แอดมินสร้างคิวได้ที่หน้า Operation — หรือสแกน VIN เพื่อเปิดรายการ NG ของคันนั้นได้เลย</div>
        </div>
      ))}

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
                {openDefectsFirst(unit.damages).map(d => (
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

// ── Gate-out view ────────────────────────────────────────────────────────────
function GateOutView() {
  const trackingRows = useSiteRows()
  const units = useSiteUnits()
  const wrongSite = useWrongSiteHint()
  const queues = useSiteQueues()
  const { loadFromIdb, updateCell } = useTracking()
  const { toast, currentUser, sites, currentSite, markDeparted } = useYard()
  const { confirmSeqGateOut } = useOps()
  const { block: blockGate, blockWith, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [dn, setDn] = useState<string | null>(null)      // scanned DN / grouping number
  // a scanned car that belongs to a DIFFERENT grouping — the popup that stops a
  // driver from dispatching a car with the wrong group
  const [wrongGroup, setWrongGroup] = useState<{ vin: string; group: string } | null>(null)
  const [done, setDone] = useState<{ vin: string; label: string } | { group: number } | null>(null)

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

  const dnGone = dnCars.filter(c => c.gone).length

  const onScanDn = (raw: string) => {
    const g = normGroup(raw)
    if (!g) return
    const n = trackingRows.filter(r => normGroup(r.cells[GROUP_KEY]) === g).length
    if (!n) { toast('err', `ไม่พบ DN / เลข Grouping: ${raw}`); return }
    setVin(null); setDn(g)
  }

  // VIN scan INSIDE a scanned DN — the operator walks to the physical car and
  // scans it there, so what leaves the gate is exactly what the Note says.
  const onScan = (v: string) => {
    if (!dn) return
    // the DN barcode shot into this field switches to that Note
    if (trackingRows.some(r => normGroup(r.cells[GROUP_KEY]) === normGroup(v))) { onScanDn(v); return }
    let r = trackingRows.find(x => x.vin === v)
    if (!r && v.length <= 8) {
      const hits = trackingRows.filter(x => x.vin.endsWith(v))
      if (hits.length === 1) r = hits[0]
      else if (hits.length > 1) { toast('err', `พบ ${hits.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
    }
    if (!r) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    // the whole point of scanning at the car: a car whose grouping is not THIS
    // DN must never slip into the load — stop it with a popup, not a quiet toast
    if (normGroup(r.cells[GROUP_KEY]) !== dn) {
      setWrongGroup({ vin: r.vin, group: (r.cells[GROUP_KEY] ?? '').trim() })
      return
    }
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
    setVin(r.vin) // dn stays — after this car confirms, the next scan continues the Note
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
            {'group' in done ? (
              <>
                <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
                  style={{ background: 'rgba(22,163,74,0.15)' }}>
                  <CheckCircle2 size={28} style={{ color: '#16a34a' }} />
                </div>
                <div className="text-[20px] font-extrabold mb-1" style={{ color: '#16a34a' }}>ยืนยัน Gate-out ครบกลุ่มแล้ว!</div>
                <div className="text-[14px] font-bold mb-5" style={{ color: 'var(--muted)' }}>{done.group} คัน</div>
              </>
            ) : (
              <>
                <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
                  style={{ background: 'rgba(100,116,139,0.15)' }}>
                  <LogOut size={28} style={{ color: '#64748b' }} />
                </div>
                <div className="text-[20px] font-extrabold mb-1" style={{ color: '#475569' }}>{done.label} สำเร็จ!</div>
                <div className="vin text-[14px] font-bold mb-5" style={{ color: 'var(--muted)' }}>{done.vin}</div>
              </>
            )}
            <button onClick={() => setDone(null)}
              className="w-full py-3 rounded-2xl text-[15px] font-bold text-white active:scale-95 transition-all"
              style={{ background: 'group' in done ? '#16a34a' : '#64748b' }}>ตกลง</button>
          </div>
        </div>
      )}
      {gateModal}

      {/* wrong grouping — the popup that stops a mixed-up load at the gate */}
      {wrongGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}
          onClick={() => setWrongGroup(null)}>
          <div className="panel p-6 w-full max-w-xs text-center fade-up" onClick={e => e.stopPropagation()}>
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
              style={{ background: '#fee2e2' }}>
              <AlertTriangle size={28} style={{ color: '#dc2626' }} />
            </div>
            <div className="text-[17px] font-extrabold mb-1" style={{ color: '#dc2626' }}>กรุณาตรวจสอบ</div>
            <div className="text-[14px] font-bold mb-1">รถไม่อยู่ใน Grouping นี้</div>
            <div className="vin text-[12.5px] font-bold" style={{ color: 'var(--muted)' }}>{wrongGroup.vin}</div>
            <div className="text-[12px] mt-1 mb-5" style={{ color: 'var(--muted)' }}>
              คันนี้อยู่ group <b style={{ color: '#b45309' }}>{wrongGroup.group || '— (ไม่มีเลข grouping)'}</b><br />
              DN ที่กำลังทำ: <b style={{ color: '#b45309' }}>{dn}</b>
            </div>
            <button onClick={() => setWrongGroup(null)}
              className="w-full py-3 rounded-2xl text-[15px] font-bold text-white active:scale-95 transition-all"
              style={{ background: '#dc2626' }}>ตกลง</button>
          </div>
        </div>
      )}

      {/* step 1 — scan the DN: only the DN field and the work queues live here */}
      {!row && !dn && (
        <div className="panel p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <ClipboardList size={15} style={{ color: '#f59e0b' }} />
            <span className="text-[12.5px] font-bold">สแกน DN · เลข Grouping</span>
            <span className="text-[11px] ml-auto" style={{ color: 'var(--muted)' }}>เช่น ATL260804-12</span>
          </div>
          <VinInput
            onScan={onScanDn}
            accent="#f59e0b"
            placeholder="เลข Grouping / DN…"
            action="เรียกรถทั้ง DN"
            camTitle="สแกน Barcode DN"
            camHint="จ่อกล้องไปที่ barcode Trip No บนใบ DN"
          />
        </div>
      )}

      {/* step 2 — inside the DN: scan each car AT the car, one by one */}
      {!row && dn && (
        <>
          <div className="panel p-3.5 space-y-2.5">
            <div className="flex items-center gap-2">
              <LogOut size={15} style={{ color: '#64748b' }} />
              <span className="text-[12.5px] font-bold">Gate-out · สแกนที่ตัวรถทีละคัน</span>
              <span className="text-[11px] ml-auto tabular font-bold" style={{ color: '#16a34a' }}>ออกแล้ว {dnGone}/{dnCars.length}</span>
            </div>
            <VinInput
              onScan={onScan}
              accent="#64748b"
              placeholder="VIN / 5 ตัวท้าย…"
              action="สแกน / ค้นหา VIN"
            />
          </div>

          <div className="panel overflow-hidden fade-up">
            <div className="px-4 py-3 flex items-center gap-3" style={{ background: 'rgba(245,158,11,0.10)' }}>
              <div className="min-w-0 flex-1">
                <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>DN · Grouping</div>
                <div className="vin text-[14px] font-extrabold clip" style={{ color: '#b45309' }}>{dn}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  ทั้งหมด <b style={{ color: 'var(--text)' }}>{dnCars.length}</b> คัน
                  {' · '}ออกแล้ว <b style={{ color: '#16a34a' }}>{dnGone}</b>
                  {' · '}เหลือ <b style={{ color: '#d97706' }}>{dnCars.length - dnGone}</b>
                </div>
              </div>
              <button onClick={() => setDn(null)}
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ background: 'rgba(0,0,0,0.06)', color: 'var(--muted)' }}>
                <X size={16} />
              </button>
            </div>

            <div className="border-t hairline divide-y" style={{ borderColor: 'var(--line)' }}>
              {dnCars.map(c => (
                <div key={c.vin} className="px-4 py-2.5 flex items-center gap-3"
                  style={c.gone ? { opacity: 0.55 } : undefined}>
                  {c.gone
                    ? <CheckCircle2 size={17} style={{ color: '#16a34a' }} className="shrink-0" />
                    : <span className="w-[17px] shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="vin text-[12.5px] font-bold clip">{c.vin}</div>
                    <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2" style={{ color: 'var(--muted)' }}>
                      <span>{c.model}</span><span>· {c.color}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="tabular text-[12px] font-bold">{c.location}</div>
                    <span className="badge mt-0.5 inline-block" style={c.gone
                      ? { background: 'rgba(22,163,74,0.12)', color: '#16a34a', fontSize: 10 }
                      : c.reason
                        ? { background: '#fee2e2', color: '#b91c1c', fontSize: 10 }
                        : { background: 'rgba(245,158,11,0.15)', color: '#b45309', fontSize: 10 }}>
                      {c.gone ? c.status : c.reason || 'รอสแกน'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {dnCars.length > 0 && dnGone === dnCars.length && (
              // last-mile safety checkpoint: every car in the Note is confirmed
              // individually above, but the group itself isn't "done" until the
              // operator deliberately presses this — a quiet screen full of green
              // checks is easy to walk away from believing the DN dispatched when
              // it hasn't; this makes the final confirmation an explicit action.
              <div className="px-4 py-3 border-t hairline">
                <button
                  onClick={() => { setDone({ group: dnCars.length }); setDn(null) }}
                  className="w-full py-3 rounded-2xl text-[15px] font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                  style={{ background: '#16a34a' }}>
                  <CheckCircle2 size={18} /> ยืนยัน Gate-out ครบกลุ่ม {dnCars.length} คัน
                </button>
              </div>
            )}
            <div className="px-4 py-2.5 border-t hairline text-[10.5px] text-center leading-snug" style={{ color: 'var(--muted)', borderColor: 'var(--line)' }}>
              เดินไปสแกน VIN ที่ตัวรถทีละคัน · รถนอก group นี้จะถูกเตือนทันที · รถจะออกจริงตอน 09:30
            </div>
          </div>
        </>
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
  // ── ยิงตามแถว: pick a lane once (e.g. A10), then scan car after car — each
  // one lands on the next free space down that lane automatically ──
  const [mode, setMode] = useState<'one' | 'lane'>('one')
  const [laneStr, setLaneStr] = useState('')
  const [laneAdded, setLaneAdded] = useState<{ vin: string; code: string }[]>([])
  const lastSaveGuard = useRef(0)          // double-fire guard: single-car save
  const lastLaneHit = useRef({ v: '', at: 0 }) // double-fire guard: lane scans
  // scan order of THIS round (oldest first) — the scan sequence IS the lane
  // order: 1st scan parks as คันที่ 1, 2nd as คันที่ 2, … (ref: scans arrive
  // faster than state flushes)
  const laneOrderRef = useRef<string[]>([])
  // rebuild generation: each scan supersedes the WHOLE lane layout, so an
  // async (cloud-verified) rebuild only applies if no newer scan happened —
  // a late verify from an earlier scan must not overwrite a newer rebuild
  const laneGenRef = useRef(0)
  // walking direction: 'head' = 1st scan is คันที่ 1 · 'tail' = the worker
  // walks tail→head in ONE pass, so each NEW scan becomes คันที่ 1 and the
  // earlier scans slide down — the FIRST scan ends up last
  const [laneDir, setLaneDir] = useState<'head' | 'tail'>('head')
  const laneDirRef = useRef(laneDir)
  laneDirRef.current = laneDir
  const switchLaneDir = (d: 'head' | 'tail') => {
    if (d === laneDir) return
    setLaneDir(d)
    laneOrderRef.current = []
    laneGenRef.current++
    setLaneAdded([])
    toast('info', d === 'tail' ? 'ยิงจากท้ายแถว — คันที่ยิงล่าสุดจะเป็นคันที่ 1' : 'ยิงจากหัวแถว — คันแรกที่ยิงเป็นคันที่ 1')
  }

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

  // The Car Status CELL can lag reality: a unit standing in the yard (placed by
  // gate-in on another device, or a lane/plan import) while the sheet still says
  // Pre Gate-in. A physically-present unit IS gated-in — trust it over the stale
  // cell and heal the cell so counts/filters agree from now on.
  const unitGated = (vin: string) => {
    const u = siteUnits.find(x => x.vin === vin)
    return !!u && (u.status !== 'EXPECTED' || !!(u.block && u.row && u.slot))
  }
  const passGateGuard = (r: TrackRow): boolean => {
    if (isGatedInStatus(r.cells['Car Status'])) return true
    if (!unitGated(r.vin)) return false
    useTracking.getState().updateCell(r.vin, 'Car Status', 'In Yard')
    return true
  }

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
    if (!passGateGuard(r)) { blockGate(r.vin, r.cells['Model name'] ?? r.cells['Model'] ?? ''); return }
    setVin(r.vin)
    recordRecent('reloc:search', r.vin)
  }

  /** "T1201" — block name + column + which car down it, the yard's own form. */
  const codeOf = (b: string, col: number, depth: number) =>
    `${blockCode(b)}${String(col).padStart(2, '0')}${String(depth).padStart(2, '0')}`

  // ── ยิงตามแถว derived state — a PURE function of the lane string, so the
  // scan handler can evaluate any lane text directly (no stale-closure state)
  const laneInfoOf = (str: string) => {
    const parsed = parseLane(str.trim())
    const blk = parsed ? resolveBlockByName(parsed.block, blocks) : null
    const blockId = parsed ? (blk ? blockTag(blk) : blockKeyOfTag(parsed.block)) : ''
    const slot = parsed?.row ?? 0
    const slotOk = slot >= 1 && (!blk || slot <= blk.cols)
    const blockOk = !!blockId && (blocks.length === 0 || !!blk)
    const ready = blockOk && slotOk
    const depth = blk?.rows ?? 8
    const cars = ready
      ? siteUnits.filter(u => u.block && u.slot === slot && blockKeyOfTag(u.block) === blockId)
          .sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
      : []
    const taken = new Set(cars.map(u => u.row))
    let next: number | null = null
    if (ready) for (let r = 1; r <= depth; r++) if (!taken.has(r)) { next = r; break }
    return { parsed, blk, blockOk, ready, blockId, slot, depth, cars, next }
  }
  const laneCur = useMemo(() => laneInfoOf(laneStr), [laneStr, siteUnits, blocks]) // eslint-disable-line react-hooks/exhaustive-deps
  const laneParsed = laneCur.parsed
  const laneBlk = laneCur.blk
  const laneBlockOk = laneCur.blockOk
  const laneReady = laneCur.ready
  const laneBlockId = laneCur.blockId
  const laneSlot = laneCur.slot
  const laneDepthMax = laneCur.depth
  const laneCars = laneCur.cars
  const laneNextRow = laneCur.next

  // a handheld with focus still in the LANE box types the whole VIN there —
  // once the keystroke burst settles, split "A10<VIN17>" back into lane + VIN
  // and route the VIN to the scan handler (evaluating mid-burst split wrong)
  useEffect(() => {
    const t = setTimeout(() => {
      const m = /^(.*?)([A-HJ-NPR-Z0-9]{17})$/.exec(laneStr)
      // route with the LANE PART as an explicit override — the state update
      // hasn't landed yet, so the handler must not read laneStr itself
      if (m) { setLaneStr(m[1]); onLaneScan(m[2], m[1]) }
    }, 250)
    return () => clearTimeout(t)
  }, [laneStr]) // eslint-disable-line react-hooks/exhaustive-deps

  const onLaneScan = (v: string, laneOverride?: string) => {
    const L = laneOverride != null ? laneInfoOf(laneOverride) : laneCur
    if (!L.ready) { toast('err', 'ใส่แถวก่อน — Block + เลขช่อง เช่น A10'); return }
    let r = trackingRows.find(x => x.vin === v)
    if (!r && v.length <= 8) {
      const hits = trackingRows.filter(x => x.vin.endsWith(v))
      if (hits.length === 1) r = hits[0]
      else if (hits.length > 1) { toast('err', `พบ ${hits.length} คัน — พิมพ์ให้ยาวขึ้น`); return }
    }
    if (!r) { toast('err', wrongSite(v) ?? `ไม่พบ VIN: ${v}`); return }
    if (hasGoneOut(r.cells)) {
      blockGate2(r.vin, r.cells['Model name'] ?? r.cells['Model'] ?? '', 'รถออกจากลานแล้ว',
        <>รถคันนี้ <b style={{ color: '#dc2626' }}>Gate-out</b> ไปแล้ว จึงไม่มีตำแหน่งในลานให้ย้าย</>)
      return
    }
    if (!passGateGuard(r)) { blockGate(r.vin, r.cells['Model name'] ?? r.cells['Model'] ?? ''); return }
    const u = siteUnits.find(x => x.vin === r!.vin)
    // the same scan can reach here twice (wedge + debounce racing) before the
    // store re-renders — the second pass would double-place with stale data
    if (lastLaneHit.current.v === r.vin && Date.now() - lastLaneHit.current.at < 1500) return
    lastLaneHit.current = { v: r.vin, at: Date.now() }

    // ── the SCAN SEQUENCE is the lane order ─────────────────────────────────
    // 1st scan parks as คันที่ 1, 2nd as คันที่ 2, … — even a car already in
    // this lane moves to its scan position; cars in the lane NOT yet scanned
    // slide to the END (their relative order kept). The worker walks the row
    // scanning car after car and the system mirrors the physical order.
    const ord = laneOrderRef.current
    const dir = laneDirRef.current
    if (ord.includes(r.vin)) {
      const seq0 = dir === 'tail' ? [...ord].reverse() : ord
      toast('info', `ยิงคันนี้แล้ว — คันที่ ${seq0.indexOf(r.vin) + 1}`)
      return
    }
    const incumbents = L.cars.filter(x => !ord.includes(x.vin) && x.vin !== r!.vin)
    if (ord.length + 1 + incumbents.length > L.depth) {
      toast('err', `แถว ${L.blockId}${L.slot} เต็มแล้ว (${L.depth} คัน)`)
      return
    }
    ord.push(r.vin)
    // 'tail' = worker walks from the END of the row toward the front in one
    // pass, so the LATEST scan is always คันที่ 1 and earlier scans slide down
    const seq = dir === 'tail' ? [...ord].reverse() : ord
    const pos = seq.indexOf(r.vin) + 1
    // rebuild the whole lane: scanned cars at 1..k in direction order, then
    // the not-yet-scanned cars after them
    // The whole lane is rebuilt in ONE updateLocations batch (splitting it
    // breaks the rebuild's atomicity — cells collide mid-way). Incumbents come
    // from THIS device's view of the lane, which can be stale: another device
    // may have already relocated one of them elsewhere, and sliding it here
    // would silently teleport it back (the T5004→W0101 class of bug). So the
    // incumbent list is verified against the CLOUD first — only cars the cloud
    // still parks in this lane slide — then the batch applies. Offline (or no
    // cloud configured) keeps the old trust-local behavior.
    type LocUpdate = { vin: string; block: string; row: number; slot: number; modelName?: string; color?: string }
    const gen = ++laneGenRef.current
    const buildAndApply = (inc: typeof incumbents) => {
      if (gen !== laneGenRef.current) return // a newer scan supersedes this rebuild
      const updates: LocUpdate[] = []
      seq.forEach((vin, i) => {
        const cu = siteUnits.find(x => x.vin === vin)
        const row = i + 1
        if (cu && cu.block === L.blockId && cu.slot === L.slot && cu.row === row) return // already right
        const tr2 = vin === r!.vin ? r : trackingRows.find(x => x.vin === vin)
        updates.push({ vin, block: L.blockId, row, slot: L.slot,
          modelName: cu?.modelName || tr2?.cells['Model name'] || tr2?.cells['Model'] || undefined,
          color: cu?.color || tr2?.cells['Color'] || undefined })
      })
      inc.forEach((cu, i) => {
        const row = seq.length + 1 + i
        if (cu.block === L.blockId && cu.slot === L.slot && cu.row === row) return
        updates.push({ vin: cu.vin, block: L.blockId, row, slot: L.slot, modelName: cu.modelName, color: cu.color })
      })
      if (!updates.length) return
      updateLocations(updates)
      // every car the rebuild moves BESIDES the scanned one (a reordered
      // earlier scan, an incumbent sliding down) gets its own Location history
      // line — the silent slide made a car's position contradict its ประวัติการย้าย
      for (const up of updates) {
        if (up.vin === r!.vin) continue
        const cu = siteUnits.find(x => x.vin === up.vin)
        appendHistory(up.vin, {
          at: Date.now(), by: currentUser, field: 'Location', src: 'scan',
          from: cu ? yardLocFull(cu) : '',
          to: codeOf(L.blockId, L.slot, up.row),
        })
      }
    }
    if (!incumbents.length || !isConfigured()) buildAndApply(incumbents)
    else Promise.race([
      fetchUnitsByVins(incumbents.map(c => c.vin)),
      // flaky yard wifi must not stall the lane rebuild — after 2.5s fall back
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ])
      .then(cloud => buildAndApply(incumbents.filter(local => {
        const cu = cloud.find(x => x.vin === local.vin)
        return cu && cu.block && cu.slot === L.slot && blockKeyOfTag(cu.block) === L.blockId
      })))
      .catch(() => buildAndApply(incumbents)) // cloud unreachable — behave as before
    const code = codeOf(L.blockId, L.slot, pos)
    appendHistory(r.vin, {
      at: Date.now(), by: currentUser, field: 'Location', src: 'scan',
      from: u?.block && u.row && u.slot ? yardLocFull(u) : '',
      to: code,
    })
    recordRecent('reloc:save', r.vin, `ย้ายไป ${code}`)
    setLaneAdded(seq.map((vin, i) => ({ vin, code: codeOf(L.blockId, L.slot, i + 1) })))
    toast('ok', `${code} · คันที่ ${pos} · ${r.vin.slice(-6)} — ยิงคันถัดไปต่อได้เลย`)
  }

  const doSave = () => {
    if (!canSave || !row || nextRow === null) return
    // double-tap / double-Enter guard: `saved` state hasn't flushed yet when a
    // second event lands in the same frame — this ref has
    if (Date.now() - lastSaveGuard.current < 1200) return
    lastSaveGuard.current = Date.now()
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
      at: Date.now(), by: currentUser, field: 'Location', src: 'scan',
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
      {/* mode: move one car ↔ scan a whole lane (ยิงตามแถว) */}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => setMode('one')}
          className="py-2.5 rounded-xl text-[13px] font-bold transition"
          style={mode === 'one' ? { background: '#0ea5e9', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
          ทีละคัน
        </button>
        <button onClick={() => setMode('lane')}
          className="py-2.5 rounded-xl text-[13px] font-bold transition"
          style={mode === 'lane' ? { background: '#0ea5e9', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
          ยิงตามแถว
        </button>
      </div>

      {mode === 'lane' && (
        <div className="space-y-4 fade-up">
          <div className="panel p-4 space-y-2.5">
            <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>แถวปลายทาง (Block + เลขช่อง)</div>
            <input
              className="input w-full font-bold text-center text-[17px] uppercase tabular"
              placeholder="A10" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              value={laneStr}
              onChange={e => {
                const v = e.target.value.toUpperCase().replace(/\s+/g, '')
                setLaneStr(v)
                // reset the scan round only on a real lane edit — a handheld
                // burst appending a VIN here is NOT a lane change
                if (v === '' || parseLane(v)) { setLaneAdded([]); laneOrderRef.current = []; laneGenRef.current++ }
              }}
            />
            {laneReady ? (
              <div className="text-[12px] font-semibold flex items-center gap-1.5" style={{ color: '#0284c7' }}>
                <MapPin size={13} /> Block {laneBlockId} ช่อง {laneSlot} · มีรถ {laneCars.length}/{laneDepthMax} คัน
                {laneNextRow !== null
                  ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}>· คันถัดไปลงคันที่ {laneNextRow}</span>
                  : <span style={{ color: '#dc2626' }}>· แถวเต็มแล้ว</span>}
              </div>
            ) : laneStr.trim() ? (
              <div className="text-[12px] font-semibold flex items-center gap-1.5" style={{ color: '#dc2626' }}>
                <AlertTriangle size={13} />
                {!laneParsed ? 'รูปแบบไม่ถูกต้อง — พิมพ์ Block ตามด้วยเลขช่อง เช่น A10'
                  : !laneBlockOk ? `ไม่มี Block ${laneParsed.block} ในผังลานนี้`
                  : laneBlk ? `Block ${blockTag(laneBlk)} มีช่อง 1–${laneBlk.cols}` : 'เลขช่องไม่ถูกต้อง'}
              </div>
            ) : (
              <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
                ใส่แถวครั้งเดียว แล้วสแกน/พิมพ์วินทีละคันจนครบ — รถต่อท้ายคันที่มีอยู่ในแถวอัตโนมัติ
              </div>
            )}

            {/* walking direction — tail mode lets the worker loop the row once
                without walking back to the head before scanning */}
            <div className="grid grid-cols-2 gap-2 pt-0.5">
              <button onClick={() => switchLaneDir('head')}
                className="py-2 rounded-xl text-[12px] font-bold transition"
                style={laneDir === 'head' ? { background: '#16a34a', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
                ยิงจากหัวแถว
                <div className="text-[10px] font-medium" style={{ opacity: 0.85 }}>คันแรกที่ยิง = คันที่ 1</div>
              </button>
              <button onClick={() => switchLaneDir('tail')}
                className="py-2 rounded-xl text-[12px] font-bold transition"
                style={laneDir === 'tail' ? { background: '#dc2626', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
                ยิงจากท้ายแถว
                <div className="text-[10px] font-medium" style={{ opacity: 0.85 }}>คันล่าสุดที่ยิง = คันที่ 1</div>
              </button>
            </div>
          </div>

          {/* autoFocus off: this input MOUNTS the moment the lane string turns
              valid ("A1" while typing "A12") — grabbing focus mid-keystroke
              yanked the cursor out of the lane field */}
          {laneReady && <VinInput onScan={onLaneScan} accent="#0ea5e9" autoFocus={false} />}

          {/* live view of the lane, depth order — just-scanned cars highlighted */}
          {laneReady && (laneCars.length > 0 || laneAdded.length > 0) && (
            <div className="panel overflow-hidden fade-up">
              <div className="px-4 py-2.5 border-b hairline text-[12px] font-bold" style={{ background: 'var(--chip)' }}>
                รถในแถว {laneBlockId}{laneSlot} ({laneCars.length}/{laneDepthMax})
                {laneAdded.length > 0 && <span className="ml-1.5" style={{ color: '#16a34a' }}>· ยิงรอบนี้ {laneAdded.length} คัน</span>}
              </div>
              <div className="divide-y max-h-[45vh] overflow-y-auto" style={{ borderColor: 'var(--line)' }}>
                {laneCars.map(u => {
                  const fresh = laneAdded.some(a => a.vin === u.vin)
                  const tr = trackingRows.find(x => x.vin === u.vin)
                  const color = u.color || tr?.cells['Color'] || '—'
                  // who recorded this car's LAST move and when — the same trail
                  // the single-car mode's ประวัติการย้าย shows
                  const lastMove = [...(tr?.history ?? [])].filter(e => e.field === 'Location' || e.field === LOCATION_KEY).pop()
                  return (
                    <div key={u.vin} className="px-4 py-2 flex items-center gap-3"
                      style={fresh ? { background: 'rgba(22,163,74,0.07)' } : undefined}>
                      <span className="tabular font-bold text-[13px] shrink-0" style={{ color: '#0284c7', width: 30 }}>{u.row}</span>
                      <div className="min-w-0 flex-1">
                        <div className="vin text-[12.5px] font-bold clip">{u.vin}</div>
                        <div className="text-[11px] flex flex-wrap gap-x-1.5" style={{ color: 'var(--muted)' }}>
                          <span>{u.modelName || '—'}</span><span>· {color}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        {lastMove ? (
                          <div className="text-[10.5px] leading-tight" style={{ color: 'var(--muted)' }}>
                            <div className="font-semibold" style={{ color: fresh ? '#16a34a' : 'var(--text)' }}>{lastMove.by || '—'}</div>
                            <div className="tabular">{fmtCheckedAt(lastMove.at)}</div>
                          </div>
                        ) : (
                          <span className="text-[10.5px]" style={{ color: 'var(--faint)' }}>—</span>
                        )}
                      </div>
                      {fresh && <CheckCircle2 size={15} className="shrink-0" style={{ color: '#16a34a' }} />}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'one' && <VinInput onScan={onScan} accent="#0ea5e9" />}
      {gateModal}
      {mode === 'one' && !row && <RecentPanel station="reloc" accent="#0ea5e9" onPick={onScan} />}
      {mode === 'one' && row && (
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
            {/* who recorded the position last, and when — the latest Location move */}
            {moves[0] && (() => {
              const d = new Date(moves[0].at)
              const p2 = (n: number) => String(n).padStart(2, '0')
              return (
                <div className="text-[11.5px] mt-1 flex items-center gap-x-2 flex-wrap" style={{ color: 'var(--muted)' }}>
                  <span className="flex items-center gap-1"><User size={11} /> บันทึกโดย <b style={{ color: 'var(--text)' }}>{moves[0].by || '—'}</b></span>
                  <span className="flex items-center gap-1"><Clock size={11} /> {p2(d.getDate())}/{p2(d.getMonth() + 1)}/{d.getFullYear()} {p2(d.getHours())}:{p2(d.getMinutes())}</span>
                </div>
              )
            })()}
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
function UpdateDamageView({ accent = '#dc2626', stationName = 'Update Damage', source = 'update', recentKey = 'damage', richCard = false }:
  { accent?: string; stationName?: string; source?: DamageSource; recentKey?: string; richCard?: boolean } = {}) {
  const units = useSiteUnits()
  const trackingRows = useSiteRows()
  const wrongSite = useWrongSiteHint()
  const { loadFromIdb } = useTracking()
  const { addDamage, updateRepairStatus, toast, loadFromSupabase } = useYard()
  const { block: blockGate, modal: gateModal } = useNotGatedIn()
  const [vin, setVin] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const unit = vin ? units.find(u => u.vin === vin) ?? null : null
  const trackRow = vin ? trackingRows.find(r => r.vin === vin) ?? null : null
  const damages = unit?.damages ?? []

  // this scanned car's local copy has a defect with no photo at all — that's
  // an IndexedDB boot-cache stub racing a cloud fetch that hasn't landed yet,
  // not a real defect (every saved one has ≥1 photo). Self-heal it directly
  // instead of waiting on the site-wide load to eventually catch up.
  useEffect(() => {
    if (unit && hasPhotolessDamage(unit)) fetchUnitPhotoHeal(unit.vin)
  }, [unit])

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
    recordRecent(`${recentKey}:search`, found)
  }

  const fmt = (ts: number) => {
    const d = new Date(ts)
    return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
  }

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent={accent} />
      {gateModal}
      {!vin && <RecentPanel station={recentKey} accent={accent} onPick={onScan} />}

      {/* full car card (top-view + VIN/Model/Color/ผู้ตรวจ/เวลา) — same card
          Gate-in shows, once the unit has synced. Falls through to the compact
          panel below when only the tracking row has landed so far. */}
      {richCard && unit && vin ? (
        <div className="space-y-3 fade-up">
          <UnitCard unit={unit} accent={accent} />
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-semibold flex items-center gap-1.5">
                <AlertTriangle size={14} style={{ color: accent }} />
                Damage {damages.length > 0 && <span className="badge" style={{ color: accent, background: accent + '14' }}>{damages.length}</span>}
              </span>
              <button onClick={() => setShowAdd(v => !v)}
                className="btn btn-ghost text-[12px] py-1 px-2.5" style={{ color: accent }}>
                <Plus size={13} /> add damage
              </button>
            </div>
            {showAdd && (
              <div className="mb-2">
                <DamageForm
                  key={vin}
                  onSaveAll={dmgs => {
                    dmgs.forEach(d => addDamage(unit.vin, { ...d, source, station: stationName }))
                    recordRecent(`${recentKey}:save`, unit.vin, dmgs.length > 1 ? `บันทึก Defect ${dmgs.length} รายการ` : 'บันทึก Defect 1 รายการ')
                    setShowAdd(false)
                    toast('ok', dmgs.length > 1 ? `บันทึก Defect ${dmgs.length} รายการ` : 'บันทึก Defect แล้ว')
                  }}
                  onCancel={() => setShowAdd(false)}
                />
              </div>
            )}
            {damages.length > 0 && (
              <div className="space-y-2">
                {openDefectsFirst(damages).map(d => (
                  <DefectCard key={d.id} d={d}
                    right={<DefectStatusSelect d={d} onChange={s => updateRepairStatus(vin, d.id, s)} />} />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (unit || trackRow) && vin && (
        <div className="panel overflow-hidden fade-up">
          {/* header */}
          <div className="px-4 py-3 border-b hairline flex items-center gap-2" style={{ background: accent + '0d' }}>
            <AlertTriangle size={15} style={{ color: accent }} />
            <div className="flex-1 min-w-0">
              <div className="vin text-[13px] font-bold truncate">{vin}</div>
              <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                {unit?.modelName ?? trackRow?.cells['Model name'] ?? '—'}
              </div>
            </div>
            <span className="badge font-bold" style={{ background: damages.length > 0 ? accent + '1a' : 'rgba(22,163,74,0.1)', color: damages.length > 0 ? accent : '#16a34a' }}>
              {damages.length > 0 ? `${damages.length} damage` : 'OK'}
            </span>
          </div>

          {/* existing damages */}
          {damages.length > 0 && (
            <div className="p-3 space-y-2">
              {openDefectsFirst(damages).map(d => (
                <DefectCard key={d.id} d={d}
                  right={<DefectStatusSelect d={d} onChange={s => updateRepairStatus(vin, d.id, s)} />} />
              ))}
            </div>
          )}

          {/* add new damage form — same dropdowns / photos / remark as Gate-in */}
          {showAdd ? (
            <div className="border-t hairline p-3" style={{ background: accent + '08' }}>
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
                  dmgs.forEach(d => addDamage(unit.vin, { ...d, source, station: stationName }))
                  recordRecent(`${recentKey}:save`, unit.vin, dmgs.length > 1 ? `บันทึก Defect ${dmgs.length} รายการ` : 'บันทึก Defect 1 รายการ')
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
                style={{ background: accent + '14', color: accent, border: `1px dashed ${accent}4d` }}>
                <Plus size={15} /> เพิ่มความเสียหาย
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── CheckView's own layout helpers — hoisted to module scope ────────────────
// These used to be declared INSIDE CheckView's render body. A component
// defined inside another component's render is a NEW function identity every
// render, so React treats it as a different element TYPE each time and
// unmounts + remounts the whole subtree under it — including any DefectCard
// with an open PhotoLightbox. CheckView calls the un-selectored `useYard()`
// (subscribes to the ENTIRE store), so literally ANY store change anywhere
// in the app — an unrelated toast, a background sync, anything — re-rendered
// it and silently closed a photo the operator was just looking at, with zero
// interaction from them ("คลิ๊กที่รูปเพื่อดูรูป รูปแสดงขึ้นมา สักพักแล้ว
// รูปปิดไปเอง ... ไม่ได้แตะอะไรเลย").
function CheckSec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-4 py-2 text-[10.5px] font-bold uppercase tracking-wider"
        style={{ background: 'var(--chip)', color: 'var(--muted)' }}>{title}</div>
      {children}
    </div>
  )
}
function CheckRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-center px-4 py-2.5 gap-3 border-b hairline">
      <span className="text-[11.5px] shrink-0" style={{ color: 'var(--muted)', width: 96 }}>{label}</span>
      <span className="text-[12.5px] font-semibold flex-1 text-right" style={accent ? { color: accent } : {}}>{value}</span>
    </div>
  )
}
// one line in a station's driver/inspector timeline
function CheckHistLine({ icon, label, who, time, color }: { icon: React.ReactNode; label: string; who: string; time?: number; color: string }) {
  const timeLabel = time != null
    ? (() => { const d = new Date(time); return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}` })()
    : null
  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      <span style={{ color }} className="shrink-0 flex">{icon}</span>
      <span className="shrink-0" style={{ color: 'var(--muted)', width: 82 }}>{label}</span>
      <span className="font-semibold flex-1 truncate">{who}</span>
      {timeLabel && <span className="text-[10.5px] shrink-0" style={{ color: 'var(--faint)' }}>{timeLabel}</span>}
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
  const columns = useTracking(s => s.columns)
  const { toast, loadFromSupabase } = useYard()
  const [vin, setVin] = useState<string | null>(null)
  const [ctab, setCtab] = useState<'info' | 'location' | 'work' | 'event'>('info')

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
    setCtab('info')
    recordRecent('check:search', found)
    // refresh from the cloud so defects recorded moments ago on another
    // device (PDI tablet) appear on this scan, not the next app restart
    loadFromSupabase().catch(() => {})
  }

  // Work checklist + Event log — the SAME data the admin Unit detail shows,
  // built by the shared lib so หน้างาน reads the identical history
  const workData = row ? buildWorkRows(row, unit ?? undefined, columns) : null
  const eventLog = row ? buildEventLog(row, unit?.damages ?? [], queues, row.vin, zoneLabel) : []
  // movement history: sheet yard-moves (Move from → Transfer) + in-yard position
  // moves from Re-location / Update Location (who + when)
  const sheetMoves: { from: string; to: string }[] = []
  if (row) for (let i = 1; i <= 4; i++) {
    const from = row.cells[`Move from  ${i}`] || '', to = row.cells[`Transfer ${i}`] || ''
    if (from || to) sheetMoves.push({ from, to })
  }
  const posMoves = row ? histOf(row, columns, LOCATION_KEY, 'Location') : []

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

  return (
    <div className="space-y-4">
      <VinInput onScan={onScan} accent="#0891b2" />
      {!vin && <RecentPanel station="check" accent="#0891b2" onPick={onScan} />}

      {/* tabs — ข้อมูล / Work / Event, same history the admin detail shows */}
      {(row || unit) && vin && (
        <div className="flex gap-1.5">
          {([['info', 'ข้อมูล'], ['location', 'Location'], ['work', `Work${workData ? ` ${workData.done}/${workData.rows.length}` : ''}`], ['event', `Event${eventLog.length ? ` ${eventLog.length}` : ''}`]] as ['info' | 'location' | 'work' | 'event', string][]).map(([id, label]) => (
            <button key={id} onClick={() => setCtab(id)}
              className="flex-1 py-2 rounded-xl text-[12.5px] font-bold transition"
              style={ctab === id ? { background: '#0891b2', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── Location tab — current position + every move ── */}
      {(row || unit) && vin && ctab === 'location' && (
        <div className="panel p-4 fade-up space-y-2.5">
          {/* current position first — what the driver actually walks to */}
          <div className="rounded-xl px-3.5 py-3 flex items-center gap-2.5" style={{ background: 'rgba(8,145,178,0.08)', border: '1px solid rgba(8,145,178,0.2)' }}>
            <MapPin size={16} style={{ color: '#0891b2' }} />
            <div>
              <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>ตำแหน่งปัจจุบัน</div>
              <div className="text-[15px] font-extrabold tabular" style={{ color: '#0891b2' }}>
                {(unit && yardLocFull(unit)) || row?.cells['Location yard'] || '—'}
                {unit && yardLocFull(unit) && row?.cells['Location yard'] ? <span className="text-[11.5px] font-semibold ml-1.5" style={{ color: 'var(--muted)' }}>· {row.cells['Location yard']}</span> : null}
              </div>
            </div>
          </div>
          {sheetMoves.length === 0 && posMoves.length === 0 ? (
            <div className="py-4 text-center text-[12.5px]" style={{ color: 'var(--faint)' }}>— ไม่มีประวัติการย้าย —</div>
          ) : (
            <div className="space-y-2">
              {sheetMoves.map((m, i) => (
                <div key={i} className="flex items-center gap-2 text-[13px]">
                  <span className="badge" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>{i + 1}</span>
                  <span className="font-medium">{m.from || '—'}</span>
                  <ArrowRight size={13} style={{ color: 'var(--faint)' }} />
                  <span className="font-medium" style={{ color: '#0891b2' }}>{m.to || '—'}</span>
                </div>
              ))}
              {posMoves.map((h, i) => (
                <div key={`p${i}`} className="text-[13px]">
                  <div className="flex items-center gap-2">
                    <span className="badge" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>{sheetMoves.length + i + 1}</span>
                    <span className="font-medium tabular">{h.from || '—'}</span>
                    <ArrowRight size={13} style={{ color: 'var(--faint)' }} />
                    <span className="font-medium tabular" style={{ color: '#0891b2' }}>{h.to || '—'}</span>
                  </div>
                  <div className="text-[11px] mt-0.5 pl-8" style={{ color: 'var(--faint)' }}>{fmtHistAt(h.at)} · {h.by || '—'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Work tab — the car's whole workflow with dates / status / user ── */}
      {(row || unit) && vin && ctab === 'work' && workData && (
        <div className="panel overflow-hidden fade-up">
          <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {workData.rows.map((w, i) => (
              <div key={w.code} className="px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-[11px] font-bold tabular shrink-0" style={{ color: 'var(--faint)', width: 18 }}>{i + 1}</span>
                  <span className="text-[11.5px] font-bold tabular shrink-0" style={{ color: '#0891b2', width: 34 }}>{w.code}</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-semibold">{w.name}</span>
                    {w.value && <span className="ml-1.5 tabular font-bold text-[13px]" style={{ color: '#0891b2' }}>{w.value}</span>}
                    {w.note && <span className="ml-1.5 text-[10.5px]" style={{ color: 'var(--faint)' }}>{w.note}</span>}
                  </div>
                  {w.done
                    ? <span className="inline-flex w-5 h-5 rounded-full items-center justify-center shrink-0" style={{ background: '#16a34a' }}><Check size={13} color="#fff" strokeWidth={3} /></span>
                    : <span className="inline-flex w-5 h-5 rounded-full items-center justify-center shrink-0" style={{ background: '#ef4444' }}><X size={12} color="#fff" strokeWidth={3} /></span>}
                </div>
                {(w.date || w.user) && (
                  <div className="text-[11px] mt-0.5 pl-[52px]" style={{ color: 'var(--muted)' }}>
                    {w.date || '—'}{w.user ? ` · ${w.user}` : ''}
                  </div>
                )}
                {/* SOC / Tire Pressure — every recorded value */}
                {w.sub && w.sub.length > 0 && (
                  <div className="mt-1 pl-[52px] space-y-0.5">
                    {[...w.sub].reverse().map((v, vi) => (
                      <div key={vi} className="flex items-baseline gap-2 text-[11.5px]">
                        <span className="font-bold tabular">{v.value}</span>
                        <span className="ml-auto text-right" style={{ color: 'var(--faint)' }}>
                          {v.at ? fmtHistAt(v.at) : 'จากไฟล์นำเข้า'}{v.by ? ` · ${v.by}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Event tab — every recorded action, newest first ── */}
      {(row || unit) && vin && ctab === 'event' && (
        <div className="panel overflow-hidden fade-up">
          {eventLog.length === 0 ? (
            <div className="py-8 text-center text-[12.5px]" style={{ color: 'var(--faint)' }}>— ไม่มีเหตุการณ์ —</div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
              {eventLog.map((e, i) => (
                <div key={i} className="px-3.5 py-2.5">
                  <div className="text-[12.5px] leading-snug" style={e.accent ? { color: e.accent, fontWeight: 600 } : undefined}>{e.text}</div>
                  <div className="text-[11px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--muted)' }}>
                    {e.station && <span className="badge" style={{ background: 'var(--chip)', color: 'var(--muted)', fontSize: 10 }}>{e.station}</span>}
                    <span>{fmtHistAt(e.at)}</span><span>· {e.by || '—'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(row || unit) && vin && ctab === 'info' && (
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
          <CheckSec title="ข้อมูลรถ">
            <CheckRow label="Model"       value={model} />
            {row?.cells['company']   && <CheckRow label="Company"  value={row.cells['company']} />}
            {(unit?.color || row?.cells['Color']) && <CheckRow label="Color" value={unit?.color ?? row?.cells['Color'] ?? '—'} />}
            {row?.cells['Lot transfer'] && <CheckRow label="Lot" value={row.cells['Lot transfer']} />}
            {row?.cells['moving date']  && <CheckRow label="Moving Date" value={row.cells['moving date']} />}
            {/* always shown — the gate uses this screen to CHECK whether the car
                has an allocation yet, so an empty date must read "—", not vanish */}
            {row && <CheckRow label="Allocation Date" value={row.cells['Allocation Date']?.trim() || '—'} />}
            {row?.cells['Grouping  Number'] && <CheckRow label="Group No." value={row.cells['Grouping  Number']} />}
          </CheckSec>

          {/* ── Route ── */}
          {(row?.cells['From'] || row?.cells['To']) && (
            <CheckSec title="เส้นทาง">
              <div className="flex items-center gap-2 mx-4 my-2.5 rounded-2xl px-3.5 py-2.5"
                style={{ background: 'rgba(37,99,235,0.07)', border: '1px solid rgba(37,99,235,0.14)' }}>
                <MapPin size={13} style={{ color: '#2563eb', flexShrink: 0 }} />
                <span className="text-[12.5px] font-bold" style={{ color: '#1d4ed8' }}>{row?.cells['From'] ?? '—'}</span>
                <ArrowRight size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <span className="text-[12.5px] font-bold flex-1 truncate" style={{ color: '#1d4ed8' }}>{row?.cells['To'] ?? '—'}</span>
              </div>
            </CheckSec>
          )}

          {/* ── Gate-in / Location ── */}
          <CheckSec title="Gate-in / ตำแหน่ง">
            {row?.cells['Gate In (Rayong yard)'] && <CheckRow label="Gate In Date" value={row.cells['Gate In (Rayong yard)']} />}
            {row?.cells['Gate In Inspector']      && <CheckRow label="ผู้ตรวจรับ"  value={row.cells['Gate In Inspector']} />}
            {row?.cells['Gate Out time stamp']     && <CheckRow label="Gate Out"    value={row.cells['Gate Out time stamp']} />}
            {(unit?.block || row?.cells['Location yard'] || row?.cells['storage Yard']) && (
              <CheckRow label="Location" value={yardLocFull(unit) || row?.cells['Location yard'] || row?.cells['storage Yard'] || '—'} />
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
          </CheckSec>

          {/* ── Status / Damage ── */}
          <CheckSec title="สถานะ / ความเสียหาย">
            {row?.cells['Final Status'] && <CheckRow label="Final Status" value={row.cells['Final Status']} />}
            {row?.cells['Status']       && <CheckRow label="Status (Excel)" value={row.cells['Status']} />}
            {row?.cells['PIC (PDI)']    && <CheckRow label="PIC (PDI)" value={row.cells['PIC (PDI)']} />}
            <CheckRow label="Damage" value={damaged ? 'NG — มี Defect' : 'OK — ปกติ'} accent={damaged ? '#dc2626' : '#16a34a'} />
            {/* same DefectCard as Gate-in: bilingual labels, photo strip with
                full-screen lightbox, and a read-only repair-status badge */}
            {unit && unit.damages.length > 0 && (
              <div className="p-3 space-y-2">
                {openDefectsFirst(unit.damages).map(d => (
                  <DefectCard key={d.id} d={d} right={
                    <span className="font-bold rounded-lg px-2.5 py-1.5 whitespace-nowrap shrink-0"
                      style={{ ...defectStatusStyle(d.statusRepair || 'Waiting Repair'), fontSize: 11.5 }}>
                      {d.statusRepair || 'Waiting Repair'}
                    </span>
                  } />
                ))}
              </div>
            )}
          </CheckSec>

          {/* ── Station work + driver history (per station) ── */}
          {vinQueues.length > 0 && (
            <CheckSec title="งานสถานี · ประวัติคนขับ">
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
                    {item.deliveredBy && <CheckHistLine icon={<Car size={13} />} label="ส่งเข้าสถานี" who={item.deliveredBy} time={item.deliveredAt} color="var(--st-yard)" />}
                    {item.checkedBy && <CheckHistLine icon={<ShieldCheck size={13} />} label={`ตรวจ · ${item.result ?? ''}`} who={item.checkedBy} time={item.checkedAt} color="#7c3aed" />}
                    {item.returnedBy && <CheckHistLine icon={<Car size={13} />} label="นำกลับไปจอด" who={item.returnedBy} time={item.returnedAt} color="var(--st-yard)" />}
                    {!item.deliveredBy && !item.checkedBy && !item.returnedBy && (
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                        {item.done ? <>✓ เสร็จแล้ว{item.doneBy ? ` · ${item.doneBy}` : ''}</> : '⏳ ยังไม่เริ่ม'}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </CheckSec>
          )}

          {/* ── Driver Trips ── */}
          {vinTrips.length > 0 && (
            <CheckSec title={`ประวัติการขับ (${vinTrips.length} ครั้ง)`}>
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
            </CheckSec>
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

  // pending-work count per station menu — the iOS-style red badge on each tile
  const queues = useSiteQueues()
  const trackingRows = useSiteRows()
  const menuBadges = useMemo(() => {
    const n: Partial<Record<RoleKey, number>> = {}
    const add = (k: RoleKey, v: number) => { if (v > 0) n[k] = (n[k] ?? 0) + v }
    const queuedPreGateInVins = new Set<string>()
    for (const q of queues) if (isPreGateInQueue(q.name)) for (const i of q.items) queuedPreGateInVins.add(i.vin)
    for (const q of queues) {
      if (isQueueComplete(q)) continue
      if (isSequenceQueue(q)) {
        // delivery run: cars not yet gated out → Gate-out; not yet at their
        // loading lane → Driver still has moves to make
        add('gateout', q.items.filter(i => !i.done && !i.gatedOut).length)
        add('driver', q.items.filter(i => !i.done && !i.atLaneAt).length)
        continue
      }
      if (isPreGateInQueue(q.name)) { add('walk', q.items.filter(i => !i.done).length); continue }
      const t = queueTypeOf(q)
      // the station's own count: cars whose check hasn't been recorded yet
      const unchecked = q.items.filter(i => !i.done && stageOf(i) !== 'checked').length
      if (t === 'PDI') add('pdi', unchecked)
      else if (t === 'PM') add('pm', unchecked)
      else if (t === 'FINAL') add('fc', unchecked)
      // ช่าง (ซ่อม) and งานพิเศษ queues both land at the mechanic station
      else if (t === 'REPAIR' || t === 'SPECIAL') add('mechanic', unchecked)
      // the driver moves cars in (queued) and back out (checked)
      add('driver', q.items.filter(i => !i.done && (stageOf(i) === 'queued' || stageOf(i) === 'checked')).length)
    }
    // same safety net as the Gate-in station's own list (and the admin Gate
    // In/Out board): a Pre Gate-in row with no queue at all must still count,
    // or this badge undercounts against both the in-station list and the
    // Dashboard's sitewide Pre Gate-in tally
    add('walk', trackingRows.filter(r => !queuedPreGateInVins.has(r.vin) && deriveCarStatus(r.cells) === 'Pre Gate-in').length)
    return n
  }, [queues, trackingRows])

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
                className="panel p-5 text-left flex flex-col gap-3 transition-all hover:shadow-md active:scale-95 relative"
                style={{ touchAction: 'manipulation' }}
              >
                {/* pending-work badge — iOS-style red count, top-right of the tile */}
                {(menuBadges[r.key] ?? 0) > 0 && (
                  <span className="absolute flex items-center justify-center font-bold text-white tabular"
                    style={{ top: 10, right: 10, minWidth: 24, height: 24, borderRadius: 12, padding: '0 7px',
                      fontSize: 12.5, background: '#ef4444', boxShadow: '0 2px 8px -2px rgba(239,68,68,0.6)' }}>
                    {menuBadges[r.key]! > 999 ? '999+' : menuBadges[r.key]}
                  </span>
                )}
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
      {role === 'walkcheck'  && <UpdateDamageView accent="#0d9488" stationName="Walk Around Check" source="walkcheck" recentKey="walkcheck" richCard />}
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
