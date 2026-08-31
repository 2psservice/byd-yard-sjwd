import { useMemo, useState } from 'react'
import { Download, ClipboardList } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { rowInSite } from '../lib/siteScope'
import { PageHead, cx } from '../components/ui'
import { DailyStockReport } from '../components/DailyStockReport'
import { DayPicker, dayKeyOf } from './Grouping'
import {
  REPORT_MENUS, TIME_PERIODS, buildListRange, buildDefectsRange, buildTimeMatrixRange,
  exportOpsReport, daysInRange, dayKeyOfTs, type ReportCtx,
} from '../lib/opsReport'

export function Report() {
  const lang = useYard((s) => s.lang)

  return (
    <div>
      <PageHead
        title={lang === 'th' ? 'รายงาน (Report)' : 'Report'}
        sub={lang === 'th'
          ? 'รายงานประจำวัน — เลือกดูวันเดียวหรือเป็นช่วงวันที่ก็ได้'
          : 'Daily stock report — one day or a date range'}
      />

      {/* ── operation report (ส่งทุกเบรค) — 14 เมนู realtime จากหน้างาน ──
          เมนูแรกคือ Daily report stock (คอมโพเนนต์เดิม) · ไฟล์ Excel ออกจาก
          ปุ่มในแถบเมนูนั้น ซึ่งเคารพวันที่/ช่วงวันที่ที่เลือกไว้ */}
      <OpsReportSection />
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
  // "ช่วงวันที่": the FIRST day of the range. 'all' = no range, just `day`.
  const [from, setFrom] = useState<string | 'all'>('all')
  const [exporting, setExporting] = useState(false)

  const site = sites.find((s) => s.id === currentSite)
  // "NYB2" style short label for sheet names/titles
  const siteLabel = useMemo(() => {
    const n = (site?.name ?? '').toUpperCase()
    if (n.includes('NYB')) return 'NYB2'
    if (n.includes('RAYONG')) return 'Rayong'
    return site?.code || site?.name || 'Yard'
  }, [site])

  const theDay = day === 'all' ? dayKeyOf(new Date()) : day
  const range = useMemo(
    () => (from === 'all' || from === theDay ? undefined : daysInRange(from, theDay)),
    [from, theDay],
  )
  const ctx = useMemo<ReportCtx>(() => ({
    rows: currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows,
    units: currentSite ? units.filter((u) => !u.site || u.site === currentSite) : units,
    queues: queues.filter((q) => !currentSite || !q.site || q.site === currentSite),
    day: theDay,
    days: range,
    siteLabel,
  }), [allRows, units, queues, currentSite, sites, theDay, range, siteLabel])

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
  const listRows = useMemo(() => (active.kind === 'list' ? buildListRange(ctx, active.id) : []), [ctx, active])
  const defRows = useMemo(() => (active.kind === 'defect' ? buildDefectsRange(ctx, active.id as 'fcdefect' | 'pmdefect') : null), [ctx, active])
  const matrix = useMemo(() => (active.kind === 'time' ? buildTimeMatrixRange(ctx, active.id as 'fctime' | 'pmtime') : null), [ctx, active])

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
        {/* one day, or a stretch of days — the "from" picker is empty until the
            office wants a range, so the everyday case stays a single click */}
        <div className="flex items-center gap-2">
          <DayPicker days={dayCounts} value={from} onChange={setFrom}
            allText="ดูวันเดียว (ไม่กำหนดช่วง)"
            hint="ตั้งวันเริ่มต้นเพื่อดูเป็นช่วงวันที่ — ว่างไว้คือดูวันเดียว" />
          <span className="text-[12px] shrink-0" style={{ color: range ? 'var(--muted)' : 'var(--faint)' }}>ถึง</span>
          <DayPicker days={dayCounts} value={day} onChange={setDay} />
          {range && (
            <span className="badge shrink-0" style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--brand)' }}>
              {range.length} วัน
            </span>
          )}
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
