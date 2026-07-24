import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Search, Filter, Download, Columns3, RefreshCw, Trash2, X,
  ArrowUpDown, ChevronUp, ChevronDown, ChevronRight, Plus, Database,
  FileText, List as ListIcon, ClipboardList, Eye, Copy, MapPin,
  Car, Clock, ShieldCheck, Route, Printer, CheckSquare, Check, History, Pencil,
  SlidersHorizontal, Lock,
} from 'lucide-react'
import { CarTopView } from '../components/CarTopView'
import { printIr, printDn, printIrPaper } from '../lib/dnir'
import { useYard } from '../store/useYard'
import { useTracking, useTrackingRows, useVisibleColumns } from '../store/useTracking'
import { CAR_STATUS_VALUES, GROUP_LABEL, SELECT_DATA_KEYS, LOCATION_KEY, MAX_FILTERS, DEFAULT_FILTER_COLS, agingPmDays, cleanStorage, isDateColumn, fmtSerialToDate, type ColGroup, type Column } from '../lib/trackingColumns'
import { siteGroupingConfig, yardLocFull } from '../lib/groupingImport'
import { CAR_STATUS_META, deriveCarStatus, IN_YARD_STATUSES, PARKED_STATUSES, isWaitingRepair, finalColor, vinOfStatusColor, taxStatusColor } from '../lib/carStatus'
import { rowsToCsv, type TrackRow, type RowEvent } from '../lib/excelTracking'
import { printFindList, exportFindListXlsx } from '../lib/groupingPrint'
import { matchVins, toFindListRows } from '../lib/findCar'
import { rowInSite } from '../lib/siteScope'
import { zoneLabel } from '../components/CarDiagramMultiView'
import { partLabel, defectLabel } from '../lib/damageLabel'
import { resolvePart, resolveDefect } from '../lib/masterDefect'
import { cx, PhotoLightbox } from '../components/ui'
import { useQueues } from '../store/useOps'

const DMG_SRC: Record<string, string> = { walkaround: 'Walk-around', pdi: 'PDI', mechanic: 'ช่าง', update: 'Update', yardDefect: 'Defect-Yard', factoryDefect: 'Defect-Factory', whaleDefect: 'Defect-Whale', manual: 'เพิ่มเอง' }

// blank add-damage form for the Damages tab
const BLANK_DMG_FORM = { position: '', defect: '', categoryNG: '', categoryRepair: '', incharge: '', note: '', date: '', statusRepair: 'Waiting Repair', repairDate: '' }

// combobox: free-type + pick from a <datalist> of values seen in the imported data
function Combo({ value, onChange, options, placeholder, id, type = 'text' }: { value: string; onChange: (v: string) => void; options?: string[]; placeholder?: string; id?: string; type?: string }) {
  return (
    <>
      <input list={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full min-w-[68px] px-1.5 py-1 rounded outline-none focus:ring-1"
        style={{ border: '1px solid var(--line-strong)', background: 'var(--panel)', fontSize: 11 }} />
      {options && id && <datalist id={id}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
    </>
  )
}

// dashboard quick-filter presets (card → Unit List), matching the dashboard's KPI logic
const PRESET_LABEL: Record<string, string> = { inYard: 'In Yard', parked: 'Parked', gatein: 'Gate In', expected: 'Pre Gate-in', damage: 'Waiting Repair', preGateOut: 'Pre Gate-out', preload: 'Preload' }
// Summary-table cell preset: "sum:<Model>|<Final Status>" ('' = blank-status
// bucket, '*' = any — used by the รวม row/column totals). The match must mirror
// YardSummary's counting exactly (same model derivation + in-yard scope) so the
// Unit List shows the same number the cell displayed.
const parseSumPreset = (preset: string): { model: string; final: string } | null => {
  if (!preset.startsWith('sum:')) return null
  const i = preset.lastIndexOf('|')
  return { model: preset.slice(4, i), final: preset.slice(i + 1) }
}
export const presetChipLabel = (preset: string): string => {
  const sum = parseSumPreset(preset)
  if (!sum) return PRESET_LABEL[preset] ?? preset
  if (sum.model === '*' && sum.final === '*') return 'In Yard (ทั้งหมด)'
  const m = sum.model === '*' ? 'ทุกรุ่น' : sum.model
  const f = sum.final === '*' ? 'ทุกสถานะ' : sum.final || '(ว่าง)'
  return `${m} · ${f}`
}
const presetMatch = (preset: string, r: TrackRow): boolean => {
  const cs = deriveCarStatus(r.cells)
  const sum = parseSumPreset(preset)
  if (sum) {
    if (!IN_YARD_STATUSES.has(cs)) return false
    const model = (r.cells['Model'] || r.cells['Model name'] || '—').trim() || '—'
    const final = (r.cells['Final Status'] || '').trim()
    if (sum.model !== '*' && model !== sum.model) return false
    if (sum.final !== '*' && final !== sum.final) return false
    return true
  }
  switch (preset) {
    case 'inYard':     return IN_YARD_STATUSES.has(cs)
    case 'parked':     return PARKED_STATUSES.has(cs)
    case 'gatein':     return cs === 'Gate-in'
    case 'expected':   return cs === 'Pre Gate-in'
    case 'preGateOut': return cs === 'Pre Gate-out'
    case 'preload':    return cs === 'Preload'
    // match the Dashboard "Damage" KPI exactly: waiting-repair cars that are
    // still IN YARD (a gated-out / preload / pre-gate-in car waiting repair is
    // counted by neither — otherwise the drill-down over-counts by those).
    case 'damage':     return IN_YARD_STATUSES.has(cs) && isWaitingRepair(r.cells)
    default:           return true
  }
}

// Status Repair options + colour (editable in the Damages tab)
const REPAIR_STATUSES = ['Waiting Repair', 'Repaired', 'Accept'] as const
// compact Excel-like date (27 Jun 26) for the defect table
const fmtDay = (ts: number) => new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
const repairColor = (s?: string): { color: string; background: string } =>
  s === 'Repaired' || s === 'Accept' ? { color: '#16a34a', background: '#dcfce7' }
  : s === 'Waiting Repair' ? { color: '#b45309', background: '#fef3c7' }
  : { color: '#dc2626', background: '#fee2e2' }
/** Full date-time "DD/MM/YYYY HH:MM" for defect / repair history. */
function fmtDT(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const ROW_H = 28
const GUTTER = 14 // small left pad (checkbox column removed)
const GROUPING_KEY = 'Grouping  Number'

// strip everything but A–Z/0–9 so a pasted VIN with stray spaces, dashes, line
// breaks or hidden unicode (common when copied from Excel / a label) still matches
const normKey = (s: string) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
// fields the "Unit Nbr" box searches across
const SEARCH_KEYS = ['Vin', 'Model name', 'Model', GROUPING_KEY, 'company', 'Location yard', 'storage Yard', 'PIC (PDI)']

const COLOR_SW: Record<string, string> = {
  BLACK: '#23282f', GREY: '#828a93', GRAY: '#828a93', WHITE: '#eef1f4',
  'WHITE(CREAM)': '#efe7d2', WHITECREAM: '#efe7d2', BLUE: '#2f6fed', GREEN: '#2f9e6f', RED: '#d23a3a',
}

type SortDir = 1 | -1
type Tab = 'grouping' | 'units' | 'mylist'

// Filter bar: Unit Nbr + Grouping are pinned; every other filter is a COLUMN
// chosen from the column manager (up to MAX_FILTERS). The config now lives in
// the tracking store (persisted + part of the shared "default view" preset).

export function Units() {
  const { focus, setFocus } = useYard()
  const unitPreset = useYard((s) => s.unitPreset)
  const setUnitPreset = useYard((s) => s.setUnitPreset)
  const unitVinFilter = useYard((s) => s.unitVinFilter)
  const setUnitVinFilter = useYard((s) => s.setUnitVinFilter)
  // explicit VIN set from a drill-down (e.g. a PM-plan cell) — O(1) membership
  const vinFilterSet = useMemo(() => (unitVinFilter ? new Set(unitVinFilter.vins) : null), [unitVinFilter])
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const allRows = useTrackingRows()
  // per-yard separation: the whole Unit List only ever shows the active site
  const rows = useMemo(
    () => (currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows),
    [allRows, currentSite, sites],
  )
  const visCols = useVisibleColumns()
  const { lastImport, loadFromIdb } = useTracking()
  // computed yard-location code (prefix-block+row+slot), for the Location column.
  // ONLY the real placement code — no cell fallback (storage Yard / Location yard
  // are junk / the site name, not a position → they showed stray numbers).
  const allUnits = useYard((s) => s.units)
  const locPrefix = siteGroupingConfig(sites.find((x) => x.id === currentSite)?.name ?? '').prefix
  const locOf = (r: TrackRow) => yardLocFull(allUnits[r.vin], locPrefix)

  const [tab, setTab] = useState<Tab>('units')
  const [q, setQ] = useState('')
  const [fGroup, setFGroup] = useState('')
  // generic per-column filters: column key → selected value ('ALL'/'' = off)
  const [colFilters, setColFilters] = useState<Record<string, string>>({})
  const setColFilter = (key: string, v: string) => setColFilters((m) => ({ ...m, [key]: v }))
  const [filtersOpen, setFiltersOpen] = useState(true)
  const filterCols = useTracking((s) => s.filterCols)
  const setFilterCols = useTracking((s) => s.setFilterCols)
  const [filterMgr, setFilterMgr] = useState(false)
  // only apply filters whose column is currently visible in the table
  const visColKeys = useMemo(() => new Set(visCols.map((c) => c.key)), [visCols])
  const colByKey = useMemo(() => new Map(visCols.map((c) => [c.key, c])), [visCols])
  const activeFilterCols = useMemo(() => filterCols.filter((k) => visColKeys.has(k)), [filterCols, visColKeys])
  const [sortKey, setSortKey] = useState('No')
  // "Last update" sorts NEWEST-FIRST by default: editing a cell bumps the row's
  // updatedAt, and with ascending order the edited row silently teleported to
  // the far END of the list — the user saw "nothing changed" because the row
  // they edited vanished from view. Descending pops it to the top instead.
  const [sortDir, setSortDir] = useState<SortDir>(-1)

  const [sel, setSel] = useState<Set<string>>(new Set())
  const [colMgr, setColMgr] = useState(false)

  useEffect(() => { loadFromIdb() }, [loadFromIdb])
  useEffect(() => { if (import.meta.env.DEV) (window as any).__tracking = useTracking }, [])
  useEffect(() => { if (focus) { setQ(focus); setTab('units'); setFocus(null) } }, [focus, setFocus])
  // a dashboard card / PM-plan cell opened us with a quick-filter → show the list
  useEffect(() => { if (unitPreset) setTab('units') }, [unitPreset])
  useEffect(() => { if (unitVinFilter) setTab('units') }, [unitVinFilter])

  const grabDistinct = (key: string) => {
    const set = new Set<string>()
    for (const r of rows) { const v = r.cells[key]; if (v) set.add(v) }
    return [...set].sort()
  }
  // distinct value list for a filter column ('Car Status' uses the derived
  // lifecycle status, not the raw cell, so gate-out logic stays consistent)
  const distinctFor = (key: string): string[] => {
    if (key === 'Car Status') {
      const present = new Set(rows.map((r) => deriveCarStatus(r.cells)))
      return CAR_STATUS_VALUES.filter((v) => present.has(v))
    }
    if (key === LOCATION_KEY) {
      const set = new Set<string>()
      for (const r of rows) { const v = locOf(r); if (v) set.add(v) }
      return [...set].sort()
    }
    return grabDistinct(key)
  }
  const filterOptions = useMemo(() => {
    const o: Record<string, string[]> = {}
    for (const key of activeFilterCols) o[key] = distinctFor(key)
    return o
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, activeFilterCols])

  const liveOpts = useMemo(() => {
    const o: Record<string, string[]> = {}
    for (const key of SELECT_DATA_KEYS) o[key] = grabDistinct(key)
    return o
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])
  const optionsFor = (col: Column): string[] =>
    [...new Set([...(col.options ?? []), ...(liveOpts[col.key] ?? [])])].sort()

  // pre-normalized search blob per row (built once per dataset, not per keystroke)
  const searchIndex = useMemo(
    () => rows.map((r) => normKey([r.vin, ...SEARCH_KEYS.map((k) => r.cells[k] || '')].join(' '))),
    [rows],
  )

  const filtered = useMemo(() => {
    const query = normKey(q)
    const g = normKey(fGroup)
    let arr = rows.filter((r, i) => {
      if (query && !searchIndex[i].includes(query)) return false
      if (g && !normKey(r.cells[GROUPING_KEY] || '').includes(g)) return false
      // per-column filters — only those whose column is currently visible
      for (const key of activeFilterCols) {
        const val = colFilters[key]
        if (!val || val === 'ALL') continue
        const cell = key === 'Car Status' ? deriveCarStatus(r.cells) : key === LOCATION_KEY ? locOf(r) : (r.cells[key] ?? '')
        if (cell !== val) return false
      }
      if (unitPreset && !presetMatch(unitPreset, r)) return false
      if (vinFilterSet && !vinFilterSet.has(r.vin)) return false
      return true
    })
    arr = [...arr].sort((a, b) => {
      if (sortKey === 'No') { // "Last update" column → sort by timestamp (No order as tiebreaker)
        const d = (a.updatedAt ?? 0) - (b.updatedAt ?? 0)
        return (d || (Number(a.cells['No']) || 0) - (Number(b.cells['No']) || 0)) * sortDir
      }
      const av = sortKey === LOCATION_KEY ? locOf(a) : (a.cells[sortKey] ?? '')
      const bv = sortKey === LOCATION_KEY ? locOf(b) : (b.cells[sortKey] ?? '')
      return av < bv ? -sortDir : av > bv ? sortDir : 0
    })
    return arr
  }, [rows, searchIndex, q, fGroup, colFilters, activeFilterCols, allUnits, locPrefix, unitPreset, vinFilterSet, sortKey, sortDir])

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d * -1) as SortDir)
    else { setSortKey(key); setSortDir(1) }
  }

  const counts = useMemo(() => {
    let ok = 0, wait = 0
    for (const r of rows) {
      const f = (r.cells['Final Status'] || '').toLowerCase()
      if (f.startsWith('ok')) ok++; else if (f.includes('wait')) wait++
    }
    return { ok, wait }
  }, [rows])

  const clearFilters = () => { setQ(''); setFGroup(''); setColFilters({}); setUnitPreset(null); setUnitVinFilter(null) }
  const anyFilter = !!q || !!fGroup || !!unitPreset || !!unitVinFilter
    || activeFilterCols.some((k) => colFilters[k] && colFilters[k] !== 'ALL')

  const doExport = () => {
    // inject the computed Location cell so the CSV column isn't blank
    const out = visCols.some((c) => c.key === LOCATION_KEY)
      ? filtered.map((r) => ({ ...r, cells: { ...r.cells, [LOCATION_KEY]: locOf(r) } }))
      : filtered
    rowsToCsv(`SJWD_tracking_${Date.now()}.csv`, visCols.map((c) => ({ key: c.key, label: c.label })), out)
  }

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'grouping', label: 'Grouping No.', icon: <FileText size={14} /> },
    { id: 'units', label: 'Units', icon: <ListIcon size={14} /> },
    { id: 'mylist', label: 'Units Mylist', icon: <ClipboardList size={14} /> },
  ]

  return (
    <div className="max-w-full -mt-1 flex flex-col" style={{ height: 'calc(100vh - 104px)' }}>
      {/* tabs + toolbar — one compact row */}
      <div className="flex items-stretch gap-1 border-b hairline mb-1.5 shrink-0">
        {TABS.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className="flex items-center gap-1.5 px-3 text-[13px] font-medium relative transition"
            style={tab === tb.id ? { color: 'var(--brand)' } : { color: 'var(--muted)' }}>
            {tb.icon} {tb.label}
            {tab === tb.id && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: 'var(--brand)' }} />}
          </button>
        ))}
        {unitPreset && (
          <div className="flex items-center gap-1.5 ml-2 self-center px-2.5 py-1 rounded-lg text-[12px] font-semibold"
            style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--brand)', border: '1px solid rgba(37,99,235,0.25)' }}>
            <Filter size={12} /> {presetChipLabel(unitPreset)}
            <span style={{ opacity: 0.7 }}>· {filtered.length.toLocaleString()}</span>
            <button onClick={() => setUnitPreset(null)} title="ล้างตัวกรอง" className="ml-0.5 -mr-0.5 flex"><X size={13} /></button>
          </div>
        )}
        {unitVinFilter && (
          <div className="flex items-center gap-1.5 ml-2 self-center px-2.5 py-1 rounded-lg text-[12px] font-semibold"
            style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--brand)', border: '1px solid rgba(37,99,235,0.25)' }}>
            <Filter size={12} /> {unitVinFilter.label}
            <span style={{ opacity: 0.7 }}>· {filtered.length.toLocaleString()}</span>
            <button onClick={() => setUnitVinFilter(null)} title="ล้างตัวกรอง" className="ml-0.5 -mr-0.5 flex"><X size={13} /></button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 py-1">
          <div className="text-[12px] tabular hidden lg:block mr-1" style={{ color: 'var(--muted)' }}>
            <b style={{ color: 'var(--text)' }}>{rows.length.toLocaleString()}</b> total
            <span className="mx-1">·</span><b style={{ color: 'var(--st-yard)' }}>{counts.ok.toLocaleString()}</b> OK
            <span className="mx-1">·</span><b style={{ color: 'var(--st-pending)' }}>{counts.wait.toLocaleString()}</b> Waiting
            <span className="mx-1">·</span><b style={{ color: 'var(--brand)' }}>{filtered.length.toLocaleString()}</b> shown
          </div>
          <button className={cx('btn py-1.5', filtersOpen && 'btn-blue')} onClick={() => setFiltersOpen((v) => !v)}>
            <Filter size={14} /> ตัวกรอง
          </button>
          <button className="btn py-1.5" onClick={doExport}><Download size={14} /> CSV</button>
          <button className="btn btn-ghost p-1.5" title="โหลดใหม่" onClick={() => location.reload()}><RefreshCw size={14} style={{ color: 'var(--muted)' }} /></button>
          <button className={cx('btn btn-ghost p-1.5', colMgr && 'btn-blue')} title="คอลัมน์" onClick={() => setColMgr((v) => !v)}><Columns3 size={14} /></button>
        </div>
      </div>

      {/* filter bar — Unit Nbr + Grouping pinned, the rest configurable */}
      {filtersOpen && (
        <div className="panel px-2.5 py-1.5 mb-1.5 flex flex-nowrap items-center gap-x-3 overflow-x-auto fade-up shrink-0 relative">
          <FInput label="Unit Nbr" value={q} onChange={setQ} placeholder="VIN / รุ่น / ที่จอด / บริษัท" wide />
          <FInput label="Grouping" value={fGroup} onChange={setFGroup} placeholder="B/L / Grouping" />
          {activeFilterCols.map((key) => (
            <FSel key={key} label={colByKey.get(key)?.label ?? key} value={colFilters[key] ?? 'ALL'} onChange={(v) => setColFilter(key, v)}
              options={[['ALL', 'All'], ...(filterOptions[key] ?? []).map((m) => [m, m] as [string, string])]} />
          ))}
          {anyFilter && <button className="btn btn-ghost shrink-0" onClick={clearFilters}><X size={14} /> ล้าง</button>}
          <button className={cx('btn btn-ghost shrink-0 ml-auto', filterMgr && 'btn-blue')} title="ปรับแต่งช่องกรอง" onClick={() => setFilterMgr((v) => !v)}><SlidersHorizontal size={14} /></button>
        </div>
      )}

      {/* body */}
      <div className="flex gap-2 flex-1 min-h-0">
        {rows.length === 0 ? (
          <EmptyState />
        ) : tab === 'units' ? (
          <DataGrid rows={filtered} visCols={visCols} sel={sel} setSel={setSel}
            sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} optionsFor={optionsFor}
            footer={<GridFooter sel={sel} shown={filtered.length} total={rows.length} lastImport={lastImport} />} />
        ) : tab === 'grouping' ? (
          <GroupingView rows={filtered} visCols={visCols} sel={sel} setSel={setSel}
            sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} optionsFor={optionsFor} />
        ) : (
          <MylistView allRows={rows} visCols={visCols} sel={sel} setSel={setSel}
            sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} optionsFor={optionsFor} />
        )}

        {filterMgr && <FilterManager cols={visCols} filterCols={filterCols} setFilterCols={setFilterCols} onClose={() => setFilterMgr(false)} />}
        {colMgr && <ColumnManager onClose={() => setColMgr(false)} />}
      </div>
    </div>
  )
}

// ============================ reusable virtualized grid ============================
interface GridProps {
  rows: TrackRow[]; visCols: Column[]; sel: Set<string>; setSel: React.Dispatch<React.SetStateAction<Set<string>>>
  sortKey: string; sortDir: SortDir; toggleSort: (k: string) => void; optionsFor: (c: Column) => string[]
  footer?: React.ReactNode
}

function DataGrid({ rows, visCols, sel, setSel, sortKey, sortDir, toggleSort, optionsFor, footer }: GridProps) {
  const bulkUpdate = useTracking((s) => s.bulkUpdate)
  const deleteRows = useTracking((s) => s.deleteRows)
  const columns = useTracking((s) => s.columns)
  const reorderColumn = useTracking((s) => s.reorderColumn)
  const toast = useYard((s) => s.toast)
  // computed "Location" column: prefix-block+row+slot from the car's placement,
  // falling back to the storage / Location-yard cell when the car isn't placed
  const units = useYard((s) => s.units)
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const locPrefix = siteGroupingConfig(sites.find((x) => x.id === currentSite)?.name ?? '').prefix
  const locFor = (r: TrackRow) => yardLocFull(units[r.vin], locPrefix)
  const [dragCol, setDragCol] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewH, setViewH] = useState(560)
  const lastIdx = useRef<number | null>(null)
  const dragRef = useRef<{ anchor: number; dragged: boolean } | null>(null)
  const autoScrollRef = useRef<{ raf: number; vy: number; clientY: number } | null>(null)
  const selectRangeRef = useRef<(a: number, b: number) => void>(() => {})
  const totalRef = useRef(0)
  const lastSelIdxRef = useRef(-1)
  const [menu, setMenu] = useState<{ x: number; y: number; targets: string[]; vin: string } | null>(null)
  const [detailVin, setDetailVin] = useState<string | null>(null)
  const [bulkDefect, setBulkDefect] = useState<string[] | null>(null) // VINs to add the same defect to
  // custom in-app editor for text/date cells (replaces the native window.prompt)
  const [editInput, setEditInput] = useState<{ key: string; label: string; initial: string; targets: string[]; history: RowEvent[] } | null>(null)
  const submitEditInput = (value: string) => {
    if (!editInput) return
    bulkUpdate(editInput.targets, editInput.key, value)
    toast('ok', `อัปเดต ${editInput.label} · ${editInput.targets.length} คัน`)
    setEditInput(null)
  }

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el); setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const totalWidth = useMemo(() => GUTTER + visCols.reduce((s, c) => s + c.width, 0), [visCols])
  const total = rows.length
  totalRef.current = total
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8)
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + 8)
  const slice = rows.slice(start, end)

  const selectRange = (a: number, b: number) => {
    const [lo, hi] = a < b ? [a, b] : [b, a]
    setSel(new Set(rows.slice(lo, hi + 1).map((r) => r.vin)))
  }
  selectRangeRef.current = selectRange
  const onRowMouseDown = (e: React.MouseEvent, idx: number) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('input,select,button,.no-drag')) return
    dragRef.current = { anchor: idx, dragged: false }
    lastSelIdxRef.current = idx
  }
  const onRowClick = (e: React.MouseEvent, vin: string, idx: number) => {
    if (dragRef.current?.dragged) return
    if (e.shiftKey && lastIdx.current != null) selectRange(lastIdx.current, idx)
    else if (e.ctrlKey || e.metaKey) setSel((p) => { const n = new Set(p); n.has(vin) ? n.delete(vin) : n.add(vin); return n })
    else setSel(new Set([vin]))
    lastIdx.current = idx
  }

  // ---------- right-click context menu ----------
  const onContextMenu = (e: React.MouseEvent, vin: string, idx: number) => {
    e.preventDefault()
    let targets: string[]
    if (sel.has(vin) && sel.size > 0) targets = [...sel]
    else { setSel(new Set([vin])); targets = [vin] }
    lastIdx.current = idx
    const x = Math.min(e.clientX, window.innerWidth - 248)
    const y = Math.min(e.clientY, window.innerHeight - 420)
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), targets, vin })
  }

  const menuModel = useMemo<MenuNode[]>(() => {
    if (!menu) return []
    const { targets, vin } = menu
    const n = targets.length
    const colByKey = new Map(columns.map((c) => [c.key, c]))
    const cur = (key: string) => (n === 1 ? rows.find((r) => r.vin === vin)?.cells[key] ?? '' : '')
    const apply = (key: string, value: string) => {
      bulkUpdate(targets, key, value)
      toast('ok', `อัปเดต ${colByKey.get(key)?.label ?? key} · ${n} คัน`)
      setMenu(null)
    }
    const promptApply = (key: string) => {
      const label = colByKey.get(key)?.label ?? key
      // audit trail for THIS field — only meaningful when editing a single car
      const hist = n === 1
        ? (rows.find((r) => r.vin === vin)?.history ?? []).filter((h) => h.field === label || h.field === key)
        : []
      setEditInput({ key, label, initial: cur(key), targets, history: hist })
      setMenu(null)
    }
    // column editor node — no pencil icon / "ตั้ง" prefix (TOS-style plain labels);
    // columns with harvested options expand to a value list, else a prompt
    const editCol = (key: string): MenuNode | null => {
      const col = colByKey.get(key)
      if (!col || !col.editable) return null
      const opts = optionsFor(col).slice(0, 40)
      if (!opts.length) return { kind: 'item', label: `${col.label}…`, onSelect: () => promptApply(key) }
      return { kind: 'sub', label: col.label, options: opts.map((o) => ({ kind: 'item' as const, label: o, onSelect: () => apply(key, o) })) }
    }
    // grouped like the RoRo TOS context menu (numbered categories → columns)
    // 3-level TOS menu: Category → Subcategory → editable columns. A select
    // column expands one level further to its value list; a text/date column is
    // a leaf that prompts. Non-editable columns (No/Vin) are skipped by editCol;
    // empty subcategories/categories collapse away. Keys are the EXACT sheet
    // headers (see trackingColumns.ts) so they map 1:1 to the cell being edited.
    const MENU_TREE: { label: string; subs: { label: string; keys: string[] }[] }[] = [
      { label: '🚗 Vehicle Info', subs: [
        { label: 'Identity', keys: ['Match Tax/Shuttle', 'Vin Of Status'] },
        { label: 'Specification', keys: ['Model name', 'Model', 'Model Code', 'Front Motor no.', 'Rear Motor no.', 'Engine No.', 'Color'] },
        { label: 'Battery / Company', keys: ['battery', 'company'] },
      ] },
      { label: '🏭 Yard Operations', subs: [
        { label: 'Gate', keys: ['Car Status', 'Gate In (Rayong yard)', 'Gate Out time stamp'] },
        { label: 'Location', keys: ['Location yard', 'storage Yard'] },
        { label: 'Transfers', keys: ['Lot transfer', 'moving date', 'From', 'To', 'Move from  1', 'Transfer 1', 'Move from  2', 'Transfer 2', 'Move from  3', 'Transfer 3', 'Move from  4', 'Transfer 4'] },
      ] },
      { label: '🔍 PDI & Quality', subs: [
        { label: 'PDI Status', keys: ['Status', 'PDI', 'PIC (PDI)'] },
        { label: 'RE-PDI Dates', keys: ['RE PDI  Date #1', 'RE PDI  Date #2', 'RE PDI  Date #3', 'RE PDI  Date #4', 'RE PDI  Date #5', 'RE PDI  Date #6', 'RE PDI  Date #7', 'RE PDI  Date #8'] },
        { label: 'Completion', keys: ['OK date', 'Final check date', 'Final Status'] },
      ] },
      { label: '🚚 Delivery & Allocation', subs: [
        { label: 'Dealer', keys: ['Dealer Code', 'Dealer Location'] },
        { label: 'Allocation', keys: ['Allocation Date', 'Grouping  Number'] },
        { label: 'Transport', keys: ['Tailer Company', 'Remark'] },
      ] },
      { label: '💰 Tax & Commercial', subs: [
        { label: 'Tax Status', keys: ['Status Tax', 'Match Tax/Shuttle'] },
        { label: 'Stock', keys: ['Stock of Status'] },
        { label: 'Aging', keys: ['Aging PM'] },
      ] },
      { label: '🔧 Maintenance', subs: [
        { label: 'Accessories', keys: ['Factory-Installed', 'Accessories'] },
        { label: 'PM Schedule', keys: Array.from({ length: 15 }, (_, i) => `PM${i + 1}`) },
        { label: 'Notes', keys: ['หมายเหตุ', 'Remark'] },
      ] },
    ]
    const placed = new Set(MENU_TREE.flatMap((c) => c.subs.flatMap((s) => s.keys)))
    const buildSub = (sub: { label: string; keys: string[] }): MenuNode | null => {
      const kids = sub.keys.map(editCol).filter(Boolean) as MenuNode[]
      return kids.length ? { kind: 'sub', label: sub.label, options: kids } : null
    }
    const buildCat = (cat: { label: string; subs: { label: string; keys: string[] }[] }): MenuNode | null => {
      const subs = cat.subs.map(buildSub).filter(Boolean) as MenuNode[]
      return subs.length ? { kind: 'sub', label: cat.label, options: subs } : null
    }
    const groups = MENU_TREE.map(buildCat).filter(Boolean) as MenuNode[]
    // any editable column not placed above (e.g. user-added custom columns) stays reachable
    const otherCols = columns.filter((c) => c.editable && !placed.has(c.key))
    if (otherCols.length) {
      groups.push({ kind: 'sub', label: '⚙️ Other Columns', options: otherCols.map((c) => ({ kind: 'item' as const, label: c.label, onSelect: () => promptApply(c.key) })) })
    }

    const nodes: MenuNode[] = []
    if (n === 1) nodes.push({ kind: 'item', label: 'View Detail', icon: <Eye size={14} />, onSelect: () => { setDetailVin(vin); setMenu(null) } })
    nodes.push({ kind: 'item', label: `Copy VIN (${n})`, icon: <Copy size={14} />, onSelect: () => { navigator.clipboard?.writeText(targets.join('\n')); toast('ok', `คัดลอก ${n} VIN`); setMenu(null) } })
    nodes.push({ kind: 'divider' })
    nodes.push(...groups)
    // Add Defect: attach the SAME manual defect to all selected VINs at once
    nodes.push({ kind: 'divider' })
    nodes.push({ kind: 'item', label: n > 1 ? `Add Defect (${n})…` : 'Add Defect…', icon: <ShieldCheck size={14} />, onSelect: () => { setBulkDefect(targets); setMenu(null) } })
    // Grouping: type / change the grouping number — writes to the tracking cell
    // (bulkUpdate) so it updates everywhere the group is read (Grouping view etc.).
    nodes.push({ kind: 'divider' })
    nodes.push({ kind: 'item', label: n > 1 ? `Grouping No. (${n})…` : 'Grouping No.…', icon: <FileText size={14} />, onSelect: () => promptApply(GROUPING_KEY) })
    // Delete: permanently remove the selected VIN(s) from the system (local +
    // IndexedDB + cloud, via deleteRows). Danger-styled + confirm guard so it
    // can't be hit by accident.
    nodes.push({ kind: 'divider' })
    nodes.push({ kind: 'item', label: n > 1 ? `Delete (${n})` : 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => {
      const ok = window.confirm(
        n > 1
          ? `ลบ ${n} VIN ออกจากระบบถาวร?\n(ลบทั้งในเครื่องและ cloud — ย้อนกลับไม่ได้)`
          : `ลบ VIN นี้ออกจากระบบถาวร?\n${vin}\n(ลบทั้งในเครื่องและ cloud — ย้อนกลับไม่ได้)`,
      )
      if (ok) {
        deleteRows(targets)
        setSel(new Set())
        toast('ok', `ลบ ${n} คันออกจากระบบแล้ว`)
      }
      setMenu(null)
    } })
    return nodes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, columns, rows])

  // Drag-select with edge auto-scroll: works past the visible rows (virtualized)
  // — dragging to the top/bottom edge keeps scrolling + selecting to the very end.
  useEffect(() => {
    const rowAt = (clientY: number) => {
      const el = bodyRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const y = clientY - rect.top + el.scrollTop
      return Math.max(0, Math.min(totalRef.current - 1, Math.floor(y / ROW_H)))
    }
    const extend = (clientY: number) => {
      const d = dragRef.current
      if (!d) return
      const idx = rowAt(clientY)
      if (idx === lastSelIdxRef.current) return
      lastSelIdxRef.current = idx
      selectRangeRef.current(d.anchor, idx)
    }
    const stopAuto = () => {
      if (autoScrollRef.current) { cancelAnimationFrame(autoScrollRef.current.raf); autoScrollRef.current = null }
    }
    const tick = () => {
      const st = autoScrollRef.current, el = bodyRef.current
      if (!st || !el || !dragRef.current) { stopAuto(); return }
      el.scrollTop += st.vy
      extend(st.clientY)
      st.raf = requestAnimationFrame(tick)
    }
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      d.dragged = true
      extend(e.clientY)
      const el = bodyRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const EDGE = 48 // px from edge that triggers auto-scroll (faster the closer/further)
      let vy = 0
      if (e.clientY < rect.top + EDGE) vy = -Math.min(64, Math.max(5, Math.round((rect.top + EDGE - e.clientY) / 1.6)))
      else if (e.clientY > rect.bottom - EDGE) vy = Math.min(64, Math.max(5, Math.round((e.clientY - (rect.bottom - EDGE)) / 1.6)))
      if (vy === 0) { stopAuto(); return }
      if (autoScrollRef.current) { autoScrollRef.current.vy = vy; autoScrollRef.current.clientY = e.clientY }
      else autoScrollRef.current = { raf: requestAnimationFrame(tick), vy, clientY: e.clientY }
    }
    const onUp = () => { stopAuto(); setTimeout(() => { dragRef.current = null }, 0) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); stopAuto() }
  }, [])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase()
      if (e.key === 'Escape') { setSel(new Set()); return }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(new Set(rows.map((r) => r.vin))) }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel.size) {
        e.preventDefault(); navigator.clipboard?.writeText([...sel].join('\n')); toast('ok', `คัดลอก ${sel.size} VIN แล้ว`)
      }
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [rows, sel, setSel, toast])

  return (
    <div className="panel-solid overflow-hidden flex flex-col flex-1 min-w-0">
      <div className="ghead shrink-0 select-none">
        <div className="ghrow" style={{ width: totalWidth, transform: `translateX(${-scrollLeft}px)` }}>
          <div className="ghcell" style={{ width: GUTTER, cursor: 'default' }} />
          {visCols.map((c) => {
            const isDragging = dragCol === c.key
            const isDropTarget = !!dragCol && dragCol !== c.key && overCol === c.key
            return (
              <div key={c.key} className="ghcell" title={`${c.key} · ลากเพื่อย้ายคอลัมน์`}
                style={{
                  width: c.width, cursor: dragCol ? 'grabbing' : 'grab',
                  opacity: isDragging ? 0.4 : 1,
                  boxShadow: isDropTarget ? 'inset 3px 0 0 var(--brand)' : undefined,
                  background: isDropTarget ? 'var(--brand-soft, #eef4ff)' : undefined,
                }}
                draggable
                onClick={() => toggleSort(c.key)}
                onDragStart={(e) => { setDragCol(c.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.key) }}
                onDragEnter={() => { if (dragCol && dragCol !== c.key) setOverCol(c.key) }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                onDrop={(e) => { e.preventDefault(); const dk = dragCol ?? e.dataTransfer.getData('text/plain'); if (dk && dk !== c.key) reorderColumn(dk, c.key); setDragCol(null); setOverCol(null) }}
                onDragEnd={() => { setDragCol(null); setOverCol(null) }}>
                <span className="clip">{c.label}</span>
                <ArrowUpDown size={10} style={{ opacity: sortKey === c.key ? 0.95 : 0.3, flex: 'none' }} />
              </div>
            )
          })}
        </div>
      </div>

      <div ref={bodyRef} className="gbody flex-1 select-none" onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop); setScrollLeft(e.currentTarget.scrollLeft) }}>
        <div style={{ height: total * ROW_H, width: totalWidth, position: 'relative' }}>
          {slice.map((r, i) => {
            const idx = start + i
            const selected = sel.has(r.vin)
            const carStatus = deriveCarStatus(r.cells)
            return (
              <div key={r.vin} className={cx('grow', idx % 2 === 1 && 'odd', selected && 'sel')} style={{ top: idx * ROW_H, height: ROW_H, width: totalWidth }}
                onMouseDown={(e) => onRowMouseDown(e, idx)} onClick={(e) => onRowClick(e, r.vin, idx)}
                onDoubleClick={() => setDetailVin(r.vin)}
                onContextMenu={(e) => onContextMenu(e, r.vin, idx)}>
                <div className="gcell" style={{ width: GUTTER }} />
                {visCols.map((c) => (
                  <Cell key={c.key} col={c} value={c.key === 'Car Status' ? carStatus : c.key === 'No' ? fmtUpdated(r.updatedAt) : c.key === LOCATION_KEY ? locFor(r) : c.key === 'Aging PM' ? fmtAgingPm(r.cells) : c.key === 'storage Yard' ? cleanStorage(r.cells[c.key]) : isDateColumn(c.key, c.label) ? fmtSerialToDate(r.cells[c.key]) : (r.cells[c.key] ?? '')}
                    dim={c.key === 'Final Status' && carStatus === 'Gate-out'} />
                ))}
              </div>
            )
          })}
        </div>
        {total === 0 && <div className="text-center py-14" style={{ color: 'var(--faint)' }}>— ไม่พบรายการ —</div>}
      </div>

      {footer}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y}
          title={menu.targets.length > 1 ? `${menu.targets.length} คันที่เลือก` : menu.vin.slice(-8)}
          items={menuModel} onClose={() => setMenu(null)} />
      )}
      {detailVin && <RowDetail vin={detailVin} onClose={() => setDetailVin(null)} />}
      {bulkDefect && <BulkDefectModal vins={bulkDefect} onClose={() => setBulkDefect(null)} onDone={() => setSel(new Set())} />}
      <InputPromptModal input={editInput} onSubmit={submitEditInput} onClose={() => setEditInput(null)} />
    </div>
  )
}

// ── add the SAME manual defect to many VINs at once (Unit List bulk action) ────
// stacked label + control — TOP-LEVEL (defining it inside the modal remounts the
// input on every keystroke, which drops focus and closes the datalist dropdown)
function DField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>{label}</div>{children}</div>
}

function BulkDefectModal({ vins, onClose, onDone }: { vins: string[]; onClose: () => void; onDone: () => void }) {
  const addManualDamageBulk = useYard((s) => s.addManualDamageBulk)
  const allUnits = useYard((s) => s.units)
  const toast = useYard((s) => s.toast)
  const [form, setForm] = useState(BLANK_DMG_FORM)
  // which Report sheet this defect belongs to (yardDefect → Defect-Yard, factoryDefect → Defect-Factory)
  const [source, setSource] = useState<'yardDefect' | 'factoryDefect'>('yardDefect')
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])
  const opts = useMemo(() => {
    const S = { position: new Set<string>(), defect: new Set<string>(), catNG: new Set<string>(), catRepair: new Set<string>(), incharge: new Set<string>(), note: new Set<string>() }
    for (const u of Object.values(allUnits)) for (const d of u.damages) {
      if (d.area && d.area !== '—') S.position.add(zoneLabel(d.area))
      const df = d.item ?? d.type; if (df && df !== '—') S.defect.add(df)
      if (d.categoryNG) S.catNG.add(d.categoryNG)
      if (d.categoryRepair) S.catRepair.add(d.categoryRepair)
      if (d.incharge) S.incharge.add(d.incharge)
      if (d.note) S.note.add(d.note)
    }
    const arr = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b))
    return { position: arr(S.position), defect: arr(S.defect), catNG: arr(S.catNG), catRepair: arr(S.catRepair), incharge: arr(S.incharge), note: arr(S.note) }
  }, [allUnits])
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const save = () => {
    if (!form.position.trim() && !form.defect.trim()) { toast('err', 'กรุณากรอกอย่างน้อย Position หรือ Defect/NG'); return }
    const n = addManualDamageBulk(vins, { ...form, source })
    toast('ok', `Add Defect (${source === 'factoryDefect' ? 'Factory' : 'Yard'}) ให้ ${n} คันแล้ว`)
    onDone(); onClose()
  }
  const factory = source === 'factoryDefect'
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid pop w-full overflow-hidden flex flex-col" style={{ maxWidth: 560, maxHeight: '90vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-5 py-4 border-b hairline shrink-0">
          <ShieldCheck size={18} style={{ color: 'var(--st-damage)' }} />
          <div className="min-w-0 flex-1">
            <div className="font-bold text-[16px] leading-tight">Add Defect</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>ใส่ Defect เดียวกันให้ <b className="tabular" style={{ color: 'var(--brand)' }}>{vins.length}</b> คันที่เลือก</div>
          </div>
          <button className="btn btn-ghost p-2" onClick={onClose}><X size={18} /></button>
        </div>
        {/* sheet selector — decides which Report sheet the defect lands in */}
        <div className="px-4 pt-3">
          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>ประเภท Defect (ชีตในรายงาน)</div>
          <div className="inline-flex p-0.5 rounded-xl gap-0.5 w-full" style={{ background: 'var(--chip)' }}>
            {([['yardDefect', 'Defect-Yard'], ['factoryDefect', 'Defect-Factory']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setSource(k)}
                className="flex-1 py-2 rounded-lg text-[12.5px] font-semibold transition"
                style={source === k ? { background: '#fff', color: 'var(--brand)', boxShadow: '0 0 0 1px var(--line-strong)' } : { color: 'var(--muted)' }}>{l}</button>
            ))}
          </div>
        </div>
        <div className="p-4 overflow-auto grid grid-cols-2 gap-3">
          {/* every field is type-in + dropdown (native datalist) — needs a unique id */}
          <DField label="Position"><Combo id="bd-pos" value={form.position} onChange={(v) => set({ position: v })} options={opts.position} placeholder="Position" /></DField>
          <DField label={factory ? 'Defect/NG' : 'Defect'}><Combo id="bd-defect" value={form.defect} onChange={(v) => set({ defect: v })} options={opts.defect} placeholder="Defect" /></DField>
          <DField label={factory ? 'Category defect' : 'Category NG'}><Combo id="bd-catng" value={form.categoryNG} onChange={(v) => set({ categoryNG: v })} options={opts.catNG} placeholder="Category" /></DField>
          {!factory && <DField label="Category (Repair)"><Combo id="bd-catrep" value={form.categoryRepair} onChange={(v) => set({ categoryRepair: v })} options={opts.catRepair} placeholder="Category (Repair)" /></DField>}
          <DField label="Incharge"><Combo id="bd-incharge" value={form.incharge} onChange={(v) => set({ incharge: v })} options={opts.incharge} placeholder="Incharge" /></DField>
          <DField label="Stock of Status"><Combo id="bd-note" value={form.note} onChange={(v) => set({ note: v })} options={opts.note} placeholder="Stock of Status" /></DField>
          <DField label="Date"><Combo value={form.date} onChange={(v) => set({ date: v })} type="date" /></DField>
          <DField label="Status Repair">
            <select className="input w-full text-[13px] py-2" value={form.statusRepair} onChange={(e) => set({ statusRepair: e.target.value })}>
              {REPAIR_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
          </DField>
          <DField label="Repair Date"><Combo value={form.repairDate} onChange={(v) => set({ repairDate: v })} type="date" /></DField>
        </div>
        <div className="flex gap-2 p-4 border-t hairline shrink-0">
          <button className="btn flex-1 py-2.5 text-[13px]" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary flex-1 py-2.5 text-[13px] font-semibold" onClick={save}><ShieldCheck size={15} /> Add Defect · {vins.length} คัน</button>
        </div>
      </div>
    </div>
  )
}

// ── in-app value editor (replaces the ugly native window.prompt) ───────────────
function InputPromptModal({ input, onSubmit, onClose }: {
  input: { key: string; label: string; initial: string; targets: string[]; history: RowEvent[] } | null
  onSubmit: (v: string) => void
  onClose: () => void
}) {
  const [v, setV] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const multiline = !!input && /remark|หมายเหตุ|accessor|note|dealer location/i.test(input.key)
  useEffect(() => {
    if (!input) return
    setV(input.initial)
    const t = setTimeout(() => { ref.current?.focus(); ref.current?.select() }, 30)
    return () => clearTimeout(t)
  }, [input])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  if (!input) return null
  const n = input.targets.length
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: 200, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="panel-solid glow-ring pop w-full overflow-hidden" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 border-b hairline">
          <div className="text-[11.5px] font-semibold mb-0.5" style={{ color: 'var(--muted)' }}>
            แก้ไขค่า{n > 1 ? ` · ${n} คัน` : ''}
          </div>
          <div className="font-bold display text-[16px]" style={{ color: 'var(--text)' }}>{input.label}</div>
        </div>
        <div className="px-5 pt-4 pb-1">
          {multiline ? (
            <textarea
              ref={ref as any}
              className="input w-full font-semibold"
              style={{ minHeight: 96, resize: 'vertical', lineHeight: 1.5 }}
              value={v}
              onChange={e => setV(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit(v) } }}
              placeholder="พิมพ์ค่า…"
            />
          ) : (
            <input
              ref={ref}
              className="input w-full font-semibold"
              value={v}
              onChange={e => setV(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(v) } }}
              placeholder="พิมพ์ค่า…"
            />
          )}
        </div>
        {/* audit trail: who changed this field, from → to, when */}
        {input.history.length > 0 ? (
          <div className="px-5 pb-2 pt-1">
            <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>
              ประวัติการแก้ไข · {input.history.length} ครั้ง
            </div>
            <div className="space-y-1.5 overflow-y-auto pr-0.5" style={{ maxHeight: 176, overscrollBehavior: 'contain' }}>
              {[...input.history].reverse().map((h, i) => (
                <div key={i} className="rounded-lg px-2.5 py-1.5 text-[11.5px]" style={{ background: 'var(--chip)' }}>
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="font-bold" style={{ color: 'var(--text)' }}>{h.by || '—'}</span>
                    <span className="tabular text-[10.5px]" style={{ color: 'var(--faint)' }}>{fmtDT(h.at)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="line-through" style={{ color: 'var(--faint)' }}>{h.from || '(ว่าง)'}</span>
                    <span style={{ color: 'var(--muted)' }}>→</span>
                    <span className="font-semibold" style={{ color: 'var(--brand)' }}>{h.to || '(ว่าง)'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-5 pb-1 pt-0.5 text-[11px]" style={{ color: 'var(--faint)' }}>
            {input.targets.length > 1 ? 'แก้หลายคัน · ประวัติจะแสดงเมื่อเลือกทีละคัน' : 'ยังไม่มีประวัติการแก้ไขฟิลด์นี้'}
          </div>
        )}
        <div className="px-5 py-4 flex justify-end gap-2 items-center">
          <span className="text-[10.5px] mr-auto" style={{ color: 'var(--faint)' }}>
            {multiline ? 'Ctrl+Enter เพื่อบันทึก' : 'Enter เพื่อบันทึก'} · Esc ยกเลิก
          </span>
          <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
          <button className="btn" style={{ background: 'var(--brand)', color: '#fff', borderColor: 'transparent' }} onClick={() => onSubmit(v)}>
            บันทึก
          </button>
        </div>
      </div>
    </div>
  )
}

function GridFooter({ sel, shown, total, lastImport }: { sel: Set<string>; shown: number; total: number; lastImport: any }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-t hairline text-[11.5px] flex-wrap shrink-0" style={{ color: 'var(--muted)' }}>
      <div className="flex items-center gap-3">
        <span>เลือก: <b className="tabular" style={{ color: sel.size ? 'var(--brand)' : 'var(--text)' }}>{sel.size.toLocaleString()}</b></span>
        <span>แสดง: <b className="tabular" style={{ color: 'var(--text)' }}>{shown.toLocaleString()}</b> จาก {total.toLocaleString()}</span>
        {lastImport && <span className="hidden lg:inline" style={{ color: 'var(--faint)' }}>· นำเข้าล่าสุด {new Date(lastImport.at).toLocaleString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
      </div>
      <div className="hidden md:flex items-center gap-2" style={{ color: 'var(--faint)' }}>
        <Hint k="คลุม/ลาก">เลือกหลายแถว</Hint><Hint k="Shift+Click">ช่วง</Hint><Hint k="คลิกขวา">แก้ไข/ลบ</Hint><Hint k="Ctrl+A">ทั้งหมด</Hint><Hint k="Ctrl+C">คัดลอก VIN</Hint>
      </div>
    </div>
  )
}

// ============================ B/L NO. (Grouping) view ============================
function GroupingView({ rows, visCols, sel, setSel, sortKey, sortDir, toggleSort, optionsFor }: GridProps) {
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<string | null>(null)

  const groups = useMemo(() => {
    const m = new Map<string, TrackRow[]>()
    for (const r of rows) {
      const g = r.cells[GROUPING_KEY] || '(ไม่มี Grouping)'
      ;(m.get(g) ?? m.set(g, []).get(g)!).push(r)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  const filteredGroups = useMemo(() => {
    const s = search.trim().toUpperCase()
    return s ? groups.filter(([g]) => g.toUpperCase().includes(s)) : groups
  }, [groups, search])

  const activeKey = active && groups.some(([g]) => g === active) ? active : filteredGroups[0]?.[0] ?? null
  const activeRows = useMemo(() => groups.find(([g]) => g === activeKey)?.[1] ?? [], [groups, activeKey])
  const totalWithGroup = rows.length

  // selection within the active group → drives DN IR printing
  const selInGroup = useMemo(() => activeRows.filter((r) => sel.has(r.vin)), [activeRows, sel])
  const toPrint = selInGroup.length ? selInGroup : activeRows // selected VINs, else the whole group
  const allSel = activeRows.length > 0 && selInGroup.length === activeRows.length
  const toggleGroupSel = () => setSel((prev) => {
    const n = new Set(prev)
    if (allSel) activeRows.forEach((r) => n.delete(r.vin)); else activeRows.forEach((r) => n.add(r.vin))
    return n
  })

  return (
    <>
      {/* left: grouping list */}
      <div className="panel-solid shrink-0 flex flex-col" style={{ width: 270 }}>
        <div className="px-3 py-2.5 border-b hairline shrink-0">
          <div className="text-[10.5px] font-bold uppercase mb-1.5" style={{ color: 'var(--faint)' }}>Grouping Number</div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--faint)' }} />
            <input className="input pl-8 py-1.5 text-[12.5px]" placeholder="ค้นหา Grouping…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--muted)' }}>
            <b className="tabular" style={{ color: 'var(--text)' }}>{groups.length}</b> กลุ่ม · <b className="tabular">{totalWithGroup.toLocaleString()}</b> คัน
          </div>
        </div>
        <div className="overflow-auto flex-1">
          {filteredGroups.map(([g, list]) => (
            <button key={g} onClick={() => setActive(g)}
              className={cx('w-full text-left flex items-center gap-2 px-3 py-2 border-b hairline transition', g === activeKey ? 'sel-group' : 'row-hover')}
              style={g === activeKey ? { background: 'var(--brand-soft)' } : undefined}>
              <FileText size={14} style={{ color: g === activeKey ? 'var(--brand)' : 'var(--faint)', flex: 'none' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold clip" style={{ color: g === activeKey ? 'var(--brand)' : 'var(--text)' }}>{g}</div>
                <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{list.length} คัน</div>
              </div>
              <span className="badge tabular" style={{ color: 'var(--brand)', background: '#fff', border: '1px solid var(--line)' }}>{list.length}</span>
            </button>
          ))}
          {filteredGroups.length === 0 && <div className="text-center py-10 text-[12px]" style={{ color: 'var(--faint)' }}>— ไม่พบ —</div>}
        </div>
      </div>

      {/* right: vehicles of active group */}
      <div className="flex flex-col flex-1 min-w-0 gap-2">
        <div className="flex items-center gap-2 px-1 shrink-0">
          <FileText size={16} style={{ color: 'var(--brand)' }} />
          <span className="display font-bold text-[15px]">{activeKey ?? '—'}</span>
          <span className="badge" style={{ color: 'var(--brand)', background: 'var(--brand-soft)' }}>{activeRows.length} vehicles</span>
          {selInGroup.length > 0 && <span className="badge" style={{ color: 'var(--brand)', background: '#fff', border: '1px solid var(--line)' }}>เลือก {selInGroup.length}</span>}
          <div className="ml-auto flex items-center gap-2">
            <button className="btn btn-ghost py-1.5 text-[12.5px]" onClick={toggleGroupSel} disabled={!activeRows.length}>
              <CheckSquare size={14} /> {allSel ? 'ยกเลิกทั้งกลุ่ม' : 'เลือกทั้งกลุ่ม'}
            </button>
            <button className="btn py-1.5 text-[12.5px]" onClick={() => printDn(toPrint)} disabled={!toPrint.length} title="พิมพ์ใบส่งมอบรถ (Delivery Note) — 1 ใบ รวมรถที่เลือก">
              <FileText size={14} /> พิมพ์ DN ({toPrint.length})
            </button>
            <button className="btn btn-primary py-1.5 text-[12.5px]" onClick={() => printIr(toPrint)} disabled={!toPrint.length} title="พิมพ์ใบตรวจรถ (Inspector Report) เต็มฟอร์ม — 1 หน้า ต่อ 1 คัน ลงกระดาษเปล่า">
              <Printer size={14} /> พิมพ์ IR ({toPrint.length})
            </button>
            <button className="btn py-1.5 text-[12.5px]" onClick={() => printIrPaper(toPrint)} disabled={!toPrint.length} title="พิมพ์เฉพาะข้อมูลลงบนกระดาษฟอร์ม IR ที่พิมพ์ไว้ล่วงหน้า (ตรงตำแหน่ง AMS 100%)">
              <Printer size={14} /> พิมพ์กระดาษ IR ({toPrint.length})
            </button>
          </div>
        </div>
        <DataGrid rows={sortRows(activeRows, sortKey, sortDir)} visCols={visCols} sel={sel} setSel={setSel}
          sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} optionsFor={optionsFor}
          footer={<div className="px-3 py-1.5 border-t hairline text-[11.5px] shrink-0" style={{ color: 'var(--muted)' }}>เลือก: <b className="tabular" style={{ color: sel.size ? 'var(--brand)' : 'var(--text)' }}>{sel.size}</b> · ในกลุ่มนี้: <b className="tabular">{activeRows.length}</b></div>} />
      </div>
    </>
  )
}

// ============================ Units Mylist (paste VINs) ============================
function MylistView({ allRows, visCols, sel, setSel, sortKey, sortDir, toggleSort, optionsFor }: Omit<GridProps, 'rows'> & { allRows: TrackRow[] }) {
  const [text, setText] = useState('')
  const units = useYard((s) => s.units)
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const toast = useYard((s) => s.toast)
  const siteName = sites.find((s) => s.id === currentSite)?.name ?? ''
  const { found, notFound, asked } = useMemo(() => matchVins(text, allRows), [text, allRows])

  // build ใบหารถ rows (yard location code + fallbacks), for print / Excel export
  const findRows = useMemo(
    () => toFindListRows(found, (vin) => units[vin], siteName),
    [found, units, siteName],
  )

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const doPdf = () => { if (findRows.length) printFindList(findRows, today) }
  const doXlsx = async () => {
    if (!findRows.length) return
    try { await exportFindListXlsx(findRows, today) } catch (e) { console.error('[findlist] xlsx', e); toast('err', 'ออกไฟล์ Excel ไม่สำเร็จ') }
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 gap-2">
      <div className="panel p-2.5 shrink-0">
        <div className="text-[12px] font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>วาง/พิมพ์ VIN เต็ม หรือ 5 ตัวท้าย (รองรับเว้นวรรค ขึ้นบรรทัด หรือก็อปจาก Excel/อีเมล)</div>
        <textarea className="input" style={{ minHeight: 92, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
          placeholder={'LGXCE4CB5TG015112\n015112\n14413'} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex items-center gap-3 mt-1.5 text-[12px] flex-wrap">
          <span style={{ color: 'var(--muted)' }}>ค้นหา <b className="tabular">{asked}</b> รายการ</span>
          <span style={{ color: 'var(--st-yard)' }}>พบ <b className="tabular">{found.length}</b> คัน</span>
          {notFound.length > 0 && <span style={{ color: 'var(--st-damage)' }}>ไม่พบ <b className="tabular">{notFound.length}</b></span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button className="btn btn-ghost py-1" disabled={!found.length} onClick={doXlsx}><Download size={13} /> ใบหารถ (Excel)</button>
            <button className="btn btn-ghost py-1" disabled={!found.length} onClick={doPdf}><Printer size={13} /> ใบหารถ (PDF)</button>
            {text && <button className="btn btn-ghost py-1" onClick={() => setText('')}><X size={13} /> ล้าง</button>}
          </div>
        </div>
        {notFound.length > 0 && <div className="text-[11px] mt-1 vin clip" style={{ color: 'var(--faint)' }}>ไม่พบ: {notFound.slice(0, 12).join(', ')}{notFound.length > 12 ? ` +${notFound.length - 12}` : ''}</div>}
      </div>
      {asked === 0
        ? <div className="panel-solid flex-1 flex items-center justify-center text-[13px]" style={{ color: 'var(--faint)' }}>วาง VIN เต็มหรือ 5 ตัวท้ายในกล่องด้านบนเพื่อค้นหา แล้วออก "ใบหารถ" เป็น Excel/PDF ได้</div>
        : <DataGrid rows={sortRows(found, sortKey, sortDir)} visCols={visCols} sel={sel} setSel={setSel}
            sortKey={sortKey} sortDir={sortDir} toggleSort={toggleSort} optionsFor={optionsFor}
            footer={<div className="px-3 py-1.5 border-t hairline text-[11.5px] shrink-0" style={{ color: 'var(--muted)' }}>พบ <b className="tabular" style={{ color: 'var(--st-yard)' }}>{found.length}</b> คัน จาก {asked} รายการที่ค้นหา</div>} />}
    </div>
  )
}

function sortRows(rows: TrackRow[], sortKey: string, sortDir: SortDir): TrackRow[] {
  return [...rows].sort((a, b) => {
    if (sortKey === 'No') {
      const d = (a.updatedAt ?? 0) - (b.updatedAt ?? 0)
      return (d || (Number(a.cells['No']) || 0) - (Number(b.cells['No']) || 0)) * sortDir
    }
    const av = a.cells[sortKey] ?? '', bv = b.cells[sortKey] ?? ''
    return av < bv ? -sortDir : av > bv ? sortDir : 0
  })
}

/** "Last update" display — date + time in Thai locale (empty when never updated). */
function fmtUpdated(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** "Aging PM" display: whole days since the last PM (PM1…PM15), e.g. "125 วัน".
 *  '' when the car has never been PM'd — so the cell shows "—" instead of the
 *  stray Excel serial (46223) the sheet formula produced. */
function fmtAgingPm(cells: Record<string, string>): string {
  const d = agingPmDays(cells)
  return d === '' ? '' : `${d} วัน`
}

function EmptyState() {
  return (
    <div className="panel flex-1 flex flex-col items-center justify-center text-center p-14">
      <Database size={38} className="mb-4" style={{ color: 'var(--faint)' }} />
      <div className="display text-[17px] font-bold mb-1">ยังไม่มีข้อมูลในรายการรถ</div>
      <div className="text-[13.5px]" style={{ color: 'var(--muted)' }}>
        ไปที่หน้า <b style={{ color: 'var(--brand)' }}>นำเข้าข้อมูล</b> แล้วอัปโหลดไฟล์ที่มี sheet <b>"Tracking Status"</b>
      </div>
    </div>
  )
}

// ============================ cell (display-only — edits happen via right-click) ============================
function Cell({ col, value, dim }: { col: Column; value: string; dim?: boolean }) {
  let content: React.ReactNode
  if (!value) content = <span style={{ color: '#aab4c2' }}>—</span>
  else if (col.key === 'Color') {
    const sw = COLOR_SW[value.toUpperCase().replace(/\s/g, '')]
    content = <span className="inline-flex items-center gap-1.5">{sw && <span className="rounded-full border" style={{ width: 11, height: 11, background: sw, borderColor: 'rgba(0,0,0,0.15)', flex: 'none' }} />}{value}</span>
  } else if (col.key === 'Final Status') {
    // car already gated-out → fade the badge, it's no longer an actionable status
    const fc = finalColor(value)
    content = fc
      ? <span className="gbadge" style={{ color: fc.color, background: fc.bg, opacity: dim ? 0.4 : 1 }}>{value}</span>
      : <span style={{ opacity: dim ? 0.4 : 1 }}>{value}</span>
  } else if (col.key === 'Car Status') {
    const meta = CAR_STATUS_META[value]
    content = meta ? <span className="gbadge" style={{ color: meta.color, background: meta.bg }}>{value}</span> : <span>{value}</span>
  } else if (col.key === 'Vin Of Status') {
    const vc = vinOfStatusColor(value)
    content = vc ? <span className="gbadge" style={{ color: vc.color, background: vc.bg }}>{value}</span> : <span>{value}</span>
  } else if (col.key === 'Status Tax') {
    const tc = taxStatusColor(value)
    content = tc ? <span className="gbadge" style={{ color: tc.color, background: tc.bg }}>{value}</span> : <span>{value}</span>
  } else if (col.key === 'No') content = <span className="tabular whitespace-nowrap text-[11.5px]" style={{ color: '#7c8696' }}>{value}</span>
  else content = <span>{value}</span>

  return (
    <div className="gcell" style={{ width: col.width }} title={value}>
      {content}
    </div>
  )
}

// ============================ right-click context menu ============================
// TOS-style: root shows numbered categories; hovering cascades a flyout of
// columns to the side, and a column with preset values cascades a further
// flyout of values — same left/right flip logic at every nesting depth.
type MenuNode =
  | { kind: 'item'; label: string; icon?: React.ReactNode; danger?: boolean; onSelect: () => void }
  | { kind: 'sub'; label: string; icon?: React.ReactNode; options: MenuNode[] }
  | { kind: 'divider' }

/** Keep-alive chain shared down the flyout tree. Nested panels render in a
 *  PORTAL on document.body (see FlyoutItem) — outside their ancestors' DOM —
 *  so hovering one would otherwise let every ancestor's leave-timer fire and
 *  unmount the very panel being hovered. keepAlive() cancels the pending
 *  timers of THIS level and every level above; scheduleClose() re-arms them. */
const FlyoutChainCtx = createContext<{ keepAlive: () => void; scheduleClose: () => void }>({
  keepAlive: () => {}, scheduleClose: () => {},
})

/**
 * Renders one level of the menu (a list of MenuNodes) and owns which ONE
 * 'sub' sibling is currently expanded — exactly one at a time, never two at
 * once. Switching siblings (and closing on leaving the whole group) both go
 * through a short dwell delay, so diagonally crossing a sibling row while
 * heading for a deeper flyout doesn't disturb what's already open:
 *   - hovering a NEW sibling schedules a switch ~130ms out; leaving that
 *     sibling before it fires cancels the switch (it was just a pass-through)
 *   - leaving the whole group schedules a full close ~220ms out; re-entering
 *     any sibling (or the portaled panel — via the keep-alive chain) cancels it
 * Used for both the root category list and every nested value list — same
 * component at every depth. */
function FlyoutList({ items, depth = 0 }: { items: MenuNode[]; depth?: number }) {
  const parentChain = useContext(FlyoutChainCtx)
  const [active, setActive] = useState<number | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])
  const clearClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null } }
  const clearOpen = () => { if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null } }
  const keepAlive = () => { clearClose(); parentChain.keepAlive() }
  const scheduleClose = () => {
    clearOpen()
    if (!closeTimer.current) closeTimer.current = setTimeout(() => setActive(null), 220)
    parentChain.scheduleClose()
  }
  // context provided to children: their keepAlive/scheduleClose walk this whole chain
  const chain = useMemo(() => ({ keepAlive, scheduleClose }), [active]) // eslint-disable-line react-hooks/exhaustive-deps
  // hovering a sub item: cancel pending closes up the chain, then (if not
  // already active) schedule switching to it after a brief dwell
  const onItemEnter = (i: number) => {
    keepAlive()
    clearOpen()
    if (active !== i) openTimer.current = setTimeout(() => setActive(i), 130)
  }
  // leaving a sub item without landing elsewhere yet — cancel its pending switch
  const onItemLeave = () => clearOpen()
  // leaving the whole list — schedule close here and up the chain (re-entering
  // any item, or a portaled panel, cancels via keepAlive)
  const onGroupLeave = () => scheduleClose()
  // a plain (non-sub) item took the hover — collapse the open sibling now
  const onPlainEnter = () => { keepAlive(); clearOpen(); setActive(null) }

  return (
    <FlyoutChainCtx.Provider value={chain}>
      <div onMouseLeave={onGroupLeave}>
        {items.map((it, i) => {
          if (it.kind === 'divider') return <div key={i} className="ctx-div" />
          if (it.kind === 'sub') {
            return (
              <FlyoutItem key={i} node={it} depth={depth} open={active === i}
                onEnter={() => onItemEnter(i)} onLeave={onItemLeave} />
            )
          }
          return (
            <button key={i} className={cx('ctx-item', it.danger && 'danger')} onMouseEnter={onPlainEnter} onClick={it.onSelect}>
              {it.icon}<span className="clip">{it.label}</span>
            </button>
          )
        })}
      </div>
    </FlyoutChainCtx.Provider>
  )
}

/** One 'sub' row. Depth 0 (root categories) uses the plain CSS cascade
 *  (.ctx-sub absolute at left:100% — nothing clips inside .ctx-menu). Deeper
 *  panels MUST portal to document.body with fixed coordinates: the parent
 *  .ctx-sub scrolls (overflow:auto → BOTH axes clip), so an absolutely-
 *  positioned grandchild flyout is invisible even though it's in the DOM —
 *  that was the "ชั้นที่ 3 ไม่เด้ง" bug. (position:fixed WITHOUT a portal
 *  also fails: backdrop-filter on .ctx-sub makes it the containing block.)
 *  The portaled panel re-arms/cancels ancestors via the keep-alive chain. */
function FlyoutItem({ node, depth, open, onEnter, onLeave }: {
  node: Extract<MenuNode, { kind: 'sub' }>; depth: number; open: boolean; onEnter: () => void; onLeave: () => void
}) {
  const chain = useContext(FlyoutChainCtx) // this list's chain (provided by parent FlyoutList)
  const [toLeft, setToLeft] = useState(false)                                  // inline (depth-0) flip
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)   // portaled panel spot
  const itemRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const nested = depth >= 1
  const handleEnter = () => {
    const r = itemRef.current?.getBoundingClientRect()
    if (r) setToLeft(r.right > window.innerWidth - 250) // not enough room for one more flyout width
    onEnter()
  }
  // Place a portaled (nested) panel flush beside its parent item. We measure the
  // panel's REAL rendered size (not a fixed reserve) so a short 2-row flyout sits
  // right next to its item instead of being shoved toward the top — the old code
  // reserved 352px for every panel, which flung small ones far away. Runs in a
  // layout effect (after mount, before paint) so the corrected spot shows with no
  // flicker; the first render uses a provisional spot from the item rect.
  useLayoutEffect(() => {
    if (!nested || !open) { setPos(null); return }
    const it = itemRef.current?.getBoundingClientRect()
    const panel = panelRef.current
    if (!it || !panel) return
    const pw = panel.offsetWidth, ph = panel.offsetHeight
    const openLeft = it.right + pw > window.innerWidth - 8            // no room on the right → flip left
    const left = openLeft ? Math.max(8, it.left - pw + 4) : it.right - 4  // 4px overlap: no gap for the cursor to cross
    const top = Math.max(8, Math.min(it.top - 5, window.innerHeight - ph - 8))
    setPos({ top, left })
  }, [nested, open])

  const panelBody = node.options.length === 0
    ? <div className="ctx-item disabled">— no options —</div>
    : <FlyoutList items={node.options} depth={depth + 1} />

  // provisional spot for the first render (before the panel can be measured);
  // the layout effect above corrects it in the same frame
  const provisional = (): { top: number; left: number } => {
    const it = itemRef.current?.getBoundingClientRect()
    return it ? { top: Math.max(8, it.top - 5), left: it.right - 4 } : { top: -9999, left: -9999 }
  }
  const portalPos = pos ?? provisional()

  return (
    <div ref={itemRef} className={cx('ctx-item', open && 'open')} onMouseEnter={handleEnter} onMouseLeave={onLeave}>
      {node.icon}<span className="clip">{node.label}</span>
      <ChevronRight size={13} className="chev" />
      {open && !nested && (
        <div className={cx('ctx-sub', toLeft ? 'toleft' : 'toright')}>{panelBody}</div>
      )}
      {open && nested && createPortal(
        <div ref={panelRef} className="ctx-sub ctx-portal"
          style={{ position: 'fixed', top: portalPos.top, left: portalPos.left, zIndex: 100 }}
          onMouseEnter={chain.keepAlive} onMouseLeave={chain.scheduleClose}>
          {panelBody}
        </div>,
        document.body,
      )}
    </div>
  )
}

function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title: string; items: MenuNode[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      // portaled sub-panels live on document.body — clicking a value inside one
      // must NOT count as "outside the menu" (it would unmount before onClick)
      if (ref.current && !ref.current.contains(t) && !t.closest?.('.ctx-portal')) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Close on a PAGE scroll behind the menu — but NOT when the wheel scrolls a
    // long flyout list (which has its own overflow). Those scroll events target
    // the menu root or a portaled ".ctx-portal" panel; ignore them so the user
    // can wheel down to reach options below the fold.
    const onScroll = (e: Event) => {
      const t = e.target as Element | null
      if (t && ((ref.current && ref.current.contains(t)) || t.closest?.('.ctx-portal'))) return
      onClose()
    }
    window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, true) }
  }, [onClose])

  return (
    <div ref={ref} className="ctx-menu" style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-head"><ListIcon size={14} /> Actions · {title}<span className="x" onClick={onClose}><X size={15} /></span></div>
      <FlyoutList items={items} />
    </div>
  )
}

// ============================ row detail modal (View Detail) ============================
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
function parseSheetDate(s: string): number | null {
  const m = (s || '').match(/(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})/)
  if (!m) return null
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]
  if (!mon) return null
  const y = +m[3]
  return (y < 100 ? 2000 + y : y) * 10000 + mon * 100 + +m[1]
}
function darkStatusPill(v: string): { color: string } {
  const s = (v || '').toLowerCase()
  if (s.startsWith('ok')) return { color: '#34d399' }
  if (s.includes('repair')) return { color: '#f87171' }
  if (s.includes('wait')) return { color: '#fbbf24' }
  return { color: '#93c5fd' }
}

const TIMELINE_KEYS: [string, string][] = [
  ['Match Tax/Shuttle', 'Match Tax / Shuttle'], ['PDI', 'PDI'],
  ['RE PDI  Date #1', 'RE PDI #1'], ['RE PDI  Date #2', 'RE PDI #2'], ['RE PDI  Date #3', 'RE PDI #3'],
  ['RE PDI  Date #4', 'RE PDI #4'], ['RE PDI  Date #5', 'RE PDI #5'], ['RE PDI  Date #6', 'RE PDI #6'],
  ['RE PDI  Date #7', 'RE PDI #7'], ['RE PDI  Date #8', 'RE PDI #8'],
  ['OK date', 'OK date'], ['Final check date', 'Final check date'],
  ['Gate In (Rayong yard)', 'Gate In (Rayong yard)'], ['Allocation Date', 'Allocation Date'],
  ['Gate Out time stamp', 'Gate Out'],
]

function RowDetail({ vin, onClose }: { vin: string; onClose: () => void }) {
  const row = useTracking((s) => s.rows[vin])
  const columns = useTracking((s) => s.columns)
  const lang = useYard((s) => s.lang)
  const unit = useYard((s) => s.units[vin])
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const locPrefix = siteGroupingConfig(sites.find((x) => x.id === currentSite)?.name ?? '').prefix
  const damages = unit?.damages ?? []
  const updateRepairStatus = useYard((s) => s.updateRepairStatus)
  const updateDamage = useYard((s) => s.updateDamage)
  const addManualDamage = useYard((s) => s.addManualDamage)
  const removeDamage = useYard((s) => s.removeDamage)
  const allUnits = useYard((s) => s.units)
  const canEdit = useYard((s) => s.appUsers.find((u) => u.id === s.loggedInUserId)?.role === 'admin')
  const [histOpen, setHistOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(BLANK_DMG_FORM)
  // editing an existing damage row goes through the same form shape as "add
  // new" — Pencil opens it (instead of a bare trash can sitting in every row,
  // which was one misclick away from deleting) and Delete lives inside this
  // form, so removing a row now takes edit-first + confirm.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState(BLANK_DMG_FORM)
  const [tab, setTab] = useState<'overview' | 'timeline' | 'location' | 'damages' | 'event'>('overview')
  const [lightbox, setLightbox] = useState<{ photos: string[]; index: number } | null>(null)
  const queues = useQueues()
  // distinct values per column from all loaded units → combobox dropdown suggestions
  const dmgOpts = useMemo(() => {
    const S = { position: new Set<string>(), defect: new Set<string>(), catNG: new Set<string>(), catRepair: new Set<string>(), incharge: new Set<string>(), note: new Set<string>() }
    for (const u of Object.values(allUnits)) for (const d of u.damages) {
      if (d.area && d.area !== '—') S.position.add(zoneLabel(d.area))
      const df = d.item ?? d.type; if (df && df !== '—') S.defect.add(df)
      if (d.categoryNG) S.catNG.add(d.categoryNG)
      if (d.categoryRepair) S.catRepair.add(d.categoryRepair)
      if (d.incharge) S.incharge.add(d.incharge)
      if (d.note) S.note.add(d.note)
    }
    const arr = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b))
    return { position: arr(S.position), defect: arr(S.defect), catNG: arr(S.catNG), catRepair: arr(S.catRepair), incharge: arr(S.incharge), note: arr(S.note) }
  }, [allUnits])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])
  if (!row) return null

  const c = row.cells
  const head = c['Model name'] || c['Model'] || ''
  const finalStatus = c['Final Status'] || c['Status'] || '—'
  const pill = darkStatusPill(finalStatus)
  const carColor = COLOR_SW[(c['Color'] || '').toUpperCase().replace(/\s/g, '')] || '#cfd6dd'
  const pos = [c['Location yard'], cleanStorage(c['storage Yard'])].filter(Boolean).join(' · ') || '—'

  // timeline from dated columns
  const events = TIMELINE_KEYS
    .map(([k, label]) => ({ label, raw: c[k] || '', sort: parseSheetDate(c[k] || '') }))
    .filter((e) => e.raw)
    .sort((a, b) => (a.sort ?? 9e9) - (b.sort ?? 9e9))

  // location history from Move from N → Transfer N (+ current)
  const moves: { from: string; to: string }[] = []
  for (let i = 1; i <= 4; i++) {
    const from = c[`Move from  ${i}`] || '', to = c[`Transfer ${i}`] || ''
    if (from || to) moves.push({ from, to })
  }

  // ── unified "Event" log — every station's cell edits (Gate-in / Driver /
  // PDI-PM-FC / Gate-out / Relocation, plus admin edits from the context menu —
  // all logged in row.history by updateCell/bulkUpdate) merged with damage
  // creation, repair-status history, and ops-queue station processing
  // (deliver/check/return), newest first.
  const eventLog = (() => {
    type LogEntry = { at: number; by: string; station?: string; text: string; accent?: string }
    const DAMAGE_STATION_FALLBACK: Record<string, string> = {
      walkaround: 'Gate-in', pdi: 'PDI', mechanic: 'ช่าง (Mechanic)', update: 'Update Damage',
      yardDefect: 'Co-Inspection (Yard)', factoryDefect: 'Co-Inspection (Factory)', whaleDefect: 'Co-Inspection (Whale)',
      manual: 'เพิ่มเอง (Manual)',
    }
    const log: LogEntry[] = []
    for (const h of row.history ?? []) {
      if (h.field === '__damage') { log.push({ at: h.at, by: h.by, station: 'Damage', text: h.to, accent: '#dc2626' }); continue }
      log.push({ at: h.at, by: h.by, text: `แก้ไข ${h.field}: ${h.from || '(ว่าง)'} → ${h.to}` })
    }
    for (const d of damages) {
      const station = d.station || DAMAGE_STATION_FALLBACK[d.source ?? ''] || 'Gate-in'
      log.push({
        at: d.at, by: d.by, station,
        text: `บันทึก Defect ${zoneLabel(d.area)} · ${d.item ?? d.type}${d.severity === 'major' ? ' (Heavy NG)' : ''}`,
        accent: '#dc2626',
      })
      for (const h of d.repairHistory ?? []) {
        log.push({
          at: h.at, by: h.by, station: 'ซ่อม (Repair)',
          text: `เปลี่ยนสถานะซ่อม ${zoneLabel(d.area)}: ${h.from ? `${h.from} → ` : ''}${h.status}`,
          accent: '#16a34a',
        })
      }
    }
    for (const q of queues) {
      const item = q.items.find((i) => i.vin === vin)
      if (!item) continue
      if (item.deliveredAt) log.push({ at: item.deliveredAt, by: item.deliveredBy || '—', station: q.name, text: `นำรถเข้าสถานี ${q.name}${item.fromSlot ? ` (จาก ${item.fromSlot})` : ''}` })
      if (item.checkedAt) log.push({ at: item.checkedAt, by: item.checkedBy || '—', station: q.name, text: `ตรวจสอบที่ ${q.name} · ผล ${item.result ?? '—'}`, accent: item.result === 'NG' ? '#dc2626' : '#16a34a' })
      if (item.returnedAt) log.push({ at: item.returnedAt, by: item.returnedBy || '—', station: q.name, text: 'นำรถกลับเข้าจอด' })
      else if (item.doneAt && !item.checkedAt) {
        // Pre Gate-in queues rarely carry the item's doneBy (auto-reconciled) —
        // fall back to the Gate In Inspector stamped on the tracking row.
        const isGateIn = q.name.trim().startsWith('(')
        const by = item.doneBy || (isGateIn ? c['Gate In Inspector'] : '') || '—'
        log.push({ at: item.doneAt, by, station: q.name, text: isGateIn ? `Gate-in เสร็จ · ${q.name}` : `ทำรายการเสร็จที่ ${q.name}` })
      }
    }
    return log.sort((a, b) => b.at - a.at)
  })()

  const heroFields: [string, string, string][] = [
    ['MODEL', head, '#ffffff'],
    ['COLOR', c['Color'] || '—', '#ffffff'],
    ['LOCATION', c['Location yard'] || '—', '#fbbf24'],
    ['STORAGE', cleanStorage(c['storage Yard']) || '—', '#7dd3fc'],
    ['GROUPING', c['Grouping  Number'] || '—', '#7dd3fc'],
    ['COMPANY', c['company'] || '—', '#ffffff'],
    ['STATUS (PDI)', c['Status'] || '—', '#fbbf24'],
    ['PIC', c['PIC (PDI)'] || '—', '#ffffff'],
    ['GATE IN', c['Gate In (Rayong yard)'] || '—', '#ffffff'],
    ['TAX', c['Status Tax'] || '—', '#ffffff'],
  ]

  const TABS = [
    { id: 'overview' as const, label: 'Overview', icon: <Car size={14} /> },
    { id: 'timeline' as const, label: 'Timeline', icon: <Clock size={14} />, n: events.length },
    { id: 'location' as const, label: 'Location History', icon: <Route size={14} />, n: moves.length },
    { id: 'damages' as const, label: 'Damages', icon: <ShieldCheck size={14} />, n: damages.length },
    { id: 'event' as const, label: 'Event', icon: <History size={14} />, n: eventLog.length },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid glow-ring pop w-full overflow-hidden flex flex-col" style={{ maxWidth: 'min(1360px, 96vw)', maxHeight: '92vh' }} onClick={(e) => e.stopPropagation()}>
        {/* dark header */}
        <div className="flex items-center gap-3 px-5 py-3.5 shrink-0" style={{ background: 'linear-gradient(120deg,#0c1a2e,#16294a)' }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
            <Car size={20} color="#cdd9ec" />
          </div>
          <div className="min-w-0">
            <div className="vin font-bold text-[17px] text-white leading-tight">{vin}</div>
            <div className="text-[12.5px] flex items-center gap-2" style={{ color: 'rgba(255,255,255,0.65)' }}>
              {head}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold" style={{ color: pill.color, background: 'rgba(255,255,255,0.08)' }}>
                <span className="dot" style={{ background: pill.color }} />{finalStatus}
              </span>
            </div>
          </div>
          <button className="ml-auto p-1.5 rounded-lg shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }} onClick={onClose}><X size={18} /></button>
        </div>

        {/* tabs */}
        <div className="flex items-center gap-1 px-4 border-b hairline shrink-0">
          {TABS.map((tb) => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className="flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium relative transition"
              style={tab === tb.id ? { color: 'var(--brand)' } : { color: 'var(--muted)' }}>
              {tb.icon} {tb.label}
              {tb.n != null && tb.n > 0 && <span className="badge tabular" style={{ color: 'var(--brand)', background: 'var(--brand-soft)', padding: '0 6px' }}>{tb.n}</span>}
              {tab === tb.id && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: 'var(--brand)' }} />}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="overflow-auto p-5 flex-1" style={{ background: 'var(--app-bg)' }}>
          {tab === 'overview' && (
            <>
              {/* hero card */}
              <div className="rounded-2xl p-5 mb-4 relative overflow-hidden" style={{ background: 'linear-gradient(135deg,#0c1a2e,#101f36 60%,#0c1a2e)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  {/* left fields */}
                  <div className="grid gap-y-1.5 flex-1 min-w-[260px]" style={{ gridTemplateColumns: 'auto 1fr' }}>
                    {heroFields.map(([label, val, col]) => (
                      <div key={label} className="contents">
                        <div className="text-[11px] font-bold tracking-wide pr-5 py-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>{label}</div>
                        <div className="text-[13px] font-semibold py-0.5 clip" style={{ color: col }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {/* right: status + car photo */}
                  <div className="flex flex-col items-center gap-3 shrink-0">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-bold" style={{ color: pill.color, background: 'rgba(255,255,255,0.06)', border: `1px solid ${pill.color}40` }}>
                      <span className="dot" style={{ background: pill.color }} />{(finalStatus || '').toUpperCase()}
                    </span>
                    <CarTopView color={carColor} width={120} />
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-semibold" style={{ color: '#86efac', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(134,239,172,0.3)' }}>
                      <MapPin size={12} /> {pos}
                    </span>
                  </div>
                </div>
              </div>

              {/* full grouped fields */}
              <div className="space-y-4">
                {(['vehicle', 'status', 'location', 'movement', 'pm'] as ColGroup[]).map((g) => {
                  const cols = columns.filter((col) => col.group === g)
                  if (!cols.length) return null
                  return (
                    <section key={g} className="panel-solid p-4">
                      <div className="text-[11px] font-bold uppercase mb-2" style={{ color: 'var(--faint)' }}>{GROUP_LABEL[g][lang]}</div>
                      <div className="grid sm:grid-cols-2 gap-x-7 gap-y-0">
                        {cols.map((col) => {
                          // "No" → "Last update" (timestamp), "__location" → the
                          // computed yard code; everything else is a raw sheet cell
                          const val = col.key === 'No' ? fmtUpdated(row.updatedAt)
                            : col.key === LOCATION_KEY ? yardLocFull(unit, locPrefix)
                            : col.key === 'Aging PM' ? fmtAgingPm(c)
                            : col.key === 'storage Yard' ? cleanStorage(c[col.key])
                            : isDateColumn(col.key, col.label) ? fmtSerialToDate(c[col.key])
                            : (c[col.key] || '')
                          return (
                            <div key={col.key} className="flex items-center justify-between gap-3 text-[12.5px] border-b hairline py-1.5">
                              <span style={{ color: 'var(--muted)' }}>{col.label}</span>
                              <span className="font-medium text-right clip" style={{ color: val ? 'var(--text)' : 'var(--faint)' }}>{val || '—'}</span>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )
                })}
              </div>
            </>
          )}

          {tab === 'timeline' && (
            <div className="panel-solid p-5">
              {events.length === 0 ? <Empty>ไม่มีข้อมูลวันที่</Empty> : (
                <div className="relative pl-6">
                  <div className="absolute left-[7px] top-1 bottom-1 w-px" style={{ background: 'var(--line-strong)' }} />
                  {events.map((e, i) => (
                    <div key={i} className="relative pb-4 last:pb-0">
                      <span className="absolute -left-6 top-0.5 w-3.5 h-3.5 rounded-full border-2" style={{ background: '#fff', borderColor: 'var(--brand)' }} />
                      <div className="text-[13px] font-semibold">{e.label}</div>
                      <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{e.raw}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'location' && (
            <div className="panel-solid p-5">
              {moves.length === 0 && !c['Location yard'] ? <Empty>ไม่มีประวัติการย้าย</Empty> : (
                <div className="space-y-2">
                  {moves.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-[13px]">
                      <span className="badge" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>{i + 1}</span>
                      <span className="font-medium">{m.from || '—'}</span>
                      <ChevronRight size={14} style={{ color: 'var(--faint)' }} />
                      <span className="font-medium" style={{ color: 'var(--brand)' }}>{m.to || '—'}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 text-[13px] pt-1 border-t hairline mt-1">
                    <MapPin size={14} style={{ color: 'var(--st-yard)' }} />
                    <span style={{ color: 'var(--muted)' }}>ปัจจุบัน:</span>
                    <span className="font-semibold">{c['Location yard'] || '—'}{c['storage Yard'] ? ` · ${c['storage Yard']}` : ''}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'damages' && (() => {
              const stat = (d: typeof damages[number]) => d.statusRepair ?? (d.repairDate ? 'Repaired' : 'Waiting Repair')
              const waiting = damages.filter((d) => stat(d) === 'Waiting Repair').length
              const done = damages.length - waiting
              const TH = ['#', 'Position', 'Defect/NG', 'Cat NG', 'Cat (Repair)', 'Incharge', 'From/Stock', 'Date', 'Status Repair', 'Repair Date', '']
              const saveNew = () => {
                if (!form.position.trim() && !form.defect.trim()) { window.alert('กรุณากรอกอย่างน้อย Position หรือ Defect/NG'); return }
                addManualDamage(vin, form); setForm(BLANK_DMG_FORM); setAdding(false)
              }
              const toDateInput = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : '')
              const startEdit = (d: typeof damages[number]) => {
                setEditingId(d.id)
                setEditForm({
                  position: partLabel(d, 'en'), defect: defectLabel(d, 'en'),
                  categoryNG: d.categoryNG ?? '', categoryRepair: d.categoryRepair ?? '',
                  incharge: d.incharge ?? '', note: d.note ?? '',
                  date: toDateInput(d.at), statusRepair: d.statusRepair ?? 'Waiting Repair',
                  repairDate: toDateInput(d.repairDate),
                })
              }
              const cancelEdit = () => { setEditingId(null); setEditForm(BLANK_DMG_FORM) }
              const saveEdit = (d: typeof damages[number]) => {
                if (!editForm.position.trim() && !editForm.defect.trim()) { window.alert('กรุณากรอกอย่างน้อย Position หรือ Defect/NG'); return }
                const ep = resolvePart(editForm.position.trim()), ed = resolveDefect(editForm.defect.trim())
                updateDamage(vin, d.id, {
                  area: ep.en || d.area, areaTh: ep.th || d.areaTh,
                  type: editForm.defect.trim() || d.type,
                  item: ed.en || undefined, itemTh: ed.th || undefined,
                  categoryNG: (editForm.categoryNG.trim() as typeof d.categoryNG) || undefined,
                  categoryRepair: (editForm.categoryRepair.trim() as typeof d.categoryRepair) || undefined,
                  incharge: (editForm.incharge.trim() as typeof d.incharge) || undefined,
                  note: editForm.note.trim() || undefined,
                  at: editForm.date ? new Date(editForm.date).getTime() : d.at,
                  statusRepair: (editForm.statusRepair.trim() as typeof d.statusRepair) || undefined,
                  repairDate: editForm.repairDate ? new Date(editForm.repairDate).getTime() : undefined,
                })
                cancelEdit()
              }
              const deleteEdit = (d: typeof damages[number]) => {
                if (window.confirm(`ลบ Defect นี้?\n${zoneLabel(d.area)} · ${d.item ?? d.type}`)) { removeDamage(vin, d.id); cancelEdit() }
              }
              return (
              <div className="panel-solid overflow-hidden">
                {/* summary bar */}
                <div className="flex items-center gap-3 px-3.5 py-2 border-b hairline text-[12px]" style={{ background: 'var(--app-bg)' }}>
                  <span className="font-bold">{damages.length} รายการ</span>
                  {done > 0 && <span className="badge" style={{ color: '#16a34a', background: '#dcfce7' }}>ซ่อมแล้ว/รับ {done}</span>}
                  {waiting > 0 && <span className="badge" style={{ color: '#dc2626', background: '#fee2e2' }}>รอซ่อม {waiting}</span>}
                  {canEdit && (
                    <button onClick={() => setAdding((v) => !v)} className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-md font-bold text-[11.5px] transition"
                      style={adding ? { color: 'var(--muted)', background: 'var(--chip)' } : { color: '#fff', background: 'var(--brand)' }}>
                      {adding ? <><X size={13} /> ยกเลิก</> : <><Plus size={13} /> เพิ่มแผล</>}
                    </button>
                  )}
                </div>
                {damages.length === 0 && !adding ? (
                  <Empty>ไม่พบข้อมูล Defect สำหรับคันนี้{canEdit ? ' — กด “เพิ่มแผล” เพื่อบันทึก' : ''}</Empty>
                ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--chip)' }}>
                        {TH.map((h, i) => (
                          <th key={i} className="text-left px-2.5 py-3 font-bold whitespace-nowrap" style={{ color: 'var(--muted)', fontSize: 11, position: 'sticky', top: 0 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {/* ── add-damage row (admin) — พิมพ์ได้ + เลือกจาก dropdown ── */}
                      {adding && (
                        <tr style={{ background: 'rgba(37,99,235,0.06)', borderTop: '2px solid var(--brand)' }}>
                          <td className="px-2 py-2.5 font-bold whitespace-nowrap" style={{ color: 'var(--brand)', borderLeft: '3px solid var(--brand)' }}>ใหม่</td>
                          <td className="px-1 py-1.5"><Combo id="dl-pos" value={form.position} onChange={(v) => setForm({ ...form, position: v })} options={dmgOpts.position} placeholder="Position" /></td>
                          <td className="px-1 py-1.5"><Combo id="dl-defect" value={form.defect} onChange={(v) => setForm({ ...form, defect: v })} options={dmgOpts.defect} placeholder="Defect/NG" /></td>
                          <td className="px-1 py-1.5"><Combo id="dl-catng" value={form.categoryNG} onChange={(v) => setForm({ ...form, categoryNG: v })} options={dmgOpts.catNG} placeholder="Cat NG" /></td>
                          <td className="px-1 py-1.5"><Combo id="dl-catrep" value={form.categoryRepair} onChange={(v) => setForm({ ...form, categoryRepair: v })} options={dmgOpts.catRepair} placeholder="Cat (Repair)" /></td>
                          <td className="px-1 py-1.5"><Combo id="dl-incharge" value={form.incharge} onChange={(v) => setForm({ ...form, incharge: v })} options={dmgOpts.incharge} placeholder="Incharge" /></td>
                          <td className="px-1 py-1.5"><Combo id="dl-note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} options={dmgOpts.note} placeholder="From/Stock" /></td>
                          <td className="px-1 py-1.5"><Combo value={form.date} onChange={(v) => setForm({ ...form, date: v })} type="date" /></td>
                          <td className="px-1 py-1.5">
                            <select value={form.statusRepair} onChange={(e) => setForm({ ...form, statusRepair: e.target.value })}
                              className="w-full font-bold rounded px-1 py-1.5 cursor-pointer outline-none" style={{ ...repairColor(form.statusRepair), border: '1px solid var(--line-strong)', fontSize: 12 }}>
                              {REPAIR_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                            </select>
                          </td>
                          <td className="px-1 py-1.5"><Combo value={form.repairDate} onChange={(v) => setForm({ ...form, repairDate: v })} type="date" /></td>
                          <td className="px-1 py-1.5">
                            <div className="flex items-center gap-1.5">
                              <button onClick={saveNew} title="บันทึก" className="w-7 h-7 rounded flex items-center justify-center shrink-0" style={{ background: '#16a34a', color: '#fff' }}><Check size={14} /></button>
                              <button onClick={() => { setForm(BLANK_DMG_FORM); setAdding(false) }} title="ยกเลิก" className="w-7 h-7 rounded flex items-center justify-center shrink-0" style={{ background: 'var(--chip)', color: 'var(--muted)' }}><X size={14} /></button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {damages.map((d, idx) => {
                        const repaired = !!d.repairDate
                        const curStatus = stat(d)
                        const histN = d.repairHistory?.length ?? 0
                        const green = curStatus === 'Repaired' || curStatus === 'Accept'
                        const red = curStatus === 'Waiting Repair'
                        const tint = green ? 'rgba(34,197,94,0.10)' : red ? 'rgba(220,38,38,0.07)' : 'transparent'
                        const accent = green ? '#16a34a' : red ? '#dc2626' : 'var(--line-strong)'
                        const editingThis = editingId === d.id
                        if (editingThis) return (
                          <Fragment key={d.id}>
                            <tr style={{ background: 'rgba(37,99,235,0.06)', borderTop: '2px solid var(--brand)' }}>
                              <td className="px-2 py-2.5 tabular" style={{ color: 'var(--brand)', borderLeft: '3px solid var(--brand)' }}>{idx + 1}</td>
                              <td className="px-1 py-1.5"><Combo value={editForm.position} onChange={(v) => setEditForm({ ...editForm, position: v })} options={dmgOpts.position} placeholder="Position" /></td>
                              <td className="px-1 py-1.5"><Combo value={editForm.defect} onChange={(v) => setEditForm({ ...editForm, defect: v })} options={dmgOpts.defect} placeholder="Defect/NG" /></td>
                              <td className="px-1 py-1.5"><Combo value={editForm.categoryNG} onChange={(v) => setEditForm({ ...editForm, categoryNG: v })} options={dmgOpts.catNG} placeholder="Cat NG" /></td>
                              <td className="px-1 py-1.5"><Combo value={editForm.categoryRepair} onChange={(v) => setEditForm({ ...editForm, categoryRepair: v })} options={dmgOpts.catRepair} placeholder="Cat (Repair)" /></td>
                              <td className="px-1 py-1.5"><Combo value={editForm.incharge} onChange={(v) => setEditForm({ ...editForm, incharge: v })} options={dmgOpts.incharge} placeholder="Incharge" /></td>
                              <td className="px-1 py-1.5"><Combo value={editForm.note} onChange={(v) => setEditForm({ ...editForm, note: v })} options={dmgOpts.note} placeholder="From/Stock" /></td>
                              <td className="px-1 py-1.5"><Combo value={editForm.date} onChange={(v) => setEditForm({ ...editForm, date: v })} type="date" /></td>
                              <td className="px-1 py-1.5">
                                <select value={editForm.statusRepair} onChange={(e) => setEditForm({ ...editForm, statusRepair: e.target.value })}
                                  className="w-full font-bold rounded px-1 py-1.5 cursor-pointer outline-none" style={{ ...repairColor(editForm.statusRepair), border: '1px solid var(--line-strong)', fontSize: 12 }}>
                                  {REPAIR_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                                </select>
                              </td>
                              <td className="px-1 py-1.5"><Combo value={editForm.repairDate} onChange={(v) => setEditForm({ ...editForm, repairDate: v })} type="date" /></td>
                              <td className="px-1 py-1.5">
                                <div className="flex items-center gap-1.5">
                                  <button onClick={() => saveEdit(d)} title="บันทึก" className="w-7 h-7 rounded flex items-center justify-center shrink-0" style={{ background: '#16a34a', color: '#fff' }}><Check size={14} /></button>
                                  <button onClick={cancelEdit} title="ยกเลิก" className="w-7 h-7 rounded flex items-center justify-center shrink-0" style={{ background: 'var(--chip)', color: 'var(--muted)' }}><X size={14} /></button>
                                  <button onClick={() => deleteEdit(d)} title="ลบ Defect" className="w-7 h-7 rounded flex items-center justify-center shrink-0" style={{ background: 'rgba(220,38,38,0.1)', color: '#dc2626' }}><Trash2 size={14} /></button>
                                </div>
                              </td>
                            </tr>
                          </Fragment>
                        )
                        return (
                          <Fragment key={d.id}>
                            <tr style={{ background: tint, borderTop: '1px solid var(--line)' }}>
                              <td className="px-2.5 py-3 tabular" style={{ color: 'var(--faint)', borderLeft: `3px solid ${accent}` }}>{idx + 1}</td>
                              <td className="px-2.5 py-3 font-semibold whitespace-nowrap">
                                {partLabel(d, 'en')}
                                {partLabel(d, 'th') && partLabel(d, 'th') !== partLabel(d, 'en') && (
                                  <span className="block font-normal text-[11px]" style={{ color: 'var(--muted)' }}>{partLabel(d, 'th')}</span>
                                )}
                              </td>
                              <td className="px-2.5 py-3">
                                <span className="flex items-center gap-1.5">
                                  {(() => {
                                    const photos = d.photos?.length ? d.photos : (d.photo ? [d.photo] : [])
                                    return photos.map((p, pi) => (
                                      <img key={pi} src={p} onClick={() => setLightbox({ photos, index: pi })}
                                        className="w-5 h-5 rounded object-cover cursor-pointer shrink-0" alt="" title={`ดูรูป ${pi + 1}/${photos.length}`} />
                                    ))
                                  })()}
                                  <span>
                                    {defectLabel(d, 'en')}
                                    {defectLabel(d, 'th') && defectLabel(d, 'th') !== defectLabel(d, 'en') && (
                                      <span className="block text-[11px]" style={{ color: 'var(--muted)' }}>{defectLabel(d, 'th')}</span>
                                    )}
                                  </span>
                                </span>
                              </td>
                              <td className="px-2.5 py-3 whitespace-nowrap">{d.categoryNG ?? '—'}</td>
                              <td className="px-2.5 py-3 whitespace-nowrap">{d.categoryRepair ?? '—'}</td>
                              <td className="px-2.5 py-3 whitespace-nowrap">{d.incharge ?? '—'}</td>
                              <td className="px-2.5 py-3 whitespace-nowrap" style={{ color: 'var(--muted)' }}>{d.note ?? '—'}</td>
                              <td className="px-2.5 py-3 whitespace-nowrap" style={{ color: 'var(--muted)' }}>{fmtDay(d.at)}</td>
                              <td className="px-2 py-2">
                                {canEdit ? (
                                  <select value={curStatus} onChange={(e) => updateRepairStatus(vin, d.id, e.target.value)}
                                    className="font-bold rounded-md px-2 py-1 cursor-pointer outline-none" style={{ ...repairColor(curStatus), border: 'none', fontSize: 12 }} title="แก้ไขสถานะการซ่อม">
                                    {REPAIR_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                                  </select>
                                ) : <span className="badge whitespace-nowrap" style={repairColor(curStatus)}>{curStatus}</span>}
                              </td>
                              <td className="px-2.5 py-3 whitespace-nowrap" style={{ color: repaired ? '#16a34a' : 'var(--faint)' }}>{repaired ? fmtDay(d.repairDate!) : '—'}</td>
                              <td className="px-2 py-2">
                                <div className="flex items-center gap-2.5">
                                  {histN > 0 && (
                                    <button onClick={() => setHistOpen(histOpen === d.id ? null : d.id)} className="flex items-center gap-0.5 whitespace-nowrap" style={{ color: 'var(--brand)', fontSize: 11 }} title="ประวัติการเปลี่ยนสถานะ">
                                      <Clock size={12} /> {histN}
                                    </button>
                                  )}
                                  {canEdit && (
                                    <button onClick={() => startEdit(d)}
                                      className="shrink-0 opacity-70 hover:opacity-100" style={{ color: 'var(--brand)' }} title="แก้ไข Defect">
                                      <Pencil size={14} />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {histOpen === d.id && histN > 0 && (
                              <tr style={{ background: 'var(--app-bg)' }}>
                                <td colSpan={TH.length} className="px-3.5 py-2">
                                  <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--muted)' }}>ประวัติการเปลี่ยนสถานะ ({histN})</div>
                                  <div className="space-y-1">
                                    {[...d.repairHistory!].reverse().map((h, i) => (
                                      <div key={i} className="flex items-center gap-1.5 text-[11px] flex-wrap">
                                        <Clock size={10.5} style={{ color: 'var(--faint)', flexShrink: 0 }} />
                                        <span className="font-semibold">{h.by}</span>
                                        <span style={{ color: 'var(--muted)' }}>แก้ไข</span>
                                        {h.from
                                          ? <><span className="badge" style={{ ...repairColor(h.from), fontSize: 9.5 }}>{h.from}</span>
                                              <span style={{ color: 'var(--muted)' }}>เป็น</span></>
                                          : <span style={{ color: 'var(--muted)' }}>เป็น</span>}
                                        <span className="badge" style={{ ...repairColor(h.status), fontSize: 9.5 }}>{h.status}</span>
                                        <span style={{ color: 'var(--faint)' }}>· {fmtDT(h.at)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                )}
              </div>
              )
            })()}

          {tab === 'event' && (
            <div className="panel-solid p-5">
              {eventLog.length === 0 ? <Empty>ยังไม่มีประวัติการเปลี่ยนแปลง</Empty> : (
                <div className="relative pl-6">
                  <div className="absolute left-[7px] top-1 bottom-1 w-px" style={{ background: 'var(--line-strong)' }} />
                  {eventLog.map((e, i) => (
                    <div key={i} className="relative pb-4 last:pb-0">
                      <span className="absolute -left-6 top-0.5 w-3.5 h-3.5 rounded-full border-2" style={{ background: '#fff', borderColor: e.accent ?? 'var(--brand)' }} />
                      <div className="flex items-center gap-2 flex-wrap text-[11.5px] mb-0.5">
                        <span className="font-bold" style={{ color: 'var(--text)' }}>{e.by}</span>
                        {e.station && <span className="badge" style={{ color: 'var(--brand)', background: 'var(--brand-soft)', fontSize: 10.5 }}>{e.station}</span>}
                        <span style={{ color: 'var(--faint)' }}>{fmtDT(e.at)}</span>
                      </div>
                      <div className="text-[13px]">{e.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {lightbox && <PhotoLightbox photos={lightbox.photos} index={lightbox.index} onClose={() => setLightbox(null)} />}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-center py-10 text-[13px]" style={{ color: 'var(--faint)' }}>— {children} —</div>
}

// ============================ filter manager (choose filters from columns) ============================
// Filters are picked FROM the (visible) columns — up to MAX_FILTERS at once,
// orderable. Unit Nbr + Grouping are pinned separately.
function FilterManager({ cols, filterCols, setFilterCols, onClose }: {
  cols: Column[]; filterCols: string[]; setFilterCols: React.Dispatch<React.SetStateAction<string[]>>; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  // only columns that still exist / are visible can be chosen; keep chosen order
  const chosen = filterCols.filter((k) => cols.some((c) => c.key === k))
  const chosenSet = new Set(chosen)
  const labelOf = (k: string) => cols.find((c) => c.key === k)?.label ?? k
  const q = query.trim().toLowerCase()
  const available = cols.filter((c) => !chosenSet.has(c.key) && (!q || c.label.toLowerCase().includes(q) || c.key.toLowerCase().includes(q)))
  const full = chosen.length >= MAX_FILTERS

  const add = (k: string) => setFilterCols((f) => (f.includes(k) || f.length >= MAX_FILTERS ? f : [...f, k]))
  const remove = (k: string) => setFilterCols((f) => f.filter((x) => x !== k))
  const move = (k: string, dir: -1 | 1) => setFilterCols((f) => {
    const i = f.indexOf(k); const j = i + dir
    if (i < 0 || j < 0 || j >= f.length) return f
    const next = [...f];[next[i], next[j]] = [next[j], next[i]]; return next
  })
  const reset = () => setFilterCols(DEFAULT_FILTER_COLS.filter((k) => cols.some((c) => c.key === k)))
  const clear = () => setFilterCols([])

  return (
    <div className="panel-solid shrink-0 flex flex-col fade-up" style={{ width: 278 }}>
      <div className="flex items-center justify-between px-3 py-2.5 border-b hairline shrink-0">
        <div className="font-semibold text-[13.5px] flex items-center gap-1.5"><SlidersHorizontal size={15} /> ปรับแต่งช่องกรอง <span className="tabular" style={{ color: chosen.length >= MAX_FILTERS ? 'var(--st-damage)' : 'var(--faint)' }}>({chosen.length}/{MAX_FILTERS})</span></div>
        <button className="btn btn-ghost p-1.5" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="flex items-center gap-1.5 px-3 py-2 border-b hairline shrink-0 text-[12px]">
        <button className="btn btn-ghost px-2 py-1" onClick={reset}>ค่าเริ่มต้น</button>
        <button className="btn btn-ghost px-2 py-1" onClick={clear}>ล้างทั้งหมด</button>
      </div>
      <div className="overflow-auto flex-1 p-2">
        {/* pinned */}
        <div className="text-[10.5px] font-bold uppercase px-1 py-1" style={{ color: 'var(--faint)' }}>ตรึงไว้</div>
        {['Unit Nbr', 'Grouping'].map((label) => (
          <div key={label} className="flex items-center gap-2 px-1.5 py-1 rounded-md" style={{ opacity: 0.7 }}>
            <Lock size={12} style={{ color: 'var(--faint)' }} />
            <span className="text-[12.5px] flex-1">{label}</span>
          </div>
        ))}

        {/* chosen filters (ordered) */}
        <div className="text-[10.5px] font-bold uppercase px-1 py-1 mt-2" style={{ color: 'var(--faint)' }}>ช่องกรองที่เลือก</div>
        {chosen.length === 0 && <div className="text-[11.5px] px-1.5 py-1" style={{ color: 'var(--faint)' }}>ยังไม่ได้เลือก — ติ๊กคอลัมน์ด้านล่างเพื่อเพิ่ม</div>}
        {chosen.map((k) => (
          <div key={k} className="flex items-center gap-2 px-1.5 py-1 rounded-md row-hover">
            <input type="checkbox" checked onChange={() => remove(k)} />
            <span className="text-[12.5px] flex-1 clip" title={k}>{labelOf(k)}</span>
            <button className="btn btn-ghost p-0.5" title="เลื่อนขึ้น" onClick={() => move(k, -1)}><ChevronUp size={13} /></button>
            <button className="btn btn-ghost p-0.5" title="เลื่อนลง" onClick={() => move(k, 1)}><ChevronDown size={13} /></button>
          </div>
        ))}

        {/* available columns to add (from the column manager set) */}
        <div className="text-[10.5px] font-bold uppercase px-1 py-1 mt-2 flex items-center gap-1.5" style={{ color: 'var(--faint)' }}>
          เพิ่มจากคอลัมน์ {full && <span style={{ color: 'var(--st-damage)' }}>· ครบ {MAX_FILTERS} แล้ว</span>}
        </div>
        <div className="relative mb-1">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--faint)' }} />
          <input className="input py-1.5 text-[12.5px] w-full" style={{ paddingLeft: 26 }} placeholder="ค้นหาคอลัมน์…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {available.map((c) => (
          <label key={c.key} className="flex items-center gap-2 px-1.5 py-1 rounded-md row-hover" style={full ? { opacity: 0.4, cursor: 'not-allowed' } : { cursor: 'pointer' }}>
            <input type="checkbox" checked={false} disabled={full} onChange={() => add(c.key)} />
            <span className="text-[12.5px] flex-1 clip" title={c.key}>{c.label}</span>
          </label>
        ))}
        {available.length === 0 && q && <div className="text-center text-[12px] py-3" style={{ color: 'var(--faint)' }}>ไม่พบคอลัมน์</div>}
      </div>
      <ViewDefaultButtons />
    </div>
  )
}

// shared "default view" controls — admins publish the current columns + filters
// as everyone's starting default; anyone can pull the latest default on demand
function ViewDefaultButtons() {
  const isAdmin = useYard((s) => s.appUsers.find((u) => u.id === s.loggedInUserId)?.role === 'admin')
  const toast = useYard((s) => s.toast)
  const saveViewDefault = useTracking((s) => s.saveViewDefault)
  const resetToViewDefault = useTracking((s) => s.resetToViewDefault)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!window.confirm('ตั้งลำดับคอลัมน์ + ช่องกรองปัจจุบัน เป็นค่าเริ่มต้นของทุกคน?\n\nทุก user และทุก yard จะได้ลำดับนี้อัตโนมัติ ไม่ต้องดาวน์โหลดหรือกดโหลดเอง\n(เครื่องที่เปิดอยู่เห็นทันที · ที่เหลือเห็นตอนเข้าใช้งานครั้งถัดไป) — แล้วแต่ละคนปรับแต่งของตัวเองได้ภายหลัง')) return
    setBusy(true)
    try { await saveViewDefault(); toast('ok', 'ตั้งเป็นค่าเริ่มต้นของทุกคนแล้ว — ส่งให้ทุกคนอัตโนมัติ') }
    catch { toast('err', 'บันทึกไม่สำเร็จ — ต้องสร้างตาราง app_config ใน Supabase ก่อน') }
    setBusy(false)
  }
  const load = async () => {
    setBusy(true)
    try { const ok = await resetToViewDefault(); toast(ok ? 'ok' : 'info', ok ? 'ใช้ค่าเริ่มต้นที่แอดมินตั้งไว้แล้ว' : 'ยังไม่มีค่าเริ่มต้นที่ตั้งไว้') }
    catch { toast('err', 'ดึงค่าเริ่มต้นไม่สำเร็จ') }
    setBusy(false)
  }
  return (
    <div className="p-2 border-t hairline shrink-0 space-y-1">
      {isAdmin && (
        <button className="btn btn-ghost w-full justify-center text-[12px] py-1.5" disabled={busy} onClick={save} title="ตั้งคอลัมน์+ช่องกรองปัจจุบันเป็นค่าเริ่มต้นของทุกคน — ส่งให้อัตโนมัติ ไม่ต้องดาวน์โหลด">
          <Check size={13} /> ตั้งเป็นค่าเริ่มต้นของทุกคน
        </button>
      )}
      <button className="btn btn-ghost w-full justify-center text-[12px] py-1.5" disabled={busy} onClick={load} title="ดึงค่าเริ่มต้นที่แอดมินตั้งไว้มาใช้กับเครื่องนี้ทันที (ปกติได้อัตโนมัติอยู่แล้ว)">
        <RefreshCw size={13} /> ใช้ค่าเริ่มต้นของแอดมิน
      </button>
    </div>
  )
}

function DefRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex gap-2 text-[13px]">
      <span className="shrink-0" style={{ color: 'var(--muted)', width: 96 }}>{label}</span>
      <span className="font-semibold flex-1 min-w-0" style={color ? { color } : undefined}>{value}</span>
    </div>
  )
}

// ============================ column manager ============================
function ColumnManager({ onClose }: { onClose: () => void }) {
  const lang = useYard((s) => s.lang)
  const { columns, toggleColumn, moveColumn, addColumn, removeColumn, showAll, resetColumns } = useTracking()
  const [newCol, setNewCol] = useState('')
  const [query, setQuery] = useState('')
  const groups: ColGroup[] = ['vehicle', 'status', 'location', 'movement', 'pm']
  const visCount = columns.filter((c) => c.visible).length
  // filter the list by label or key (case-insensitive) — moving is disabled while
  // searching since positions no longer reflect the true column order
  const q = query.trim().toLowerCase()
  const matches = (c: Column) => !q || c.label.toLowerCase().includes(q) || c.key.toLowerCase().includes(q)
  const hitCount = q ? columns.filter(matches).length : 0

  return (
    <div className="panel-solid shrink-0 flex flex-col fade-up" style={{ width: 290 }}>
      <div className="flex items-center justify-between px-3 py-2.5 border-b hairline shrink-0">
        <div className="font-semibold text-[13.5px] flex items-center gap-1.5"><Columns3 size={15} /> จัดการคอลัมน์ <span className="tabular" style={{ color: 'var(--faint)' }}>({visCount})</span></div>
        <button className="btn btn-ghost p-1.5" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="px-3 pt-2.5 pb-1 border-b hairline shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--faint)' }} />
          <input
            className="input py-1.5 text-[12.5px] w-full"
            style={{ paddingLeft: 26, paddingRight: query ? 26 : undefined }}
            placeholder="ค้นหาคอลัมน์…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
          />
          {query && (
            <button className="btn btn-ghost p-0.5 absolute right-1.5 top-1/2 -translate-y-1/2" title="ล้าง" onClick={() => setQuery('')}><X size={12} /></button>
          )}
        </div>
        <div className="flex items-center gap-1.5 py-2 text-[12px]">
          <button className="btn btn-ghost px-2 py-1" onClick={() => showAll(true)}>แสดงทั้งหมด</button>
          <button className="btn btn-ghost px-2 py-1" onClick={() => showAll(false)}>ซ่อนทั้งหมด</button>
          <button className="btn btn-ghost px-2 py-1 ml-auto" onClick={resetColumns}>รีเซ็ต</button>
        </div>
      </div>
      <div className="overflow-auto flex-1 p-2">
        {q && hitCount === 0 && (
          <div className="text-center text-[12px] py-6" style={{ color: 'var(--faint)' }}>ไม่พบคอลัมน์ที่ตรงกับ “{query}”</div>
        )}
        {groups.map((g) => {
          const cols = columns.filter((c) => c.group === g && matches(c))
          if (!cols.length) return null
          return (
            <div key={g} className="mb-2">
              <div className="text-[10.5px] font-bold uppercase px-1 py-1" style={{ color: 'var(--faint)' }}>{GROUP_LABEL[g][lang]}</div>
              {cols.map((c) => (
                <div key={c.key} className="flex items-center gap-2 px-1.5 py-1 rounded-md row-hover">
                  <input type="checkbox" checked={c.visible} onChange={() => toggleColumn(c.key)} />
                  <span className="text-[12.5px] flex-1 clip" title={c.key}>{c.label}{c.custom && <span className="ml-1 text-[10px]" style={{ color: 'var(--brand)' }}>•</span>}</span>
                  <button className="btn btn-ghost p-0.5" title={q ? 'ล้างการค้นหาก่อนจึงจะจัดเรียงได้' : 'เลื่อนขึ้น'} disabled={!!q} onClick={() => moveColumn(c.key, -1)}><ChevronUp size={13} /></button>
                  <button className="btn btn-ghost p-0.5" title={q ? 'ล้างการค้นหาก่อนจึงจะจัดเรียงได้' : 'เลื่อนลง'} disabled={!!q} onClick={() => moveColumn(c.key, 1)}><ChevronDown size={13} /></button>
                  {c.custom && <button className="btn btn-ghost p-0.5" title="ลบ" onClick={() => removeColumn(c.key)}><Trash2 size={12} style={{ color: 'var(--st-damage)' }} /></button>}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <div className="p-2.5 border-t hairline shrink-0 flex items-center gap-1.5">
        <input className="input" placeholder="เพิ่มคอลัมน์ใหม่…" value={newCol} onChange={(e) => setNewCol(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && newCol.trim()) { addColumn(newCol); setNewCol('') } }} />
        <button className="btn btn-primary px-2.5" onClick={() => { if (newCol.trim()) { addColumn(newCol); setNewCol('') } }}><Plus size={15} /></button>
      </div>
      <ViewDefaultButtons />
    </div>
  )
}

function FInput({ label, value, onChange, placeholder, wide }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; wide?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-[12px] font-medium whitespace-nowrap" style={{ color: 'var(--muted)' }}>{label}:</span>
      <input className="input py-1.5 text-[12.5px] vin uppercase" style={{ width: wide ? 180 : 124 }} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function FSel({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-[12px] font-medium whitespace-nowrap" style={{ color: 'var(--muted)' }}>{label}:</span>
      <select className="select w-auto py-1.5 text-[12.5px]" style={{ minWidth: 84, maxWidth: 132 }} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
}

function Hint({ k, children }: { k: string; children: any }) {
  return <span className="inline-flex items-center gap-1"><kbd className="k">{k}</kbd>{children}</span>
}
