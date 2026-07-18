import { useEffect, useMemo, useState } from 'react'
import { ScanLine, LogOut, ChevronDown, ChevronRight, CheckCircle2, Clock, Calendar, X, ClipboardList, ListChecks } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { PageHead, cx } from '../components/ui'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { useActiveQueues, queueProgress, isSequenceQueue } from '../store/useOps'
import { isGateOutStamp } from '../lib/carStatus'
import { rowInSite } from '../lib/siteScope'
import { siteGroupingConfig } from '../lib/groupingImport'
import { SeqQueuePicker } from '../components/SeqQueueList'
import type { TrackRow } from '../lib/excelTracking'

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
      preGateIn: rows.filter((r) => !r.cells['Car Status'] || r.cells['Car Status'] === 'Pre Gate-in').length,
      gateIn:    rows.filter((r) => r.cells['Car Status'] === 'Gate-in').length,
      gateOut:   rows.filter((r) => r.cells['Car Status'] === 'Gate-out').length,
      lastUpdated: Math.max(...rows.map((r) => r.updatedAt ?? 0)),
    }))
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
}

const S_STYLE: Record<string, { bg: string; c: string }> = {
  'Pre Gate-in': { bg: '#fef9c3', c: '#854d0e' },
  'Gate-in':     { bg: '#dbeafe', c: '#1e40af' },
  'Gate-out':    { bg: '#dcfce7', c: '#166534' },
}
const ss = (s: string) => S_STYLE[s] ?? S_STYLE['Pre Gate-in']

// ── history: which day did each row gate-in / gate-out on? ──────────────────
// Best-effort parse covering the 3 formats actually seen in this data: plain
// ISO, this app's own dd/mm/yyyy[ HH:MM] stamp (written by the Ops Scan
// station), and Excel's short-date display e.g. "20-May-26" (raw:false
// renders each cell using the source file's own number format). Never
// guesses a genuinely ambiguous format — returns null rather than risk
// attributing an event to the wrong day.
const MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}
function parseLooseDate(s: string | undefined): Date | null {
  const t = (s ?? '').trim()
  if (!t) return null
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3])
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/)
  if (m) {
    const mon = MONTH_ABBR[m[2].toLowerCase()]
    if (mon !== undefined) return new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon, +m[1])
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return new Date(+m[3], +m[2] - 1, +m[1])
  return null
}
const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayKey = () => dateKey(new Date())
const fmtDateTh = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Gate-in day: prefer the exact epoch the Ops Scan station stamps at the
 *  moment of gate-in (immune to later edits); fall back to the imported date. */
function gateInDateKey(r: TrackRow): string | null {
  const ms = parseInt(r.cells['Gate In Time'] ?? '')
  if (!isNaN(ms) && ms > 0) return dateKey(new Date(ms))
  const d = parseLooseDate(r.cells['Gate In (Rayong yard)'])
  return d ? dateKey(d) : null
}
function gateOutDateKey(r: TrackRow): string | null {
  // a pickup-PLAN value ("แผนรับวันที่ …") is not a gate-out — don't count its date
  if (!isGateOutStamp(r.cells['Gate Out time stamp'])) return null
  const d = parseLooseDate(r.cells['Gate Out time stamp'])
  return d ? dateKey(d) : null
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
    ? group.rows.filter((r) => r.cells['Car Status'] === 'Gate-in' || r.cells['Car Status'] === 'Gate-out')
    : group.rows

  // ── history mode: compact card — just the day's count + VIN list, no live progress bar ──
  if (dateFilter) {
    const rows = dateRows!
    if (rows.length === 0) return null // nothing happened in this lot that day
    // show the WHOLE lot (every VIN that must gate in), not just that day's —
    // gated-in first → still-pending → gated-out; that day's rows are dot-marked.
    const todayVins = new Set(rows.map((r) => r.vin))
    const stOrd = (r: TrackRow) => { const s = r.cells['Car Status'] ?? 'Pre Gate-in'; return s === 'Gate-in' ? 0 : s === 'Pre Gate-in' ? 1 : 2 }
    const listRows = (mode === 'in' ? group.rows : visibleRows).slice().sort((a, b) => stOrd(a) - stOrd(b))
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
              const status = r.cells['Car Status'] || 'Pre Gate-in'
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
            .sort((a, b) => {
              const ord: Record<string, number> = { 'Gate-in': 0, 'Gate-out': 1, 'Pre Gate-in': 2 }
              return (ord[a.cells['Car Status'] ?? 'Pre Gate-in'] ?? 2) - (ord[b.cells['Car Status'] ?? 'Pre Gate-in'] ?? 2)
            })
            .map((r) => {
              const status = r.cells['Car Status'] || 'Pre Gate-in'
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

// ── Pre Gate-in work queues (the "(yard · date · N)" import batches) — same view
//    as YardOps: name · done/total · waiting VIN list. Scoped to the active site. ──
function PreGateInQueues() {
  const all = useActiveQueues()
  const currentSite = useYard((s) => s.currentSite)
  const rows = useTrackingRows()
  const [openId, setOpenId] = useState<string | null>(null)
  const modelByVin = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) m.set(r.vin, r.cells['Model name'] || r.cells['Model'] || '')
    return m
  }, [rows])
  const queues = useMemo(
    () => all.filter((q) => q.name.trim().startsWith('(') && (!q.site || q.site === currentSite)),
    [all, currentSite],
  )
  if (queues.length === 0) return null
  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 border-b hairline flex items-center gap-2">
        <ClipboardList size={14} style={{ color: 'var(--brand)' }} />
        <span className="text-[13px] font-bold">คิวงาน Pre Gate-in</span>
        <span className="badge ml-auto" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--brand)' }}>{queues.length} คิว</span>
      </div>
      <div className="divide-y">
        {queues.map((q) => {
          const { done, total } = queueProgress(q)
          const pending = q.items.filter((i) => !i.done)
          const open = openId === q.id
          const pct = total ? Math.round((done / total) * 100) : 0
          const complete = pending.length === 0
          return (
            <div key={q.id}>
              <button className="w-full text-left px-4 py-3 transition active:bg-chip" onClick={() => setOpenId(open ? null : q.id)}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-[13px] truncate" style={{ color: 'var(--brand)' }}>{q.name}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                      {done}/{total} เสร็จ{complete ? '' : ` · รอ Gate-in ${pending.length} คัน`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="badge tabular" style={complete
                      ? { background: 'rgba(22,163,74,0.12)', color: '#16a34a' }
                      : { background: '#fef9c3', color: '#854d0e' }}>{done}/{total}</span>
                    {open ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
                  </div>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden mt-2" style={{ background: 'var(--chip)' }}>
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: complete ? '#22c55e' : 'var(--brand)' }} />
                </div>
              </button>
              {open && (
                <div className="border-t hairline max-h-[320px] overflow-y-auto divide-y">
                  {complete ? (
                    <div className="px-4 py-3 text-[11.5px] font-bold flex items-center gap-1.5" style={{ color: '#16a34a' }}>
                      <CheckCircle2 size={13} /> เข้าครบแล้ว
                    </div>
                  ) : pending.map((item) => (
                    <div key={item.vin} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: '#f6d365' }} />
                      <span className="vin text-[12px] flex-1 truncate">{item.vin}</span>
                      <span className="text-[11px] truncate shrink-0" style={{ color: 'var(--muted)', maxWidth: 130 }}>{modelByVin.get(item.vin) || ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Delivery-sequence queues (Grouping to Dealer) ───────────────────────────
// Created by "Create Sequence" on the Grouping page — the SAME ops work queue
// the Ops-Scan gate-out station drives. Surfaced on the Gate Out side here as
// clickable cards (identical look) so the office can watch each dispatch run.
// Scoped to the active site.
function SeqQueues() {
  const all = useActiveQueues()
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const allUnits = useUnits()
  const allRows = useTrackingRows()
  const queues = useMemo(
    () => all.filter((q) => isSequenceQueue(q) && (!q.site || q.site === currentSite)),
    [all, currentSite],
  )
  const units = useMemo(
    () => (currentSite ? allUnits.filter((u) => !u.site || u.site === currentSite) : allUnits),
    [allUnits, currentSite],
  )
  const siteRows = useMemo(
    () => (currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows),
    [allRows, currentSite, sites],
  )
  const locPrefix = siteGroupingConfig(sites.find((s) => s.id === currentSite)?.name ?? '').prefix
  if (queues.length === 0) return null
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 pt-1">
        <ListChecks size={14} style={{ color: 'var(--st-yard)' }} />
        <span className="text-[13px] font-bold">คิวส่งออก · Grouping to Dealer</span>
        <span className="badge ml-auto" style={{ background: 'rgba(22,163,74,0.1)', color: '#166534' }}>{queues.length} คิว</span>
      </div>
      <SeqQueuePicker queues={queues} units={units} trackingRows={siteRows} locPrefix={locPrefix} queuedLabel="รอจ่าย" />
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
      {mode === 'in' && <PreGateInQueues />}

      {/* Delivery-sequence (Grouping-to-Dealer) runs — the primary gate-out view */}
      {mode === 'out' && <SeqQueues />}

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
