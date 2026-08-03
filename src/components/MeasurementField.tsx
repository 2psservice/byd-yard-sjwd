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
      {open && past.length > 0 && <PastReadings past={past} />}
    </div>
  )
}

function PastReadings({ past }: { past: { value: string; at?: number }[] }) {
  return (
    <div className="mt-1.5 ml-[126px] flex flex-wrap gap-1.5">
      {[...past].reverse().map((r, i) => (
        <span key={i} className="badge text-[10.5px] tabular"
          style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
          {r.value}{r.at ? ` · ${fmtDay(r.at)}` : ''}
        </span>
      ))}
    </div>
  )
}

/** The four wheels, in the order the paper form lists them. */
export const TIRE_WHEELS = [
  { key: 'Tire Pressure FL', th: 'หน้าซ้าย', en: 'FL' },
  { key: 'Tire Pressure FR', th: 'หน้าขวา', en: 'FR' },
  { key: 'Tire Pressure RL', th: 'หลังซ้าย', en: 'RL' },
  { key: 'Tire Pressure RR', th: 'หลังขวา', en: 'RR' },
] as const

/** Combined value written to the plain "Tire Pressure" cell: "320 / 318 / 315 / 316". */
export const joinTirePressure = (byWheel: Record<string, string>) =>
  TIRE_WHEELS.map(w => (byWheel[w.key] ?? '').trim() || '—').join(' / ')

const TIRE_MIN = 310
const TIRE_MAX = 340

/**
 * Tire pressure — one reading per wheel. A single number could not say which
 * wheel was soft, which is the whole point of the check.
 */
export function TirePressureField({ label, values, onChange, row }: {
  label: string
  values: Record<string, string>
  onChange: (key: string, v: string) => void
  row: TrackRow | null
}) {
  const [open, setOpen] = useState(false)
  const readings = useMemo(() => readingsOf(row, 'Tire Pressure'), [row])
  const past = readings.slice(0, -1)
  const latest = readings[readings.length - 1]

  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="text-[11.5px] shrink-0 pt-2" style={{ color: 'var(--muted)', width: 118 }}>{label}</span>
        {/* the grid takes the history column too — four readings joined never
            fit in the narrow slot the single-value fields use */}
        <div className="flex-1 min-w-0 grid grid-cols-2 gap-1.5">
          {TIRE_WHEELS.map(w => {
            const v = (values[w.key] ?? '').trim()
            const n = Number(v)
            const off = v !== '' && (!Number.isFinite(n) || n < TIRE_MIN || n > TIRE_MAX)
            const last = (row?.cells[w.key] ?? '').trim()
            return (
              <div key={w.key} className="flex items-center gap-1.5">
                <span className="text-[10.5px] font-bold shrink-0 text-right" style={{ color: 'var(--faint)', width: 20 }}>{w.en}</span>
                <input value={values[w.key] ?? ''} onChange={e => onChange(w.key, e.target.value)}
                  inputMode="decimal" placeholder={last || w.th}
                  title={w.th}
                  className="w-full min-w-0 rounded-lg px-2 py-2 text-[13px] tabular outline-none"
                  style={{
                    background: 'var(--chip)',
                    border: `1px solid ${off ? '#dc2626' : 'var(--line)'}`,
                    color: off ? '#dc2626' : undefined,
                  }} />
              </div>
            )
          })}
        </div>
      </div>

      {/* the last full set, on its own line — tap to unfold earlier ones */}
      {latest && (
        <button onClick={() => past.length && setOpen(x => !x)} disabled={!past.length}
          className="mt-1.5 ml-[126px] text-[11px] tabular flex items-center gap-1"
          style={{ color: 'var(--muted)', cursor: past.length ? 'pointer' : 'default' }}>
          {past.length > 0 && <History size={11} style={{ color: 'var(--faint)' }} />}
          ล่าสุด {latest.value}
        </button>
      )}
      {open && past.length > 0 && <PastReadings past={past} />}
    </div>
  )
}
