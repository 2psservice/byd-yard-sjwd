import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  UploadCloud, FileSpreadsheet, Download, Sparkles, Trash2, CheckCircle2, Table2,
  Loader2, Database, MapPin, Car, CalendarDays, Hourglass, ClipboardCheck, AlertTriangle,
} from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { downloadTemplate } from '../lib/excel'
import { parseTrackingWorkbook, parseImportWorkbook, type ParseResult } from '../lib/excelTracking'
import { parseLane, resolveBlock, parseLaneWorkbook, type LaneParseResult, type LaneRow } from '../lib/laneImport'
import { coInspectionAccepts, rowInSite, siteForRow } from '../lib/siteScope'
import { pos } from '../lib/format'
import { PageHead } from '../components/ui'

/** group key for a row's date — Pre Gate-in files date by "Gate In Date",
 *  transfer files by "moving date" (empty → "(ไม่ระบุ)") */
const dateKey = (cells: Record<string, string>) => (cells['Gate In Date'] || cells['moving date'] || '').trim() || '(ไม่ระบุ)'

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
/** Parse a moving-date label to a sortable YYYYMMDD number (unknown → -Infinity → bottom). */
function dateSortVal(s: string): number {
  if (!s || s === '(ไม่ระบุ)') return -Infinity
  const yr = (y: number) => (y < 100 ? 2000 + y : y)
  let m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})$/) // 10-Dec-25
  if (m) { const mon = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mon) return yr(+m[3]) * 10000 + mon * 100 + +m[1] }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/) // 12/10/25 (M/D/Y)
  if (m) return yr(+m[3]) * 10000 + +m[1] * 100 + +m[2]
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) // 2025-12-10
  if (m) return +m[1] * 10000 + +m[2] * 100 + +m[3]
  return -Infinity
}

export function ImportPage() {
  const { loadSample, clearAll, toast, importDefects, updateLocations } = useYard()
  const blocksBySite = useYard((s) => s.blocksBySite)
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const curSiteName = sites.find((s) => s.id === currentSite)?.name ?? '—'
  const yardUnits = useYard((s) => s.units)
  const { commitImport, commitCoInspection, clearRows, lastImport, loadFromIdb } = useTracking()
  const existing = useTracking((s) => s.rows)
  const rowCount = Object.keys(existing).length
  // distinct vehicles across BOTH stores (gated-in cars live in tracking + yard units)
  const vehicleCount = useMemo(
    () => new Set([...Object.keys(existing), ...Object.keys(yardUnits)]).size,
    [existing, yardUnits],
  )
  const { createQueue, addVins: addQueueVins, clearQueues } = useOps()

  // wipe every store so the system returns to a clean, empty state
  const clearEverything = () => {
    clearRows()     // tracking rows + IndexedDB
    clearAll()      // yard units + trailers + trips
    clearQueues()   // Pre Gate-in work queues
    toast('info', 'ล้างข้อมูลทั้งหมดแล้ว')
  }

  // load existing rows from IndexedDB so duplicate VINs are detected & skipped
  useEffect(() => { loadFromIdb() }, [loadFromIdb])

  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [selectedDate, setSelectedDate] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // ── Co Inspection (merge) import ──
  const [coParsed, setCoParsed] = useState<ParseResult | null>(null)
  const [coFileName, setCoFileName] = useState('')
  const [coBusy, setCoBusy] = useState(false)
  const [coSaving, setCoSaving] = useState(false)
  const [coDrag, setCoDrag] = useState(false)
  const coInputRef = useRef<HTMLInputElement>(null)

  // ── Update Location (VinNo + LaneNo → block/row/slot) ──
  const [locParsed, setLocParsed] = useState<LaneParseResult | null>(null)
  const [locFileName, setLocFileName] = useState('')
  const [locBusy, setLocBusy] = useState(false)
  const [locDrag, setLocDrag] = useState(false)
  const locInputRef = useRef<HTMLInputElement>(null)

  const handleLocFile = async (file: File) => {
    setLocBusy(true)
    try {
      const res = await parseLaneWorkbook(file)
      setLocParsed(res); setLocFileName(file.name)
    } catch (e: any) {
      toast('err', e?.message || 'อ่านไฟล์ไม่สำเร็จ — ต้องมีคอลัมน์ VinNo + LaneNo')
    } finally { setLocBusy(false) }
  }

  // slot plan: the lane digits = the block's COLUMN (ช่องด้านบน, e.g. N-O15 →
  // block OO column 15); cars stack down that column's rows 1..8 in file order,
  // skipping cells already occupied by cars NOT in this file (re-placed cars
  // free their old cell)
  const locPlan = useMemo(() => {
    if (!locParsed) return null
    // the file is the source of truth, newest row wins: a VIN repeated in the
    // file (movement history) keeps only its LAST row's lane
    const lastIdx = new Map<string, number>()
    locParsed.rows.forEach((r, i) => lastIdx.set(r.vin, i))
    const dup = locParsed.rows.length - lastIdx.size
    const rows = locParsed.rows.filter((r, i) => lastIdx.get(r.vin) === i)
    const placing = new Set(rows.map((r) => r.vin))
    const occ = new Map<string, Set<number>>() // "block|column" → used rows
    for (const u of Object.values(yardUnits)) {
      if (!u.block || !u.row || !u.slot || u.status === 'DEPARTED' || placing.has(u.vin)) continue
      const k = `${u.block}|${u.slot}`
      if (!occ.has(k)) occ.set(k, new Set())
      occ.get(k)!.add(u.row)
    }
    // this yard's blocks (match by internal id OR display name, e.g. name "NN").
    // Needed BEFORE placing: the file's lane token is resolved against these, since
    // yards name blocks differently ("A" here vs "AA" at NYB2).
    const drawn = new Set<string>()
    for (const b of blocksBySite[currentSite ?? '_global'] ?? []) {
      drawn.add(b.id.trim().toUpperCase())
      if (b.name) drawn.add(b.name.trim().toUpperCase())
    }
    const placements: { vin: string; block: string; row: number; slot: number; modelName?: string; color?: string; gateInAt?: number }[] = []
    const badLane: LaneRow[] = []
    const rowFull: LaneRow[] = []
    for (const r of rows) {
      const lane = parseLane(r.lane)
      if (!lane) { badLane.push(r); continue }
      const block = resolveBlock(lane.block, drawn)
      const k = `${block}|${lane.row}`
      if (!occ.has(k)) occ.set(k, new Set())
      const used = occ.get(k)!
      let posn = 0
      for (let i = 1; i <= 8; i++) if (!used.has(i)) { posn = i; break }
      if (!posn) { rowFull.push(r); continue }
      used.add(posn)
      placements.push({ vin: r.vin, block, row: posn, slot: lane.row, modelName: r.modelName, color: r.colorName, gateInAt: r.gateInAt })
    }
    const byBlock = new Map<string, number>()
    for (const p of placements) byBlock.set(p.block, (byBlock.get(p.block) ?? 0) + 1)
    const matched = placements.filter((p) => yardUnits[p.vin]).length
    // blocks referenced by the file but not yet drawn in this yard's plan
    const missingBlocks = [...byBlock.keys()].filter((b) => !drawn.has(b)).sort()
    return { placements, badLane, rowFull, dup, matched, byBlock: [...byBlock.entries()].sort(), missingBlocks }
  }, [locParsed, yardUnits, blocksBySite, currentSite])

  const confirmLoc = () => {
    if (!locPlan || !locPlan.placements.length) return
    const n = updateLocations(locPlan.placements)
    toast('ok', `Update Location · จัดตำแหน่ง ${n.toLocaleString()} คัน` +
      (locPlan.rowFull.length ? ` · ช่องเต็ม ข้าม ${locPlan.rowFull.length}` : '') +
      (locPlan.badLane.length ? ` · Lane อ่านไม่ได้ ${locPlan.badLane.length}` : ''))
    setLocParsed(null); setLocFileName('')
  }

  const handleFile = async (file: File) => {
    setBusy(true)
    try {
      const res = await parseImportWorkbook(file)
      setParsed(res); setFileName(file.name); setSelectedDate('')
    } catch (e: any) {
      toast('err', e?.message || 'อ่านไฟล์ไม่สำเร็จ — ตรวจรูปแบบ Excel')
    } finally { setBusy(false) }
  }

  const handleCoFile = async (file: File) => {
    setCoBusy(true)
    try {
      const res = await parseTrackingWorkbook(file)
      setCoParsed(res); setCoFileName(file.name)
    } catch (e: any) {
      toast('err', e?.message || 'อ่านไฟล์ไม่สำเร็จ — ตรวจรูปแบบ Excel')
    } finally { setCoBusy(false) }
  }

  // yard scoping: only rows for the active site (or unplaced) count; other yards are skipped
  const coAccepted = useMemo(
    () => (coParsed ? coParsed.rows.filter((r) => coInspectionAccepts(r.cells, sites, currentSite)) : []),
    [coParsed, sites, currentSite],
  )
  const coOtherYard = coParsed ? coParsed.rows.length - coAccepted.length : 0
  const coMatched = useMemo(() => coAccepted.filter((r) => existing[r.vin]).length, [coAccepted, existing])
  const coNew = coAccepted.length - coMatched
  // cars already in the system whose file row now says gate-out → will flip to Gate-out
  const coGateOut = useMemo(
    () => (coParsed ? (coParsed.gateOutRows ?? []).filter((r) => existing[r.vin]).length : 0),
    [coParsed, existing],
  )

  const confirmCo = async () => {
    if (!coParsed || coSaving) return
    setCoSaving(true)
    try {
      const { updated, added, skipped, gateOut, moved } = commitCoInspection(coParsed)
      // defects: only for VINs that belong to this yard (accepted from the file, or already here)
      const okVins = new Set(coAccepted.map((r) => r.vin))
      const defectsForSite = coParsed.defects.filter((d) => okVins.has(d.vin) || rowInSite(existing[d.vin], currentSite, sites))
      // AWAIT the cloud write — importDefects can push 10k+ damage rows; blocking here
      // (with the overlay below) stops the user reloading before it finishes
      const def = await importDefects(defectsForSite, existing)
      toast(
        'ok',
        `Co Inspection · เติม ${updated.toLocaleString()} คัน${added ? ` · ใหม่ ${added.toLocaleString()}` : ''}` +
          (gateOut ? ` · Gate-out ${gateOut.toLocaleString()}` : '') +
          (def.damages ? ` · Defect ${def.damages.toLocaleString()}` : '') +
          (moved ? ` · ย้ายไปยาร์ดที่ถูกต้อง ${moved.toLocaleString()}` : '') +
          (skipped ? ` · ข้ามยาร์ดอื่น ${skipped.toLocaleString()}` : ''),
      )
      setCoParsed(null); setCoFileName('')
    } catch (e: any) {
      toast('err', e?.message || 'บันทึกไม่สำเร็จ')
    } finally { setCoSaving(false) }
  }

  // yard scoping: Pre Gate-in imports only the ACTIVE site's sheet — a Vin List
  // Inventory file has one sheet per yard (Rayong · SOI 5 · NYB2 · 20/38 Rai), and
  // each row is tagged with its yard's "Location yard". We keep only the rows that
  // map to the current site so the date counts / import reflect just this yard.
  const siteRows = useMemo(() => {
    if (!parsed) return []
    if (!currentSite) return parsed.rows
    return parsed.rows.filter((r) => siteForRow(r.cells, sites, currentSite) === currentSite)
  }, [parsed, sites, currentSite])
  const otherYardCount = parsed ? parsed.rows.length - siteRows.length : 0

  // distinct moving dates found in the file (with counts) — drives the picker
  const movingDates = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of siteRows) { const d = dateKey(r.cells); m.set(d, (m.get(d) ?? 0) + 1) }
    return [...m.entries()].sort((a, b) => dateSortVal(b[0]) - dateSortVal(a[0])) // latest date first
  }, [siteRows])

  // rows matching the picked date, split into NEW vs already-in-system (skipped)
  const selRows = useMemo(
    () => (selectedDate ? siteRows.filter((r) => dateKey(r.cells) === selectedDate) : siteRows),
    [siteRows, selectedDate],
  )
  // NEW vins only — a VIN already in the system (e.g. already gated-in / In Yard)
  // is skipped: never re-imported and never re-queued, so no duplicate work
  const newRows = useMemo(() => selRows.filter((r) => !existing[r.vin]), [selRows, existing])
  const dupCount = selRows.length - newRows.length
  const importCount = newRows.length

  const confirm = () => {
    if (!parsed || !newRows.length) return
    for (const r of newRows) r.cells['Car Status'] = 'Pre Gate-in'
    commitImport({ ...parsed, rows: newRows, inYard: newRows.length })
    toast('ok', `นำเข้าใหม่ ${newRows.length.toLocaleString()} คัน · ข้ามซ้ำ (In Yard เดิม) ${dupCount.toLocaleString()} · Pre Gate-in`)

    // build a Gate-in work queue per (yard + Gate-in date) from NEW VINs ONLY —
    // a VIN already in the system is skipped (never re-queued) so gated-in cars
    // aren't dragged back into a Pre Gate-in queue and no duplicate work is made.
    // Different yards never share a queue; each is tagged to its own yard's site
    // so that yard's YardOps sees it. Name MUST start with "(" (isPreGateInQueue).
    const groups = new Map<string, { site?: string; yard: string; date: string; vins: string[] }>()
    for (const r of newRows) {
      const dk = dateKey(r.cells)
      if (dk === '(ไม่ระบุ)') continue
      const yard = (r.cells['Location yard'] || '').trim() || '—'
      const key = `${yard}||${dk}`
      const g = groups.get(key) ?? { site: siteForRow(r.cells, sites, currentSite), yard, date: dk, vins: [] }
      g.vins.push(r.vin)
      groups.set(key, g)
    }
    for (const g of groups.values()) {
      const sv = dateSortVal(g.date)
      const datePart = sv > 0 ? `${Math.floor((sv % 10000) / 100)}-${sv % 100}` : g.date
      const qName = `(${g.yard} · ${datePart} · ${g.vins.length})`
      const qid = createQueue(qName, undefined, g.site)
      if (qid) addQueueVins(qid, g.vins)
    }

    setParsed(null); setFileName(''); setSelectedDate('')
  }

  const breakdown = useMemo(() => {
    const m: Record<string, number> = {}, l: Record<string, number> = {}
    for (const r of siteRows) {
      const mod = r.cells['Model'] || '—'; m[mod] = (m[mod] ?? 0) + 1
      const loc = r.cells['Location yard'] || '—'; l[loc] = (l[loc] ?? 0) + 1
    }
    const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1])
    return { models: top(m), locs: top(l) }
  }, [siteRows])

  return (
    <div className="max-w-[1100px] mx-auto">
      <PageHead title="นำเข้าข้อมูล" sub="อัปโหลดไฟล์ Excel (Vin list / Yard-to-Yard transfer) ที่มีคอลัมน์ Vin — ดาวน์โหลดเทมเพลตด้านขวาเพื่อดูคอลัมน์ที่รองรับ" />

      <div className="grid lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3">
          {/* Pre Gate-in import (per-yard Vin List Inventory) */}
          <div className="panel overflow-hidden fade-up">
            <div className="flex items-center gap-2 px-4 py-3 border-b hairline">
              <Hourglass size={16} style={{ color: 'var(--brand)' }} />
              <span className="font-semibold text-[14px]">Pre Gate-in</span>
              <span className="text-[12px] ml-auto" style={{ color: 'var(--muted)' }}>นำเข้า Vin List แยกตามยาร์ด → สร้างคิว Gate-in อัตโนมัติ</span>
            </div>
            <div className="p-4">
              <UploadRow
                color="var(--brand)" soft="var(--brand-soft)"
                icon={<UploadCloud size={20} style={{ color: 'var(--brand)' }} />}
                title="ลากไฟล์ Vin List Inventory มาวาง หรือคลิกเพื่อเลือก"
                sub={<>อ่านชีตแยกตามยาร์ด (Rayong · SOI 5 · NYB2 · 20 Rai · 38 Rai) — เลือกวันที่จาก <b>Gate In Date</b> · นำเข้าเป็น Pre Gate-in</>}
                busy={busy} drag={drag} inputRef={inputRef} onFile={handleFile} setDrag={setDrag}
              />
            </div>
          </div>

          {/* preview / summary */}
          {parsed && (
            <div className="panel-solid mt-4 fade-up overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b hairline">
                <FileSpreadsheet size={16} style={{ color: 'var(--brand)' }} />
                <span className="font-semibold text-[14px] clip">{fileName}</span>
                <span className="badge ml-auto" style={{ color: 'var(--brand)', background: 'rgba(37,99,235,0.1)' }}>{parsed.headers.length} คอลัมน์</span>
              </div>
              <div className="grid grid-cols-3 gap-px" style={{ background: 'var(--line)' }}>
                <SumCell label="นำเข้าใหม่" value={importCount} accent="var(--st-yard)" big />
                <SumCell label="ซ้ำในระบบ — ข้าม" value={dupCount} accent="var(--st-pending)" />
                <SumCell label="ทั้งหมด (ยาร์ดนี้)" value={siteRows.length} accent="var(--text)" />
              </div>
              <div className="px-4 py-2 border-t hairline text-[11.5px]" style={{ color: 'var(--muted)' }}>
                📍 แสดงเฉพาะยาร์ด <b style={{ color: 'var(--brand)' }}>{curSiteName}</b> (ตาม site ที่เลือก · sheet ต้องตรงกัน)
                {otherYardCount > 0 && <> · ข้ามยาร์ดอื่นในไฟล์ <b style={{ color: 'var(--st-pending)' }}>{otherYardCount.toLocaleString()}</b> คัน</>}
              </div>
              {siteRows.length === 0 && parsed.rows.length > 0 && (
                <div className="px-4 py-3 text-[12.5px] text-center" style={{ color: '#d97706' }}>
                  ⚠️ ไฟล์นี้ไม่มีข้อมูลยาร์ด {curSiteName} — สลับ site ให้ตรงกับ sheet ที่จะนำเข้า
                </div>
              )}
              {/* moving date filter + status note */}
              <div className="px-4 py-3 border-t hairline flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <CalendarDays size={15} style={{ color: 'var(--brand)' }} />
                  <span className="text-[13px] font-medium">เลือกวันที่ Gate In</span>
                  <select className="select" style={{ width: 'auto', minWidth: 220 }} value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}>
                    <option value="">ทั้งหมด ({siteRows.length.toLocaleString()} คัน)</option>
                    {movingDates.map(([d, n]) => <option key={d} value={d}>{d} ({n.toLocaleString()} คัน)</option>)}
                  </select>
                </div>
                <span className="badge" style={{ color: '#a16207', background: 'rgba(234,179,8,0.16)' }}>
                  <Hourglass size={11} /> นำเข้าเป็น Pre Gate-in
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-t hairline">
                <span className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
                  {selectedDate ? <>เฉพาะวันที่ <b style={{ color: 'var(--text)' }}>{selectedDate}</b></> : 'ทุกวันที่ในไฟล์'} · <b style={{ color: 'var(--st-yard)' }}>{importCount.toLocaleString()}</b> ใหม่{dupCount ? <> · <b style={{ color: 'var(--st-pending)' }}>{dupCount.toLocaleString()}</b> เดิมในระบบ (ข้าม)</> : ''}
                </span>
                <div className="flex items-center gap-2">
                  <button className="btn" onClick={() => { setParsed(null); setFileName('') }}>ยกเลิก</button>
                  <button className="btn btn-primary" onClick={confirm} disabled={importCount === 0}><CheckCircle2 size={15} /> ยืนยัน · สร้างคิว Pre Gate-in ({importCount.toLocaleString()})</button>
                </div>
              </div>
            </div>
          )}

          {/* ── Co Inspection import (merge inspection columns into existing VINs) ── */}
          <div className="panel mt-4 overflow-hidden fade-up">
            <div className="flex items-center gap-2 px-4 py-3 border-b hairline">
              <ClipboardCheck size={16} style={{ color: '#0891b2' }} />
              <span className="font-semibold text-[14px]">นำเข้า Co Inspection</span>
              <span className="text-[12px] ml-auto" style={{ color: 'var(--muted)' }}>เติมข้อมูลตรวจสอบเข้า VIN ที่มีอยู่</span>
              <span className="text-[10px] font-mono shrink-0" title="เวอร์ชันแอป (build)" style={{ color: 'var(--faint)' }}>build {__BUILD__}</span>
            </div>
            <div className="p-4">
              {!coParsed ? (
                <UploadRow
                  color="#0891b2" soft="rgba(8,145,178,0.1)"
                  icon={<ClipboardCheck size={20} style={{ color: '#0891b2' }} />}
                  title="ลากไฟล์ Co Inspection มาวาง หรือคลิก"
                  sub={<>Sheet <b>Tracking Status</b> — merge เข้า VIN เดิม (PDI · RE PDI · OK date · Final check · PM…)</>}
                  busy={coBusy} drag={coDrag} inputRef={coInputRef} onFile={handleCoFile} setDrag={setCoDrag}
                />
              ) : (
                <div className="fade-up">
                  <div className="flex items-center gap-2 mb-3">
                    <FileSpreadsheet size={15} style={{ color: '#0891b2' }} />
                    <span className="font-semibold text-[13.5px] clip">{coFileName}</span>
                    <span className="badge ml-auto" style={{ color: '#0891b2', background: 'rgba(8,145,178,0.1)' }}>{coParsed.headers.length} คอลัมน์</span>
                  </div>
                  <div className="mb-2 flex items-center gap-1.5 text-[12px] flex-wrap">
                    <MapPin size={13} style={{ color: '#0891b2' }} />
                    <span style={{ color: 'var(--muted)' }}>กรองเฉพาะยาร์ด:</span>
                    <span className="font-bold px-2 py-0.5 rounded-md" style={{ color: '#0891b2', background: 'rgba(8,145,178,0.1)' }}>{curSiteName}</span>
                    <span style={{ color: 'var(--faint)' }}>· รวมในไฟล์ {coParsed.total.toLocaleString()} คัน</span>
                  </div>
                  <div className="grid grid-cols-3 gap-px rounded-xl overflow-hidden" style={{ background: 'var(--line)' }}>
                    <SumCell label="เติม VIN เดิม (ยาร์ดนี้)" value={coMatched} accent="#0891b2" big />
                    <SumCell label="เพิ่มใหม่ (ยาร์ดนี้)" value={coNew} accent="var(--st-yard)" />
                    <SumCell label="ข้าม (ยาร์ดอื่น)" value={coOtherYard} accent="var(--st-pending)" />
                  </div>
                  {coGateOut > 0 && (
                    <div className="text-[11.5px] px-3 py-2 rounded-lg mt-2 flex items-center gap-1.5" style={{ background: 'rgba(100,116,139,0.1)', color: '#475569' }}>
                      <CheckCircle2 size={12} className="shrink-0" />
                      <span><b>{coGateOut.toLocaleString()}</b> คันในระบบมี Gate Out ในไฟล์แล้ว — จะถูกปรับสถานะเป็น <b>Gate-out</b> (ออกจากลาน)</span>
                    </div>
                  )}
                  {coParsed.defectSheets.length > 0 && (
                    <div className="mt-2.5 space-y-1.5">
                      {coParsed.defectSheets.map((s) => {
                        const missing = s.rows - s.withText
                        // ok = every row has defect text · partial = a few blank cells (fine, shown as หมวด/ตำแหน่ง) · fail = column not found
                        const state = missing === 0 ? 'ok' : s.withText > 0 ? 'partial' : 'fail'
                        const pal = state === 'ok' ? { bg: 'rgba(22,163,74,0.06)', fg: '#166534' }
                          : state === 'partial' ? { bg: 'rgba(217,119,6,0.09)', fg: '#92400e' }
                          : { bg: 'rgba(220,38,38,0.07)', fg: '#b91c1c' }
                        const sample = coParsed.defects.filter((d) => d.source === s.source && d.defect).slice(0, 3)
                        return (
                          <div key={s.sheet} className="text-[11.5px] px-3 py-2 rounded-lg" style={{ background: pal.bg, color: pal.fg }}>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {state === 'ok' ? <CheckCircle2 size={12} className="shrink-0" /> : <AlertTriangle size={12} className="shrink-0" />}
                              <b>{s.sheet}</b>: {s.rows.toLocaleString()} แถว · อ่านข้อความ Defect ได้ <b>{s.withText.toLocaleString()}</b>
                              {state === 'partial' && <span>· อีก {missing.toLocaleString()} แถวช่อง Defect ว่าง (แสดงหมวด/ตำแหน่งแทน)</span>}
                              {state === 'fail' && <span>— อ่านคอลัมน์ Defect ไม่เจอ</span>}
                            </div>
                            {sample.length > 0 && (
                              <div className="mt-0.5" style={{ opacity: 0.85 }}>
                                ตัวอย่าง: {sample.map((d) => `${d.position ?? '?'} → ${d.defect}`).join(' · ')}
                              </div>
                            )}
                            {state === 'fail' && s.headers.length > 0 && (
                              <div className="mt-0.5 font-mono" style={{ fontSize: 10, opacity: 0.75 }}>
                                หัวคอลัมน์ที่พบ: {s.headers.filter(Boolean).join(' | ')}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
                    <span className="text-[12px]" style={{ color: coSaving ? '#0891b2' : 'var(--muted)' }}>
                      {coSaving
                        ? <b className="flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" /> กำลังบันทึกขึ้น cloud… อย่าปิด/รีเฟรชหน้านี้</b>
                        : <><b style={{ color: '#0891b2' }}>{coMatched.toLocaleString()}</b> คันจะถูกเติมข้อมูลตรวจสอบ{coParsed.defects.length ? ` + Defect ${coParsed.defects.length.toLocaleString()} รายการ` : ''}</>}
                    </span>
                    <div className="flex items-center gap-2">
                      <button className="btn" onClick={() => { setCoParsed(null); setCoFileName('') }} disabled={coSaving}>ยกเลิก</button>
                      <button className="btn" style={{ background: coSaving ? '#6b8fd4' : '#0891b2', color: '#fff' }} onClick={confirmCo} disabled={coSaving || coMatched + coNew + coGateOut === 0}>
                        {coSaving ? <><Loader2 size={15} className="animate-spin" /> กำลังบันทึก…</> : <><CheckCircle2 size={15} /> ยืนยัน Merge ({(coMatched + coNew + coGateOut).toLocaleString()})</>}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Update Location import (VinNo + LaneNo → auto slot) ── */}
          <div className="panel mt-4 overflow-hidden fade-up">
            <div className="flex items-center gap-2 px-4 py-3 border-b hairline">
              <MapPin size={16} style={{ color: '#d97706' }} />
              <span className="font-semibold text-[14px]">Update Location</span>
              <span className="text-[12px] ml-auto" style={{ color: 'var(--muted)' }}>จับคู่ VinNo + LaneNo → จัดช่องจอดอัตโนมัติ</span>
            </div>
            <div className="p-4">
              {!locParsed ? (
                <UploadRow
                  color="#d97706" soft="rgba(217,119,6,0.1)"
                  icon={<MapPin size={20} style={{ color: '#d97706' }} />}
                  title="ลากไฟล์ Update Location มาวาง หรือคลิก"
                  sub={<>ต้องมีคอลัมน์ <b>VinNo</b> + <b>LaneNo</b> — เช่น N-O15 → บล็อก <b>OO</b> ช่องที่ <b>15</b> · เรียงลงแถว 1–8 อัตโนมัติ</>}
                  busy={locBusy} drag={locDrag} inputRef={locInputRef} onFile={handleLocFile} setDrag={setLocDrag}
                />
              ) : locPlan && (
                <div className="fade-up">
                  <div className="flex items-center gap-2 mb-3">
                    <FileSpreadsheet size={15} style={{ color: '#d97706' }} />
                    <span className="font-semibold text-[13.5px] clip">{locFileName}</span>
                    <span className="badge ml-auto" style={{ color: '#d97706', background: 'rgba(217,119,6,0.1)' }}>{locParsed.total.toLocaleString()} VIN ในไฟล์</span>
                  </div>
                  <div className="grid grid-cols-4 gap-px rounded-xl overflow-hidden" style={{ background: 'var(--line)' }}>
                    <SumCell label="จัดตำแหน่งได้" value={locPlan.placements.length} accent="#d97706" big />
                    <SumCell label="VIN เดิมในระบบ" value={locPlan.matched} accent="var(--st-yard)" />
                    <SumCell label="สร้างใหม่" value={locPlan.placements.length - locPlan.matched} accent="var(--brand)" />
                    <SumCell label="ข้าม" value={locPlan.badLane.length + locPlan.rowFull.length + locPlan.dup + locParsed.noLane} accent="var(--st-pending)" />
                  </div>
                  {/* skip breakdown — say exactly WHY rows were skipped so a bad
                      file (wrong column / new lane format) is obvious at a glance */}
                  {(locParsed.noLane > 0 || locPlan.badLane.length > 0 || locPlan.rowFull.length > 0 || locPlan.dup > 0) && (
                    <div className="text-[11.5px] px-3 py-2 rounded-lg mt-2" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                      สาเหตุที่ข้าม:
                      {locParsed.noLane > 0 && <> LaneNo ว่าง <b style={{ color: 'var(--text)' }}>{locParsed.noLane.toLocaleString()}</b> ·</>}
                      {locPlan.badLane.length > 0 && <> Lane อ่านไม่ได้ <b style={{ color: 'var(--st-damage)' }}>{locPlan.badLane.length.toLocaleString()}</b> (ตย.: {locPlan.badLane.slice(0, 3).map((r) => `"${r.lane}"`).join(', ')}) ·</>}
                      {locPlan.rowFull.length > 0 && <> ช่องเต็ม <b style={{ color: 'var(--text)' }}>{locPlan.rowFull.length.toLocaleString()}</b> ·</>}
                      {locPlan.dup > 0 && <> VIN ซ้ำในไฟล์ <b style={{ color: 'var(--text)' }}>{locPlan.dup.toLocaleString()}</b> (ใช้แถวล่าสุดของแต่ละคัน)</>}
                    </div>
                  )}
                  {/* per-block breakdown */}
                  {locPlan.byBlock.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {locPlan.byBlock.map(([b, n]) => (
                        <span key={b} className="badge" style={{ color: '#92400e', background: 'rgba(217,119,6,0.1)' }}>บล็อก {b} · {n.toLocaleString()} คัน</span>
                      ))}
                    </div>
                  )}
                  {/* sample of assigned positions */}
                  {locPlan.placements.length > 0 && (
                    <div className="text-[11.5px] mt-2" style={{ color: 'var(--muted)' }}>
                      ตัวอย่าง: {locPlan.placements.slice(0, 3).map((p) => `…${p.vin.slice(-6)} → ${pos(p)}`).join(' · ')}
                    </div>
                  )}
                  {locPlan.missingBlocks.length > 0 && (
                    <div className="text-[11.5px] px-3 py-2 rounded-lg mt-2 flex items-center gap-1.5" style={{ background: 'rgba(217,119,6,0.09)', color: '#92400e' }}>
                      <AlertTriangle size={12} className="shrink-0" />
                      <span>บล็อกที่ยังไม่มีในผังลานนี้: <b>{locPlan.missingBlocks.join(' · ')}</b> — สร้างบล็อกชื่อนี้ในหน้า Yard Plan เพื่อให้เห็นช่องจอด</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
                    <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
                      <b style={{ color: '#d97706' }}>{locPlan.placements.length.toLocaleString()}</b> คันจะถูกจอดเป็น Parked ตาม Lane
                      {locPlan.rowFull.length > 0 && <> · <b style={{ color: 'var(--st-pending)' }}>{locPlan.rowFull.length}</b> คันช่องเต็ม (เกิน 8)</>}
                    </span>
                    <div className="flex items-center gap-2">
                      <button className="btn" onClick={() => { setLocParsed(null); setLocFileName('') }}>ยกเลิก</button>
                      <button className="btn" style={{ background: '#d97706', color: '#fff' }} onClick={confirmLoc} disabled={!locPlan.placements.length}>
                        <CheckCircle2 size={15} /> ยืนยัน Update Location ({locPlan.placements.length.toLocaleString()})
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* side panel */}
        <div className="lg:col-span-2 space-y-4">
          <div className="panel p-5">
            <h3 className="font-semibold display flex items-center gap-2 mb-3"><Table2 size={16} style={{ color: 'var(--brand)' }} /> สรุปการนำเข้า</h3>
            {parsed ? (
              <>
                <div className="text-[12px] font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--muted)' }}><Car size={13} /> แยกตามรุ่น</div>
                <div className="space-y-1.5 mb-4">
                  {breakdown.models.slice(0, 6).map(([id, n]) => (
                    <div key={id} className="flex items-center justify-between text-[12.5px]"><span>{id}</span><span className="font-semibold tabular">{n.toLocaleString()}</span></div>
                  ))}
                </div>
                <div className="text-[12px] font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--muted)' }}><MapPin size={13} /> แยกตามลาน</div>
                <div className="space-y-1.5">
                  {breakdown.locs.slice(0, 7).map(([id, n]) => (
                    <div key={id} className="flex items-center justify-between text-[12.5px]"><span className="clip">{id}</span><span className="font-semibold tabular">{n.toLocaleString()}</span></div>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-[13px]" style={{ color: 'var(--muted)' }}>
                <div className="flex items-center gap-2 mb-2"><Database size={15} style={{ color: 'var(--brand)' }} /><b style={{ color: 'var(--text)' }}>{rowCount.toLocaleString()}</b> คันในระบบตอนนี้</div>
                {lastImport && <div className="text-[12px]" style={{ color: 'var(--faint)' }}>นำเข้าล่าสุด: {new Date(lastImport.at).toLocaleString('th-TH')} ({lastImport.inYard.toLocaleString()} คัน)</div>}
                <p className="mt-2">อัปโหลดไฟล์เพื่อดูสรุปก่อนยืนยัน — ข้อมูลจะเก็บถาวรในเครื่อง (IndexedDB) และเปิดดู/แก้ไขได้ที่หน้า <b style={{ color: 'var(--brand)' }}>รายการรถ</b></p>
              </div>
            )}
          </div>

          {vehicleCount > 0 && (
            <div className="panel p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-[14px]">ล้างข้อมูลรายการรถ</div>
                  <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>ลบรถทั้งหมด ({vehicleCount.toLocaleString()} คัน) ออกจากระบบ</div>
                </div>
                <button className="btn btn-danger" onClick={() => { if (window.confirm('ยืนยันลบข้อมูลรายการรถทั้งหมด?')) clearEverything() }}><Trash2 size={15} /></button>
              </div>
            </div>
          )}

          <div className="panel p-4">
            <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--muted)' }}>เครื่องมือ (เดโม่)</div>
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={downloadTemplate}><Download size={14} /> เทมเพลต</button>
              <button className="btn flex-1" onClick={() => { loadSample(); toast('ok', 'โหลดข้อมูลตัวอย่างหน้าอื่นแล้ว') }}><Sparkles size={14} /> ข้อมูลตัวอย่าง</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Compact single-row uploader — icon + title/sub + a pick button, drag-droppable.
 *  Replaces the old tall dashed dropzones so the Import page stacks in far less space. */
function UploadRow({
  color, soft, icon, title, sub, busy, drag, inputRef, onFile, setDrag,
}: {
  color: string
  soft: string
  icon: ReactNode
  title: string
  sub: ReactNode
  busy: boolean
  drag: boolean
  inputRef: RefObject<HTMLInputElement>
  onFile: (f: File) => void
  setDrag: (b: boolean) => void
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl cursor-pointer transition-colors px-3.5 py-2.5"
      style={{ border: '1.5px dashed', borderColor: drag ? color : 'var(--line-strong)', background: drag ? soft : 'transparent' }}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
    >
      <div className="w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0" style={{ background: soft }}>
        {busy ? <Loader2 size={20} className="animate-spin" style={{ color }} /> : icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-[13.5px] clip">{busy ? 'กำลังอ่านไฟล์…' : title}</div>
        <div className="text-[11.5px] mt-0.5 clip" style={{ color: 'var(--muted)' }}>{sub}</div>
      </div>
      <div className="btn shrink-0" style={{ pointerEvents: 'none', color }}><UploadCloud size={14} /> เลือกไฟล์</div>
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
    </div>
  )
}

function SumCell({ label, value, accent, big }: { label: string; value: number; accent: string; big?: boolean }) {
  return (
    <div className="p-4 text-center" style={{ background: 'var(--panel)' }}>
      <div className={big ? 'display font-bold tabular' : 'display font-bold tabular'} style={{ color: accent, fontSize: big ? 30 : 22 }}>{value.toLocaleString()}</div>
      <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{label}</div>
    </div>
  )
}
