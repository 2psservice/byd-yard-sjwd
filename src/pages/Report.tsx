import { useMemo, useState } from 'react'
import { FileSpreadsheet, Download, Database, ShieldAlert } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { rowInSite } from '../lib/siteScope'
import { PageHead } from '../components/ui'
import type { Damage, Unit } from '../types'
import type { TrackRow } from '../lib/excelTracking'

// ── formatting ────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** timestamp → "5-Jun-26" — the date shape the Defect sheets use, and the one
 *  the import parser (parseDefDate) reads back, so a re-import round-trips. */
const defDate = (ts?: number) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`
}

// ── defect sheet layouts — headers mirror the real workbook per sheet ─────
// (Defect-Yard uses "Category NG"/"Defect"; Factory uses "Category defect"/
//  "Defect/NG"; Whale uses "Category"/"Defect/NG" — same names the import
//  parser matches, so an exported report can be imported back 1:1.)
const YARD_HEADERS = ['Vin', 'Model', 'From', 'Stock of Status', 'Category NG', 'Category (Repair)', 'Incharge', 'Date', 'Position', 'Defect', 'Status Repair', 'Repair Date', 'Remark']
const FACTORY_HEADERS = ['Vin', 'Model', 'From', 'Stock of Status', 'Category defect', 'Incharge', 'Date', 'Position', 'Defect/NG', 'Status Repair', 'Repair Date', 'Remark']
const WHALE_HEADERS = ['Vin', 'Model', 'From', 'Stock of Status', 'Category', 'Incharge', 'Date', 'Position', 'Defect/NG', 'Status Repair', 'Repair Date', 'Remark']

interface DefectExportRow { unit: Unit; dmg: Damage }

function defectRow(headers: string[], { unit, dmg }: DefectExportRow, cells: Record<string, string> | undefined): (string | number)[] {
  const category = dmg.categoryNG ?? ''
  const byHeader: Record<string, string> = {
    Vin: unit.vin,
    Model: cells?.['Model'] || unit.modelName || unit.model || '',
    From: '',
    'Stock of Status': cells?.['Stock of Status'] || '',
    'Category NG': category,
    'Category defect': category,
    Category: category,
    'Category (Repair)': dmg.categoryRepair ?? '',
    Incharge: dmg.incharge ?? '',
    Date: defDate(dmg.at),
    Position: dmg.area === '—' ? '' : dmg.area,
    Defect: dmg.item ?? (dmg.type === '—' ? '' : dmg.type),
    'Defect/NG': dmg.item ?? (dmg.type === '—' ? '' : dmg.type),
    'Status Repair': dmg.statusRepair ?? (dmg.repairDate ? 'Repaired' : 'Waiting Repair'),
    'Repair Date': defDate(dmg.repairDate),
    Remark: dmg.note ?? '',
  }
  return headers.map((h) => byHeader[h] ?? '')
}

export function Report() {
  const lang = useYard((s) => s.lang)
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const toast = useYard((s) => s.toast)
  const units = useUnits()
  const columns = useTracking((s) => s.columns)
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
      // and the report must carry the master file's look: Tahoma 10, sized
      // columns, fixed row heights, coloured bold header band per sheet.
      const XJS: any = await import('exceljs')
      const ExcelJS = XJS.default ?? XJS
      const wb = new ExcelJS.Workbook()
      wb.creator = 'SJWD Yard Control'

      const DATA_FONT = { name: 'Tahoma', size: 10 }
      const thin = { style: 'thin', color: { argb: 'FFD0D5DD' } }
      const BORDER = { top: thin, left: thin, bottom: thin, right: thin }
      const HEADER_HEIGHT = 24
      const ROW_HEIGHT = 18

      /** One styled sheet: frozen coloured header row + bordered Tahoma body. */
      const addSheet = (name: string, headerArgb: string, headers: string[], widths: number[], rows: (string | number)[][]) => {
        const ws = wb.addWorksheet(name, {
          views: [{ state: 'frozen', ySplit: 1 }],
          properties: { tabColor: { argb: headerArgb }, defaultRowHeight: ROW_HEIGHT },
        })
        // column style (font/border/alignment) is inherited by every cell added later
        ws.columns = headers.map((_, i) => ({
          width: widths[i],
          style: { font: DATA_FONT, border: BORDER, alignment: { vertical: 'middle' } },
        }))
        const hr = ws.addRow(headers)
        hr.height = HEADER_HEIGHT
        hr.eachCell((cell: any) => {
          cell.font = { ...DATA_FONT, bold: true, color: { argb: 'FFFFFFFF' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerArgb } }
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
          cell.border = BORDER
        })
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } }
        for (const r of rows) ws.addRow(r).height = ROW_HEIGHT
        return ws
      }

      // ── sheet 1: "Tracking Status" — column layout mirrors the import 100%
      // (headers = the exact sheet header text each cell was imported under,
      //  in the configured column order; 'No' is the running row number)
      const headers = columns.map((c) => c.key)
      const widths = columns.map((c) => Math.max(10, Math.min(40, Math.round(c.width / 7))))
      const body = scopedRows.map((r, i) =>
        columns.map((c) => (c.key === 'No' ? i + 1 : c.key === 'Vin' ? r.vin : (r.cells[c.key] ?? ''))))
      addSheet('Tracking Status', 'FF1B4FA8', headers, widths, body) // น้ำเงิน brand

      // ── defect sheets — same names/headers the import parser reads back
      const trackByVin = new Map(scopedRows.map((r) => [r.vin, r.cells]))
      const defectWidths = (hs: string[]) => hs.map((h) => (h === 'Vin' ? 20 : /defect|remark/i.test(h) ? 32 : 14))
      const defectBody = (hs: string[], rows: DefectExportRow[]) => rows.map((r) => defectRow(hs, r, trackByVin.get(r.unit.vin)))
      addSheet('Defect-Yard', 'FFD97706', YARD_HEADERS, defectWidths(YARD_HEADERS), defectBody(YARD_HEADERS, defectSplit.yard))        // ส้มอำพัน
      addSheet('Defect-Factory', 'FF15803D', FACTORY_HEADERS, defectWidths(FACTORY_HEADERS), defectBody(FACTORY_HEADERS, defectSplit.factory)) // เขียว
      addSheet('Defect-Whale 28 rai', 'FF0D9488', WHALE_HEADERS, defectWidths(WHALE_HEADERS), defectBody(WHALE_HEADERS, defectSplit.whale))    // teal

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
          ? 'ออกรายงาน Excel หน้าตาเดียวกับไฟล์นำเข้า — Tracking Status + Defect-Yard / Defect-Factory / Defect-Whale 28 rai'
          : 'Export an Excel report mirroring the import workbook — Tracking Status + Defect sheets'}
        right={
          <button className="btn btn-primary px-4 py-2.5 text-[13.5px]" onClick={doExport} disabled={exporting}>
            <Download size={16} className="mr-1.5" />
            {exporting ? (lang === 'th' ? 'กำลังสร้างไฟล์…' : 'Building…') : (lang === 'th' ? 'ออกรายงาน Excel' : 'Export Excel')}
          </button>
        }
      />

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
          <li><b>Tracking Status</b> — {lang === 'th' ? 'ทุกคอลัมน์ตามผังนำเข้า (ลำดับเดียวกับที่ตั้งไว้ในหน้ารายการรถ)' : 'every column in the configured Unit List order, headers identical to the import sheet'}</li>
          <li><b>Defect-Yard / Defect-Factory / Defect-Whale 28 rai</b> — {lang === 'th' ? 'รายการตำหนิแยกตามแหล่งที่พบ (ตำหนิที่บันทึกในแอปรวมอยู่ใน Defect-Yard)' : 'defects split by source (in-app finds are included in Defect-Yard)'}</li>
          <li>{lang === 'th' ? 'ไฟล์นี้นำกลับมา Import ในระบบได้ทันที (หัวคอลัมน์ตรงกับตัวอ่านไฟล์ 100%)' : 'The exported file can be re-imported — headers match the parser 1:1'}</li>
        </ul>
      </div>
    </div>
  )
}
