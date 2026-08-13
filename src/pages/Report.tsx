import { useEffect, useMemo, useState } from 'react'
import { Download, ClipboardList } from 'lucide-react'
import * as db from '../lib/db'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { rowInSite } from '../lib/siteScope'
import { PageHead, cx } from '../components/ui'
import { DailyStockReport } from '../components/DailyStockReport'
import { dayKeyOf } from './Grouping'
import {
  REPORT_MENUS, TIME_PERIODS, buildList, buildDefects, buildTimeMatrix, exportOpsReport,
  rangeLabel, type ReportCtx,
} from '../lib/opsReport'

export function Report() {
  const lang = useYard((s) => s.lang)

  return (
    <div>
      <PageHead
        title={lang === 'th' ? 'รายงาน (Report)' : 'Report'}
        sub={lang === 'th'
          ? 'รายงาน Operation ส่งทุกเบรค · ดูย้อนหลังได้ทุกวัน · Export Excel ได้ทุกเมนู'
          : 'Operation report per break, any past date, Excel export for every menu'}
      />

      {/* ── operation report (ส่งทุกเบรค) — 14 เมนู realtime จากหน้างาน ──
          เมนูแรกคือ Daily report stock (คอมโพเนนต์เดิม) · ปุ่มมุมขวาบนยังออก
          ไฟล์ master (Tracking Status + Defect sheets) ได้เหมือนเดิม */}
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
  // date RANGE (inclusive) — one day by default; pick from–to for a period
  const [dayFrom, setDayFrom] = useState(dayKeyOf(new Date()))
  const [dayTo, setDayTo] = useState(dayKeyOf(new Date()))
  const [exporting, setExporting] = useState(false)

  // admin remarks under the time matrices — shared across devices via
  // app_config (`ops_report_remarks_<site>`), cached locally so the box is
  // filled instantly on boot and survives an offline refresh
  const [remarks, setRemarks] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!currentSite) return
    let dead = false
    try {
      const cached = localStorage.getItem(`sjwd.opsRemarks.${currentSite}`)
      setRemarks(cached ? JSON.parse(cached) : {})
    } catch { setRemarks({}) }
    db.fetchAppConfig<Record<string, string>>(`ops_report_remarks_${currentSite}`)
      .then((v) => {
        if (dead || !v) return
        setRemarks(v)
        try { localStorage.setItem(`sjwd.opsRemarks.${currentSite}`, JSON.stringify(v)) } catch { /* full/blocked */ }
      })
      .catch(() => {})
    return () => { dead = true }
  }, [currentSite])

  const site = sites.find((s) => s.id === currentSite)
  // "NYB2" style short label for sheet names/titles
  const siteLabel = useMemo(() => {
    const n = (site?.name ?? '').toUpperCase()
    if (n.includes('NYB')) return 'NYB2'
    if (n.includes('RAYONG')) return 'Rayong'
    return site?.code || site?.name || 'Yard'
  }, [site])

  const ctx = useMemo<ReportCtx>(() => {
    // tolerate a reversed pick (from > to) — swap instead of showing nothing
    const [f, t] = dayFrom <= dayTo ? [dayFrom, dayTo] : [dayTo, dayFrom]
    return {
      rows: currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows,
      units: currentSite ? units.filter((u) => !u.site || u.site === currentSite) : units,
      queues: queues.filter((q) => !currentSite || !q.site || q.site === currentSite),
      dayFrom: f, dayTo: t,
      siteLabel,
      remarks,
    }
  }, [allRows, units, queues, currentSite, sites, dayFrom, dayTo, siteLabel, remarks])

  const active = REPORT_MENUS.find((m) => m.id === menu) ?? REPORT_MENUS[0]
  const listRows = useMemo(() => (active.kind === 'list' ? buildList(ctx, active.id) : []), [ctx, active])
  const defRows = useMemo(() => (active.kind === 'defect' ? buildDefects(ctx, active.id as 'fcdefect' | 'pmdefect') : null), [ctx, active])
  const matrix = useMemo(() => (active.kind === 'time' ? buildTimeMatrix(ctx, active.id as 'fctime' | 'pmtime') : null), [ctx, active])

  const doExport = async () => {
    setExporting(true)
    try {
      await exportOpsReport(ctx)
      toast('ok', `ออกไฟล์ Report_operation (${rangeLabel(ctx)}) แล้ว`)
    } catch (e) { console.error('[opsReport] export', e); toast('err', 'ออกไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง') }
    finally { setExporting(false) }
  }

  const remarkKey = `${active.id}|${ctx.dayFrom}`
  const saveRemark = (text: string) => {
    if (!currentSite) return
    const next = { ...remarks }
    if (text.trim()) next[remarkKey] = text.trim(); else delete next[remarkKey]
    setRemarks(next)
    try { localStorage.setItem(`sjwd.opsRemarks.${currentSite}`, JSON.stringify(next)) } catch { /* full/blocked */ }
    db.saveAppConfig(`ops_report_remarks_${currentSite}`, next)
      .then(() => toast('ok', 'บันทึก Remark แล้ว'))
      .catch(() => toast('err', 'บันทึก Remark ขึ้นคลาวด์ไม่สำเร็จ — เครื่องนี้ยังเห็นค่าใหม่'))
  }

  const th = 'text-left px-3 py-2 text-[11.5px] font-bold whitespace-nowrap'
  const td = 'px-3 py-1.5 whitespace-nowrap'

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-[12px] font-bold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
          <ClipboardList size={14} /> รายงาน Operation ({siteLabel}) · ส่งทุกเบรค — นับ realtime จากที่หน้างานบันทึก
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* จาก–ถึง: เลือกวันเดียว (ค่าเริ่มต้น = วันนี้) หรือทั้งช่วง */}
          <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted)' }}>
            <span>จาก</span>
            <input type="date" className="input py-1 px-2 text-[12.5px] tabular" value={dayFrom}
              onChange={(e) => { if (e.target.value) setDayFrom(e.target.value) }} />
            <span>ถึง</span>
            <input type="date" className="input py-1 px-2 text-[12.5px] tabular" value={dayTo}
              onChange={(e) => { if (e.target.value) setDayTo(e.target.value) }} />
            <button className="btn px-2 py-1 text-[12px]"
              onClick={() => { const t = dayKeyOf(new Date()); setDayFrom(t); setDayTo(t) }}>
              วันนี้
            </button>
          </div>
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
            <span className="font-medium" style={{ color: 'var(--faint)' }}>· {rangeLabel(ctx)}</span>
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
            <span className="font-medium" style={{ color: 'var(--faint)' }}>· {rangeLabel(ctx)}</span>
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
            {matrix.title} · {rangeLabel(ctx)}
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
          {/* admin remark — saved on blur, shared to every device + the Excel sheet */}
          <div className="px-4 py-3 border-t hairline">
            <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>
              Remark (แอดมิน) · {rangeLabel(ctx)}
            </div>
            <textarea key={remarkKey} rows={2}
              className="input w-full text-[13px] py-2"
              style={{ resize: 'vertical', minHeight: 44 }}
              placeholder="พิมพ์หมายเหตุของรายงานนี้ — บันทึกอัตโนมัติเมื่อคลิกออกจากช่อง และแนบลงไฟล์ Excel ให้ด้วย"
              defaultValue={remarks[remarkKey] ?? ''}
              onBlur={(e) => { if ((remarks[remarkKey] ?? '') !== e.target.value.trim()) saveRemark(e.target.value) }} />
          </div>
        </div>
      )}
    </div>
  )
}
