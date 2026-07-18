import { useMemo, useState } from 'react'
import type { Block, Unit } from '../types'
import { modelById } from '../lib/sampleData'
import { pct, pos, unitInBlock } from '../lib/format'
import { StatusBadge, cx } from './ui'
import { useYard } from '../store/useYard'

/** Slot grid for one block — colored by model, click to inspect / pick. */
export function BlockGrid({
  block, units, pickMode = false, onPick, highlight,
}: {
  block: Block
  units: Unit[]
  pickMode?: boolean
  onPick?: (slot: { block: string; row: number; slot: number }) => void
  highlight?: string // vin
}) {
  const lang = useYard((s) => s.lang)
  const [sel, setSel] = useState<Unit | null>(null)

  const grid = useMemo(() => {
    const map = new Map<string, Unit>()
    for (const u of units) {
      if (unitInBlock(u, block) && u.row && u.slot && (u.status === 'PARKED' || u.status === 'ASSIGNED' || u.status === 'LOADED')) {
        map.set(`${u.row}-${u.slot}`, u)
      }
    }
    return map
  }, [units, block.id, block.name])

  const filled = grid.size
  const cap = block.rows * block.cols
  const models = useMemo(() => {
    const s = new Set<string>()
    grid.forEach((u) => s.add(u.model))
    return [...s]
  }, [grid])

  const cell = 15

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center font-bold display"
            style={{ background: 'var(--brand)', color: '#fff' }}>{block.id}</div>
          <div>
            <div className="font-semibold display">{block.name}</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
              {block.rows} {lang === 'th' ? 'แถว' : 'rows'} × {block.cols} {lang === 'th' ? 'ช่อง' : 'slots'} · zone {block.zone}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[20px] font-bold display tabular" style={{ color: 'var(--brand)' }}>{pct(filled, cap)}%</div>
          <div className="text-[12px] tabular" style={{ color: 'var(--muted)' }}>{filled} / {cap}</div>
        </div>
      </div>

      <div className="overflow-auto pb-2" style={{ maxWidth: '100%' }}>
        <div className="inline-block">
          {/* column header */}
          <div className="flex" style={{ paddingLeft: 26 }}>
            {Array.from({ length: block.cols }, (_, c) => (
              <div key={c} className="text-center mono" style={{ width: cell, fontSize: 8, color: 'var(--faint)' }}>{c + 1}</div>
            ))}
          </div>
          {/* rows */}
          {Array.from({ length: block.rows }, (_, r) => (
            <div key={r} className="flex items-center" style={{ height: cell, marginTop: 2 }}>
              <div className="mono text-right pr-1.5" style={{ width: 24, fontSize: 9, color: 'var(--faint)' }}>{r + 1}</div>
              <div className="flex" style={{ gap: 1 }}>
                {Array.from({ length: block.cols }, (_, c) => {
                  const u = grid.get(`${r + 1}-${c + 1}`)
                  const m = u ? modelById(u.model) : null
                  const isHi = u && highlight && u.vin === highlight
                  return (
                    <div
                      key={c}
                      className={cx('slot', u ? 'slot-occupied' : 'slot-empty')}
                      style={{
                        width: cell, height: cell,
                        background: u ? m?.color ?? '#888' : undefined,
                        opacity: u && u.status === 'ASSIGNED' ? 0.55 : 1,
                        boxShadow: isHi ? '0 0 0 2px #fff, 0 0 12px 2px var(--brand)' : undefined,
                        cursor: u ? 'pointer' : pickMode ? 'cell' : 'default',
                      }}
                      title={u ? `${u.vin} · ${u.modelName}` : pickMode ? `${block.id}-${r + 1}-${c + 1}` : ''}
                      onClick={() => {
                        if (u) setSel(u)
                        else if (pickMode && onPick) onPick({ block: block.id, row: r + 1, slot: c + 1 })
                      }}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* legend */}
      {models.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 pt-3 border-t hairline">
          {models.map((mid) => {
            const m = modelById(mid)
            return (
              <span key={mid} className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--muted)' }}>
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: m?.color }} /> {m?.name ?? mid}
              </span>
            )
          })}
        </div>
      )}

      {/* selected slot detail */}
      {sel && (
        <div className="mt-3 panel p-3 flex items-center justify-between pop">
          <div>
            <div className="vin text-[13px] font-semibold">{sel.vin}</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{sel.modelName} · {sel.color} · {pos(sel)}</div>
          </div>
          <StatusBadge status={sel.status} />
        </div>
      )}
    </div>
  )
}
