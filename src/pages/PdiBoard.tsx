/**
 * PDI board — the three tables the office keeps for PDI, built LIVE from what
 * the field records instead of being keyed into Excel by hand:
 *
 *  1. PDI          — one row per car the PDI station checked off that day
 *  2. PDI DEFECT   — every defect those cars carry, with its repair ladder
 *  3. ตาราง PDI     — the shift matrix (P1–P5) the operations workbook uses
 *
 * All three read the SAME source as the Operation report (opsReport.ts), so a
 * number here can never disagree with the number on that page — they are one
 * calculation, not two.
 */
import { useMemo, useState } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { rowInSite } from '../lib/siteScope'
import { PageHead, cx } from '../components/ui'
import { DayPicker, dayKeyOf } from './Grouping'
import { TIME_PERIODS, buildList, buildDefects, buildTimeMatrix, dayKeyOfTs, type ReportCtx } from '../lib/opsReport'

const th = 'px-3 py-2 text-left font-semibold whitespace-nowrap'
const td = 'px-3 py-1.5 whitespace-nowrap'

type Tab = 'list' | 'defect' | 'time'
const TABS: { id: Tab; label: string }[] = [
  { id: 'list', label: 'PDI' },
  { id: 'defect', label: 'PDI DEFECT' },
  { id: 'time', label: 'ตาราง PDI' },
]

export function PdiBoard() {
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const lang = useYard((s) => s.lang)
  const allRows = useTrackingRows()
  const units = useUnits()
  const queues = useOps((s) => s.queues)
  const [tab, setTab] = useState<Tab>('list')
  const [day, setDay] = useState<string | 'all'>(dayKeyOf(new Date()))

  const site = sites.find((s) => s.id === currentSite)
  const siteLabel = useMemo(() => {
    const n = (site?.name ?? '').toUpperCase()
    if (n.includes('NYB')) return 'NYB'
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

  // calendar marks: days the PDI station actually recorded something
  const dayCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const q of ctx.queues) for (const i of q.items) {
      const t = i.checkedAt ?? i.doneAt
      if (t) m.set(dayKeyOfTs(t), (m.get(dayKeyOfTs(t)) ?? 0) + 1)
    }
    return m
  }, [ctx.queues])

  const listRows = useMemo(() => (tab === 'list' ? buildList(ctx, 'pdi') : []), [ctx, tab])
  const defRows = useMemo(() => (tab === 'defect' ? buildDefects(ctx, 'pdidefect') : []), [ctx, tab])
  const matrix = useMemo(() => (tab === 'time' ? buildTimeMatrix(ctx, 'pditime') : null), [ctx, tab])
  const dayLabel = ctx.day.split('-').reverse().join('/')

  return (
    <div>
      <PageHead
        title={<span className="flex items-center gap-2">
          <ClipboardCheck size={20} style={{ color: 'var(--brand)' }} /> PDI
        </span>}
        sub={lang === 'th'
          ? `ตาราง PDI ประจำวัน — ขึ้นเองจากที่หน้างานบันทึก ไม่ต้องคีย์ซ้ำ${site?.name ? ` — ${site.name}` : ''}`
          : `Daily PDI tables, built live from what the stations record${site?.name ? ` — ${site.name}` : ''}`}
        right={<DayPicker days={dayCounts} value={day} onChange={setDay} />}
      />

      <div className="flex flex-wrap gap-1.5 mb-3">
        {TABS.map((t, i) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cx('btn px-3 py-1.5 text-[12.5px]', tab === t.id && 'btn-primary')}>
            {i + 1}. {t.label}
          </button>
        ))}
      </div>

      {/* ── 1. PDI — one row per car checked off that day ── */}
      {tab === 'list' && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline flex items-center gap-2 text-[12.5px] font-bold" style={{ background: 'var(--chip)' }}>
            PDI · Total <span style={{ color: 'var(--brand)' }}>{listRows.length}</span>
            <span className="font-medium" style={{ color: 'var(--faint)' }}>· {dayLabel}</span>
          </div>
          <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b hairline" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                {['No.', 'Vin', 'Model Name', 'Model', 'Color', 'Date', 'LOT M-D-lot', 'Remark'].map((h) => <th key={h} className={th}>{h}</th>)}
              </tr></thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {listRows.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-8" style={{ color: 'var(--faint)' }}>— ยังไม่มีรถที่บันทึก PDI ในวันนี้ —</td></tr>
                )}
                {listRows.map((r) => (
                  <tr key={`${r.no}-${r.vin}`}>
                    <td className={td}>{r.no}</td>
                    <td className={cx(td, 'vin font-bold')}>{r.vin}</td>
                    <td className={td}>{r.modelName}</td>
                    <td className={td}>{r.model}</td>
                    <td className={td}>{r.color}</td>
                    <td className={cx(td, 'tabular')}>{r.date}</td>
                    <td className={cx(td, 'tabular')}>{r.lot}</td>
                    <td className={td} style={r.remark === 'NG' ? { color: '#dc2626', fontWeight: 700 } : undefined}>{r.remark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 2. PDI DEFECT — the full office column set ── */}
      {tab === 'defect' && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline flex items-center gap-2 text-[12.5px] font-bold" style={{ background: 'var(--chip)' }}>
            PDI DEFECT · Total <span style={{ color: '#dc2626' }}>{defRows.length}</span>
            <span className="font-medium" style={{ color: 'var(--faint)' }}>· {dayLabel}</span>
          </div>
          <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b hairline" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                {['No', 'Vin', 'Model', 'From', 'Stock of Status', 'Category NG', 'Category (Repair)',
                  'Incharge', 'Date', 'Position', 'Defect', 'Status Repair', 'Repair Date']
                  .map((h) => <th key={h} className={th}>{h}</th>)}
              </tr></thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {defRows.length === 0 && (
                  <tr><td colSpan={13} className="text-center py-8" style={{ color: 'var(--faint)' }}>— ไม่มี Defect ของวันนี้ —</td></tr>
                )}
                {defRows.map((r) => (
                  <tr key={`${r.no}-${r.vin}-${r.position}-${r.defect}`}>
                    <td className={td}>{r.no}</td>
                    <td className={cx(td, 'vin font-bold')}>{r.vin}</td>
                    <td className={td}>{r.model}</td>
                    <td className={td}>{r.from}</td>
                    <td className={td}>{r.stockStatus}</td>
                    <td className={td} style={/heavy/i.test(r.categoryNG) ? { color: '#dc2626', fontWeight: 700 } : undefined}>{r.categoryNG}</td>
                    <td className={td}>{r.categoryRepair}</td>
                    <td className={td}>{r.incharge}</td>
                    <td className={cx(td, 'tabular')}>{r.date}</td>
                    <td className={td}>{r.position}</td>
                    <td className={td} style={{ color: '#dc2626' }}>{r.defect}</td>
                    <td className={td} style={/repaired/i.test(r.status) ? { color: '#16a34a', fontWeight: 600 } : undefined}>{r.status}</td>
                    <td className={cx(td, 'tabular')}>{r.repairDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 3. ตาราง PDI — the P1–P5 shift matrix ── */}
      {tab === 'time' && matrix && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline text-center text-[13px] font-bold" style={{ background: '#000', color: '#fff' }}>
            {matrix.title} · {dayLabel}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] text-center" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--chip)' }}>
                  <th className="px-3 py-2 border hairline font-bold" rowSpan={2}>Task</th>
                  <th className="px-3 py-2 border hairline font-bold" rowSpan={2}>Volume</th>
                  {['P1', 'P2', 'P3', 'P4', 'P5'].map((p) => (
                    <th key={p} className="px-3 py-1 border hairline font-bold" style={{ color: '#2563eb' }}>{p}</th>
                  ))}
                </tr>
                <tr style={{ background: 'var(--chip)' }}>
                  {TIME_PERIODS.map((t) => <th key={t} className="px-3 py-1 border hairline font-medium text-[11px]">{t}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="px-3 py-1.5 border hairline font-semibold">Plan</td>
                  <td className="px-3 py-1.5 border hairline tabular font-bold">{matrix.plan}</td>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <td key={i} className="px-3 py-1.5 border hairline tabular">
                      {matrix.plan ? Math.round((matrix.plan / 5) * 10) / 10 : ''}
                    </td>
                  ))}
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
                  {matrix.ok.map((n, i) => (
                    <td key={i} className="px-3 py-1.5 border hairline tabular">{matrix.total ? Math.round((n / matrix.total) * 100) : 0}%</td>
                  ))}
                </tr>
                <tr style={{ background: 'rgba(234,88,12,0.12)', color: '#dc2626' }}>
                  <td className="px-3 py-1.5 border hairline font-bold">NG</td>
                  <td className="px-3 py-1.5 border hairline tabular font-bold">{matrix.ngTotal}</td>
                  {matrix.ng.map((n, i) => <td key={i} className="px-3 py-1.5 border hairline tabular">{n}</td>)}
                </tr>
                <tr style={{ background: 'rgba(234,88,12,0.12)', color: '#dc2626' }}>
                  <td className="px-3 py-1.5 border hairline font-semibold">Ratio(NG)</td>
                  <td className="px-3 py-1.5 border hairline tabular">{matrix.total ? Math.round((matrix.ngTotal / matrix.total) * 100) : 0}%</td>
                  {matrix.ng.map((n, i) => (
                    <td key={i} className="px-3 py-1.5 border hairline tabular">{matrix.total ? Math.round((n / matrix.total) * 100) : 0}%</td>
                  ))}
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
