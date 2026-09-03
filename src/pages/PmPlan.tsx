/**
 * PM Plan — two tabs mirroring the operations workbook (Update Plan & Actual
 * PM of <month> - RAYONG):
 *
 *  1) "PM-<เดือน>"  — the monthly pivot exactly as the sheet lays it out:
 *     rows = Model × Variant, columns = calendar days, cells = cars falling
 *     due that day, with the sheet's three footer rows — Total (plan),
 *     Actual (PMs really recorded that day, read from the PM1…PM15 date
 *     cells) and Diff. The month picker reaches any month, not just this one.
 *  2) "PM Status" — the per-VIN register: Vin · Model · Color · Gate In ·
 *     every PM round's date · the latest measurements (%SOC / ODO / 12V /
 *     Tire) · Location · Remark.
 *
 * A car with an Allocation Date (or a Grouping number) is being prepared for
 * sale — PM can no longer be done on it, so BOTH tabs cut it: it neither
 * appears in the plan nor in the register (the register shows how many were
 * cut, so the missing rows are explained, not mysterious).
 *
 * PM cadence: first PM once the car has been in the yard one interval, then
 * every interval after — 30 days everywhere except Auto Tran 38 Rai (90).
 */
import { useMemo, useState } from 'react'
import { CalendarClock, Send, Table2, ClipboardList, Search, Download } from 'lucide-react'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { useYard } from '../store/useYard'
import { parseCellDate, lastPmDate, PM_KEYS } from '../lib/trackingColumns'
import { deriveCarStatus } from '../lib/carStatus'
import { siteIdForLocation } from '../lib/siteScope'
import { PageHead, cx } from '../components/ui'
import { DayPicker, dayKeyOf } from './Grouping'
import { StationTables, useStationCtx, type StationTab } from '../components/StationTables'
import { exportStationReport } from '../lib/opsReport'
import type { TrackRow } from '../lib/excelTracking'

const DAY_MS = 86_400_000

/** The page's five tabs: the station's daily tables, then the plan + register. */
type PmTab = StationTab | 'plan' | 'status'
const DAY_TABS: { id: StationTab; label: string }[] = [
  { id: 'list', label: 'PM' },
  { id: 'defect', label: 'PM DEFECT' },
  { id: 'time', label: 'ตาราง PM' },
]

/** Short yard label to match the operations sheet (ระยอง / soi 5 / 38 ไร่ / …). */
function shortSite(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('rayong')) return 'ระยอง'
  if (n.includes('soi')) return 'soi 5'
  if (n.includes('38')) return '38 ไร่'
  if (n.includes('20')) return '20 ไร่'
  if (n.includes('nyb')) return 'NYB'
  return name
}
/** PM interval in days — 38 Rai runs every 90 days, every other yard every 30. */
const pmInterval = (name: string) => (name.toLowerCase().includes('38') ? 90 : 30)

/** A car is not eligible for PM once it is allocated — it is being prepared
 *  for sale (Allocation Date set) or already grouped for delivery. */
const isAllocated = (c: Record<string, string>) =>
  !!((c['Allocation Date'] || '').trim() || (c['Grouping  Number'] || '').trim())

/** The sheet splits each model by its variant — parse it off the Model name
 *  ("BYD DOLPHIN (435KM-STD)" → STD) the same way the workbook rows read. */
function variantOf(modelName: string): string {
  const n = modelName.toUpperCase()
  if (n.includes('PREMIUM')) return 'PREMIUM'
  if (n.includes('DYNAMIC')) return 'DYNAMIC'
  if (n.includes('EXT')) return 'EXT'
  if (n.includes('STANDARD') || n.includes('STD')) return 'STD'
  if (n.includes('AWD')) return 'AWD'
  return '—'
}
const modelOf = (c: Record<string, string>) =>
  (c['Model'] || c['Model name'] || '').trim() || '—'

/** The measurement columns each PM round carries, exactly as the workbook lays
 *  them out — %SOC · ODO · 12V · แรงดันลมยางทั้ง 4 ล้อ (FR/FL/RL/RR). */
const MEAS = [
  { key: '% SOC', head: '%SOC' },
  { key: 'Mileage', head: 'ODO' },
  { key: 'Voltage of 12V', head: '12V' },
  { key: 'Tire Pressure FR', head: 'FR' },
  { key: 'Tire Pressure FL', head: 'FL' },
  { key: 'Tire Pressure RL', head: 'RL' },
  { key: 'Tire Pressure RR', head: 'RR' },
] as const
const sameDay = (a: number, b: number) => {
  const x = new Date(a), y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

function ymNow(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function PmPlan() {
  const rows = useTrackingRows() // ALL yards — this board is cross-site by design
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const toast = useYard((s) => s.toast)
  const setView = useYard((s) => s.setView)
  const setCurrentSite = useYard((s) => s.setCurrentSite)
  const setUnitVinFilter = useYard((s) => s.setUnitVinFilter)

  // 1–3 are the station's daily tables (same three the PDI board shows);
  // 4–5 are this page's own monthly plan grid and per-VIN register.
  const [tab, setTab] = useState<PmTab>('list')
  const [day, setDay] = useState<string | 'all'>(dayKeyOf(new Date()))
  const [exporting, setExporting] = useState(false)
  const { ctx, dayCounts, dayLabel } = useStationCtx(day)
  const [ym, setYm] = useState<string>(ymNow)
  // which yard to show — the active site by default, or every yard
  const [siteSel, setSiteSel] = useState<string>(() => currentSite ?? 'all')
  const [q, setQ] = useState('') // PM Status tab: vin / model filter

  const [year, month] = ym.split('-').map(Number) // month is 1-12
  const daysInMonth = new Date(year, month, 0).getDate()

  const siteList = useMemo(
    () => sites.map((s) => ({ id: s.id, name: s.name, short: shortSite(s.name), interval: pmInterval(s.name) })),
    [sites],
  )
  const inScope = (siteId: string | null) =>
    !!siteId && (siteSel === 'all' || siteId === siteSel)

  // ── shared row triage: site, eligibility, allocation cut ──────────────────
  const triage = useMemo(() => {
    const eligible: { row: TrackRow; siteId: string; interval: number }[] = []
    let cutAllocated = 0
    const intervalOf = new Map(siteList.map((s) => [s.id, s.interval]))
    for (const row of rows) {
      const c = row.cells
      const cs = deriveCarStatus(c)
      // not yet in the yard, already gone, or written off → no PM
      if (cs === 'Gate-out' || cs === 'Total loss' || cs === 'Pre Gate-in') continue
      const siteId = row.site ?? siteIdForLocation(c, sites) ?? null
      if (!inScope(siteId)) continue
      if (isAllocated(c)) { cutAllocated++; continue } // เตรียมขายแล้ว — ตัดออก
      eligible.push({ row, siteId: siteId!, interval: intervalOf.get(siteId!) ?? 30 })
    }
    return { eligible, cutAllocated }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sites, siteList, siteSel])

  // ── tab 1: the monthly pivot (Model × Variant vs day) + Total/Actual/Diff ──
  const plan = useMemo(() => {
    const monthStart = new Date(year, month - 1, 1).getTime()
    const monthEnd = new Date(year, month - 1, daysInMonth, 23, 59, 59, 999).getTime()

    // model|variant → day (1…N) → VINs due
    const grid = new Map<string, string[][]>()
    const keyOf = (c: Record<string, string>) => `${modelOf(c)}|${variantOf(c['Model name'] || '')}`
    for (const { row, interval } of triage.eligible) {
      const c = row.cells
      const base = lastPmDate(c) ?? parseCellDate(c['Gate In (Rayong yard)']) ?? parseCellDate(c['Gate In Date'])
      if (base == null) continue
      const k = keyOf(c)
      if (!grid.has(k)) grid.set(k, Array.from({ length: daysInMonth + 1 }, () => [] as string[]))
      const lane = grid.get(k)!
      const step = interval * DAY_MS
      let n = Math.max(1, Math.ceil((monthStart - base) / step))
      for (let due = base + n * step; due <= monthEnd; due += step) {
        if (due < monthStart) continue
        lane[new Date(due).getDate()].push(row.vin)
      }
    }
    const modelRows = [...grid.entries()]
      .map(([k, dayVins]) => {
        const [model, variant] = k.split('|')
        const cells = dayVins.map((v) => v.length)
        const sum = cells.reduce((a, b) => a + b, 0)
        return { key: k, model, variant, dayVins, cells, sum }
      })
      .filter((r) => r.sum > 0)
      .sort((a, b) => a.model.localeCompare(b.model) || a.variant.localeCompare(b.variant))

    // Actual: PMs REALLY recorded on each day of this month (PM1…PM15 cells).
    // Counted across every in-scope row regardless of allocation — work that
    // was done is work that was done. actualVins mirrors the counts so the
    // footer's numbers can open the same Unit-List filter the grid's own
    // day cells already do — a manager reading "Actual 7" wants those 7 VINs,
    // not just the number.
    const actual = new Array(daysInMonth + 1).fill(0)
    const actualVins: string[][] = Array.from({ length: daysInMonth + 1 }, () => [])
    for (const row of rows) {
      const c = row.cells
      const siteId = row.site ?? siteIdForLocation(c, sites) ?? null
      if (!inScope(siteId)) continue
      for (const k of PM_KEYS) {
        const t = parseCellDate(c[k])
        if (t != null && t >= monthStart && t <= monthEnd) { const d = new Date(t).getDate(); actual[d]++; actualVins[d].push(row.vin) }
      }
    }
    return { modelRows, actual, actualVins }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triage, rows, sites, year, month, daysInMonth, siteSel])

  // Total row's own per-day VIN lists — the union of every model row's due
  // cars that day, so the footer's Total cell opens the same list its column
  // of model rows sums to (not the model, the whole day).
  const { colTotals, totalDayVins } = useMemo(() => {
    const t = new Array(daysInMonth + 1).fill(0)
    const v: string[][] = Array.from({ length: daysInMonth + 1 }, () => [])
    for (const r of plan.modelRows) for (let d = 1; d <= daysInMonth; d++) { t[d] += r.cells[d]; if (r.dayVins[d].length) v[d].push(...r.dayVins[d]) }
    return { colTotals: t, totalDayVins: v }
  }, [plan.modelRows, daysInMonth])
  const grand = plan.modelRows.reduce((a, r) => a + r.sum, 0)
  const actualSum = plan.actual.reduce((a: number, b: number) => a + b, 0)

  // month-wide VIN sets for the footer's rightmost "Total" cell of each row —
  // deduped, since a 30-day cadence can land a car on two different days
  // within one month while the day cells (and the numbers above) count both
  const dedupe = (lists: string[][]) => { const s = new Set<string>(); for (const l of lists) for (const v of l) s.add(v); return [...s] }
  const grandVins = useMemo(() => dedupe(totalDayVins), [totalDayVins])
  const actualMonthVins = useMemo(() => dedupe(plan.actualVins), [plan.actualVins])

  // Diff = Plan − Actual, so its cars are a set difference, not a count of
  // its own: positive means cars due that day with no PM recorded yet
  // (ค้าง — still pending), negative means PMs recorded that day for cars
  // not actually due (ทำเกินแผน — ahead of schedule / catch-up work).
  const diffVins = useMemo(() => Array.from({ length: daysInMonth + 1 }, (_, d) => {
    if (d === 0) return { pending: [] as string[], extra: [] as string[] }
    const due = new Set(totalDayVins[d]), done = new Set(plan.actualVins[d])
    return { pending: [...due].filter((v) => !done.has(v)), extra: [...done].filter((v) => !due.has(v)) }
  }), [totalDayVins, plan.actualVins, daysInMonth])
  const diffMonthVins = useMemo(() => ({
    pending: dedupe(diffVins.map((x) => x.pending)),
    extra: dedupe(diffVins.map((x) => x.extra)),
  }), [diffVins])

  // ── tab 2: the per-VIN PM Status register ─────────────────────────────────
  const status = useMemo(() => {
    const needle = q.trim().toUpperCase()
    const list = triage.eligible
      .map(({ row }) => row)
      .filter((r) => !needle
        || r.vin.includes(needle)
        || (r.cells['Model name'] || '').toUpperCase().includes(needle)
        || modelOf(r.cells).toUpperCase().includes(needle))
      .sort((a, b) => modelOf(a.cells).localeCompare(modelOf(b.cells)) || a.vin.localeCompare(b.vin))
    // how many PM rounds actually carry a date, over the whole register —
    // that's how many PM columns the table needs (at least 1, like the sheet)
    let maxPm = 1
    for (const r of list) {
      for (let i = PM_KEYS.length - 1; i >= maxPm; i--) {
        if ((r.cells[PM_KEYS[i]] || '').trim()) { maxPm = i + 1; break }
      }
    }
    return { list, maxPm }
  }, [triage, q])

  // history logs each write under the column LABEL (falling back to the key) —
  // accept either name when digging a round's values back out
  const columns = useTracking((s) => s.columns)
  const measNames = useMemo(() => new Map(MEAS.map((m) => {
    const label = columns.find((x) => x.key === m.key)?.label ?? m.key
    return [m.key, new Set([m.key, label])] as const
  })), [columns])

  /**
   * The values each PM round was recorded with. ค่าแต่ละรอบไม่เหมือนกัน — the
   * live cells only hold the LATEST round's numbers, but every save also left
   * a history line stamped with when it happened, so a round's values are the
   * history entries written on that round's PM date. The latest round falls
   * back to the live cells (imported rows carry no history at all).
   */
  const roundVals = (r: TrackRow, count: number): { date: string; vals: string[] }[] => {
    const c = r.cells
    const hist = r.history ?? []
    let lastIdx = -1
    for (let i = 0; i < count; i++) if ((c[PM_KEYS[i]] || '').trim()) lastIdx = i
    return Array.from({ length: count }, (_, i) => {
      const date = (c[PM_KEYS[i]] || '').trim()
      if (!date) return { date: '', vals: MEAS.map(() => '') }
      const t = parseCellDate(c[PM_KEYS[i]])
      const vals = MEAS.map((m) => {
        const names = measNames.get(m.key)!
        let v = ''
        if (t != null) for (const h of hist) if (names.has(h.field) && sameDay(h.at, t)) v = h.to
        if (!v && i === lastIdx) v = (c[m.key] || '').trim()
        return v
      })
      return { date, vals }
    })
  }

  const now = new Date()
  const todayDay = now.getFullYear() === year && now.getMonth() + 1 === month ? now.getDate() : -1
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1)
  const isSunday = (d: number) => new Date(year, month - 1, d).getDay() === 0

  // click a number anywhere on this grid → open the Unit List filtered to
  // exactly the cars behind it. Shared by the model rows AND the footer's
  // Total / Actual / Diff — a manager reading any of these numbers wants the
  // cars, not just the count.
  const openVins = (label: string, vins: string[]) => {
    if (!vins.length) return
    if (siteSel !== 'all' && siteSel !== currentSite) setCurrentSite(siteSel) // Unit List is per-yard
    setView('units')
    setUnitVinFilter({ label, vins })
    toast('ok', `กรอง ${vins.length} คัน — ${label}`)
  }
  const openCell = (label: string, day: number, vins: string[]) => openVins(`PM ${label} ${day}/${month}`, vins)

  const sendLine = () => {
    const lines = [
      `แผน PM ${MONTH_EN[month - 1]} ${year}${siteSel !== 'all' ? ` · ${siteList.find((s) => s.id === siteSel)?.short ?? ''}` : ''}`,
      ...plan.modelRows.map((r) => `${r.model} ${r.variant}: ${r.sum.toLocaleString()}`),
      `Plan รวม: ${grand.toLocaleString()} คัน · Actual: ${actualSum.toLocaleString()} คัน`,
    ]
    window.open(`https://line.me/R/msg/text/?${encodeURIComponent(lines.join('\n'))}`, '_blank')
    toast('ok', 'เปิด LINE เพื่อส่งสรุปแผน PM')
  }

  const colBg = (d: number) => (d === todayDay ? 'rgba(16,185,129,0.10)' : isSunday(d) ? 'rgba(239,68,68,0.06)' : undefined)
  const numColor = (v: number, d: number) => (v === 0 ? (isSunday(d) ? '#f87171' : 'var(--faint)') : 'var(--text)')
  const thMonth = new Date(year, month - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })

  const SHOW_CAP = 400
  const shownStatus = status.list.slice(0, SHOW_CAP)
  const pmCols = PM_KEYS.slice(0, status.maxPm)

  const isDayTab = tab === 'list' || tab === 'defect' || tab === 'time'
  // one workbook for the day's three tables, same as the PDI board
  const doExport = async () => {
    setExporting(true)
    try {
      await exportStationReport(ctx, 'PM')
      toast('ok', `ออกไฟล์ PM (${dayLabel}) แล้ว`)
    } catch (e) { console.error('[pm] export', e); toast('err', 'ออกไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง') }
    finally { setExporting(false) }
  }

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="panel p-4 mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <PageHead
            title={<span className="flex items-center gap-2"><CalendarClock size={20} style={{ color: 'var(--brand)' }} /> Update Plan &amp; Actual PM</span>}
            sub={`${MONTH_EN[month - 1]} ${year} — PM ทุก 30 วัน (38 ไร่ ทุก 90 วัน) · รถที่มี Allocation Date ถูกตัดออก (เตรียมขายแล้ว ทำ PM ไม่ได้)`}
          />
        </div>
        {/* yard selector — own site or all */}
        <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--chip)' }}>
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>Site:</span>
          <select className="bg-transparent outline-none text-[13px] font-bold" style={{ color: 'var(--brand)' }} value={siteSel} onChange={(e) => setSiteSel(e.target.value)}>
            <option value="all">ทุก site งาน</option>
            {siteList.map((r) => <option key={r.id} value={r.id}>{r.short}</option>)}
          </select>
        </label>
        {/* the daily tables pick a DAY; the plan grid picks a MONTH */}
        {isDayTab && (
          <>
            <DayPicker days={dayCounts} value={day} onChange={setDay} />
            <button className="btn btn-primary px-3 py-2 text-[12.5px]" onClick={doExport} disabled={exporting}
              title="ออกไฟล์ Excel ของวันนี้ — 3 ชีท: PM · PM DEFECT · ตาราง PM">
              <Download size={14} /> {exporting ? 'กำลังสร้างไฟล์…' : 'Export Excel'}
            </button>
          </>
        )}
        {tab === 'plan' && (
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--chip)' }}>
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>เดือน:</span>
            <input type="month" className="bg-transparent outline-none text-[13px] font-bold tabular" style={{ color: 'var(--brand)' }} value={ym} onChange={(e) => e.target.value && setYm(e.target.value)} />
          </label>
        )}
        {tab === 'plan' && (
          <button className="btn btn-primary px-4 py-2" onClick={sendLine} style={{ background: '#06c755', border: 'none' }}>
            <Send size={15} /> ส่ง LINE
          </button>
        )}
      </div>

      {/* ── 1–3 the station's daily tables · 4 the plan grid · 5 the register ── */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {DAY_TABS.map((t, i) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cx('btn px-3 py-2 text-[13px] font-bold', tab === t.id && 'btn-primary')}>
            {i + 1}. {t.label}
          </button>
        ))}
        <button onClick={() => setTab('plan')}
          className="btn px-4 py-2 text-[13px] font-bold flex items-center gap-1.5"
          style={tab === 'plan'
            ? { background: 'var(--brand)', color: '#fff', border: 'none' }
            : { background: 'var(--chip)', color: 'var(--muted)', border: '1px solid var(--line)' }}>
          <Table2 size={14} /> 4. ตารางแผน PM · {thMonth}
        </button>
        <button onClick={() => setTab('status')}
          className="btn px-4 py-2 text-[13px] font-bold flex items-center gap-1.5"
          style={tab === 'status'
            ? { background: 'var(--brand)', color: '#fff', border: 'none' }
            : { background: 'var(--chip)', color: 'var(--muted)', border: '1px solid var(--line)' }}>
          <ClipboardList size={14} /> 5. PM STATUS
          <span className="badge text-[11px]" style={tab === 'status'
            ? { background: 'rgba(255,255,255,0.22)', color: '#fff' }
            : { background: 'var(--panel)', color: 'var(--muted)' }}>{status.list.length.toLocaleString()}</span>
        </button>
        {triage.cutAllocated > 0 && (
          <span className="text-[12px] ml-2" style={{ color: 'var(--muted)' }}>
            ตัดออก <b style={{ color: '#dc2626' }}>{triage.cutAllocated.toLocaleString()}</b> คัน (มี Allocation Date — เตรียมขายแล้ว)
          </span>
        )}
      </div>

      {isDayTab && <StationTables ctx={ctx} tab={tab} kind="PM" />}

      {tab === 'plan' && (
        <>
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="text-[11.5px] tabular" style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
                <thead>
                  <tr style={{ background: 'var(--chip)' }}>
                    <th className="sticky left-0 z-10 px-3 py-2 text-left font-bold whitespace-nowrap"
                      style={{ background: 'var(--chip)', color: 'var(--muted)', minWidth: 110, borderBottom: '1px solid var(--line)' }}>MODEL</th>
                    <th className="px-2 py-2 text-left font-bold whitespace-nowrap"
                      style={{ color: 'var(--muted)', minWidth: 78, borderBottom: '1px solid var(--line)' }}>VARIANT</th>
                    {days.map((d) => (
                      <th key={d} className="px-1.5 py-2 text-center font-bold" title={isSunday(d) ? 'อาทิตย์' : undefined}
                        style={{ minWidth: 30, color: isSunday(d) ? '#dc2626' : 'var(--muted)', background: colBg(d), borderBottom: '1px solid var(--line)', ...(d === todayDay ? { boxShadow: 'inset 0 0 0 2px #10b981' } : {}) }}>
                        {d}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-center font-bold" style={{ minWidth: 56, color: 'var(--brand)', background: 'var(--brand-soft, #eef4ff)', borderBottom: '1px solid var(--line)' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.modelRows.map((r) => (
                    <tr key={r.key} className="hover:bg-chip">
                      <td className="sticky left-0 z-10 px-3 py-2 font-bold whitespace-nowrap"
                        style={{ background: 'var(--panel, #fff)', color: 'var(--text)', borderBottom: '1px solid var(--line)' }}>{r.model}</td>
                      <td className="px-2 py-2 whitespace-nowrap" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>{r.variant}</td>
                      {days.map((d) => {
                        const v = r.cells[d]
                        return (
                          <td key={d} onClick={() => openCell(`${r.model} ${r.variant}`, d, r.dayVins[d])}
                            className="px-1.5 py-2 text-center transition-colors"
                            title={v ? `คลิกเพื่อดู ${v} คัน` : undefined}
                            style={{ color: numColor(v, d), background: colBg(d), borderBottom: '1px solid var(--line)', fontWeight: v ? 700 : 400, cursor: v ? 'pointer' : 'default' }}
                            onMouseEnter={(e) => { if (v) (e.currentTarget.style.background = 'rgba(37,99,235,0.12)') }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = colBg(d) ?? '' }}>
                            {v}
                          </td>
                        )
                      })}
                      <td className="px-3 py-2 text-center font-black" style={{ color: 'var(--brand)', background: 'var(--brand-soft, #eef4ff)', borderBottom: '1px solid var(--line)' }}>{r.sum.toLocaleString()}</td>
                    </tr>
                  ))}
                  {/* the sheet's three footer rows: Total (plan) · Actual · Diff —
                      every number here opens the same Unit-List filter the
                      model-row cells above already do, so a manager reading
                      "Total 44" or "Diff. 7" gets straight to those cars
                      instead of having to hunt them down row by row. */}
                  <tr style={{ background: 'var(--chip)' }}>
                    <td className="sticky left-0 z-10 px-3 py-2.5 font-black whitespace-nowrap" style={{ background: 'var(--chip)', color: 'var(--text)' }}>Total</td>
                    <td />
                    {days.map((d) => (
                      <td key={d} onClick={() => openVins(`PM Total ${d}/${month}`, totalDayVins[d])}
                        className="px-1.5 py-2.5 text-center font-bold transition-colors"
                        title={colTotals[d] ? `คลิกเพื่อดู ${colTotals[d]} คัน` : undefined}
                        style={{ color: numColor(colTotals[d], d), background: colBg(d), cursor: colTotals[d] ? 'pointer' : 'default', ...(d === todayDay ? { boxShadow: 'inset 0 0 0 2px #10b981' } : {}) }}
                        onMouseEnter={(e) => { if (colTotals[d]) e.currentTarget.style.background = 'rgba(37,99,235,0.12)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = colBg(d) ?? '' }}>
                        {colTotals[d]}
                      </td>
                    ))}
                    <td onClick={() => openVins(`PM Total ${thMonth}`, grandVins)}
                      className="px-3 py-2.5 text-center font-black text-white transition-colors"
                      title={grandVins.length ? `คลิกเพื่อดู ${grandVins.length} คัน` : undefined}
                      style={{ background: 'var(--brand)', cursor: grandVins.length ? 'pointer' : 'default' }}>
                      {grand.toLocaleString()}
                    </td>
                  </tr>
                  <tr style={{ background: 'rgba(22,163,74,0.07)' }}>
                    <td className="sticky left-0 z-10 px-3 py-2.5 font-black whitespace-nowrap" style={{ background: 'rgba(22,163,74,0.10)', color: '#15803d' }}>Actual</td>
                    <td />
                    {days.map((d) => (
                      <td key={d} onClick={() => openVins(`PM Actual ${d}/${month}`, plan.actualVins[d])}
                        className="px-1.5 py-2.5 text-center font-bold transition-colors"
                        title={plan.actual[d] ? `คลิกเพื่อดู ${plan.actual[d]} คัน` : undefined}
                        style={{ color: plan.actual[d] ? '#15803d' : 'var(--faint)', background: colBg(d), cursor: plan.actual[d] ? 'pointer' : 'default' }}
                        onMouseEnter={(e) => { if (plan.actual[d]) e.currentTarget.style.background = 'rgba(37,99,235,0.12)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = colBg(d) ?? '' }}>
                        {plan.actual[d]}
                      </td>
                    ))}
                    <td onClick={() => openVins(`PM Actual ${thMonth}`, actualMonthVins)}
                      className="px-3 py-2.5 text-center font-black text-white transition-colors"
                      title={actualMonthVins.length ? `คลิกเพื่อดู ${actualMonthVins.length} คัน` : undefined}
                      style={{ background: '#16a34a', cursor: actualMonthVins.length ? 'pointer' : 'default' }}>
                      {actualSum.toLocaleString()}
                    </td>
                  </tr>
                  <tr style={{ background: 'rgba(234,88,12,0.06)' }}>
                    <td className="sticky left-0 z-10 px-3 py-2.5 font-black whitespace-nowrap" style={{ background: 'rgba(234,88,12,0.10)', color: '#c2410c' }}>Diff.</td>
                    <td />
                    {days.map((d) => {
                      const diff = colTotals[d] - plan.actual[d]
                      const dv = diffVins[d]
                      const label = diff > 0 ? `PM ค้าง ${d}/${month}` : `PM ทำเกินแผน ${d}/${month}`
                      const vins = diff > 0 ? dv.pending : diff < 0 ? dv.extra : []
                      return (
                        <td key={d} onClick={() => openVins(label, vins)}
                          className="px-1.5 py-2.5 text-center font-bold transition-colors"
                          title={vins.length ? `คลิกเพื่อดู ${vins.length} คัน — ${diff > 0 ? 'ค้าง PM' : 'ทำเกินแผน'}` : undefined}
                          style={{ color: diff > 0 ? '#c2410c' : diff < 0 ? '#15803d' : 'var(--faint)', background: colBg(d), cursor: vins.length ? 'pointer' : 'default' }}
                          onMouseEnter={(e) => { if (vins.length) e.currentTarget.style.background = 'rgba(37,99,235,0.12)' }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = colBg(d) ?? '' }}>
                          {diff}
                        </td>
                      )
                    })}
                    {(() => {
                      const diffGrand = grand - actualSum
                      const vins = diffGrand > 0 ? diffMonthVins.pending : diffGrand < 0 ? diffMonthVins.extra : []
                      const label = diffGrand > 0 ? `PM ค้าง ${thMonth}` : `PM ทำเกินแผน ${thMonth}`
                      return (
                        <td onClick={() => openVins(label, vins)}
                          className="px-3 py-2.5 text-center font-black text-white transition-colors"
                          title={vins.length ? `คลิกเพื่อดู ${vins.length} คัน` : undefined}
                          style={{ background: '#ea580c', cursor: vins.length ? 'pointer' : 'default' }}>
                          {diffGrand.toLocaleString()}
                        </td>
                      )
                    })()}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          {grand === 0 && (
            <div className="text-center text-[13px] mt-4" style={{ color: 'var(--faint)' }}>
              ไม่มีรถที่ถึงกำหนด PM ในเดือนนี้ — ลองเลือกเดือนอื่น/site อื่น หรือตรวจสอบวันที่ Gate In / PM ในข้อมูล
            </div>
          )}
        </>
      )}

      {tab === 'status' && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2.5 border-b hairline flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-2 px-3 py-1.5 rounded-xl flex-1 min-w-[220px] max-w-[380px]" style={{ background: 'var(--chip)' }}>
              <Search size={14} style={{ color: 'var(--muted)' }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา VIN / รุ่น…"
                className="bg-transparent outline-none text-[13px] w-full" />
            </label>
            <span className="text-[12px] ml-auto" style={{ color: 'var(--muted)' }}>
              {status.list.length > SHOW_CAP
                ? `แสดง ${SHOW_CAP} จาก ${status.list.length.toLocaleString()} คัน — พิมพ์ค้นหาเพื่อกรอง`
                : `${status.list.length.toLocaleString()} คัน`}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="text-[11.5px] tabular" style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
              <thead>
                {/* two-row header exactly like the workbook: each PM round is a
                    group of วันที่ + %SOC/ODO/12V + ลมยาง 4 ล้อ */}
                <tr style={{ background: 'var(--chip)' }}>
                  {['No.', 'Vin', 'Model name', 'Model', 'Color', 'Gate In'].map((h, i) => (
                    <th key={h} rowSpan={2} className={`px-2.5 py-2 font-bold whitespace-nowrap ${i === 1 ? 'text-left' : 'text-center'}`}
                      style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)', ...(i === 1 ? { position: 'sticky', left: 0, zIndex: 10, background: 'var(--chip)' } : {}) }}>
                      {h}
                    </th>
                  ))}
                  {pmCols.map((k, gi) => (
                    <th key={k} colSpan={1 + MEAS.length} className="px-2.5 py-1.5 text-center font-bold whitespace-nowrap"
                      style={{ color: 'var(--brand)', borderBottom: '1px solid var(--line)', borderLeft: '2px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.06)' : 'var(--chip)' }}>
                      PM {gi + 1}
                    </th>
                  ))}
                  {['Location', 'หมายเหตุ'].map((h) => (
                    <th key={h} rowSpan={2} className="px-2.5 py-2 text-center font-bold whitespace-nowrap"
                      style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)', borderLeft: '2px solid var(--line)' }}>{h}</th>
                  ))}
                </tr>
                <tr style={{ background: 'var(--chip)' }}>
                  {pmCols.flatMap((k, gi) => [
                    <th key={`${k}-d`} className="px-2 py-1.5 text-center font-bold whitespace-nowrap"
                      style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)', borderLeft: '2px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.06)' : undefined }}>วันที่</th>,
                    ...MEAS.map((m) => (
                      <th key={`${k}-${m.key}`} className="px-2 py-1.5 text-center font-semibold whitespace-nowrap"
                        style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.06)' : undefined }}>{m.head}</th>
                    )),
                  ])}
                </tr>
              </thead>
              <tbody>
                {shownStatus.map((r, i) => {
                  const c = r.cells
                  const rounds = roundVals(r, status.maxPm)
                  return (
                    <tr key={r.vin} className="hover:bg-chip">
                      <td className="px-2.5 py-1.5 text-center" style={{ color: 'var(--faint)', borderBottom: '1px solid var(--line)' }}>{i + 1}</td>
                      <td className="px-2.5 py-1.5 vin font-semibold whitespace-nowrap"
                        style={{ position: 'sticky', left: 0, zIndex: 5, background: 'var(--panel, #fff)', borderBottom: '1px solid var(--line)' }}>{r.vin}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{c['Model name'] || '—'}</td>
                      <td className="px-2.5 py-1.5 text-center whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{modelOf(c)}</td>
                      <td className="px-2.5 py-1.5 text-center whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{c['Color'] || '—'}</td>
                      <td className="px-2.5 py-1.5 text-center whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{c['Gate In (Rayong yard)'] || c['Gate In Date'] || '—'}</td>
                      {rounds.flatMap((rd, gi) => [
                        <td key={`d${gi}`} className="px-2 py-1.5 text-center whitespace-nowrap font-semibold"
                          style={{ color: rd.date ? '#15803d' : 'var(--faint)', borderBottom: '1px solid var(--line)', borderLeft: '2px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.035)' : undefined }}>
                          {rd.date || '—'}
                        </td>,
                        ...rd.vals.map((v, mi) => (
                          <td key={`v${gi}-${mi}`} className="px-2 py-1.5 text-center whitespace-nowrap"
                            style={{ color: v ? 'var(--text)' : 'var(--faint)', borderBottom: '1px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.035)' : undefined }}>
                            {v || '—'}
                          </td>
                        )),
                      ])}
                      <td className="px-2.5 py-1.5 text-center whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)', borderLeft: '2px solid var(--line)' }}>{c['Location yard'] || '—'}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>{c['หมายเหตุ'] || c['Remark'] || ''}</td>
                    </tr>
                  )
                })}
                {shownStatus.length === 0 && (
                  <tr><td colSpan={8 + pmCols.length * (1 + MEAS.length)} className="px-4 py-8 text-center" style={{ color: 'var(--faint)' }}>
                    ไม่พบรถที่เข้าเงื่อนไข PM {q ? `ที่ตรงกับ "${q}"` : ''} — รถที่มี Allocation Date ถูกตัดออกจากตารางนี้
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
