/**
 * Report 2PS — Report Inspection Tracking Status (On Yard): every station
 * event (Gate-in / PDI / PM / Final Check / ช่าง) and every Defect event
 * (found / status change) recorded by this app, for cars currently on yard.
 * The Defect tab lists only what the yard's own inspection stations found
 * (Gate-in / Walk Around Check / Update Damage). A date range narrows both
 * tabs and the Excel export.
 */
import { useMemo, useState } from 'react'
import { Search, ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { useActiveQueues, queueTypeOf, isSequenceQueue, type QueueType, type WorkQueue } from '../store/useOps'
import { PageHead, Segmented } from '../components/ui'
import { partLabel, defectLabel, partBilingual, defectBilingual } from '../lib/damageLabel'
import { stationLabelOf } from '../lib/carHistory'
import { deriveCarStatus, IN_YARD_STATUSES } from '../lib/carStatus'
import { rowsForSite } from '../lib/siteScope'
import { realDefects } from '../lib/finalCheckList'
import { downloadBlob } from '../lib/defectReport'
import { dateKey } from '../lib/dayKey'
import type { TrackRow } from '../lib/excelTracking'
import type { Unit } from '../types'

const PAGE_SIZE = 20
const isPreGateInQueue = (name: string) => name.trim().startsWith('(')

// which queue types feed the Station-history tab, and their display name —
// WASH is excluded (not one of the stations asked for: Gate-in/PDI/PM/Final Check/ช่าง)
const STATION_LABEL: Partial<Record<QueueType, string>> = {
  PDI: 'PDI', PM: 'PM', FINAL: 'FINAL CHECK', REPAIR: 'ช่าง (Mechanic)', SPECIAL: 'ช่าง (Mechanic)',
}

function fmt(ts: number) {
  const d = new Date(ts)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

interface StationEvent { vin: string; model: string; station: string; result?: 'OK' | 'NG'; by: string; at: number }
interface DefectEvent {
  vin: string; model: string; station: string; area: string; defect: string
  // English versions, kept alongside the Thai-first ones above so the on-screen
  // table (read by Thai yard staff) and the Excel export (English, per the
  // office's ask) can each show their own language from the same event list.
  areaEn: string; defectEn: string
  kind: 'found' | 'status'; status?: string; severity?: 'minor' | 'major'; by: string; at: number
}

/** Station labels are mostly already English ("PDI", "Gate-in", "Final Check")
 *  except the couple recorded bilingual for Thai readability on screen — strip
 *  those down to English-only for the export. */
/** Defect tab: only the yard's own inspection stations. PDI / PM / ช่าง / Co-Inspection
 *  imports / manual entries are not used for this report (the office's ask). */
export const DEFECT_STATIONS = ['Walk Around Check', 'Update Damage', 'Gate-in'] as const
const DEFECT_STATION_SET = new Set<string>(DEFECT_STATIONS.map((s) => s.toLowerCase()))
export const isReportDefectStation = (label: string) => DEFECT_STATION_SET.has(label.trim().toLowerCase())

const STATION_EN: Record<string, string> = {
  'ช่าง (Mechanic)': 'Mechanic',
  'เพิ่มเอง (Manual)': 'Manual',
}
const stationEn = (label: string) => STATION_EN[label] ?? label

/** One row per station the car actually completed: Gate-in (from the unit's
 *  own gate-in stamp) + every queue item this car finished (checkedAt/By —
 *  the moment PDI/PM/Final Check/ช่าง recorded OK or NG on it). */
function buildStationEvents(units: Unit[], rowByVin: Map<string, TrackRow>, queues: WorkQueue[]): StationEvent[] {
  const out: StationEvent[] = []
  for (const u of units) {
    const at = u.gateInAt || parseInt(rowByVin.get(u.vin)?.cells['Gate In Time'] || '') || 0
    if (at) out.push({
      vin: u.vin, model: u.modelName, station: 'Gate-in',
      by: u.gateInBy || rowByVin.get(u.vin)?.cells['Gate In Inspector'] || '—', at,
    })
  }
  const unitByVin = new Map(units.map((u) => [u.vin, u]))
  for (const q of queues) {
    if (isSequenceQueue(q) || isPreGateInQueue(q.name)) continue
    const station = STATION_LABEL[queueTypeOf(q)]
    if (!station) continue
    for (const item of q.items) {
      if (!item.checkedAt) continue
      out.push({
        vin: item.vin, model: unitByVin.get(item.vin)?.modelName ?? '—', station,
        result: item.result, by: item.checkedBy || '—', at: item.checkedAt,
      })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** One row per Defect event: when it was FOUND, and one more row for every
 *  time its repair status changed (the "แก้ไข" side of the ask).
 *
 *  Defect here means a mark on the car — ประตูหน้า บุบ. A Control Stock Sheet /
 *  Additional Accessories tick counts what shipped WITH the car (คู่มือ ·
 *  สมุดรับประกัน · กรอบป้ายทะเบียน); it is not an NG on the bodywork and listing
 *  it here buried the real findings. realDefects is the one rule every screen
 *  that says "Defect" filters through. */
function buildDefectEvents(units: Unit[]): DefectEvent[] {
  const out: DefectEvent[] = []
  for (const u of units) {
    for (const d of realDefects(u.damages)) {
      const station = stationLabelOf(d)
      if (!isReportDefectStation(station)) continue
      const area = partLabel(d, 'th') || partLabel(d, 'en')
      const defect = defectLabel(d, 'th') || defectLabel(d, 'en')
      const areaEn = partBilingual(d).en
      const defectEn = defectBilingual(d).en
      out.push({ vin: u.vin, model: u.modelName, station, area, defect, areaEn, defectEn, kind: 'found', status: d.statusRepair, severity: d.severity, by: d.by, at: d.at })
      for (const h of d.repairHistory ?? []) {
        out.push({ vin: u.vin, model: u.modelName, station, area, defect, areaEn, defectEn, kind: 'status', status: h.status, severity: d.severity, by: h.by, at: h.at })
      }
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** exceljs writes Date as UTC — pin the LOCAL wall-clock so the cell shows the time the yard saw */
const localCell = (ts: number) => {
  const d = new Date(ts)
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()))
}

/** One-sheet .xlsx: bold header, frozen, filter on every column; the last column is the event time
 *  as a real date (sorts and filters by date in Excel). */
async function exportXlsx(filename: string, sheet: string, headers: string[], widths: number[], rows: (string | number)[][], times: number[]): Promise<void> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [...widths, 18].map((width) => ({ width }))
  const head = ws.addRow(headers)
  head.eachCell((c: any) => {
    c.font = { bold: true, color: { argb: 'FF111111' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
    c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
    c.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  rows.forEach((r, i) => {
    const row = ws.addRow([...r, localCell(times[i])])
    row.getCell(headers.length).numFmt = 'dd/mm/yyyy hh:mm'
  })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } }
  const buf = await wb.xlsx.writeBuffer()
  downloadBlob(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename)
}

const dayStart = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime() }

export function Report2ps() {
  const allUnits = useUnits()
  const allRows = useTrackingRows()
  const allQueues = useActiveQueues()
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const [tab, setTab] = useState<'station' | 'defect'>('station')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  // date range (YYYY-MM-DD, local) — blank = no bound
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [exporting, setExporting] = useState(false)

  // ── ยาร์ดใคร ยาร์ดมัน ────────────────────────────────────────────────────
  // เดิมกรองด้วย "!site || site === currentSite" — รถที่ยังไม่มียาร์ดกำกับจึง
  // โผล่ที่ "ทุก" ยาร์ด ยาร์ดหนึ่งเลยเห็น Defect ของอีกยาร์ดที่หน้างานตัวเอง
  // ไม่เคยสแกน (เช่น Defect ที่นำเข้ามาจากไฟล์ Co-Inspection ของอีกยาร์ด)
  // ใช้กติกากลางของระบบแทน (rowsForSite): ดูแท็บยาร์ดของแถวหลักก่อน ถ้าไม่มี
  // ก็เทียบ "Location yard" กับชื่อยาร์ด — กติกาเดียวกับ Unit List/Dashboard
  const rows = useMemo(() => rowsForSite(allRows, currentSite, sites), [allRows, currentSite, sites])
  const rowByVin = useMemo(() => new Map(rows.map((r) => [r.vin, r])), [rows])
  // แถวหลักเป็นตัวตัดสินยาร์ดของรถ · unit ที่ไม่มีแถวหลักเลย (ของเก่า/กำพร้า)
  // ยังใช้กติกาเดิม จะได้ไม่มีข้อมูลหายไปเงียบๆ
  const hasRow = useMemo(() => new Set(allRows.map((r) => r.vin)), [allRows])
  const units = useMemo(() => {
    if (!currentSite) return allUnits
    return allUnits.filter((u) => (hasRow.has(u.vin) ? rowByVin.has(u.vin) : !u.site || u.site === currentSite))
  }, [allUnits, currentSite, rowByVin, hasRow])
  const queues = useMemo(() => (currentSite ? allQueues.filter((q) => !q.site || q.site === currentSite) : allQueues), [allQueues, currentSite])

  // "(On Yard)" — currently in the yard, not departed. Same status set the
  // Dashboard's "In Yard" count uses, so the two numbers agree.
  const onYardUnits = useMemo(
    () => units.filter((u) => {
      const row = rowByVin.get(u.vin)
      return row ? IN_YARD_STATUSES.has(deriveCarStatus(row.cells)) : u.status !== 'DEPARTED' && u.status !== 'EXPECTED'
    }),
    [units, rowByVin],
  )

  const stationEvents = useMemo(() => buildStationEvents(onYardUnits, rowByVin, queues), [onYardUnits, rowByVin, queues])
  const defectEvents = useMemo(() => buildDefectEvents(onYardUnits), [onYardUnits])

  const q = search.trim().toUpperCase()
  const lo = from ? dayStart(from) : -Infinity
  const hi = to ? dayStart(to) + 86_400_000 : Infinity
  const filteredStation = useMemo(
    () => stationEvents.filter((e) => e.at >= lo && e.at < hi && (!q ||
      e.vin.includes(q) || e.model.toUpperCase().includes(q) || e.by.toUpperCase().includes(q) || e.station.toUpperCase().includes(q))),
    [stationEvents, q, lo, hi],
  )
  const filteredDefect = useMemo(
    () => defectEvents.filter((e) => e.at >= lo && e.at < hi && (!q ||
      e.vin.includes(q) || e.model.toUpperCase().includes(q) || e.by.toUpperCase().includes(q) ||
      e.station.toUpperCase().includes(q) || e.area.toUpperCase().includes(q))),
    [defectEvents, q, lo, hi],
  )

  const list: (StationEvent | DefectEvent)[] = tab === 'station' ? filteredStation : filteredDefect
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const pageRows = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const doExport = async () => {
    // the file name carries the range it covers
    const span = from || to ? `${from || 'start'}_${to || dateKey(new Date())}` : dateKey(new Date())
    setExporting(true)
    try {
      if (tab === 'station') {
        await exportXlsx(`SJWD-StationHistory-${span}.xlsx`, 'Station History', ['VIN', 'Model', 'Station', 'Result', 'ผู้บันทึก', 'วันที่/เวลา'], [22, 16, 18, 10, 22],
          filteredStation.map((e) => [e.vin, e.model, e.station, e.result ?? '', e.by]), filteredStation.map((e) => e.at))
      } else {
        // English throughout — the on-screen table stays Thai-first for yard
        // staff, but the exported file is read outside the yard
        await exportXlsx(`SJWD-DefectHistory-${span}.xlsx`, 'Defect History', ['VIN', 'Model', 'Station Found', 'Zone', 'Defect', 'Event', 'Status', 'Severity', 'Recorded By', 'Date/Time'],
          [22, 16, 18, 22, 28, 14, 16, 10, 22],
          filteredDefect.map((e) => [e.vin, e.model, stationEn(e.station), e.areaEn, e.defectEn, e.kind === 'found' ? 'Found Defect' : 'Status Change', e.status ?? '', e.severity ?? '', e.by]),
          filteredDefect.map((e) => e.at))
      }
    } finally { setExporting(false) }
  }

  return (
    <div>
      <PageHead
        title="Report 2PS"
        sub="Report Inspection Tracking Status (On Yard) — ประวัติการเคลื่อนไหวทุก activity ของรถในลาน"
        right={
          <button className="btn btn-primary" onClick={doExport} disabled={exporting || !list.length} data-report-export
            title="ดาวน์โหลดเป็นไฟล์ Excel ตามแท็บ ช่วงวันที่ และคำค้นที่เลือกไว้">
            <Download size={15} /> {exporting ? 'กำลังสร้างไฟล์…' : 'Export Excel'}
          </button>
        }
      />

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Segmented
          value={tab}
          onChange={(v) => { setTab(v); setPage(1) }}
          options={[
            { value: 'station', label: `ประวัติสถานี (${filteredStation.length})` },
            { value: 'defect', label: `ประวัติ Defect (${filteredDefect.length})` },
          ]}
        />
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
          <input
            className="input pl-8 w-full text-[13px]"
            placeholder="Search VIN, model, station, ผู้บันทึก…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--chip)' }}>
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>ตั้งแต่</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setPage(1) }} aria-label="ตั้งแต่วันที่" data-report-from
            className="bg-transparent outline-none text-[13px] font-bold tabular" style={{ color: 'var(--brand)' }} />
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>ถึง</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPage(1) }} aria-label="ถึงวันที่" data-report-to
            className="bg-transparent outline-none text-[13px] font-bold tabular" style={{ color: 'var(--brand)' }} />
          {(from || to) && (
            <button onClick={() => { setFrom(''); setTo(''); setPage(1) }} title="ล้างช่วงวันที่ (แสดงทั้งหมด)" aria-label="ล้างช่วงวันที่" style={{ color: 'var(--muted)' }}>
              <X size={14} />
            </button>
          )}
        </label>
        <div className="text-[13px] ml-auto" style={{ color: 'var(--muted)' }}>
          {list.length} record{list.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          {tab === 'station' ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b hairline" style={{ background: 'var(--chip)' }}>
                  {['Vehicle', 'Station', 'Result', 'ผู้บันทึก', 'วันที่/เวลา'].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[11.5px] font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {pageRows.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-12" style={{ color: 'var(--faint)' }}>ไม่พบข้อมูล</td></tr>
                ) : (pageRows as StationEvent[]).map((e, i) => (
                  <tr key={`${e.vin}-${e.station}-${e.at}-${i}`} className="hover:bg-chip transition-colors">
                    <td className="px-4 py-3">
                      <div className="vin text-[12px] font-bold" style={{ color: 'var(--brand)' }}>{e.vin}</div>
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{e.model}</div>
                    </td>
                    <td className="px-4 py-3 font-semibold">{e.station}</td>
                    <td className="px-4 py-3">
                      {e.result && (
                        <span className="badge font-bold" style={{ fontSize: 10.5,
                          background: e.result === 'NG' ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.1)',
                          color: e.result === 'NG' ? '#dc2626' : '#16a34a' }}>
                          {e.result}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{e.by}</td>
                    <td className="px-4 py-3 whitespace-nowrap tabular" style={{ color: 'var(--muted)' }}>{fmt(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b hairline" style={{ background: 'var(--chip)' }}>
                  {['Vehicle', 'Station ที่พบ', 'Zone / Defect', 'เหตุการณ์', 'สถานะ', 'ผู้บันทึก', 'วันที่/เวลา'].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[11.5px] font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {pageRows.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-12" style={{ color: 'var(--faint)' }}>ไม่พบข้อมูล</td></tr>
                ) : (pageRows as DefectEvent[]).map((e, i) => (
                  <tr key={`${e.vin}-${e.area}-${e.at}-${i}`} className="hover:bg-chip transition-colors">
                    <td className="px-4 py-3">
                      <div className="vin text-[12px] font-bold" style={{ color: 'var(--brand)' }}>{e.vin}</div>
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{e.model}</div>
                    </td>
                    <td className="px-4 py-3 font-semibold">{e.station}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold">
                        {e.area}
                        {e.severity === 'major' && <span className="badge ml-1.5" style={{ fontSize: 10, background: '#fee2e2', color: '#b91c1c' }}>HEAVY NG</span>}
                      </div>
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{e.defect}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="badge font-bold" style={{ fontSize: 10.5,
                        background: e.kind === 'found' ? 'rgba(220,38,38,0.1)' : 'rgba(37,99,235,0.1)',
                        color: e.kind === 'found' ? '#dc2626' : '#2563eb' }}>
                        {e.kind === 'found' ? 'พบ Defect' : 'เปลี่ยนสถานะ'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{e.status ?? '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{e.by}</td>
                    <td className="px-4 py-3 whitespace-nowrap tabular" style={{ color: 'var(--muted)' }}>{fmt(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t hairline">
          <div className="text-[12px]" style={{ color: 'var(--muted)' }}>Show {pageRows.length} of {list.length} total</div>
          <div className="flex items-center gap-2">
            <button className="btn p-1.5" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} /></button>
            <span className="text-[12.5px] font-semibold px-1">{page} / {totalPages}</span>
            <button className="btn p-1.5" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}
