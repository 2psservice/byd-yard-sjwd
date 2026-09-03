/**
 * The three daily tables a station keeps — PDI or PM, one implementation.
 *
 *  1. list    — one row per car the station checked off that day
 *  2. defect  — every defect those cars carry, with its repair ladder
 *  3. time    — the shift matrix (P1–P5) the operations workbook uses
 *
 * The PDI board and the PM board show the SAME three tables; only the station
 * they read differs. Kept here rather than copied into both pages so a fix to a
 * column, a rule or a total lands on both at once — which is the whole point of
 * these boards: a number here can never disagree with the Operation report,
 * because they are one calculation, not two.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { rowInSite } from '../lib/siteScope'
import { cx } from './ui'
import { dayKeyOf } from '../pages/Grouping'
import { buildList, buildDefects, buildTimeMatrix, dayKeyOfTs, type ReportCtx, type TimeMatrix } from '../lib/opsReport'
import * as db from '../lib/db'

export type StationKind = 'PDI' | 'PM'
export type StationTab = 'list' | 'defect' | 'time'

const th = 'px-3 py-2 text-left font-semibold whitespace-nowrap border-r hairline last:border-r-0'
const td = 'px-3 py-1.5 whitespace-nowrap border-r hairline last:border-r-0'

// one color band per model row on the shift card — cycles if the roster grows
const MODEL_COLORS = [
  { bg: '#1d4ed8', text: '#fff' }, { bg: '#059669', text: '#fff' }, { bg: '#d97706', text: '#fff' },
  { bg: '#dc2626', text: '#fff' }, { bg: '#7c3aed', text: '#fff' }, { bg: '#0891b2', text: '#fff' },
  { bg: '#be185d', text: '#fff' }, { bg: '#4d7c0f', text: '#fff' }, { bg: '#b45309', text: '#fff' },
  { bg: '#1e40af', text: '#fff' }, { bg: '#9d174d', text: '#fff' },
]
const mcell = 'px-2 py-1 border hairline'

/** The office's free-text note for one shift card — one row in `app_config`,
 *  keyed by station + site + day so it never bleeds into another day's card.
 *  Shared across devices (same store the yard capacity number uses); loads on
 *  mount and saves on blur, same pattern as the Report page's "Max Cap." box. */
function RemarkBox({ configId }: { configId: string }) {
  const toast = useYard((s) => s.toast)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setSaved(null)
    setText('')
    db.fetchAppConfig<{ text?: string }>(configId)
      .then((v) => { if (!alive) return; const t = v?.text ?? ''; setText(t); setSaved(t) })
      .catch((e) => { console.error('[stationRemark] load', e); if (alive) setSaved('') })
    return () => { alive = false }
  }, [configId])

  const commit = () => {
    if (saved === null || text === saved) return
    const value = text
    db.saveAppConfig(configId, { text: value, updatedAt: Date.now() })
      .then(() => setSaved(value))
      .catch(() => toast('err', 'บันทึก Remark ไม่สำเร็จ ลองใหม่อีกครั้ง'))
  }

  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      disabled={saved === null}
      placeholder={saved === null ? 'กำลังโหลด…' : 'พิมพ์ Remark ที่นี่…'}
      rows={2}
      className="w-full bg-transparent outline-none resize-none text-[11.5px]"
      style={{ fontFamily: 'inherit', color: 'var(--text)' }}
    />
  )
}

/** One P1–P5 shift card: per-model Actual/OK rows with a PDI/OK total box
 *  beside each, a shared Remark line + a free-text Remark box, a Total
 *  PDI/Total OK footer, and a GRAND TOTAL mini-table of this month's OK count
 *  per model. */
function TimeMatrixCard({ matrix, dayLabel, remarkId }: { matrix: TimeMatrix; dayLabel: string; remarkId: string }) {
  const dayModels = matrix.models.filter((m) => m.total > 0)
  const mtdModels = matrix.models.filter((m) => (matrix.mtdOkByModel.get(m.name) ?? 0) > 0)
  const mtdTotal = mtdModels.reduce((n, m) => n + (matrix.mtdOkByModel.get(m.name) ?? 0), 0)

  return (
    <div className="border hairline rounded-lg overflow-hidden" style={{ background: 'var(--panel, #fff)' }}>
      <div className="px-3 py-1.5 text-center text-[12.5px] font-bold" style={{ background: '#000', color: '#fff' }}>
        {matrix.title} · {dayLabel}
      </div>
      <table className="w-full text-[11.5px] text-center" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--chip)' }}>
            <th className={cx(mcell, 'font-bold')} colSpan={2}>Model</th>
            {['P1', 'P2', 'P3', 'P4', 'P5'].map((p) => (
              <th key={p} className={cx(mcell, 'font-bold')} style={{ color: '#2563eb' }}>{p}</th>
            ))}
            <th className={cx(mcell, 'font-bold')}>PDI</th>
            <th className={cx(mcell, 'font-bold')}>OK</th>
          </tr>
        </thead>
        <tbody>
          {dayModels.length === 0 && (
            <tr><td colSpan={9} className="py-6" style={{ color: 'var(--faint)' }}>— ยังไม่มีรถที่บันทึกวันนี้ —</td></tr>
          )}
          {dayModels.map((m, idx) => {
            const c = MODEL_COLORS[idx % MODEL_COLORS.length]
            return (
              <Fragment key={m.name}>
                <tr>
                  <td rowSpan={2} className={cx(mcell, 'text-left font-bold')} style={{ background: c.bg, color: c.text }}>{m.name}</td>
                  <td className={cx(mcell, 'text-left font-semibold')} style={{ color: 'var(--muted)' }}>Actual</td>
                  {m.p.map((n, i) => <td key={i} className={cx(mcell, 'tabular')}>{n || ''}</td>)}
                  <td rowSpan={2} className={cx(mcell, 'tabular font-bold')} style={{ background: 'rgba(37,99,235,0.08)' }}>{m.total}</td>
                  <td rowSpan={2} className={cx(mcell, 'tabular font-bold')} style={{ background: 'rgba(34,197,94,0.14)' }}>{m.okTotal}</td>
                </tr>
                <tr style={{ background: 'rgba(34,197,94,0.08)' }}>
                  <td className={cx(mcell, 'text-left font-semibold')} style={{ color: 'var(--muted)' }}>OK</td>
                  {m.okP.map((n, i) => <td key={i} className={cx(mcell, 'tabular')}>{n || ''}</td>)}
                </tr>
              </Fragment>
            )
          })}
          <tr>
            <td colSpan={9} className={cx(mcell, 'text-left')} style={{ background: 'var(--chip)' }}>
              <b>Remark</b> — P1 : Start 08:30 น. · P5 : Finish 00:00 น.
            </td>
          </tr>
          <tr>
            <td colSpan={9} className={cx(mcell, 'text-left')} style={{ padding: 0 }}>
              <div className="px-2 py-1">
                <RemarkBox configId={remarkId} />
              </div>
            </td>
          </tr>
          <tr style={{ background: 'rgba(250,204,21,0.35)' }}>
            <td colSpan={7} className={cx(mcell, 'text-left font-bold')}>Total PDI</td>
            <td colSpan={2} className={cx(mcell, 'tabular font-bold')}>{matrix.total}</td>
          </tr>
          <tr style={{ background: 'rgba(34,197,94,0.2)' }}>
            <td colSpan={7} className={cx(mcell, 'text-left font-bold')}>Total OK</td>
            <td colSpan={2} className={cx(mcell, 'tabular font-bold')}>{matrix.okTotal}</td>
          </tr>
        </tbody>
      </table>

      <div className="border-t hairline">
        <div className="px-2 py-1 text-center font-bold text-[11px]" style={{ background: '#000', color: '#fff' }}>
          GRAND TOTAL — สะสมเดือนนี้ (OK)
        </div>
        {mtdModels.length === 0 ? (
          <div className="px-3 py-3 text-center text-[11.5px]" style={{ color: 'var(--faint)' }}>— ยังไม่มีข้อมูลเดือนนี้ —</div>
        ) : (
          <table className="w-full text-[11px] text-center" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--chip)' }}>
                {mtdModels.map((m) => <th key={m.name} className={cx(mcell, 'font-semibold')}>{m.name}</th>)}
                <th className={cx(mcell, 'font-bold')}>รวม</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {mtdModels.map((m) => (
                  <td key={m.name} className={cx(mcell, 'tabular font-bold')} style={{ color: '#16a34a' }}>
                    {matrix.mtdOkByModel.get(m.name) ?? 0}
                  </td>
                ))}
                <td className={cx(mcell, 'tabular font-bold')}>{mtdTotal}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/** Site-scoped report context for the selected day + the calendar's day marks. */
export function useStationCtx(day: string | 'all') {
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const allRows = useTrackingRows()
  const units = useUnits()
  const queues = useOps((s) => s.queues)

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

  // calendar marks: days a station actually recorded something
  const dayCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const q of ctx.queues) for (const i of q.items) {
      const t = i.checkedAt ?? i.doneAt
      if (t) m.set(dayKeyOfTs(t), (m.get(dayKeyOfTs(t)) ?? 0) + 1)
    }
    return m
  }, [ctx.queues])

  return { ctx, dayCounts, site, siteLabel, dayLabel: ctx.day.split('-').reverse().join('/') }
}

export function StationTables({ ctx, tab, kind }: { ctx: ReportCtx; tab: StationTab; kind: StationKind }) {
  const id = kind === 'PDI' ? 'pdi' : 'pm'
  const currentSite = useYard((s) => s.currentSite)
  const listRows = useMemo(() => (tab === 'list' ? buildList(ctx, id) : []), [ctx, tab, id])
  const defRows = useMemo(() => (tab === 'defect' ? buildDefects(ctx, `${id}defect` as 'pdidefect' | 'pmdefect') : []), [ctx, tab, id])
  const matrix = useMemo(() => (tab === 'time' ? buildTimeMatrix(ctx, `${id}time` as 'pditime' | 'pmtime') : null), [ctx, tab, id])
  const dayLabel = ctx.day.split('-').reverse().join('/')
  // one saved note per station + site + day — never bleeds into another day's card
  const remarkId = `stationRemark:${id}:${currentSite ?? 'all'}:${ctx.day}`

  return (
    <>
      {/* ── 1. list — one row per car checked off that day ── */}
      {tab === 'list' && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline flex items-center gap-2 text-[12.5px] font-bold" style={{ background: 'var(--chip)' }}>
            {kind} · Total <span style={{ color: 'var(--brand)' }}>{listRows.length}</span>
            <span className="font-medium" style={{ color: 'var(--faint)' }}>· {dayLabel}</span>
          </div>
          <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b hairline" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                {['No.', 'Vin', 'Model Name', 'Model', 'Color', 'Date', 'LOT M-D-lot', 'Remark'].map((h) => <th key={h} className={th}>{h}</th>)}
              </tr></thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {listRows.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-8" style={{ color: 'var(--faint)' }}>— ยังไม่มีรถที่บันทึก {kind} ในวันนี้ —</td></tr>
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

      {/* ── 2. DEFECT — the full office column set ── */}
      {tab === 'defect' && (
        <div className="panel overflow-hidden">
          <div className="px-4 py-2 border-b hairline flex items-center gap-2 text-[12.5px] font-bold" style={{ background: 'var(--chip)' }}>
            {kind} DEFECT · Total <span style={{ color: '#dc2626' }}>{defRows.length}</span>
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

      {/* ── 3. the P1–P5 shift matrix — one card per model ── */}
      {tab === 'time' && matrix && (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <div className="p-3" style={{ background: 'var(--app-bg)' }}>
              <TimeMatrixCard matrix={matrix} dayLabel={dayLabel} remarkId={remarkId} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
