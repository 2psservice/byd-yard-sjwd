/**
 * YardSummary — compact collapsible pivots on the Dashboard:
 * rows = vehicle Model, columns = a tracking-sheet column (Final Status, and
 * Vin Of Status), counting cars physically in the active yard. Every count —
 * including the รวม row and column — opens the Unit List pre-filtered to that
 * exact slice, so the number on screen always matches the list you land on.
 */
import { useMemo, useState } from 'react'
import { ChevronDown, Table2, ShieldAlert } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { rowInSite } from '../lib/siteScope'
import { deriveCarStatus, IN_YARD_STATUSES, vinOfStatusColor } from '../lib/carStatus'
import type { TrackRow } from '../lib/excelTracking'

const EMPTY_COL = '(ว่าง)'

/** One Model × <column> pivot. `presetKey` is the Unit-List preset prefix
 *  ('sum' = Final Status, 'vos' = Vin Of Status). */
function Pivot({ rows, cellKey, presetKey, title, caption, icon, colorFor }: {
  rows: TrackRow[]
  cellKey: string
  presetKey: 'sum' | 'vos'
  title: string
  caption: string
  icon: React.ReactNode
  colorFor?: (v: string) => { color: string; bg: string } | null
}) {
  const setView = useYard((s) => s.setView)
  const setUnitPreset = useYard((s) => s.setUnitPreset)
  const [open, setOpen] = useState(true)

  // jump into the Unit List filtered to this cell (order matters: setView resets the preset)
  const openInUnits = (model: string, value: string) => {
    setView('units')
    setUnitPreset(`${presetKey}:${model}|${value === EMPTY_COL ? '' : value}`)
  }

  const data = useMemo(() => {
    const matrix = new Map<string, Map<string, number>>() // model → value → count
    const colTotals = new Map<string, number>()
    for (const r of rows) {
      if (!IN_YARD_STATUSES.has(deriveCarStatus(r.cells))) continue
      const model = (r.cells['Model'] || r.cells['Model name'] || '—').trim() || '—'
      const value = (r.cells[cellKey] || '').trim() || EMPTY_COL
      if (!matrix.has(model)) matrix.set(model, new Map())
      const byValue = matrix.get(model)!
      byValue.set(value, (byValue.get(value) ?? 0) + 1)
      colTotals.set(value, (colTotals.get(value) ?? 0) + 1)
    }
    // busiest columns / models first; the blank bucket always last
    const cols = [...colTotals.entries()]
      .sort((a, b) => (a[0] === EMPTY_COL ? 1 : b[0] === EMPTY_COL ? -1 : b[1] - a[1]))
      .map(([k]) => k)
    const models = [...matrix.entries()]
      .map(([model, byValue]) => ({ model, byValue, total: [...byValue.values()].reduce((n, v) => n + v, 0) }))
      .sort((a, b) => b.total - a.total)
    return { cols, models, colTotals, grand: models.reduce((n, m) => n + m.total, 0) }
  }, [rows, cellKey])

  if (!data.grand) return null

  // shared look for every clickable count — totals included, so it's obvious
  // they drill down too (they were plain text before and read as static)
  const countBtn = 'tabular font-bold rounded-md px-2 py-0.5 transition hover:bg-[var(--brand-soft)] cursor-pointer'

  return (
    <div className="panel overflow-hidden mb-3">
      {/* header — click anywhere to collapse (keeps the plan roomy) */}
      <button className="w-full flex items-center gap-2 px-3.5 py-2 text-left" onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="font-semibold text-[12.5px]">{title}</span>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{caption} · ในลาน {data.grand.toLocaleString()} คัน</span>
        <ChevronDown size={14} className="ml-auto transition-transform" style={{ color: 'var(--muted)', transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div className="overflow-x-auto border-t hairline">
          <table className="w-full" style={{ fontSize: 11.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--app-bg)' }}>
                <th className="text-left px-3 py-1.5 font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>Model</th>
                {data.cols.map((c) => {
                  const k = c === EMPTY_COL ? null : colorFor?.(c)
                  return (
                    <th key={c} className="text-center px-2 py-1.5 font-bold whitespace-nowrap"
                      style={{ color: k?.color ?? (c === EMPTY_COL ? 'var(--faint)' : 'var(--muted)') }}>{c}</th>
                  )
                })}
                <th className="text-center px-3 py-1.5 font-bold" style={{ color: 'var(--text)' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map(({ model, byValue, total }) => (
                <tr key={model} className="border-t hairline">
                  <td className="px-3 py-1 font-semibold whitespace-nowrap">{model}</td>
                  {data.cols.map((c) => {
                    const n = byValue.get(c) ?? 0
                    return (
                      <td key={c} className="text-center px-2 py-1">
                        {n > 0 ? (
                          <button className={countBtn} style={{ color: 'var(--brand)' }}
                            title={`เปิด Unit List — ${model} · ${c}`}
                            onClick={() => openInUnits(model, c)}>
                            {n.toLocaleString()}
                          </button>
                        ) : (
                          <span style={{ color: 'var(--faint)' }}>—</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="text-center px-3 py-1">
                    <button className={countBtn} style={{ color: 'var(--brand)' }}
                      title={`เปิด Unit List — ${model} · ทุกค่า`}
                      onClick={() => openInUnits(model, '*')}>
                      {total.toLocaleString()}
                    </button>
                  </td>
                </tr>
              ))}
              {/* column totals — click to open the Unit List for that value (all models) */}
              <tr className="border-t" style={{ borderColor: 'var(--line-strong)', background: 'var(--app-bg)' }}>
                <td className="px-3 py-1 font-bold">รวม</td>
                {data.cols.map((c) => (
                  <td key={c} className="text-center px-2 py-1">
                    <button className={countBtn} style={{ color: 'var(--brand)' }}
                      title={`เปิด Unit List — ทุกรุ่น · ${c}`}
                      onClick={() => openInUnits('*', c)}>
                      {(data.colTotals.get(c) ?? 0).toLocaleString()}
                    </button>
                  </td>
                ))}
                <td className="text-center px-3 py-1">
                  <button className={countBtn} style={{ color: 'var(--brand)' }}
                    title="เปิด Unit List — In Yard ทั้งหมด"
                    onClick={() => openInUnits('*', '*')}>
                    {data.grand.toLocaleString()}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function YardSummary() {
  const allRows = useTrackingRows()
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const rows = useMemo(() => allRows.filter((r) => rowInSite(r, currentSite, sites)), [allRows, currentSite, sites])

  return (
    <>
      <Pivot
        rows={rows}
        cellKey="Final Status"
        presetKey="sum"
        title="Summary"
        caption="Model × Final Status"
        icon={<Table2 size={14} style={{ color: 'var(--brand)' }} />}
      />
      <Pivot
        rows={rows}
        cellKey="Vin Of Status"
        presetKey="vos"
        title="Vin Of Status"
        caption="Model × Vin Of Status"
        icon={<ShieldAlert size={14} style={{ color: 'var(--st-damage)' }} />}
        colorFor={vinOfStatusColor}
      />
    </>
  )
}
