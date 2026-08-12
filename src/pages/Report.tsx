import { useMemo, useState } from 'react'
import { FileSpreadsheet, Download, Database, ShieldAlert, ClipboardList } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { rowInSite } from '../lib/siteScope'
import { PageHead, cx } from '../components/ui'
import { DailyStockReport } from '../components/DailyStockReport'
import { DayPicker, dayKeyOf } from './Grouping'
import type { Unit } from '../types'
import type { TrackRow } from '../lib/excelTracking'
import { agingPmDays } from '../lib/trackingColumns'
import { YARD_SHEET, FACTORY_SHEET, WHALE_SHEET, buildDefectSheet, type DefectExportRow } from '../lib/defectReport'
import {
  REPORT_MENUS, TIME_PERIODS, buildList, buildDefects, buildTimeMatrix, exportOpsReport,
  dayKeyOfTs, type ReportCtx,
} from '../lib/opsReport'

// ═══ master workbook format — every value below was measured 1:1 from the ═══
// ═══ real master file (Defect_list_Coinspection_Update), so the exported ═══
// ═══ report matches its fonts, sizes, widths, heights and colours exactly ═══

/** light blue header band used on the Vin Of Status → Stock of Status block */
const LIGHT_BLUE = { theme: 3, tint: 0.8999908444471572 }
/** light orange fill carried by every "Match Tax/Shuttle" data cell */
const LIGHT_ORANGE = { theme: 9, tint: 0.7999816888943144 }

interface TCol {
  h: string          // exact master header (incl. trailing spaces — trimmed for the cell lookup)
  w: number          // master column width
  hFill?: object     // header fill (absent = plain white like the master)
  dFill?: object     // per-column data fill
  left?: boolean     // left-aligned data (default is centred)
  hPlain?: boolean   // header NOT bold (the Motor/Engine/Model/Color/battery/company/Status block)
  noBorder?: boolean // the Move/PM/หมายเหตุ block carries no gridline borders
}

/** "Tracking Status" — all 66 master columns, in master order. */
const TRACKING_COLS: TCol[] = [
  { h: 'No', w: 7.13 },
  { h: 'Match Tax/Shuttle', w: 20.25, dFill: LIGHT_ORANGE },
  { h: 'Vin', w: 19.63 },
  { h: 'Model name', w: 22.25 },
  { h: 'Front Motor no.', w: 22.75, hPlain: true },
  { h: 'Rear Motor no.', w: 22.75, hPlain: true },
  { h: 'Engine No.', w: 18.13, hPlain: true },
  { h: 'Model Code', w: 17, hPlain: true },
  { h: 'Model', w: 12.75, hPlain: true },
  { h: 'Color', w: 11.75, hPlain: true },
  { h: 'battery', w: 26.25, hPlain: true },
  { h: 'company', w: 14.5, hPlain: true },
  { h: 'Status', w: 14.13, hPlain: true },
  { h: 'PDI', w: 11.75 },
  { h: 'RE PDI  Date #1', w: 11.88 },
  { h: 'RE PDI  Date #2', w: 12.13 },
  { h: 'RE PDI  Date #3', w: 11.88 },
  { h: 'RE PDI  Date #4', w: 11.88 },
  { h: 'RE PDI  Date #5', w: 11.88 },
  { h: 'RE PDI  Date #6', w: 18.13 },
  { h: 'RE PDI  Date #7', w: 11.88 },
  { h: 'RE PDI  Date #8', w: 11.88 },
  { h: 'OK date ', w: 12.25 },
  { h: 'PIC (PDI)', w: 12.25, hFill: { argb: 'FFFFC000' } },
  { h: 'Vin Of Status', w: 16.75, hFill: LIGHT_BLUE },
  { h: 'Gate In (Rayong yard)', w: 15.5, hFill: LIGHT_BLUE },
  { h: 'Final check date', w: 15.75, hFill: LIGHT_BLUE },
  { h: 'Final Status', w: 12.13, hFill: LIGHT_BLUE },
  { h: 'Location yard', w: 16.88, hFill: LIGHT_BLUE },
  { h: 'Status Tax', w: 20.25, hFill: LIGHT_BLUE },
  { h: 'Stock of Status ', w: 21.75, hFill: LIGHT_BLUE },
  { h: 'Gate Out time stamp', w: 22.75 },
  { h: 'Grouping  Number', w: 20.13 },
  { h: 'Allocation Date', w: 18.38 },
  { h: 'Dealer Code', w: 15.38 },
  { h: 'Dealer Location', w: 57.75, left: true },
  { h: 'Remark', w: 63.75 },
  { h: 'Tailer Company', w: 13.5 },
  { h: 'storage Yard', w: 10.25 },
  { h: 'Move from  1', w: 16.25, noBorder: true },
  { h: 'Transfer 1', w: 14.63, noBorder: true },
  { h: 'Move from  2', w: 16.25, noBorder: true },
  { h: 'Transfer 2', w: 14.63, noBorder: true },
  { h: 'Move from  3', w: 16.25, noBorder: true },
  { h: 'Transfer 3', w: 14.63, noBorder: true },
  { h: 'Move from  4', w: 16.25, noBorder: true },
  { h: 'Transfer 4', w: 14.63, noBorder: true },
  { h: 'Factory-Installed', w: 28.75, noBorder: true },
  { h: 'Accessories', w: 28.75, noBorder: true },
  { h: 'Aging PM', w: 11.75, noBorder: true },
  { h: 'PM1', w: 8.75, noBorder: true },
  { h: 'PM2', w: 8.75, noBorder: true },
  { h: 'PM3', w: 8.75, noBorder: true },
  { h: 'PM4', w: 8.75, noBorder: true },
  { h: 'PM5', w: 8.75, noBorder: true },
  { h: 'PM6', w: 9.75, noBorder: true },
  { h: 'PM7', w: 9.75, noBorder: true },
  { h: 'PM8', w: 9.63, noBorder: true },
  { h: 'PM9', w: 8.75, noBorder: true },
  { h: 'PM10', w: 8.75, noBorder: true },
  { h: 'PM11', w: 8.75, noBorder: true },
  { h: 'PM12', w: 8.75, noBorder: true },
  { h: 'PM13', w: 8.75, noBorder: true },
  { h: 'PM14', w: 8.75, noBorder: true },
  { h: 'PM15', w: 8.75, noBorder: true },
  { h: 'หมายเหตุ', w: 17.75, noBorder: true },
]


export function Report() {
  const lang = useYard((s) => s.lang)
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const toast = useYard((s) => s.toast)
  const units = useUnits()
  const allRows = useTrackingRows()
  const [allYards, setAllYards] = useState(false)
  const [exporting, setExporting] = useState(false)

  const siteName = sites.find((s) => s.id === currentSite)?.name ?? '—'

  const scopedRows = useMemo<TrackRow[]>(() => {
    const rows = allYards || !currentSite ? allRows : allRows.filter((r) => rowInSite(r, currentSite, sites))
    return [...rows].sort((a, b) => a.vin.localeCompare(b.vin))
  }, [allRows, allYards, currentSite, sites])

  const scopedUnits = useMemo(
    () => (allYards || !currentSite ? units : units.filter((u) => !u.site || u.site === currentSite)),
    [units, allYards, currentSite],
  )

  // split every damage into its defect sheet: factory / whale keep their import
  // source; everything else (imported yard defects + in-app walk-around / PDI /
  // mechanic / manual finds) is a yard-found defect → Defect-Yard
  const defectSplit = useMemo(() => {
    const yard: DefectExportRow[] = []
    const factory: DefectExportRow[] = []
    const whale: DefectExportRow[] = []
    for (const u of scopedUnits) {
      for (const dmg of u.damages) {
        const bucket = dmg.source === 'factoryDefect' ? factory : dmg.source === 'whaleDefect' ? whale : yard
        bucket.push({ unit: u, dmg })
      }
    }
    const byVinDate = (a: DefectExportRow, b: DefectExportRow) =>
      a.unit.vin.localeCompare(b.unit.vin) || a.dmg.at - b.dmg.at
    return { yard: yard.sort(byVinDate), factory: factory.sort(byVinDate), whale: whale.sort(byVinDate) }
  }, [scopedUnits])

  const doExport = async () => {
    if (!scopedRows.length && !scopedUnits.length) { toast('info', 'ยังไม่มีข้อมูลให้ออกรายงาน'); return }
    setExporting(true)
    try {
      // exceljs (not SheetJS) — the free SheetJS build can't write fonts/fills,
      // and this export reproduces the master file's formatting exactly.
      const XJS: any = await import('exceljs')
      const ExcelJS = XJS.default ?? XJS
      const wb = new ExcelJS.Workbook()
      wb.creator = 'SJWD Yard Control'

      const thinBorder = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
      function fill(color: object) { return { type: 'pattern', pattern: 'solid', fgColor: color } }

      // ── sheet 1: "Tracking Status" — Tahoma 10, header 25.9 / rows 18.6,
      //    borders up to "storage Yard", coloured header blocks, tab green
      const addTrackingSheet = () => {
        const ws = wb.addWorksheet('Tracking Status', {
          views: [{ state: 'frozen', ySplit: 1, zoomScale: 70, zoomScaleNormal: 70 }],
          properties: { tabColor: { argb: 'FF92D050' }, defaultRowHeight: 18.6, defaultColWidth: 8.75 },
        })
        ws.columns = TRACKING_COLS.map((c) => ({
          width: c.w,
          style: {
            font: { name: 'Tahoma', size: 10 },
            alignment: c.left ? { horizontal: 'left' } : { horizontal: 'center', vertical: 'middle' },
            ...(c.noBorder ? {} : { border: thinBorder }),
          },
        }))
        const hr = ws.addRow(TRACKING_COLS.map((c) => c.h))
        hr.height = 25.9
        hr.eachCell({ includeEmpty: true }, (cell: any, col: number) => {
          const spec = TRACKING_COLS[col - 1]
          cell.font = { name: 'Tahoma', size: 10, bold: !spec?.hPlain }
          cell.alignment = { horizontal: 'center', vertical: 'middle' }
          if (spec?.hFill) cell.fill = fill(spec.hFill)
          if (spec && !spec.noBorder) cell.border = thinBorder
        })
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TRACKING_COLS.length } }
        scopedRows.forEach((r, i) => {
          const row = ws.addRow(TRACKING_COLS.map((c) => {
            const key = c.h.trim()
            return key === 'No' ? i + 1 : key === 'Vin' ? r.vin
              : key === 'Aging PM' ? agingPmDays(r.cells)
              : (r.cells[key] ?? '')
          }))
          row.height = 18.6
          TRACKING_COLS.forEach((c, ci) => { if (c.dFill) row.getCell(ci + 1).fill = fill(c.dFill) })
        })
      }
      addTrackingSheet()

      // ── defect sheets — Yard (Tahoma 11 / 21), Factory + Whale (Tahoma 8 / 13.5)
      const trackByVin = new Map(scopedRows.map((r) => [r.vin, r.cells]))
      buildDefectSheet(wb, YARD_SHEET, defectSplit.yard, trackByVin)
      buildDefectSheet(wb, FACTORY_SHEET, defectSplit.factory, trackByVin)
      buildDefectSheet(wb, WHALE_SHEET, defectSplit.whale, trackByVin)

      const d = new Date()
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const scopeTag = allYards ? 'All-Yards' : siteName.replace(/[^\w]+/g, '-')
      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `SJWD-Report-${scopeTag}-${stamp}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      toast('ok', `ออกรายงานแล้ว — ${scopedRows.length.toLocaleString()} คัน`)
    } catch (e) {
      console.error('[report] export', e)
      toast('err', 'ออกรายงานไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setExporting(false)
    }
  }

  const stat = (label: string, value: number, icon: React.ReactNode) => (
    <div className="panel p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}>{icon}</div>
      <div>
        <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{label}</div>
        <div className="display text-[20px] font-bold tabular leading-tight">{value.toLocaleString()}</div>
      </div>
    </div>
  )

  return (
    <div>
      <PageHead
        title={lang === 'th' ? 'รายงาน (Report)' : 'Report'}
        sub={lang === 'th'
          ? 'รายงานประจำวัน (ดูย้อนหลังได้ทุกวัน) และรายงาน Excel รูปแบบเดียวกับไฟล์ master 100%'
          : 'Daily stock report for any past date, plus the Excel export mirroring the master workbook'}
        right={
          <button className="btn btn-primary px-4 py-2.5 text-[13.5px]" onClick={doExport} disabled={exporting}>
            <Download size={16} className="mr-1.5" />
            {exporting ? (lang === 'th' ? 'กำลังสร้างไฟล์…' : 'Building…') : (lang === 'th' ? 'ออกรายงาน Excel' : 'Export Excel')}
          </button>
        }
      />

      {/* ── operation report (ส่งทุกเบรค) — 14 เมนู realtime จากหน้างาน ──
          เมนูแรกคือ Daily report stock (คอมโพเนนต์เดิม) */}
      <OpsReportSection />

      {/* ── master-format Excel export ── */}
      <div className="text-[12px] font-bold uppercase tracking-wider mb-2 mt-5" style={{ color: 'var(--muted)' }}>
        {lang === 'th' ? 'ออกรายงาน Excel (รูปแบบไฟล์ master)' : 'Excel export (master format)'}
      </div>

      {/* scope: current yard vs all yards */}
      <div className="panel p-3.5 mb-4 flex items-center gap-2 flex-wrap text-[13px]">
        <span className="font-medium" style={{ color: 'var(--muted)' }}>{lang === 'th' ? 'ขอบเขตข้อมูล:' : 'Scope:'}</span>
        <button className={`btn px-3 py-1.5 ${!allYards ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAllYards(false)}>
          {lang === 'th' ? `ลานปัจจุบัน (${siteName})` : `Current yard (${siteName})`}
        </button>
        <button className={`btn px-3 py-1.5 ${allYards ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setAllYards(true)}>
          {lang === 'th' ? 'ทุกลาน' : 'All yards'}
        </button>
      </div>

      {/* what goes into the file */}
      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {stat('Tracking Status', scopedRows.length, <Database size={17} />)}
        {stat('Defect-Yard', defectSplit.yard.length, <ShieldAlert size={17} />)}
        {stat('Defect-Factory', defectSplit.factory.length, <ShieldAlert size={17} />)}
        {stat('Defect-Whale 28 rai', defectSplit.whale.length, <ShieldAlert size={17} />)}
      </div>

      <div className="panel p-4 text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        <div className="font-semibold mb-1.5 flex items-center gap-1.5">
          <FileSpreadsheet size={15} /> {lang === 'th' ? 'ไฟล์ที่ได้' : 'Output file'}
        </div>
        <ul className="list-disc pl-5 space-y-1">
          <li><b>Tracking Status</b> — {lang === 'th' ? 'ครบ 66 คอลัมน์ตามไฟล์ master: ฟอนต์ Tahoma 10, ความกว้างคอลัมน์, ความสูงแถว, สีหัวคอลัมน์ (PIC (PDI) ส้ม, กลุ่ม Vin Of Status ฟ้าอ่อน) ตรงต้นฉบับ' : 'all 66 master columns with the master fonts, widths, heights and header colours'}</li>
          <li><b>Defect-Yard / Defect-Factory / Defect-Whale 28 rai</b> — {lang === 'th' ? 'หัวคอลัมน์ ฟอนต์ และขนาดตรงตาม sheet ต้นฉบับ (Defect ที่บันทึกในแอปรวมอยู่ใน Defect-Yard)' : 'defect sheets with the master layout (in-app finds are included in Defect-Yard)'}</li>
          <li>{lang === 'th' ? 'ไฟล์นี้นำกลับมา Import ในระบบได้ทันที (ชื่อ sheet และหัวคอลัมน์ตรงกับตัวอ่านไฟล์ 100%)' : 'The exported file can be re-imported — sheet names and headers match the parser 1:1'}</li>
        </ul>
      </div>
    </div>
  )
}

// ═══ Operation report (รายงานส่งทุกเบรค) — 14 เมนู, realtime จากหน้างาน ═══

function OpsReportSection() {
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const toast = useYard((s) => s.toast)
  const allRows = useTrackingRows()
  const units = useUnits()
  const queues = useOps((s) => s.queues)
  const [menu, setMenu] = useState('stock')
  const [day, setDay] = useState<string | 'all'>(dayKeyOf(new Date()))
  const [exporting, setExporting] = useState(false)

  const site = sites.find((s) => s.id === currentSite)
  // "NYB2" style short label for sheet names/titles
  const siteLabel = useMemo(() => {
    const n = (site?.name ?? '').toUpperCase()
    if (n.includes('NYB')) return 'NYB2'
    if (n.includes('RAYONG')) return 'Rayong'
    return site?.code || site?.name || 'Yard'
  }, [site])

  const ctx = useMemo<ReportCtx>(() => ({
    rows: currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows,
    units: currentSite ? units.filter((u) => !u.site || u.site === currentSite) : units,
    queues: queues.filter((q) => !currentSite || !q.site || q.site === currentSite),
    day: day === 'all' ? dayKeyOf(new Date()) : day,
    siteLabel,
  }), [allRows, units, queues, currentSite, sites, day, siteLabel])

  // calendar marks: days that have queue activity or gate scans
  const dayCounts = useMemo(() => {
    const m = new Map<string, number>()
    const add = (k: string) => m.set(k, (m.get(k) ?? 0) + 1)
    for (const q of ctx.queues) for (const i of q.items) {
      const t = i.checkedAt ?? i.doneAt
      if (t) add(dayKeyOfTs(t))
    }
    return m
  }, [ctx.queues])

  const active = REPORT_MENUS.find((m) => m.id === menu) ?? REPORT_MENUS[0]
  const listRows = useMemo(() => (active.kind === 'list' ? buildList(ctx, active.id) : []), [ctx, active])
  const defRows = useMemo(() => (active.kind === 'defect' ? buildDefects(ctx, active.id as 'fcdefect' | 'pmdefect') : null), [ctx, active])
  const matrix = useMemo(() => (active.kind === 'time' ? buildTimeMatrix(ctx, active.id as 'fctime' | 'pmtime') : null), [ctx, active])

  const doExport = async () => {
    setExporting(true)
    try {
      await exportOpsReport(ctx)
      toast('ok', `ออกไฟล์ Report_operation (${ctx.day.split('-').reverse().join('/')}) แล้ว`)
    } catch (e) { console.error('[opsReport] export', e); toast('err', 'ออกไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง') }
    finally { setExporting(false) }
  }

  const th = 'text-left px-3 py-2 text-[11.5px] font-bold whitespace-nowrap'
  const td = 'px-3 py-1.5 whitespace-nowrap'

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-[12px] font-bold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
          <ClipboardList size={14} /> รายงาน Operation ({siteLabel}) · ส่งทุกเบรค — นับ realtime จากที่หน้างานบันทึก
        </div>
        <div className="flex items-center gap-2">
          <DayPicker days={dayCounts} value={day} onChange={setDay} />
          <button className="btn btn-primary px-3 py-1.5 text-[12.5px]" onClick={doExport} disabled={exporting}>
            <Download size={14} /> {exporting ? 'กำลังสร้างไฟล์…' : 'Export Excel (ทุกเมนู)'}
          </button>
        </div>
      </div>

      {/* menu strip */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {REPORT_MENUS.map((m, i) => (
          <button key={m.id} onClick={() => setMenu(m.id)}
            className={cx('btn px-2.5 py-1.5 text-[12px]', menu === m.id && 'btn-primary')}>
            {i + 1}. {m.label}
          </button>
        ))}
      </div>

      {active.kind === 'stock' && <DailyStockReport />}

      {active.kind === 'list' && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline flex items-center gap-2 text-[12.5px] font-bold" style={{ background: 'var(--chip)' }}>
            {active.label} · Total <span style={{ color: 'var(--brand)' }}>{listRows.length}</span>
            <span className="font-medium" style={{ color: 'var(--faint)' }}>· {ctx.day.split('-').reverse().join('/')}</span>
          </div>
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b hairline" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                {['No.', 'Vin', 'Model Name', 'Model', 'Color', 'Date', active.id === 'pdiout' || active.id === 'hold' ? 'Group No' : 'LOT', 'Remark'].map((h) => <th key={h} className={th}>{h}</th>)}
              </tr></thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {listRows.length === 0 && <tr><td colSpan={8} className="text-center py-8" style={{ color: 'var(--faint)' }}>— ไม่มีรายการของวันนี้ —</td></tr>}
                {listRows.map((r) => (
                  <tr key={`${r.no}-${r.vin}`}>
                    <td className={td}>{r.no}</td>
                    <td className={cx(td, 'vin font-bold')}>{r.vin}</td>
                    <td className={td}>{r.modelName}</td>
                    <td className={td}>{r.model}</td>
                    <td className={td}>{r.color}</td>
                    <td className={cx(td, 'tabular')}>{r.date}</td>
                    <td className={cx(td, 'tabular')}>{r.lot}</td>
                    <td className={td}>{r.remark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {active.kind === 'defect' && defRows && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline flex items-center gap-2 text-[12.5px] font-bold" style={{ background: 'var(--chip)' }}>
            {active.label} · Total <span style={{ color: '#dc2626' }}>{defRows.length}</span>
            <span className="font-medium" style={{ color: 'var(--faint)' }}>· {ctx.day.split('-').reverse().join('/')}</span>
          </div>
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b hairline" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                {['No.', 'Vin', 'Postion', 'Defect/NG', 'Date', 'Status', 'LOT', 'Remark'].map((h) => <th key={h} className={th}>{h}</th>)}
              </tr></thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {defRows.length === 0 && <tr><td colSpan={8} className="text-center py-8" style={{ color: 'var(--faint)' }}>— ไม่มี Defect ของวันนี้ —</td></tr>}
                {defRows.map((r) => (
                  <tr key={`${r.no}-${r.vin}`}>
                    <td className={td}>{r.no}</td>
                    <td className={cx(td, 'vin font-bold')}>{r.vin}</td>
                    <td className={td}>{r.position}</td>
                    <td className={td} style={{ color: '#dc2626' }}>{r.defect}</td>
                    <td className={cx(td, 'tabular')}>{r.date}</td>
                    <td className={td}>{r.status}</td>
                    <td className={cx(td, 'tabular')}>{r.lot}</td>
                    <td className={td}>{r.remark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {active.kind === 'time' && matrix && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline text-center text-[13px] font-bold" style={{ background: '#000', color: '#fff' }}>
            {matrix.title} · {ctx.day.split('-').reverse().join('/')}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] text-center" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--chip)' }}>
                  <th className="px-3 py-2 border hairline font-bold" rowSpan={2}>Task</th>
                  <th className="px-3 py-2 border hairline font-bold" rowSpan={2}>Volume</th>
                  {['P1', 'P2', 'P3', 'P4', 'P5'].map((p) => <th key={p} className="px-3 py-1 border hairline font-bold" style={{ color: '#2563eb' }}>{p}</th>)}
                </tr>
                <tr style={{ background: 'var(--chip)' }}>
                  {TIME_PERIODS.map((t) => <th key={t} className="px-3 py-1 border hairline font-medium text-[11px]">{t}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="px-3 py-1.5 border hairline font-semibold">Plan</td>
                  <td className="px-3 py-1.5 border hairline tabular font-bold">{matrix.plan}</td>
                  {[0, 1, 2, 3, 4].map((i) => <td key={i} className="px-3 py-1.5 border hairline tabular">{matrix.plan ? Math.round((matrix.plan / 5) * 10) / 10 : ''}</td>)}
                </tr>
                {matrix.models.map((m) => (
                  <tr key={m.name}>
                    <td className="px-3 py-1.5 border hairline text-left pl-5">{m.name}</td>
                    <td className="px-3 py-1.5 border hairline tabular">{m.total}</td>
                    {m.p.map((n, i) => <td key={i} className="px-3 py-1.5 border hairline tabular">{n || ''}</td>)}
                  </tr>
                ))}
                <tr style={{ background: 'rgba(34,197,94,0.14)' }}>
                  <td className="px-3 py-1.5 border hairline font-bold">OK</td>
                  <td className="px-3 py-1.5 border hairline tabular font-bold">{matrix.okTotal}</td>
                  {matrix.ok.map((n, i) => <td key={i} className="px-3 py-1.5 border hairline tabular">{n}</td>)}
                </tr>
                <tr style={{ background: 'rgba(34,197,94,0.14)' }}>
                  <td className="px-3 py-1.5 border hairline font-semibold">Ratio(OK)</td>
                  <td className="px-3 py-1.5 border hairline tabular">{matrix.total ? Math.round((matrix.okTotal / matrix.total) * 100) : 0}%</td>
                  {matrix.ok.map((n, i) => <td key={i} className="px-3 py-1.5 border hairline tabular">{matrix.total ? Math.round((n / matrix.total) * 100) : 0}%</td>)}
                </tr>
                <tr style={{ background: 'rgba(234,88,12,0.12)', color: '#dc2626' }}>
                  <td className="px-3 py-1.5 border hairline font-bold">NG</td>
                  <td className="px-3 py-1.5 border hairline tabular font-bold">{matrix.ngTotal}</td>
                  {matrix.ng.map((n, i) => <td key={i} className="px-3 py-1.5 border hairline tabular">{n}</td>)}
                </tr>
                <tr style={{ background: 'rgba(234,88,12,0.12)', color: '#dc2626' }}>
                  <td className="px-3 py-1.5 border hairline font-semibold">Ratio(NG)</td>
                  <td className="px-3 py-1.5 border hairline tabular">{matrix.total ? Math.round((matrix.ngTotal / matrix.total) * 100) : 0}%</td>
                  {matrix.ng.map((n, i) => <td key={i} className="px-3 py-1.5 border hairline tabular">{matrix.total ? Math.round((n / matrix.total) * 100) : 0}%</td>)}
                </tr>
                <tr style={{ background: 'rgba(250,204,21,0.35)' }}>
                  <td className="px-3 py-1.5 border hairline font-bold">Total</td>
                  <td className="px-3 py-1.5 border hairline tabular font-bold">{matrix.total}</td>
                  <td className="px-3 py-1.5 border hairline" colSpan={5} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
