/**
 * One measured value on a station sheet — the field to enter today's reading,
 * plus EVERY reading recorded before it.
 *
 * The stations wanted the trend, not just the last number: how often a car has
 * been measured, and whether the value is drifting. Past readings come from the
 * row's own edit history (`to` value + when), so nothing extra has to be stored.
 */
import { useMemo, useState } from 'react'
import { History } from 'lucide-react'
import type { TrackRow } from '../lib/excelTracking'

const fmtDay = (t: number) => {
  const d = new Date(t)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Every value this cell has held, oldest → newest. */
export function readingsOf(row: TrackRow | null, cellKey: string, label?: string): { value: string; at?: number }[] {
  if (!row) return []
  const names = new Set([cellKey, label].filter(Boolean) as string[])
  const out: { value: string; at?: number }[] = []
  for (const e of row.history ?? []) {
    if (!names.has(e.field)) continue
    const v = (e.to ?? '').trim()
    if (v) out.push({ value: v, at: e.at })
  }
  const current = (row.cells[cellKey] ?? '').trim()
  // an imported value has no history entry — show it as the (undated) latest
  if (current && out[out.length - 1]?.value !== current) out.push({ value: current })
  return out
}

export function MeasurementField({ label, value, onChange, row, cellKey, columnLabel }: {
  label: string
  value: string
  onChange: (v: string) => void
  row: TrackRow | null
  cellKey: string
  columnLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const readings = useMemo(() => readingsOf(row, cellKey, columnLabel), [row, cellKey, columnLabel])
  const past = readings.slice(0, -1)          // everything before the current value
  const latest = readings[readings.length - 1]

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] shrink-0" style={{ color: 'var(--muted)', width: 118 }}>{label}</span>
        <input value={value} onChange={e => onChange(e.target.value)} inputMode="decimal" placeholder="กรอกค่า…"
          className="flex-1 min-w-0 rounded-lg px-2.5 py-2 text-[13px] outline-none"
          style={{ background: 'var(--chip)', border: '1px solid var(--line)' }} />
        {/* latest reading — tap to unfold the ones before it */}
        <button onClick={() => past.length && setOpen(v => !v)} disabled={!past.length}
          className="text-[11.5px] tabular text-right shrink-0 flex items-center justify-end gap-1"
          style={{ color: latest ? 'var(--muted)' : 'var(--faint)', width: 74, cursor: past.length ? 'pointer' : 'default' }}>
          {past.length > 0 && <History size={11} style={{ color: 'var(--faint)' }} />}
          {latest?.value ?? '—'}
        </button>
      </div>

      {/* every earlier reading, newest first */}
      {open && past.length > 0 && (
        <div className="mt-1.5 ml-[126px] flex flex-wrap gap-1.5">
          {[...past].reverse().map((r, i) => (
            <span key={i} className="badge text-[10.5px] tabular"
              style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
              {r.value}{r.at ? ` · ${fmtDay(r.at)}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
