/**
 * DailyStockReport — "Local Production Stock" for one calendar day.
 *
 * Every number is reconstructed from each car's gate-in / gate-out day, so any
 * past date can be asked for and answers from the same rows the Gate In/Out
 * board uses: stock at end of day = gated in on or before it, and either never
 * gated out or gated out later.
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Download, LogIn, LogOut, Warehouse, ChevronDown } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { rowInSite } from '../lib/siteScope'
import { appendMasterSheets } from '../lib/masterSheets'
import { dateKey, todayKey, addDays, fmtDateTh, gateInDateKey, gateOutDateKey } from '../lib/dayKey'
import * as db from '../lib/db'
import { YARD_CAPACITY_CONFIG_ID as CAP_CONFIG_ID, YARD_CAPACITY_CACHE_KEY as CAP_CACHE_KEY } from '../lib/yardCapacity'
import type { TrackRow } from '../lib/excelTracking'

const modelOf = (r: TrackRow) => (r.cells['Model name'] || r.cells['Model'] || '—').trim() || '—'
const colorOf = (r: TrackRow) => (r.cells['Color'] || '—').trim() || '—'
const groupOf = (r: TrackRow) => (r.cells['Grouping  Number'] || '').trim() || '—'

export function DailyStockReport() {
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const toast = useYard((s) => s.toast)
  const allRows = useTrackingRows()

  const [day, setDay] = useState(todayKey())
  const [caps, setCaps] = useState<Record<string, number>>({})
  const [capDraft, setCapDraft] = useState<string | null>(null)
  const [openList, setOpenList] = useState<'in' | 'out' | 'stock' | null>(null)
  const [exporting, setExporting] = useState(false)

  const siteName = sites.find((s) => s.id === currentSite)?.name ?? '—'
  const cap = currentSite ? caps[currentSite] ?? 0 : 0

  // capacity is shared across devices; the local copy keeps it visible offline
  useEffect(() => {
    try {
      const cached = localStorage.getItem(CAP_CACHE_KEY)
      if (cached) setCaps(JSON.parse(cached))
    } catch { /* ignore a corrupt cache */ }
    db.fetchAppConfig<Record<string, number>>(CAP_CONFIG_ID)
      .then((v) => { if (v) { setCaps(v); localStorage.setItem(CAP_CACHE_KEY, JSON.stringify(v)) } })
      .catch((e) => console.error('[report] capacity load', e))
  }, [])

  const saveCap = (raw: string) => {
    setCapDraft(null)
    if (!currentSite) return
    const n = Math.max(0, Math.round(Number(raw.replace(/[^\d]/g, '')) || 0))
    if (n === cap) return
    const next = { ...caps, [currentSite]: n }
    setCaps(next)
    localStorage.setItem(CAP_CACHE_KEY, JSON.stringify(next))
    db.saveAppConfig(CAP_CONFIG_ID, next)
      .then(() => toast('ok', `บันทึกความจุ ${siteName} = ${n.toLocaleString()} คัน`))
      .catch(() => toast('err', 'บันทึกความจุขึ้นคลาวด์ไม่สำเร็จ — เครื่องนี้ยังใช้ค่าใหม่ได้'))
  }

  const rows = useMemo(
    () => allRows.filter((r) => rowInSite(r, currentSite, sites)),
    [allRows, currentSite, sites],
  )
  const allUnits = useUnits()
  const scopedUnits = useMemo(
    () => (currentSite ? allUnits.filter((u) => !u.site || u.site === currentSite) : allUnits),
    [allUnits, currentSite],
  )

  const data = useMemo(() => {
    const prev = addDays(day, -1)
    const inRows: TrackRow[] = []
    const outRows: TrackRow[] = []
    const stock: TrackRow[] = []
    let opening = 0
    let undated = 0
    for (const r of rows) {
      const gi = gateInDateKey(r)
      const go = gateOutDateKey(r)
      if (!gi && !go) { undated++; continue }        // never gated in — not in the yard yet
      if (gi === day) inRows.push(r)
      if (go === day) outRows.push(r)
      if (gi && gi <= day && (!go || go > day)) stock.push(r)
      if (gi && gi <= prev && (!go || go > prev)) opening++
    }
    // Model × Color of what is standing in the yard at the end of the day
    const models = new Map<string, Map<string, number>>()
    const colorTotals = new Map<string, number>()
    for (const r of stock) {
      const m = modelOf(r), c = colorOf(r)
      if (!models.has(m)) models.set(m, new Map())
      const byColor = models.get(m)!
      byColor.set(c, (byColor.get(c) ?? 0) + 1)
      colorTotals.set(c, (colorTotals.get(c) ?? 0) + 1)
    }
    const colors = [...colorTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const byModel = [...models.entries()]
      .map(([model, byColor]) => ({ model, byColor, total: [...byColor.values()].reduce((n, v) => n + v, 0) }))
      .sort((a, b) => b.total - a.total)
    const sortRows = (list: TrackRow[]) =>
      [...list].sort((a, b) => modelOf(a).localeCompare(modelOf(b)) || a.vin.localeCompare(b.vin))
    return {
      inRows: sortRows(inRows), outRows: sortRows(outRows), stockRows: sortRows(stock),
      opening, colors, byModel, colorTotals, undated,
    }
  }, [rows, day])

  const stockN = data.stockRows.length
  const balance = cap - stockN
  const isToday = day === todayKey()

  const doExport = async () => {
    setExporting(true)
    try {
      const XJS: any = await import('exceljs')
      const ExcelJS = XJS.default ?? XJS
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Daily Stock')
      ws.columns = [{ width: 22 }, { width: 26 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }]

      const title = (t: string) => {
        const row = ws.addRow([t])
        row.font = { bold: true, size: 12 }
        return row
      }
      const headRow = (vals: (string | number)[]) => {
        const row = ws.addRow(vals)
        row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        row.eachCell((c: any) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A4D8C' } } })
        return row
      }

      title(`Local Production Stock — ${siteName}`)
      ws.addRow([fmtDateTh(day)])
      ws.addRow([])
      headRow(['Yard', 'Max Cap.', 'ยกมา', 'เข้า', 'ออก', 'Stock', 'Balance'])
      ws.addRow([siteName, cap || '—', data.opening, data.inRows.length, data.outRows.length, stockN, cap ? balance : '—'])
      ws.addRow([])

      title('คงเหลือในลาน แยกตามรุ่น / สี')
      headRow(['Model', ...data.colors, 'รวม'])
      for (const m of data.byModel)
        ws.addRow([m.model, ...data.colors.map((c) => m.byColor.get(c) ?? 0), m.total])
      ws.addRow(['รวม', ...data.colors.map((c) => data.colorTotals.get(c) ?? 0), stockN]).font = { bold: true }
      ws.addRow([])

      for (const [label, list] of [['รถเข้าลาน', data.inRows], ['รถออกจากลาน', data.outRows]] as const) {
        title(`${label} (${list.length} คัน)`)
        headRow(['VIN', 'Model', 'Color', 'Grouping'])
        for (const r of list) ws.addRow([r.vin, modelOf(r), colorOf(r), groupOf(r)])
        ws.addRow([])
      }

      // ── master sheets ride along: Tracking Status + the 3 Defect sheets,
      //    same 1:1 master format the Report export uses (re-importable)
      const sortedRows = [...rows].sort((a, b) => a.vin.localeCompare(b.vin))
      appendMasterSheets(wb, sortedRows, scopedUnits)

      const buf = await wb.xlsx.writeBuffer()
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `SJWD-DailyStock-${siteName.replace(/\s+/g, '')}-${day}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      toast('ok', `ออกรายงานประจำวัน ${fmtDateTh(day)} แล้ว`)
    } catch (e) {
      console.error('[report] daily export', e)
      toast('err', 'ออกรายงานไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setExporting(false)
    }
  }

  const card = (label: string, value: number, color: string, icon: React.ReactNode, onClick?: () => void, active?: boolean) => (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="panel p-3.5 flex items-center gap-3 text-left transition"
      style={{ borderColor: active ? color : undefined, cursor: onClick ? 'pointer' : 'default' }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${color}18`, color }}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{label}</div>
        <div className="display text-[20px] font-bold tabular leading-tight" style={{ color }}>{value.toLocaleString()}</div>
      </div>
    </button>
  )

  const list = openList === 'in' ? data.inRows : openList === 'out' ? data.outRows : openList === 'stock' ? data.stockRows : null
  const listLabel = openList === 'in' ? 'รถเข้าลาน' : openList === 'out' ? 'รถออกจากลาน' : 'รถคงเหลือในลาน'

  return (
    <div className="panel overflow-hidden mb-4">
      {/* ── day picker ── */}
      <div className="px-4 py-3 border-b hairline flex items-center gap-2 flex-wrap">
        <CalendarDays size={16} style={{ color: 'var(--brand)' }} />
        <span className="font-semibold text-[13.5px]">รายงานประจำวัน</span>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Local Production Stock · {siteName}</span>

        <div className="ml-auto flex items-center gap-1.5">
          <button className="btn px-2 py-1.5" title="วันก่อนหน้า" onClick={() => setDay(addDays(day, -1))}>
            <ChevronLeft size={15} />
          </button>
          <input type="date" value={day} max={todayKey()} onChange={(e) => e.target.value && setDay(e.target.value)}
            className="rounded-lg px-2.5 py-1.5 text-[13px] tabular outline-none"
            style={{ background: 'var(--chip)', border: '1px solid var(--line)' }} />
          <button className="btn px-2 py-1.5" title="วันถัดไป" disabled={isToday}
            onClick={() => setDay(addDays(day, 1))}>
            <ChevronRight size={15} />
          </button>
          <button className={`btn px-3 py-1.5 text-[12.5px] ${isToday ? 'btn-primary' : ''}`}
            onClick={() => setDay(todayKey())}>วันนี้</button>
          <button className="btn btn-primary px-3 py-1.5 text-[12.5px]" onClick={doExport} disabled={exporting}>
            <Download size={14} className="mr-1" />{exporting ? 'กำลังสร้าง…' : 'Excel'}
          </button>
        </div>
      </div>

      <div className="p-4">
        <div className="text-[12.5px] mb-3" style={{ color: 'var(--muted)' }}>
          ยอด ณ สิ้นวัน <b style={{ color: 'var(--text)' }}>{fmtDateTh(day)}</b>
        </div>

        {/* ── stock summary — the Local Production Stock block ── */}
        <div className="overflow-x-auto mb-4">
          <table className="w-full" style={{ fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--app-bg)' }}>
                <th className="text-left px-3 py-2 font-bold whitespace-nowrap">Yard</th>
                <th className="text-center px-3 py-2 font-bold whitespace-nowrap">Max Cap.</th>
                <th className="text-center px-3 py-2 font-bold whitespace-nowrap">ยกมา</th>
                <th className="text-center px-3 py-2 font-bold whitespace-nowrap">เข้า</th>
                <th className="text-center px-3 py-2 font-bold whitespace-nowrap">ออก</th>
                <th className="text-center px-3 py-2 font-bold whitespace-nowrap">Stock</th>
                <th className="text-center px-3 py-2 font-bold whitespace-nowrap">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t hairline">
                <td className="px-3 py-2 font-bold">{siteName}</td>
                <td className="text-center px-3 py-2">
                  {/* editable: capacity is a yard fact the app has no other source for */}
                  <input
                    value={capDraft ?? (cap ? cap.toLocaleString() : '')}
                    placeholder="—"
                    onFocus={() => setCapDraft(cap ? String(cap) : '')}
                    onChange={(e) => setCapDraft(e.target.value)}
                    onBlur={(e) => saveCap(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    className="w-[74px] text-center tabular font-semibold rounded-md px-1.5 py-1 outline-none"
                    style={{ background: 'var(--chip)', border: '1px solid var(--line)' }} />
                </td>
                <td className="text-center px-3 py-2 tabular">{data.opening.toLocaleString()}</td>
                <td className="text-center px-3 py-2 tabular font-bold" style={{ color: 'var(--brand)' }}>+{data.inRows.length.toLocaleString()}</td>
                <td className="text-center px-3 py-2 tabular font-bold" style={{ color: '#c2680b' }}>−{data.outRows.length.toLocaleString()}</td>
                <td className="text-center px-3 py-2 tabular font-bold text-[14px]">{stockN.toLocaleString()}</td>
                <td className="text-center px-3 py-2 tabular font-bold"
                  style={cap && balance < 0
                    ? { background: 'rgba(220,38,38,0.12)', color: '#c0362c' }
                    : { color: cap ? 'var(--st-yard)' : 'var(--faint)' }}>
                  {cap ? balance.toLocaleString() : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {!cap && (
          <div className="text-[11.5px] mb-3" style={{ color: 'var(--muted)' }}>
            กรอกความจุสูงสุด (Max Cap.) ของลานหนึ่งครั้ง ระบบจะจำไว้และคำนวณ Balance ให้ทุกวัน
          </div>
        )}

        {/* ── movement of the day ── */}
        <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
          {card('รถเข้าลาน', data.inRows.length, 'var(--brand)', <LogIn size={17} />,
            () => setOpenList(openList === 'in' ? null : 'in'), openList === 'in')}
          {card('รถออกจากลาน', data.outRows.length, '#c2680b', <LogOut size={17} />,
            () => setOpenList(openList === 'out' ? null : 'out'), openList === 'out')}
          {card('คงเหลือในลาน', stockN, 'var(--st-yard)', <Warehouse size={17} />,
            () => setOpenList(openList === 'stock' ? null : 'stock'), openList === 'stock')}
        </div>

        {/* ── the VIN list behind whichever number was clicked ── */}
        {list && (
          <div className="panel overflow-hidden mb-4">
            <div className="px-3.5 py-2 border-b hairline flex items-center gap-2 text-[12.5px] font-semibold" style={{ background: 'var(--app-bg)' }}>
              <ChevronDown size={14} style={{ color: 'var(--muted)' }} />
              {listLabel} · {list.length.toLocaleString()} คัน
              <button className="btn btn-ghost ml-auto px-2 py-1 text-[12px]" onClick={() => setOpenList(null)}>ปิด</button>
            </div>
            {list.length === 0 ? (
              <div className="px-3.5 py-4 text-[12.5px]" style={{ color: 'var(--faint)' }}>— ไม่มีรายการในวันนี้ —</div>
            ) : (
              <div className="max-h-[46vh] overflow-y-auto">
                <table className="w-full" style={{ fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--app-bg)' }}>
                      <th className="text-left px-3 py-1.5 font-bold">VIN</th>
                      <th className="text-left px-3 py-1.5 font-bold">Model</th>
                      <th className="text-left px-3 py-1.5 font-bold">Color</th>
                      <th className="text-left px-3 py-1.5 font-bold">Grouping</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={r.vin} className="border-t hairline">
                        <td className="px-3 py-1.5 vin font-semibold">{r.vin}</td>
                        <td className="px-3 py-1.5">{modelOf(r)}</td>
                        <td className="px-3 py-1.5">{colorOf(r)}</td>
                        <td className="px-3 py-1.5 tabular" style={{ color: 'var(--muted)' }}>{groupOf(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── model × colour of the cars standing in the yard ── */}
        <div className="text-[12px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
          คงเหลือในลาน แยกตามรุ่น / สี
        </div>
        {stockN === 0 ? (
          <div className="text-[12.5px] py-3" style={{ color: 'var(--faint)' }}>
            — ไม่มีรถในลานของวันนี้ (หรือยังไม่มีข้อมูลวันที่ Gate-in) —
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--app-bg)' }}>
                  <th className="text-left px-3 py-1.5 font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>Model</th>
                  {data.colors.map((c) => (
                    <th key={c} className="text-center px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>{c}</th>
                  ))}
                  <th className="text-center px-3 py-1.5 font-bold">รวม</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map(({ model, byColor, total }) => (
                  <tr key={model} className="border-t hairline">
                    <td className="px-3 py-1.5 font-semibold whitespace-nowrap">{model}</td>
                    {data.colors.map((c) => {
                      const n = byColor.get(c) ?? 0
                      return (
                        <td key={c} className="text-center px-2 py-1.5 tabular">
                          {n > 0 ? n.toLocaleString() : <span style={{ color: 'var(--faint)' }}>—</span>}
                        </td>
                      )
                    })}
                    <td className="text-center px-3 py-1.5 tabular font-bold" style={{ color: 'var(--brand)' }}>{total.toLocaleString()}</td>
                  </tr>
                ))}
                <tr className="border-t" style={{ borderColor: 'var(--line-strong)', background: 'var(--app-bg)' }}>
                  <td className="px-3 py-1.5 font-bold">รวม</td>
                  {data.colors.map((c) => (
                    <td key={c} className="text-center px-2 py-1.5 tabular font-bold">{(data.colorTotals.get(c) ?? 0).toLocaleString()}</td>
                  ))}
                  <td className="text-center px-3 py-1.5 tabular font-bold" style={{ color: 'var(--brand)' }}>{stockN.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {data.undated > 0 && (
          <div className="text-[11.5px] mt-3" style={{ color: 'var(--muted)' }}>
            หมายเหตุ · มีรถ {data.undated.toLocaleString()} คันที่ยังไม่มีวันที่ Gate-in (เช่น สถานะ Pre Gate-in) จึงไม่ถูกนับในยอดคงเหลือ
          </div>
        )}
      </div>
    </div>
  )
}
