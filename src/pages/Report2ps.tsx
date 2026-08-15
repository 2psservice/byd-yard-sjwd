/**
 * Report 2PS — Report Inspection Tracking Status (On Yard): every station
 * event (Gate-in / PDI / PM / Final Check / ช่าง) and every Defect event
 * (found / status change) recorded by this app, for cars currently on yard.
 */
import { useMemo, useState } from 'react'
import { Search, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { useActiveQueues, queueTypeOf, isSequenceQueue, type QueueType, type WorkQueue } from '../store/useOps'
import { PageHead, Segmented } from '../components/ui'
import { partLabel, defectLabel } from '../lib/damageLabel'
import { stationLabelOf } from '../lib/carHistory'
import { deriveCarStatus, IN_YARD_STATUSES } from '../lib/carStatus'
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
  kind: 'found' | 'status'; status?: string; severity?: 'minor' | 'major'; by: string; at: number
}

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
 *  time its repair status changed (the "แก้ไข" side of the ask). */
function buildDefectEvents(units: Unit[]): DefectEvent[] {
  const out: DefectEvent[] = []
  for (const u of units) {
    for (const d of u.damages) {
      const station = stationLabelOf(d)
      const area = partLabel(d, 'th') || partLabel(d, 'en')
      const defect = defectLabel(d, 'th') || defectLabel(d, 'en')
      out.push({ vin: u.vin, model: u.modelName, station, area, defect, kind: 'found', status: d.statusRepair, severity: d.severity, by: d.by, at: d.at })
      for (const h of d.repairHistory ?? []) {
        out.push({ vin: u.vin, model: u.modelName, station, area, defect, kind: 'status', status: h.status, severity: d.severity, by: h.by, at: h.at })
      }
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

function toCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const body = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export function Report2ps() {
  const allUnits = useUnits()
  const allRows = useTrackingRows()
  const allQueues = useActiveQueues()
  const currentSite = useYard((s) => s.currentSite)
  const [tab, setTab] = useState<'station' | 'defect'>('station')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const units = useMemo(() => (currentSite ? allUnits.filter((u) => !u.site || u.site === currentSite) : allUnits), [allUnits, currentSite])
  const rows = useMemo(() => (currentSite ? allRows.filter((r) => !r.site || r.site === currentSite) : allRows), [allRows, currentSite])
  const queues = useMemo(() => (currentSite ? allQueues.filter((q) => !q.site || q.site === currentSite) : allQueues), [allQueues, currentSite])
  const rowByVin = useMemo(() => new Map(rows.map((r) => [r.vin, r])), [rows])

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
  const filteredStation = useMemo(
    () => (!q ? stationEvents : stationEvents.filter((e) =>
      e.vin.includes(q) || e.model.toUpperCase().includes(q) || e.by.toUpperCase().includes(q) || e.station.toUpperCase().includes(q))),
    [stationEvents, q],
  )
  const filteredDefect = useMemo(
    () => (!q ? defectEvents : defectEvents.filter((e) =>
      e.vin.includes(q) || e.model.toUpperCase().includes(q) || e.by.toUpperCase().includes(q) ||
      e.station.toUpperCase().includes(q) || e.area.toUpperCase().includes(q))),
    [defectEvents, q],
  )

  const list: (StationEvent | DefectEvent)[] = tab === 'station' ? filteredStation : filteredDefect
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const pageRows = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const doExport = () => {
    const stamp = new Date().toISOString().slice(0, 10)
    if (tab === 'station') {
      toCsv(`SJWD-StationHistory-${stamp}.csv`, ['VIN', 'Model', 'Station', 'Result', 'ผู้บันทึก', 'วันที่/เวลา'],
        filteredStation.map((e) => [e.vin, e.model, e.station, e.result ?? '', e.by, fmt(e.at)]))
    } else {
      toCsv(`SJWD-DefectHistory-${stamp}.csv`, ['VIN', 'Model', 'Station ที่พบ', 'Zone', 'Defect', 'เหตุการณ์', 'สถานะ', 'Severity', 'ผู้บันทึก', 'วันที่/เวลา'],
        filteredDefect.map((e) => [e.vin, e.model, e.station, e.area, e.defect, e.kind === 'found' ? 'พบ Defect' : 'เปลี่ยนสถานะ', e.status ?? '', e.severity ?? '', e.by, fmt(e.at)]))
    }
  }

  return (
    <div>
      <PageHead
        title="Report 2PS"
        sub="Report Inspection Tracking Status (On Yard) — ประวัติการเคลื่อนไหวทุก activity ของรถในลาน"
        right={
          <button className="btn btn-primary" onClick={doExport}>
            <Download size={15} /> Export CSV
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
