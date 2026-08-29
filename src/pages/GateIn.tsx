import { useEffect, useMemo, useRef, useState } from 'react'
import { ScanLine, LogOut, ChevronDown, ChevronRight, CheckCircle2, Clock, Calendar, X, ClipboardList, ListChecks, ListPlus, Trash2, Pencil, Archive, ArchiveRestore, MoveRight } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { PageHead, cx } from '../components/ui'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { useActiveQueues, useOps, queueProgress, isSequenceQueue, isQueueComplete, isPreGateInQueue, gateInArrived, gateInPendingItems } from '../store/useOps'
import type { WorkQueue } from '../store/useOps'
import { deriveCarStatus, CAR_STATUS_META } from '../lib/carStatus'
import { rowInSite } from '../lib/siteScope'
import { MONTH_ABBR, parseLooseDate, dateKey, todayKey, fmtDateTh, gateInDateKey, gateOutDateKey } from '../lib/dayKey'
import { SeqQueuePicker } from '../components/SeqQueueList'
import type { TrackRow } from '../lib/excelTracking'
import { matchVins } from '../lib/findCar'

// keep re-export so UnitDetail.tsx can still import it from here
export { zoneLabel } from '../components/CarDiagramMultiView'

// ── Group rows by Grouping Number (or Lot) ──
interface Group {
  key: string
  rows: TrackRow[]
  total: number
  preGateIn: number
  gateIn: number
  gateOut: number
  lastUpdated: number
}

// "Gate-in" is retired as its own status — a car counts as gated-in the moment
// it's no longer Pre Gate-in, whether it's since progressed to In Yard/Moving/
// PDI/Ready/Preload/Pre Gate-out or already left. Reading the raw Car Status
// cell for the literal string "Gate-in" (the old approach) undercounted every
// lot whose cars had moved past that stage — this partitions every row into
// exactly one of the three buckets via the derived status instead.
function buildGroups(rows: TrackRow[]): Group[] {
  const map = new Map<string, TrackRow[]>()
  for (const r of rows) {
    const key = r.cells['Grouping  Number'] || r.cells['Lot transfer'] || 'ไม่ระบุ'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  return [...map.entries()]
    .map(([key, rows]) => ({
      key,
      rows,
      total: rows.length,
      preGateIn: rows.filter((r) => deriveCarStatus(r.cells) === 'Pre Gate-in').length,
      gateIn:    rows.filter((r) => { const s = deriveCarStatus(r.cells); return s !== 'Pre Gate-in' && s !== 'Gate-out' }).length,
      gateOut:   rows.filter((r) => deriveCarStatus(r.cells) === 'Gate-out').length,
      lastUpdated: Math.max(...rows.map((r) => r.updatedAt ?? 0)),
    }))
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
}

// shares the app-wide status colours (carStatus.ts) instead of a separate
// palette here, so a car reads the same colour on this board as everywhere else
const ss = (s: string): { bg: string; c: string } => {
  const m = CAR_STATUS_META[s]
  return m ? { bg: m.bg, c: m.color } : { bg: '#fef9c3', c: '#854d0e' }
}
/** 3-bucket ordering for this board's lists: arrived (still on-site, any stage)
 *  first, departed second, not-yet-arrived last. */
const statusOrd = (c: Record<string, string>): number => {
  const s = deriveCarStatus(c)
  return s === 'Pre Gate-in' ? 2 : s === 'Gate-out' ? 1 : 0
}

/** The day a work queue belongs to — parsed from its name (the batch's own date),
 *  falling back to when it was created:
 *   - Pre Gate-in   "(yard · M-D · count)"  → M-D
 *   - Grouping-Dealer "… Date 09 July 2026" → that date */
function queueDateKey(q: WorkQueue): string {
  let m = q.name.match(/·\s*(\d{1,2})-(\d{1,2})\s*·/)
  if (m) return dateKey(new Date(new Date(q.createdAt).getFullYear(), +m[1] - 1, +m[2]))
  m = q.name.match(/Date\s+(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/)
  if (m) { const mon = MONTH_ABBR[m[2].slice(0, 3).toLowerCase()]; if (mon !== undefined) return dateKey(new Date(+m[3], mon, +m[1])) }
  return dateKey(new Date(q.createdAt))
}

/** Which day's board does a work queue belong to?
 *  - Latest overview (null) or today: unfinished queues carry forward day to day;
 *    a finished queue drops off — unless its own date is today (today's work).
 *  - A past date: the queue is filed under its own date, done or not.
 *  Applies to every queue (Pre Gate-in, Grouping-to-Dealer, Ops Scan). */
function queueOnDate(q: WorkQueue, filterDate: string | null, closed: boolean): boolean {
  const qKey = queueDateKey(q)
  const complete = isQueueComplete(q)
  const today = todayKey()
  // an archived lot leaves the LIVE board but is still there on its own day, so
  // closing is reversible and nothing is lost from the record
  if (filterDate == null || filterDate === today) return !closed && (!complete || qKey === today)
  return qKey === filterDate
}

// ── Progress card for one Lot/Group ──
function GroupCard({ group, mode, dateFilter }: { group: Group; mode: 'in' | 'out'; dateFilter: string | null }) {
  const [open, setOpen] = useState(false)
  const accent = mode === 'in' ? 'var(--brand-2)' : 'var(--st-yard)'

  // ── history mode: which VINs of this lot moved on the selected day ──
  const dateRows = useMemo(() => {
    if (!dateFilter) return null
    const keyFn = mode === 'in' ? gateInDateKey : gateOutDateKey
    return group.rows.filter((r) => keyFn(r) === dateFilter)
  }, [group.rows, mode, dateFilter])

  const ginCurrent = group.gateIn + group.gateOut
  const ginPct     = group.total > 0 ? Math.round((ginCurrent / group.total) * 100) : 0
  const goutBase   = group.gateIn + group.gateOut
  const goutPct    = goutBase > 0 ? Math.round((group.gateOut / goutBase) * 100) : 0

  const done    = mode === 'in' ? group.preGateIn === 0 : group.gateIn === 0
  const pct     = mode === 'in' ? ginPct : goutPct
  const current = mode === 'in' ? ginCurrent : group.gateOut
  const total   = mode === 'in' ? group.total : goutBase
  const pending = mode === 'in' ? group.preGateIn : group.gateIn

  const visibleRows = mode === 'out'
    ? group.rows.filter((r) => deriveCarStatus(r.cells) !== 'Pre Gate-in')
    : group.rows

  // ── history mode: compact card — just the day's count + VIN list, no live progress bar ──
  if (dateFilter) {
    const rows = dateRows!
    if (rows.length === 0) return null // nothing happened in this lot that day
    // show the WHOLE lot (every VIN that must gate in), not just that day's —
    // gated-in first → still-pending → gated-out; that day's rows are dot-marked.
    const todayVins = new Set(rows.map((r) => r.vin))
    const listRows = (mode === 'in' ? group.rows : visibleRows).slice().sort((a, b) => statusOrd(a.cells) - statusOrd(b.cells))
    return (
      <div className="panel overflow-hidden">
        <button className="w-full p-4 text-left" onClick={() => setOpen((o) => !o)}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-[13.5px] truncate">{group.key}</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{group.total.toLocaleString()} คันในลอตนี้ · วันนี้ {mode === 'in' ? 'เข้า' : 'ออก'} {rows.length}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="badge flex items-center gap-1 tabular"
                title={`${mode === 'in' ? 'เข้าลานแล้ว' : 'ออกแล้ว'} ${current}/${group.total} คัน · วันนี้ ${rows.length}`}
                style={{ background: mode === 'in' ? '#dbeafe' : '#dcfce7', color: mode === 'in' ? '#1e40af' : '#166534' }}>
                {mode === 'in' ? 'เข้า' : 'ออก'} {current.toLocaleString()}/{group.total.toLocaleString()}
              </span>
              {open
                ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} />
                : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
            </div>
          </div>
        </button>
        {open && (
          <div className="border-t hairline max-h-[360px] overflow-y-auto">
            {listRows.map((r) => {
              const status = deriveCarStatus(r.cells)
              const { bg, c } = ss(status)
              const dateVal = mode === 'in' ? (r.cells['Gate In (Rayong yard)'] || '') : (r.cells['Gate Out time stamp'] || '')
              const today = todayVins.has(r.vin)
              return (
                <div key={r.vin} className="flex items-center gap-3 px-4 py-2 border-b hairline last:border-0" style={today ? { background: '#eff6ff' } : undefined}>
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: c }} />
                  <span className="vin text-[12px]" style={{ minWidth: 170 }}>{r.vin}</span>
                  <span className="text-[11px] clip flex-1" style={{ color: 'var(--muted)', minWidth: 0 }}>
                    {r.cells['Model name'] || r.cells['Model'] || ''}
                  </span>
                  <span className="text-[11px] shrink-0 tabular" style={{ color: 'var(--muted)', minWidth: 130 }}>
                    {dateVal || '—'}
                  </span>
                  {mode === 'in' && (
                    <span className="text-[11px] shrink-0" style={{ color: 'var(--muted)', minWidth: 70 }}>
                      {r.cells['Gate In Inspector'] || '—'}
                    </span>
                  )}
                  <span className="badge shrink-0"
                    style={{ fontSize: 10, background: bg, color: c }}>{status}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="panel overflow-hidden">
      <button className="w-full p-4 text-left" onClick={() => setOpen((o) => !o)}>
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="min-w-0">
            <div className="font-semibold text-[13.5px] truncate">{group.key}</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{group.total} คัน</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {done ? (
              <span className="badge flex items-center gap-1"
                style={{ background: mode === 'in' ? '#dbeafe' : '#dcfce7', color: mode === 'in' ? '#1e40af' : '#166534' }}>
                <CheckCircle2 size={11} />
                {mode === 'in' ? 'เข้าครบแล้ว' : 'ออกครบแล้ว'}
              </span>
            ) : (
              <span className="badge flex items-center gap-1" style={{ background: '#fef9c3', color: '#854d0e' }}>
                <Clock size={11} />
                {mode === 'in' ? `รอเข้า ${pending}` : `ในลาน ${pending}`} คัน
              </span>
            )}
            {open
              ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} />
              : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
          </div>
        </div>

        {/* progress bar */}
        <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--chip)' }}>
          <div className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: done ? '#22c55e' : accent }} />
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {current}/{total} {mode === 'in' ? 'เข้าลานแล้ว' : 'ออกแล้ว'}
          </span>
          <span className="text-[11px] font-semibold" style={{ color: done ? '#22c55e' : accent }}>{pct}%</span>
        </div>
      </button>

      {/* expandable VIN list */}
      {open && (
        <div className="border-t hairline max-h-[300px] overflow-y-auto">
          {visibleRows
            .slice()
            .sort((a, b) => statusOrd(a.cells) - statusOrd(b.cells))
            .map((r) => {
              const status = deriveCarStatus(r.cells)
              const { bg, c } = ss(status)
              const dateVal = mode === 'in'
                ? (r.cells['Gate In (Rayong yard)'] || '')
                : (r.cells['Gate Out time stamp'] || '')
              const byVal = mode === 'in' ? (r.cells['Gate In Inspector'] || '') : ''
              return (
                <div key={r.vin} className="flex items-center gap-3 px-4 py-2 border-b hairline last:border-0">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: c }} />
                  <span className="vin text-[12px]" style={{ minWidth: 170 }}>{r.vin}</span>
                  <span className="text-[11px] clip flex-1" style={{ color: 'var(--muted)', minWidth: 0 }}>
                    {r.cells['Model name'] || r.cells['Model'] || ''}
                  </span>
                  <span className="text-[11px] shrink-0 tabular" style={{ color: 'var(--muted)', minWidth: 130 }}>
                    {dateVal || '—'}
                  </span>
                  {mode === 'in' && (
                    <span className="text-[11px] shrink-0" style={{ color: 'var(--muted)', minWidth: 70 }}>
                      {byVal || '—'}
                    </span>
                  )}
                  <span className="badge shrink-0"
                    style={{ fontSize: 10, background: bg, color: c }}>{status}</span>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}

/**
 * The lot's name, renameable in place.
 *
 * Import names a lot "(yard · date · N)", which says nothing about what is on
 * the truck. The office knows — "ATTO 3 lot 2", "รอบบ่าย" — and that name is
 * what the gate operator reads on the scan station, so let it be typed here.
 * The virtual "no queue yet" card is not a real queue and has nothing to save
 * a name to, so it stays read-only.
 */
function QueueName({ q, onExpand }: { q: WorkQueue; onExpand: () => void }) {
  const renameQueue = useOps((s) => s.renameQueue)
  const createGateInQueue = useOps((s) => s.createGateInQueue)
  const currentUser = useYard((s) => s.currentUser)
  const toast = useYard((s) => s.toast)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(q.name)
  const virtual = q.id === '__uncovered_pregatein'

  const save = () => {
    const n = draft.trim()
    if (n && n !== q.name) {
      if (virtual) {
        // the "(รอ Gate-in · ยังไม่มีคิวงาน)" card is synthesized from cars no
        // queue covers — there is no queue object to rename. Naming it CREATES
        // a real GATEIN queue over exactly those cars, which then replaces this
        // card here and on the ops-scan station (same find-or-create the
        // importer uses, so a matching name merges instead of duplicating).
        createGateInQueue(n, q.items.map((i) => i.vin), currentUser)
        toast('ok', `สร้างคิวงาน "${n}" แล้ว`)
      } else {
        renameQueue(q.id, n)
        toast('ok', 'เปลี่ยนชื่อคิวงานแล้ว')
      }
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <input className="input py-1 text-[13px] font-bold w-full" value={draft} autoFocus
        placeholder="ตั้งชื่อคิวงาน…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(q.name); setEditing(false) } }} />
    )
  }
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {/* the name still opens the lot on tap, exactly as before the pencil
          arrived — renaming is the small deliberate target beside it */}
      <button className="font-bold text-[13px] truncate text-left" style={{ color: 'var(--brand)' }}
        onClick={onExpand}>{q.name}</button>
      <button className="shrink-0 p-1 rounded-md transition hover:bg-chip"
        title={virtual
          ? 'ตั้งชื่อคิวงาน — รถชุดนี้จะกลายเป็นคิวงานจริง แสดงที่หน้าสแกนของหน้างานด้วย'
          : 'เปลี่ยนชื่อคิวงาน — ชื่อนี้จะขึ้นที่หน้าสแกนของหน้างานด้วย'}
        onClick={() => { setDraft(virtual ? '' : q.name); setEditing(true) }}>
        <Pencil size={12} style={{ color: 'var(--muted)' }} />
      </button>
    </div>
  )
}

/**
 * "Move this VIN to another lot" — right-click (or long-press on a phone) a car
 * in a Pre Gate-in lot and pick where it really belongs.
 *
 * Arrival lots come from the import file, and the file is written before the
 * trucks leave: a car that ends up on the next truck instead sits in the wrong
 * lot, and the gate operator either can't find it or ticks it off a lot it never
 * came on. Only Gate-in lots offer this — a PDI/PM/FINAL car carries station
 * state (stage, inspector, result) that means nothing in another station's queue.
 */
function MoveVinModal({ vin, from, targets, onClose }: {
  vin: string
  from: WorkQueue
  targets: WorkQueue[]
  onClose: () => void
}) {
  const moveVin = useOps((s) => s.moveVin)
  const addVins = useOps((s) => s.addVins)
  const toast = useYard((s) => s.toast)
  const virtualFrom = from.id === '__uncovered_pregatein'

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const move = (to: WorkQueue) => {
    // the "(รอ Gate-in · ยังไม่มีคิวงาน)" card is synthesized, not a queue —
    // there is nothing to remove the car FROM, only a lot to add it to
    const okMove = virtualFrom ? addVins(to.id, [vin]).added > 0 : moveVin(from.id, to.id, vin)
    if (okMove) toast('ok', `ย้าย ${vin} ไปคิวงาน "${to.name}" แล้ว`)
    else toast('err', 'ย้ายไม่สำเร็จ — เลขวินนี้อยู่ในคิวงานปลายทางอยู่แล้ว')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}
      onClick={onClose}>
      <div className="pop w-full overflow-hidden flex flex-col"
        style={{ maxWidth: 420, borderRadius: 18, background: 'var(--panel)', border: '0.5px solid rgba(0,0,0,0.10)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="px-4 pt-4 pb-3 flex items-start gap-2">
          <MoveRight size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--brand)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold">ย้ายเลขวินไปคิวงานอื่น</div>
            <div className="vin text-[12px] mt-1 truncate">{vin}</div>
            <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--muted)' }}>จาก: {from.name}</div>
          </div>
          <button className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: 'var(--chip)', color: 'var(--muted)' }} onClick={onClose} title="ปิด">
            <X size={14} />
          </button>
        </div>
        <div className="divider mx-4" />
        <div className="px-3 py-3 overflow-auto" style={{ maxHeight: '52vh' }}>
          {targets.length === 0 ? (
            <div className="text-[12px] px-2 py-3 text-center" style={{ color: 'var(--muted)' }}>
              ไม่มีคิวงาน Gate-in อื่นให้ย้ายไป
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {targets.map((t) => {
                const { done, total } = queueProgress(t)
                return (
                  <button key={t.id} className="btn btn-ghost w-full justify-between px-3 py-2.5 text-left"
                    onClick={() => move(t)}>
                    <span className="text-[12.5px] font-bold truncate" style={{ color: 'var(--brand)' }}>{t.name}</span>
                    <span className="badge tabular shrink-0">{done}/{total}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Edit which cars a lot holds — take a VIN out, or paste VINs in.
 *
 * An import batch is a snapshot of one file, and the truck that actually turns
 * up rarely matches it exactly: a car is cancelled, another is added at the
 * last minute, one was listed on the wrong lot. Until now the only repair was
 * moving a car between lots (right-click) — nothing could remove a car that was
 * never coming, so the lot could never reach 100% and sat on the gate's board
 * forever, or add one that turned up unlisted.
 *
 * Pasted VINs are resolved against the tracking sheet (full VIN or ท้าย ≥3 —
 * the same matcher the Unit-List paste box uses). A VIN the sheet has never
 * heard of is refused: adding it would put a bare number on the gate's screen
 * with no model, colour or lot behind it.
 *
 * The "(รอ Gate-in · ยังไม่มีคิวงาน)" card is editable here too, and taking a
 * car out of it is the ONLY thing that really clears the gate's board: that
 * card is rebuilt from the sheet on every render, so a car removed from a lot
 * simply reappeared inside it — from the gate's side, removal never worked.
 * Removing from either place now records the operator's "คันนี้ไม่ได้มา" so the
 * safety net stops resurrecting it. Nothing in the sheet is touched, and the
 * Gate-in station searches the sheet (not the queues), so a car that turns up
 * after all still scans in normally.
 */
function EditQueueVinsModal({ q, rows, modelByVin, dismissedRows, onClose }: {
  q: WorkQueue
  rows: TrackRow[]
  modelByVin: Map<string, string>
  /** cars taken off the board earlier — listed so the removal can be undone */
  dismissedRows: TrackRow[]
  onClose: () => void
}) {
  const addVins = useOps((s) => s.addVins)
  const removeVin = useOps((s) => s.removeVin)
  const dismissPreGateIn = useOps((s) => s.dismissPreGateIn)
  const undismissPreGateIn = useOps((s) => s.undismissPreGateIn)
  const toast = useYard((s) => s.toast)
  const [text, setText] = useState('')
  const virtual = q.id === '__uncovered_pregatein'
  // live queue copy — the modal must show the list it is editing, not a snapshot.
  // the virtual card has no stored queue: its live copy is the prop, which the
  // board rebuilds on every dismissal.
  const live = useOps((s) => s.queues.find((x) => x.id === q.id)) ?? q

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const doAdd = () => {
    const { found, notFound } = matchVins(text, rows)
    if (!found.length) {
      toast('err', notFound.length ? `ไม่พบเลขวิน: ${notFound.slice(0, 5).join(', ')}` : 'ยังไม่ได้ใส่เลขวิน')
      return
    }
    const { added, dup } = addVins(live.id, found.map((r) => r.vin))
    const parts = [added ? `เพิ่ม ${added} คัน` : '', dup ? `มีอยู่แล้ว ${dup}` : '', notFound.length ? `ไม่พบ ${notFound.length}` : '']
    toast(added ? 'ok' : 'info', parts.filter(Boolean).join(' · '))
    if (added) setText('')
  }

  const doRemove = (vin: string, done: boolean) => {
    const waiting = deriveCarStatus(rows.find((r) => r.vin === vin)?.cells ?? {}) === 'Pre Gate-in'
    if (virtual) {
      if (!window.confirm(`${vin}\n\nเอารถคันนี้ออกจากกระดานประตู?\n\n· สถานะในชีทไม่เปลี่ยน — แค่ไม่ต้องรอที่ประตูอีก\n· ถ้ารถมาจริง สแกนเลขวินที่สถานี Gate-in รับเข้าได้ตามปกติ`)) return
      dismissPreGateIn([vin])
      toast('ok', `เอา ${vin} ออกจากกระดานประตูแล้ว`)
      return
    }
    // a car the gate already scanned in is real history — make that deliberate
    if (done && !window.confirm(`${vin}\n\nคันนี้ Gate-in เข้าลานไปแล้ว\nเอาออกจากคิวงานนี้จริงหรือไม่?`)) return
    removeVin(live.id, vin)
    // …and keep it off the board. Without this the car falls straight into the
    // "(รอ Gate-in · ยังไม่มีคิวงาน)" safety net and the removal looks undone.
    if (waiting && isPreGateInQueue(live)) dismissPreGateIn([vin])
    toast('ok', `เอา ${vin} ออกจากคิวงานแล้ว`)
  }

  const items = [...live.items].sort((a, b) => Number(a.done) - Number(b.done))
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}
      onClick={onClose}>
      <div className="pop w-full overflow-hidden flex flex-col"
        style={{ maxWidth: 520, borderRadius: 18, background: 'var(--panel)', border: '0.5px solid rgba(0,0,0,0.10)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="px-4 pt-4 pb-3 flex items-start gap-2">
          <ListChecks size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--brand)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold">{virtual ? 'แก้ไขรถที่รออยู่หน้าประตู' : 'แก้ไขรายชื่อรถในคิวงาน'}</div>
            <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{live.name}</div>
          </div>
          <button className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: 'var(--chip)', color: 'var(--muted)' }} onClick={onClose} title="ปิด">
            <X size={14} />
          </button>
        </div>
        <div className="divider mx-4" />
        {virtual ? (
          // this card is built from the sheet, not stored — there is no list to
          // add a car INTO. Naming it (the pencil on the card) is what turns it
          // into a real lot; here you can only take cars off the gate's board.
          <div className="px-4 py-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            รถชุดนี้ยังไม่มีคิวงาน — กดถังขยะเพื่อเอารถที่ <b>ไม่ได้มา</b> ออกจากกระดานประตู
            <div className="mt-1" style={{ color: 'var(--faint)' }}>
              สถานะในชีทไม่เปลี่ยน · ถ้ารถมาจริง สแกนที่สถานี Gate-in รับเข้าได้ตามปกติ ·
              อยากทำเป็นคิวงานจริง กดรูปดินสอที่ชื่อการ์ดเพื่อตั้งชื่อ
            </div>
          </div>
        ) : (
          <div className="px-4 py-3">
            <div className="text-[11.5px] font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>
              เพิ่มรถเข้าคิวงาน — วาง/พิมพ์เลขวินเต็ม หรือเลขท้าย (หลายคันได้ ขึ้นบรรทัดใหม่)
            </div>
            <textarea className="input" style={{ minHeight: 64, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
              placeholder={'LC0CE4CB1TG024182\n024182'} value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn btn-primary w-full mt-2 py-2 text-[12.5px]" disabled={!text.trim()} onClick={doAdd}>
              <ListPlus size={14} /> เพิ่มเข้าคิวงาน
            </button>
          </div>
        )}
        <div className="divider mx-4" />
        <div className="px-4 pt-2.5 pb-1 text-[11.5px] font-semibold flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
          {virtual ? 'รถที่รออยู่หน้าประตู' : 'รถในคิวงานนี้'} <span className="badge tabular">{items.length}</span>
        </div>
        <div className="px-2 pb-3 overflow-auto divide-y" style={{ maxHeight: '38vh' }}>
          {items.length === 0 ? (
            <div className="text-[12px] px-2 py-4 text-center" style={{ color: 'var(--muted)' }}>ยังไม่มีรถในคิวงานนี้</div>
          ) : items.map((i) => (
            <div key={i.vin} className="flex items-center gap-2.5 px-2 py-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: i.done ? '#22c55e' : '#f6d365' }} />
              <div className="min-w-0 flex-1">
                <div className="vin text-[12px] truncate">{i.vin}</div>
                <div className="text-[10.5px] truncate" style={{ color: 'var(--faint)' }}>
                  {modelByVin.get(i.vin) || '—'}{i.done ? ' · Gate-in แล้ว' : ''}
                </div>
              </div>
              <button className="btn btn-ghost px-2 py-1 shrink-0" style={{ color: '#dc2626' }}
                title={virtual ? 'เอารถคันนี้ออกจากกระดานประตู' : 'เอารถคันนี้ออกจากคิวงาน'}
                onClick={() => doRemove(i.vin, i.done)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        {/* undo: a car taken off the board is still Pre Gate-in in the sheet, so
            it must stay findable — otherwise the only way back is a re-import */}
        {(virtual || isPreGateInQueue(live)) && dismissedRows.length > 0 && (
          <>
            <div className="divider mx-4" />
            <div className="px-4 pt-2.5 pb-1 text-[11.5px] font-semibold flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              เอาออกจากกระดานประตูแล้ว <span className="badge tabular">{dismissedRows.length}</span>
            </div>
            <div className="px-2 pb-3 overflow-auto divide-y" style={{ maxHeight: '22vh' }}>
              {dismissedRows.map((r) => (
                <div key={r.vin} className="flex items-center gap-2.5 px-2 py-2">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--faint)' }} />
                  <div className="min-w-0 flex-1">
                    <div className="vin text-[12px] truncate" style={{ color: 'var(--muted)' }}>{r.vin}</div>
                    <div className="text-[10.5px] truncate" style={{ color: 'var(--faint)' }}>{modelByVin.get(r.vin) || '—'}</div>
                  </div>
                  <button className="btn btn-ghost px-2 py-1 text-[11px] shrink-0" style={{ color: 'var(--brand)' }}
                    title="เอากลับขึ้นกระดานประตู"
                    onClick={() => { undismissPreGateIn([r.vin]); toast('ok', `เอา ${r.vin} กลับขึ้นกระดานประตูแล้ว`) }}>
                    <ArchiveRestore size={13} /> เอากลับ
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Pre Gate-in work queues (the "(yard · date · N)" import batches) — same view
//    as YardOps: name · done/total · waiting VIN list. Scoped to the active site. ──
function PreGateInQueues({ filterDate }: { filterDate: string | null }) {
  const all = useActiveQueues()
  const closed = useOps((s) => s.closed) // archived lots leave the live board
  const closeQueue = useOps((s) => s.closeQueue)
  const reopenQueue = useOps((s) => s.reopenQueue)
  const currentUser = useYard((s) => s.currentUser)
  const toast = useYard((s) => s.toast)
  const isClosed = (id: string) => !!closed[id]
  const currentSite = useYard((s) => s.currentSite)
  const rows = useTrackingRows()
  const [openId, setOpenId] = useState<string | null>(null)
  const [moving, setMoving] = useState<{ fromId: string; vin: string } | null>(null)
  const [editingVins, setEditingVins] = useState<string | null>(null)
  const longPress = useRef<number | null>(null)
  const modelByVin = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) m.set(r.vin, r.cells['Model name'] || r.cells['Model'] || '')
    return m
  }, [rows])
  // inspector fallback: auto-reconciled gate-ins don't set the item's doneBy, but
  // doTrackingGateIn stamps the operator into the 'Gate In Inspector' cell.
  const inspectorByVin = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) { const by = r.cells['Gate In Inspector']; if (by) m.set(r.vin, by) }
    return m
  }, [rows])
  const queues = useMemo(
    () => all.filter((q) => isPreGateInQueue(q) && (!q.site || q.site === currentSite) && queueOnDate(q, filterDate, !!closed[q.id])),
    [all, currentSite, filterDate, closed],
  )
  // ── safety net: a Pre Gate-in car this board doesn't cover with any queue ──
  // "(yard · date · N)" queues are built once at import time; a device that
  // deletes its data and re-uploads a fresh file can end up with NEW Pre
  // Gate-in rows and no matching queue for them (the old queue for a prior
  // batch stays visible — done and dated — while the office sees nothing for
  // the cars the Unit List now counts as waiting). Same fix as the Ops-Scan
  // Gate-in station's virtual card (PR #238): collect every site Pre Gate-in
  // row not listed in ANY "(" queue (live or historical, not just today's) into
  // one virtual entry, so this board can never show fewer waiting cars than
  // the Unit List does. Live-board only — a past date is asking "what happened
  // that day", not "what's uncovered right now".
  const isToday = filterDate == null || filterDate === todayKey()
  // cars the gate has taken off this board by hand ("คันนี้ไม่ได้มา"). Without
  // this the safety net below rebuilt them from the sheet on every render, so
  // removing a car from a lot only moved it into the virtual card — the reason
  // the board looked un-editable from the yard's side.
  const dismissed = useOps((s) => s.dismissed)
  const uncovered = useMemo(() => {
    if (!isToday) return [] as TrackRow[]
    // a car is "covered" only while it still has an OPEN item — a done item in a
    // finished batch leaves nothing on screen for the operator to work from, so
    // a car returned to Pre Gate-in (admin edit / re-import) must fall through to
    // the virtual card below instead of silently belonging to a hidden queue
    const queuedVins = new Set<string>()
    for (const q of all) {
      if (!isPreGateInQueue(q) || (q.site && q.site !== currentSite)) continue
      for (const i of q.items) if (!gateInArrived(i)) queuedVins.add(i.vin)
    }
    return rows.filter((r) => rowInSite(r, currentSite, useYard.getState().sites)
      && !queuedVins.has(r.vin) && !dismissed[r.vin] && deriveCarStatus(r.cells) === 'Pre Gate-in')
  }, [all, rows, currentSite, isToday, dismissed])
  // the other side of that filter — what was taken off, so it can be put back
  const dismissedRows = useMemo(() => rows.filter((r) => dismissed[r.vin]
    && rowInSite(r, currentSite, useYard.getState().sites)
    && deriveCarStatus(r.cells) === 'Pre Gate-in'), [rows, currentSite, dismissed])
  if (queues.length === 0 && uncovered.length === 0 && dismissedRows.length === 0) return null
  // the card also stays when every waiting car has been taken off the board and
  // there is no lot left — otherwise the "เอากลับ" list would be unreachable
  const virtual: WorkQueue | null = uncovered.length || (queues.length === 0 && dismissedRows.length) ? {
    id: '__uncovered_pregatein', name: '(รอ Gate-in · ยังไม่มีคิวงาน)', createdAt: 0,
    items: uncovered.map((r) => ({ vin: r.vin, addedAt: 0, done: false })),
  } : null
  const renderQueues = virtual ? [...queues, virtual] : queues
  const movingFrom = moving ? renderQueues.find((q) => q.id === moving.fromId) ?? null : null
  return (
    <>
    {movingFrom && moving && (
      <MoveVinModal vin={moving.vin} from={movingFrom} onClose={() => setMoving(null)}
        targets={queues.filter((t) => t.id !== moving.fromId)} />
    )}
    {editingVins && (() => {
      // renderQueues, not queues — the "(รอ Gate-in · ยังไม่มีคิวงาน)" card is
      // editable too, and it only exists in the rendered list
      const q = renderQueues.find((x) => x.id === editingVins)
      return q ? <EditQueueVinsModal q={q} rows={rows} modelByVin={modelByVin}
        dismissedRows={dismissedRows} onClose={() => setEditingVins(null)} /> : null
    })()}
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 border-b hairline flex items-center gap-2">
        <ClipboardList size={14} style={{ color: 'var(--brand)' }} />
        <span className="text-[13px] font-bold">คิวงาน Pre Gate-in</span>
        <span className="badge ml-auto" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--brand)' }}>{renderQueues.length} คิว</span>
      </div>
      <div className="divide-y">
        {renderQueues.map((q) => {
          const { done, total } = queueProgress(q)
          // "เสร็จ" นับจากสถานะรถ (queueProgress) แต่ "รอ" เคยนับจากธงติ๊ก —
          // การ์ดเดียวกันจึงอ่านได้ว่า "410/545 เสร็จ · รอ Gate-in 1 คัน"
          // ซึ่งขัดกันเอง ให้ทั้งสองเลขมาจากกฎเดียวกัน
          const pending = isPreGateInQueue(q) ? gateInPendingItems(q) : q.items.filter((i) => !i.done)
          const open = openId === q.id
          const pct = total ? Math.round((done / total) * 100) : 0
          const complete = pending.length === 0
          return (
            <div key={q.id}>
              <div className="w-full text-left px-4 py-3 transition">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <QueueName q={q} onExpand={() => setOpenId(open ? null : q.id)} />
                    <button className="text-[11px] mt-0.5 block text-left" style={{ color: 'var(--muted)' }}
                      onClick={() => setOpenId(open ? null : q.id)}>
                      {done}/{total} เสร็จ{complete ? '' : ` · รอ Gate-in ${pending.length} คัน`}
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* archive: an old lot whose last car never turned up (289/290)
                        had no way off the boards — this files it away, and it is
                        still there under its own date if it needs reopening */}
                    {/* edit the lot's car list: a truck rarely matches its
                        import file exactly — a car cancelled, one added late,
                        one listed on the wrong lot. Without this a car that was
                        never coming kept the lot below 100% forever. */}
                    {/* the virtual "(รอ Gate-in · ยังไม่มีคิวงาน)" card gets it
                        too — it is where every removed car lands, so without an
                        edit button here nothing could ever leave the board */}
                    {!isClosed(q.id) && (
                      <button className="btn btn-ghost px-2 py-1" style={{ color: 'var(--muted)' }}
                        title={q.id === '__uncovered_pregatein'
                          ? 'แก้ไขรถที่รออยู่หน้าประตู — เอารถที่ไม่ได้มาออก'
                          : 'แก้ไขรายชื่อรถในคิวงาน — เพิ่ม/เอาเลขวินออก'}
                        onClick={(e) => { e.stopPropagation(); setEditingVins(q.id) }}>
                        <ListChecks size={13} />
                      </button>
                    )}
                    {q.id !== '__uncovered_pregatein' && (
                      isClosed(q.id) ? (
                        <button className="btn btn-ghost px-2 py-1 text-[11px]" style={{ color: '#16a34a' }}
                          title="เปิดคิวงานนี้อีกครั้ง"
                          onClick={(e) => { e.stopPropagation(); reopenQueue(q.id); toast('ok', `เปิดคิวงาน "${q.name}" อีกครั้ง`) }}>
                          <ArchiveRestore size={13} /> เปิดอีกครั้ง
                        </button>
                      ) : (
                        <button className="btn btn-ghost px-2 py-1" style={{ color: 'var(--muted)' }}
                          title="เก็บคิวงานนี้เข้าคลัง (ออกจากบอร์ดหน้างาน)"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (!window.confirm(`เก็บคิวงาน "${q.name}" เข้าคลัง?\n\nคิวจะหายจากบอร์ด Gate In และหน้าสแกนของหน้างาน — เปิดกลับได้จากวันที่ของคิวนี้`)) return
                            closeQueue(q.id, currentUser)
                            toast('ok', `เก็บคิวงาน "${q.name}" เข้าคลังแล้ว`)
                          }}>
                          <Archive size={13} />
                        </button>
                      )
                    )}
                    <button className="flex items-center gap-2" onClick={() => setOpenId(open ? null : q.id)}>
                      <span className="badge tabular" style={complete
                        ? { background: 'rgba(22,163,74,0.12)', color: '#16a34a' }
                        : { background: '#fef9c3', color: '#854d0e' }}>{done}/{total}</span>
                      {open ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
                    </button>
                  </div>
                </div>
                <button className="h-1.5 rounded-full overflow-hidden mt-2 block w-full" style={{ background: 'var(--chip)' }}
                  onClick={() => setOpenId(open ? null : q.id)}>
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: complete ? '#22c55e' : 'var(--brand)' }} />
                </button>
              </div>
              {open && (
                <div className="border-t hairline max-h-[320px] overflow-y-auto divide-y">
                  {complete && (
                    <div className="px-4 py-2 text-[11.5px] font-bold flex items-center gap-1.5" style={{ color: '#16a34a' }}>
                      <CheckCircle2 size={13} /> เข้าครบแล้ว
                    </div>
                  )}
                  {/* the move is invisible otherwise — say it once, at the top of
                      the list, and only when there is somewhere to move to */}
                  {queues.some((t) => t.id !== q.id) && (
                    <div className="px-4 py-1.5 text-[10.5px] flex items-center gap-1" style={{ color: 'var(--faint)' }}>
                      <MoveRight size={11} /> คลิ๊กขวา (หรือกดค้าง) ที่เลขวิน เพื่อย้ายไปคิวงานอื่น
                    </div>
                  )}
                  {/* every car — pending first, each Gate-in'd car shows when + who */}
                  {[...q.items].map((i) => ({ ...i, done: gateInArrived(i) }))
                    .sort((a, b) => Number(a.done) - Number(b.done)).map((item) => (
                    // right-click (desktop) / long-press (phone) → move this car
                    // to another arrival lot. preventDefault keeps the browser's
                    // own menu — and the long-press text selection — out of the way.
                    <div key={item.vin} className="flex items-center gap-3 px-4 py-2.5 select-none"
                      title="คลิ๊กขวา (หรือกดค้าง) เพื่อย้ายไปคิวงานอื่น"
                      onContextMenu={(e) => { e.preventDefault(); setMoving({ fromId: q.id, vin: item.vin }) }}
                      onTouchStart={() => {
                        // Android/iOS fire `contextmenu` on long-press, but not on
                        // every browser — this timer is the fallback, and opening
                        // twice is harmless (same VIN, same target state).
                        longPress.current = window.setTimeout(() => setMoving({ fromId: q.id, vin: item.vin }), 550)
                      }}
                      onTouchEnd={() => { if (longPress.current) window.clearTimeout(longPress.current) }}
                      onTouchMove={() => { if (longPress.current) window.clearTimeout(longPress.current) }}>
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: item.done ? '#22c55e' : '#f6d365' }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="vin text-[12px] truncate">{item.vin}</span>
                          <span className="text-[11px] truncate shrink-0" style={{ color: 'var(--muted)', maxWidth: 130 }}>{modelByVin.get(item.vin) || ''}</span>
                        </div>
                        {item.done && item.doneAt && (
                          <div className="text-[10.5px] mt-0.5 flex items-center gap-1" style={{ color: 'var(--faint)' }}>
                            <Clock size={10} />
                            <span>Gate-in {new Date(item.doneAt).toLocaleString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                            {(item.doneBy || inspectorByVin.get(item.vin)) && <span>· {item.doneBy || inspectorByVin.get(item.vin)}</span>}
                          </div>
                        )}
                      </div>
                      {item.done && <CheckCircle2 size={13} className="shrink-0" style={{ color: '#16a34a' }} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
    </>
  )
}

// ── Delivery-sequence queues (Grouping to Dealer) ───────────────────────────
// Created by "Create Sequence" on the Grouping page — the SAME ops work queue
// the Ops-Scan gate-out station drives. Surfaced on the Gate Out side here as
// clickable cards (identical look) so the office can watch each dispatch run.
// Scoped to the active site.
function SeqQueues({ filterDate }: { filterDate: string | null }) {
  const all = useActiveQueues()
  const closed = useOps((s) => s.closed)
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const allUnits = useUnits()
  const allRows = useTrackingRows()
  const queues = useMemo(
    () => all.filter((q) => isSequenceQueue(q) && (!q.site || q.site === currentSite) && queueOnDate(q, filterDate, !!closed[q.id])),
    [all, currentSite, filterDate, closed],
  )
  const units = useMemo(
    () => (currentSite ? allUnits.filter((u) => !u.site || u.site === currentSite) : allUnits),
    [allUnits, currentSite],
  )
  const siteRows = useMemo(
    () => (currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows),
    [allRows, currentSite, sites],
  )
  if (queues.length === 0) return null
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 pt-1">
        <ListChecks size={14} style={{ color: 'var(--st-yard)' }} />
        <span className="text-[13px] font-bold">คิวส่งออก · Grouping to Dealer</span>
        <span className="badge ml-auto" style={{ background: 'rgba(22,163,74,0.1)', color: '#166534' }}>{queues.length} คิว</span>
      </div>
      <SeqQueuePicker queues={queues} units={units} trackingRows={siteRows} queuedLabel="รอจ่าย" />
    </div>
  )
}

// ── Side panel (Gate In or Gate Out) ──
function SidePanel({ mode, groups, dateFilter }: { mode: 'in' | 'out'; groups: Group[]; dateFilter: string | null }) {
  const accent = mode === 'in' ? 'var(--brand-2)' : 'var(--st-yard)'
  const Icon   = mode === 'in' ? ScanLine : LogOut

  const filtered = mode === 'in'
    ? groups
    : groups.filter((g) => g.gateIn > 0 || g.gateOut > 0)

  const doneCount  = mode === 'in'
    ? groups.filter((g) => g.preGateIn === 0 && g.total > 0).length
    : groups.filter((g) => g.gateIn === 0 && g.gateOut > 0).length
  const totalIn    = groups.reduce((s, g) => s + g.gateIn + g.gateOut, 0)
  const pendingIn  = groups.reduce((s, g) => s + g.preGateIn, 0)
  const totalOut   = groups.reduce((s, g) => s + g.gateOut, 0)
  const inYard     = groups.reduce((s, g) => s + g.gateIn, 0)

  // ── history mode: how many VINs (and lots) moved on the selected day ──
  const dateStats = useMemo(() => {
    if (!dateFilter) return null
    const keyFn = mode === 'in' ? gateInDateKey : gateOutDateKey
    let count = 0
    const lots = new Set<string>()
    for (const g of groups) for (const r of g.rows) if (keyFn(r) === dateFilter) { count++; lots.add(g.key) }
    return { count, lots: lots.size }
  }, [groups, mode, dateFilter])

  return (
    <div className={cx('space-y-3', mode === 'in' ? 'pr-4' : 'pl-4')}>
      {/* section header */}
      <div className="pt-3 pb-2 border-b hairline">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon size={16} style={{ color: accent }} />
            <div>
              <div className="font-bold text-[14.5px]">
                {mode === 'in' ? 'Gate In / ตรวจรับ' : 'Gate Out / ส่งออก'}
              </div>
              <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                {dateFilter
                  ? `${dateStats?.lots ?? 0} Lot มีความเคลื่อนไหว วันที่ ${fmtDateTh(dateFilter)}`
                  : mode === 'in'
                    ? `${doneCount} / ${groups.length} Lot เข้าครบแล้ว`
                    : `${filtered.length} Lot ที่มีรถในลาน`}
              </div>
            </div>
          </div>
          {/* summary numbers */}
          <div className="flex gap-4 pr-1">
            <div className="text-center">
              <div className="font-bold text-[17px]" style={{ color: accent }}>
                {dateFilter ? (dateStats?.count ?? 0) : mode === 'in' ? totalIn : totalOut}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
                {dateFilter ? (mode === 'in' ? 'เข้าวันนี้' : 'ออกวันนี้') : mode === 'in' ? 'เข้าแล้ว' : 'ออกแล้ว'}
              </div>
            </div>
            {!dateFilter && (
              <div className="text-center">
                <div className="font-bold text-[17px]" style={{ color: '#f6d365' }}>
                  {mode === 'in' ? pendingIn : inYard}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
                  {mode === 'in' ? 'รอเข้า' : 'ในลาน'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Pre Gate-in work queues (import batches) — the primary gate-in view */}
      {mode === 'in' && <PreGateInQueues filterDate={dateFilter} />}

      {/* Delivery-sequence (Grouping-to-Dealer) runs — the primary gate-out view */}
      {mode === 'out' && <SeqQueues filterDate={dateFilter} />}

      {/* cards */}
      {dateFilter ? (
        (dateStats?.count ?? 0) === 0 ? (
          <div className="panel p-10 text-center" style={{ color: 'var(--faint)' }}>
            <div className="text-[12.5px]">
              ไม่มีรถ{mode === 'in' ? 'เข้า' : 'ออก'}ในวันที่ {fmtDateTh(dateFilter)}
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {groups.filter((g) => g.key !== 'ไม่ระบุ').map((g) => <GroupCard key={g.key} group={g} mode={mode} dateFilter={dateFilter} />)}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div className="panel p-10 text-center" style={{ color: 'var(--faint)' }}>
          <div className="text-[12.5px]">
            {mode === 'in' ? 'ยังไม่มีข้อมูล — นำเข้า Excel ก่อน' : 'ยังไม่มีรถในลาน'}
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.filter((g) => g.key !== 'ไม่ระบุ').map((g) => <GroupCard key={g.key} group={g} mode={mode} dateFilter={null} />)}
        </div>
      )}
    </div>
  )
}

// ── Page ──
export function GateIn() {
  const lang = useYard((s) => s.lang)
  const { loadFromIdb } = useTracking()
  const allRows = useTrackingRows()
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const [filterDate, setFilterDate] = useState<string | null>(todayKey())

  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  // scope to the active yard (like Units / Dashboard / YardOps) so other yards'
  // cars & lots don't leak in — the "8/2,025" bug was all-yards, not site-scoped
  const siteRows = useMemo(
    () => (currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows),
    [allRows, currentSite, sites],
  )
  const groups = useMemo(() => buildGroups(siteRows), [siteRows])

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHead
        title="Gate In / Gate Out"
        sub={filterDate ? `กำลังดูย้อนหลัง — วันที่ ${fmtDateTh(filterDate)}` : 'ความคืบหน้าการตรวจรับและส่งออกรถแต่ละ Lot'}
        right={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 panel px-2.5 py-1.5">
              <Calendar size={14} style={{ color: 'var(--muted)' }} />
              <input
                type="date"
                value={filterDate ?? ''}
                max={todayKey()}
                onChange={(e) => setFilterDate(e.target.value || null)}
                className="bg-transparent outline-none text-[12.5px]"
                style={{ colorScheme: 'light', border: 'none' }}
              />
            </div>
            {filterDate && (
              <button className="btn btn-ghost text-[12.5px]" onClick={() => setFilterDate(null)}>
                <X size={13} /> ดูภาพรวมล่าสุด
              </button>
            )}
          </div>
        }
      />
      <div className="grid lg:grid-cols-2 gap-0" style={{ borderTop: '1px solid var(--line)' }}>
        <SidePanel mode="in" groups={groups} dateFilter={filterDate} />
        <div style={{ borderLeft: '1px solid var(--line)' }}>
          <SidePanel mode="out" groups={groups} dateFilter={filterDate} />
        </div>
      </div>
    </div>
  )
}
