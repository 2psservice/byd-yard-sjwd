/**
 * Rounds register table + Excel export for one station's inspection rounds
 * (PDI's "Report PDI" tab). This is the full per-VIN record across every
 * round — not tied to the station's other three tables' single work day —
 * the same shape as the PM Plan page's "PM STATUS" tab, generalized so a
 * second station (PDI here) can show its own without copying the read logic.
 *
 * Its own DayPicker (separate from the page's day-scoped tabs) narrows the
 * row set to cars with a round recorded that day — with the full fleet's
 * history in view by default, a specific day is the fast way to find what
 * changed without scrolling past thousands of rows.
 */
import { useMemo, useState } from 'react'
import { Search, Download } from 'lucide-react'
import { useTracking } from '../store/useTracking'
import { useYard } from '../store/useYard'
import { deriveCarStatus } from '../lib/carStatus'
import { parseCellDate } from '../lib/trackingColumns'
import { MEAS, buildRegisterRows, maxRoundCount, exportRegister } from '../lib/roundsRegister'
import { dayKeyOfTs, type ReportCtx } from '../lib/opsReport'
import { dayKeyOf, DayPicker } from '../pages/Grouping'

const SHOW_CAP = 400

export function StationRoundsReport({ ctx, roundKeys, roundLabel, title, fileBase }: {
  ctx: ReportCtx
  roundKeys: string[]
  /** Header label for round `i` (0-based) — e.g. i===0 → "PDI", else "RE PDI #i". */
  roundLabel: (i: number) => string
  title: string
  fileBase: string
}) {
  const columns = useTracking((s) => s.columns)
  const toast = useYard((s) => s.toast)
  const [q, setQ] = useState('')
  const [day, setDay] = useState<string | 'all'>('all')
  const [exporting, setExporting] = useState(false)

  // a car not yet through the gate cannot have a round recorded yet — same
  // cut every other tab on this board makes, just not limited to today
  const siteRows = useMemo(
    () => ctx.rows.filter((r) => deriveCarStatus(r.cells) !== 'Pre Gate-in'),
    [ctx.rows],
  )

  // calendar marks: days that actually carry a round (PDI or any RE-PDI) —
  // the register default-shows everything (thousands of cars), so this is
  // how the calendar tells the office which days have something to look at
  const dayCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of siteRows) for (const k of roundKeys) {
      const t = parseCellDate(r.cells[k])
      if (t == null) continue
      const dk = dayKeyOfTs(t)
      m.set(dk, (m.get(dk) ?? 0) + 1)
    }
    return m
  }, [siteRows, roundKeys])

  const byDay = useMemo(() => {
    if (day === 'all') return siteRows
    return siteRows.filter((r) => roundKeys.some((k) => {
      const t = parseCellDate(r.cells[k])
      return t != null && dayKeyOfTs(t) === day
    }))
  }, [siteRows, roundKeys, day])

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase()
    if (!needle) return byDay
    return byDay.filter((r) => r.vin.includes(needle)
      || (r.cells['Model name'] || '').toUpperCase().includes(needle)
      || (r.cells['Model'] || '').toUpperCase().includes(needle))
  }, [byDay, q])
  const maxRound = useMemo(() => maxRoundCount(filtered, roundKeys), [filtered, roundKeys])
  const register = useMemo(() => buildRegisterRows(filtered, roundKeys, maxRound, columns), [filtered, roundKeys, maxRound, columns])
  const shown = register.slice(0, SHOW_CAP)

  const doExport = async () => {
    setExporting(true)
    try {
      await exportRegister(register, maxRound, roundLabel, {
        filename: `${fileBase}_${ctx.siteLabel.replace(/[^\w]+/g, '')}_${dayKeyOf(new Date())}.xlsx`,
        sheetName: title,
      })
      toast('ok', `ออกไฟล์ ${title} แล้ว`)
    } catch (e) { console.error('[roundsReport] export', e); toast('err', 'ออกไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง') }
    finally { setExporting(false) }
  }

  return (
    <div className="panel overflow-hidden">
      <div className="px-3 py-2.5 border-b hairline flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2 px-3 py-1.5 rounded-xl flex-1 min-w-[220px] max-w-[380px]" style={{ background: 'var(--chip)' }}>
          <Search size={14} style={{ color: 'var(--muted)' }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา VIN / รุ่น…"
            className="bg-transparent outline-none text-[13px] w-full" />
        </label>
        <DayPicker days={dayCounts} value={day} onChange={setDay}
          hint="เลือกวันที่ — กรองเฉพาะรถที่มีรอบ PDI/RE-PDI วันนั้น" />
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
          {register.length > SHOW_CAP
            ? `แสดง ${SHOW_CAP} จาก ${register.length.toLocaleString()} คัน — พิมพ์ค้นหาเพื่อกรอง`
            : `${register.length.toLocaleString()} คัน`}
        </span>
        <button className="btn btn-primary px-3 py-1.5 text-[12.5px] ml-auto" onClick={doExport} disabled={exporting}
          title={`ออกไฟล์ Excel — ${title}`}>
          <Download size={14} /> {exporting ? 'กำลังสร้างไฟล์…' : 'Export Excel'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="text-[11.5px] tabular" style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
          <thead>
            <tr style={{ background: 'var(--chip)' }}>
              {['No.', 'Vin', 'Model name', 'Model', 'Color', 'Gate In'].map((h, i) => (
                <th key={h} rowSpan={2} className={`px-2.5 py-2 font-bold whitespace-nowrap ${i === 1 ? 'text-left' : 'text-center'}`}
                  style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)', ...(i === 1 ? { position: 'sticky', left: 0, zIndex: 10, background: 'var(--chip)' } : {}) }}>
                  {h}
                </th>
              ))}
              {Array.from({ length: maxRound }, (_, gi) => (
                <th key={gi} colSpan={1 + MEAS.length} className="px-2.5 py-1.5 text-center font-bold whitespace-nowrap"
                  style={{ color: 'var(--brand)', borderBottom: '1px solid var(--line)', borderLeft: '2px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.06)' : 'var(--chip)' }}>
                  {roundLabel(gi)}
                </th>
              ))}
            </tr>
            <tr style={{ background: 'var(--chip)' }}>
              {Array.from({ length: maxRound }, (_, gi) => gi).flatMap((gi) => [
                <th key={`d${gi}`} className="px-2 py-1.5 text-center font-bold whitespace-nowrap"
                  style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)', borderLeft: '2px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.06)' : undefined }}>วันที่</th>,
                ...MEAS.map((m) => (
                  <th key={`${gi}-${m.key}`} className="px-2 py-1.5 text-center font-semibold whitespace-nowrap"
                    style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)', background: gi % 2 ? 'rgba(37,99,235,0.06)' : undefined }}>{m.head}</th>
                )),
              ])}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.vin} className="hover:bg-chip">
                <td className="px-2.5 py-1.5 text-center" style={{ color: 'var(--faint)', borderBottom: '1px solid var(--line)' }}>{i + 1}</td>
                <td className="px-2.5 py-1.5 vin font-semibold whitespace-nowrap"
                  style={{ position: 'sticky', left: 0, zIndex: 5, background: 'var(--panel, #fff)', borderBottom: '1px solid var(--line)' }}>{r.vin}</td>
                <td className="px-2.5 py-1.5 whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{r.modelName}</td>
                <td className="px-2.5 py-1.5 text-center whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{r.model}</td>
                <td className="px-2.5 py-1.5 text-center whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{r.color}</td>
                <td className="px-2.5 py-1.5 text-center whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}>{r.gateIn}</td>
                {r.rounds.flatMap((rd, gi) => [
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
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={6 + maxRound * (1 + MEAS.length)} className="px-4 py-8 text-center" style={{ color: 'var(--faint)' }}>
                ไม่พบรถ{q ? `ที่ตรงกับ "${q}"` : ''}{day !== 'all' ? ` ในวันที่ ${day.split('-').reverse().join('/')}` : ''}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
