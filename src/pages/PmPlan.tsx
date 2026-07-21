/**
 * PM Plan — monthly preventive-maintenance schedule across every yard.
 *
 * A car must have a PM once it has been in the yard for one interval, then again
 * every interval after (30 days for all yards EXCEPT Auto Tran 38 Rai, which is
 * every 90 days). A car that is already allocated (has a Grouping/Allocation) or
 * has gated out is no longer eligible for PM and is excluded.
 *
 * The table estimates, for the selected month, how many cars in each yard fall
 * due on each calendar day (rows = yards, columns = days 1…31, right column =
 * per-yard sum, bottom row = per-day totals). Sundays are tinted; today's column
 * is ringed. "ส่ง LINE" shares the per-yard summary via LINE.
 */
import { useMemo, useState } from 'react'
import { CalendarClock, Send } from 'lucide-react'
import { useTrackingRows } from '../store/useTracking'
import { useYard } from '../store/useYard'
import { parseCellDate, lastPmDate } from '../lib/trackingColumns'
import { deriveCarStatus } from '../lib/carStatus'
import { siteIdForLocation } from '../lib/siteScope'
import { PageHead, cx } from '../components/ui'

const DAY_MS = 86_400_000

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

/** A car is not eligible for PM once it is allocated (grouping / allocation set). */
const isAllocated = (c: Record<string, string>) =>
  !!((c['Allocation Date'] || '').trim() || (c['Grouping  Number'] || '').trim())

function ymNow(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function PmPlan() {
  const rows = useTrackingRows() // ALL yards — this board is cross-site by design
  const sites = useYard((s) => s.sites)
  const toast = useYard((s) => s.toast)
  const [ym, setYm] = useState<string>(ymNow)

  const [year, month] = ym.split('-').map(Number) // month is 1-12
  const daysInMonth = new Date(year, month, 0).getDate()

  const plan = useMemo(() => {
    const monthStart = new Date(year, month - 1, 1).getTime()
    const monthEnd = new Date(year, month - 1, daysInMonth, 23, 59, 59, 999).getTime()

    const siteList = sites.map((s) => ({ id: s.id, name: s.name, short: shortSite(s.name), interval: pmInterval(s.name) }))
    const grid = new Map<string, number[]>(siteList.map((s) => [s.id, new Array(daysInMonth + 1).fill(0)]))
    const intervalOf = new Map(siteList.map((s) => [s.id, s.interval]))

    for (const row of rows) {
      const c = row.cells
      const cs = deriveCarStatus(c)
      // not yet in the yard, already gone, or written off → no PM
      if (cs === 'Gate-out' || cs === 'Total loss' || cs === 'Pre Gate-in') continue
      if (isAllocated(c)) continue // allocated cars can't be PM'd
      const siteId = row.site ?? siteIdForLocation(c, sites)
      if (!siteId || !grid.has(siteId)) continue
      const interval = intervalOf.get(siteId)!
      // cycle base: the last PM if any, otherwise gate-in (in-yard start)
      const base = lastPmDate(c) ?? parseCellDate(c['Gate In (Rayong yard)']) ?? parseCellDate(c['Gate In Date'])
      if (base == null) continue
      const step = interval * DAY_MS
      // project due dates base+step, base+2·step, … that land inside this month
      let n = Math.max(1, Math.ceil((monthStart - base) / step))
      for (let due = base + n * step; due <= monthEnd; due += step) {
        if (due < monthStart) continue
        grid.get(siteId)![new Date(due).getDate()]++
      }
    }

    const siteRows = siteList.map((s) => {
      const cells = grid.get(s.id)!
      const sum = cells.reduce((a, b) => a + b, 0)
      return { ...s, cells, sum }
    })
    const colTotals = new Array(daysInMonth + 1).fill(0)
    for (const r of siteRows) for (let d = 1; d <= daysInMonth; d++) colTotals[d] += r.cells[d]
    const grand = siteRows.reduce((a, r) => a + r.sum, 0)
    return { siteRows, colTotals, grand }
  }, [rows, sites, year, month, daysInMonth])

  const now = new Date()
  const todayDay = now.getFullYear() === year && now.getMonth() + 1 === month ? now.getDate() : -1
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1)
  const isSunday = (d: number) => new Date(year, month - 1, d).getDay() === 0

  const sendLine = () => {
    const lines = [
      `แผน PM ประจำเดือน ${ym}`,
      ...plan.siteRows.map((r) => `${r.short}: ${r.sum.toLocaleString()}`),
      `รวม: ${plan.grand.toLocaleString()} คัน`,
    ]
    window.open(`https://line.me/R/msg/text/?${encodeURIComponent(lines.join('\n'))}`, '_blank')
    toast('ok', 'เปิด LINE เพื่อส่งสรุปแผน PM')
  }

  // shared cell styling helpers
  const colBg = (d: number) => (d === todayDay ? 'rgba(16,185,129,0.10)' : isSunday(d) ? 'rgba(239,68,68,0.06)' : undefined)
  const numColor = (v: number, d: number) => (v === 0 ? (isSunday(d) ? '#f87171' : 'var(--faint)') : 'var(--text)')

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="panel p-4 mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <PageHead
            title={<span className="flex items-center gap-2"><CalendarClock size={20} style={{ color: 'var(--brand)' }} /> แผน PM ประจำเดือน</span>}
            sub="PM รอบแรกเมื่ออยู่ในลานครบกำหนด แล้วนับต่อไปทุกรอบ (30 วันทุก site · 38 ไร่ ทุก 90 วัน) — รถที่ allocate แล้วหรือ gate out แล้วจะไม่นับ"
          />
        </div>
        <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--chip)' }}>
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>เดือน:</span>
          <input type="month" className="bg-transparent outline-none text-[13px] font-bold tabular" style={{ color: 'var(--brand)' }} value={ym} onChange={(e) => e.target.value && setYm(e.target.value)} />
        </label>
        <button className="btn btn-primary px-4 py-2" onClick={sendLine} style={{ background: '#06c755', border: 'none' }}>
          <Send size={15} /> ส่ง LINE
        </button>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-[11.5px] tabular" style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
            <thead>
              <tr style={{ background: 'var(--chip)' }}>
                <th className="sticky left-0 z-10 px-3 py-2 text-left font-bold whitespace-nowrap"
                  style={{ background: 'var(--chip)', color: 'var(--muted)', minWidth: 78, borderBottom: '1px solid var(--line)' }}>YARD</th>
                {days.map((d) => (
                  <th key={d} className="px-1.5 py-2 text-center font-bold" title={isSunday(d) ? 'อาทิตย์' : undefined}
                    style={{ minWidth: 30, color: isSunday(d) ? '#dc2626' : 'var(--muted)', background: colBg(d), borderBottom: '1px solid var(--line)', ...(d === todayDay ? { boxShadow: 'inset 0 0 0 2px #10b981' } : {}) }}>
                    {d}
                  </th>
                ))}
                <th className="px-3 py-2 text-center font-bold" style={{ minWidth: 56, color: 'var(--brand)', background: 'var(--brand-soft, #eef4ff)', borderBottom: '1px solid var(--line)' }}>SUM</th>
              </tr>
            </thead>
            <tbody>
              {plan.siteRows.map((r) => (
                <tr key={r.id} className="hover:bg-chip">
                  <td className="sticky left-0 z-10 px-3 py-2 font-bold whitespace-nowrap"
                    style={{ background: 'var(--panel, #fff)', color: 'var(--text)', borderBottom: '1px solid var(--line)' }}>{r.short}</td>
                  {days.map((d) => (
                    <td key={d} className="px-1.5 py-2 text-center" style={{ color: numColor(r.cells[d], d), background: colBg(d), borderBottom: '1px solid var(--line)', fontWeight: r.cells[d] ? 600 : 400 }}>
                      {r.cells[d]}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center font-black" style={{ color: 'var(--brand)', background: 'var(--brand-soft, #eef4ff)', borderBottom: '1px solid var(--line)' }}>{r.sum.toLocaleString()}</td>
                </tr>
              ))}
              {/* totals */}
              <tr style={{ background: 'var(--chip)' }}>
                <td className="sticky left-0 z-10 px-3 py-2.5 font-black whitespace-nowrap" style={{ background: 'var(--chip)', color: 'var(--text)' }}>Total</td>
                {days.map((d) => (
                  <td key={d} className={cx('px-1.5 py-2.5 text-center font-bold')} style={{ color: numColor(plan.colTotals[d], d), background: colBg(d), ...(d === todayDay ? { boxShadow: 'inset 0 0 0 2px #10b981' } : {}) }}>
                    {plan.colTotals[d]}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-center font-black text-white" style={{ background: 'var(--brand)' }}>{plan.grand.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {plan.grand === 0 && (
        <div className="text-center text-[13px] mt-4" style={{ color: 'var(--faint)' }}>
          ไม่มีรถที่ถึงกำหนด PM ในเดือนนี้ — ลองเลือกเดือนอื่น หรือตรวจสอบวันที่ Gate In / PM ในข้อมูล
        </div>
      )}
    </div>
  )
}
