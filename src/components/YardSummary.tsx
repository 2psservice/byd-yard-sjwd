/**
 * YardSummary — compact collapsible pivot on the Dashboard:
 * rows = vehicle Model, columns = Final Status (from the tracking sheet),
 * counting cars physically in the active yard. Clicking a count opens the
 * Unit List pre-filtered to that Model × Final Status (like the KPI cards).
 */
import { useMemo, useState } from 'react'
import { ChevronDown, Table2 } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { rowInSite } from '../lib/siteScope'
import { deriveCarStatus, IN_YARD_STATUSES } from '../lib/carStatus'

const EMPTY_COL = '(ว่าง)'

export function YardSummary() {
  const rows = useTrackingRows()
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const setView = useYard((s) => s.setView)
  const setUnitPreset = useYard((s) => s.setUnitPreset)
  const [open, setOpen] = useState(true)

  // jump into the Unit List filtered to this cell (order matters: setView resets the preset)
  const openInUnits = (model: string, status: string) => {
    setView('units')
    setUnitPreset(`sum:${model}|${status === EMPTY_COL ? '' : status}`)
  }

  const data = useMemo(() => {
    const matrix = new Map<string, Map<string, string[]>>() // model → status → vins
    const colTotals = new Map<string, number>()
    for (const r of rows) {
      if (!rowInSite(r, currentSite, sites)) continue
      if (!IN_YARD_STATUSES.has(deriveCarStatus(r.cells))) continue
      const model = (r.cells['Model'] || r.cells['Model name'] || '—').trim() || '—'
      const status = (r.cells['Final Status'] || '').trim() || EMPTY_COL
      if (!matrix.has(model)) matrix.set(model, new Map())
      const byStatus = matrix.get(model)!
      if (!byStatus.has(status)) byStatus.set(status, [])
      byStatus.get(status)!.push(r.vin)
      colTotals.set(status, (colTotals.get(status) ?? 0) + 1)
    }
    // busiest columns / models first; the blank-status bucket always last
    const cols = [...colTotals.entries()]
      .sort((a, b) => (a[0] === EMPTY_COL ? 1 : b[0] === EMPTY_COL ? -1 : b[1] - a[1]))
      .map(([k]) => k)
    const models = [...matrix.entries()]
      .map(([model, byStatus]) => ({ model, byStatus, total: [...byStatus.values()].reduce((n, v) => n + v.length, 0) }))
      .sort((a, b) => b.total - a.total)
    return { cols, models, colTotals, grand: models.reduce((n, m) => n + m.total, 0) }
  }, [rows, sites, currentSite])

  if (!data.grand) return null

  return (
    <div className="panel overflow-hidden mb-3">
      {/* header — click anywhere to collapse (keeps the plan roomy) */}
      <button className="w-full flex items-center gap-2 px-3.5 py-2 text-left" onClick={() => setOpen((v) => !v)}>
        <Table2 size={14} style={{ color: 'var(--brand)' }} />
        <span className="font-semibold text-[12.5px]">Summary</span>
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>Model × Final Status · ในลาน {data.grand.toLocaleString()} คัน</span>
        <ChevronDown size={14} className="ml-auto transition-transform" style={{ color: 'var(--muted)', transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div className="overflow-x-auto border-t hairline">
          <table className="w-full" style={{ fontSize: 11.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--app-bg)' }}>
                <th className="text-left px-3 py-1.5 font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>Model</th>
                {data.cols.map((c) => (
                  <th key={c} className="text-center px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: c === EMPTY_COL ? 'var(--faint)' : 'var(--muted)' }}>{c}</th>
                ))}
                <th className="text-center px-3 py-1.5 font-bold" style={{ color: 'var(--text)' }}>รวม</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map(({ model, byStatus, total }) => (
                <tr key={model} className="border-t hairline">
                  <td className="px-3 py-1 font-semibold whitespace-nowrap">{model}</td>
                  {data.cols.map((c) => {
                    const vins = byStatus.get(c) ?? []
                    return (
                      <td key={c} className="text-center px-2 py-1">
                        {vins.length > 0 ? (
                          <button
                            className="tabular font-bold rounded-md px-2 py-0.5 transition hover:bg-[var(--brand-soft)]"
                            style={{ color: 'var(--brand)' }}
                            title={`เปิด Unit List — ${model} · ${c}`}
                            onClick={() => openInUnits(model, c)}
                          >
                            {vins.length.toLocaleString()}
                          </button>
                        ) : (
                          <span style={{ color: 'var(--faint)' }}>—</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="text-center px-3 py-1">
                    <button className="tabular font-bold rounded-md px-2 py-0.5 transition hover:bg-[var(--brand-soft)]"
                      title={`เปิด Unit List — ${model} · ทุกสถานะ`}
                      onClick={() => openInUnits(model, '*')}>
                      {total.toLocaleString()}
                    </button>
                  </td>
                </tr>
              ))}
              {/* column totals — click to open the Unit List for that Final Status (all models) */}
              <tr className="border-t" style={{ borderColor: 'var(--line-strong)', background: 'var(--app-bg)' }}>
                <td className="px-3 py-1 font-bold">รวม</td>
                {data.cols.map((c) => (
                  <td key={c} className="text-center px-2 py-1">
                    <button className="tabular font-bold rounded-md px-2 py-0.5 transition hover:bg-[var(--brand-soft)]"
                      title={`เปิด Unit List — ทุกรุ่น · ${c}`}
                      onClick={() => openInUnits('*', c)}>
                      {(data.colTotals.get(c) ?? 0).toLocaleString()}
                    </button>
                  </td>
                ))}
                <td className="text-center px-3 py-1">
                  <button className="tabular font-bold rounded-md px-2 py-0.5 transition hover:bg-[var(--brand-soft)]"
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
