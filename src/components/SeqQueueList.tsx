import { useMemo, useState } from 'react'
import { ListChecks, ChevronLeft, Clock } from 'lucide-react'
import { seqStageOf } from '../store/useOps'
import { yardLocCode, byYardLocation } from '../lib/groupingImport'
import type { WorkQueue, QueueItem } from '../store/useOps'
import type { Unit } from '../types'
import type { TrackRow } from '../lib/excelTracking'


/** Per-car stage chip in the delivery-sequence list. */
const SEQ_STAGE_META: Record<string, { label: string; c: string; bg: string }> = {
  queued:  { label: 'รอย้าย',   c: '#64748b', bg: 'rgba(100,116,139,0.12)' },
  wash:    { label: 'Wash',     c: '#0ea5e9', bg: 'rgba(14,165,233,0.12)' },
  lane:    { label: 'preload',  c: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  gateout: { label: 'gate out', c: '#64748b', bg: 'rgba(100,116,139,0.16)' },
}

/**
 * Browsable list of the active Grouping-to-Dealer delivery runs. Each queue is a
 * card showing its remaining cars; expanding it lists every VIN with its yard
 * location, loading lane and stage. Shared by the Ops Scan (gate-out) station and
 * the Gate In / Gate Out page so both render the identical card.
 *
 * `queuedLabel` overrides the chip text for cars still at the 'queued' stage —
 * the gate-out overview reads them as "รอจ่าย" (pending dispatch) rather than the
 * driver-facing "รอย้าย" (pending move to wash).
 */
export function SeqQueuePicker({ queues, units, trackingRows, locPrefix, queuedLabel }: {
  queues: WorkQueue[]; units: Unit[]; trackingRows: TrackRow[]; locPrefix: string; queuedLabel?: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  // a car counts as gated-out by its LIVE Car Status — so cars gated out any way
  // (sequence flow, plain gate-out, import) show "gate out" and count toward
  // progress, even if the queue item's own flag was never set.
  const goneVins = useMemo(() => {
    const s = new Set<string>()
    for (const r of trackingRows) if (/gate-?out/i.test(r.cells['Car Status'] || '')) s.add(r.vin)
    return s
  }, [trackingRows])
  const isGone = (i: QueueItem) => i.gatedOut === true || goneVins.has(i.vin)
  const openSeq = openId ? queues.find((q) => q.id === openId) ?? null : null
  const seqCars = useMemo(() => {
    if (!openSeq) return [] as { vin: string; model: string; color: string; grouping: string; location: string; lane: string; stage: string; done: boolean; ts?: number; tsLabel?: string; by?: string }[]
    return openSeq.items.map((i) => {
      const u = units.find((x) => x.vin === i.vin)
      const row = trackingRows.find((r) => r.vin === i.vin)
      const gone = isGone(i)
      // most-recent stage timestamp for the history line (gate-out → preload → wash)
      const step = gone || i.gatedOut ? { ts: i.doneAt, label: 'gate out', by: i.doneBy }
        : i.atLaneAt ? { ts: i.atLaneAt, label: 'preload', by: i.returnedBy }
        : i.atWashAt ? { ts: i.atWashAt, label: 'wash', by: i.deliveredBy }
        : { ts: undefined, label: '', by: undefined }
      return {
        vin: i.vin,
        model: row?.cells['Model'] ?? row?.cells['Model name'] ?? u?.modelName ?? '—',
        color: row?.cells['Color'] ?? u?.color ?? '—',
        grouping: row?.cells['Grouping  Number'] ?? '—',
        location: yardLocCode(u, locPrefix) || '—',
        lane: i.laneLoad ?? '—',
        stage: gone ? 'gateout' : seqStageOf(i),
        done: gone || i.done,
        ts: step.ts,
        tsLabel: step.label,
        by: step.by,
      }
    }).sort((a, b) => byYardLocation(a.location, b.location))
  }, [openSeq, units, trackingRows, locPrefix, goneVins]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!queues.length) return null
  return (
    <div className="space-y-2.5 fade-up">
      {queues.map((q) => {
        const total = q.items.length
        const done = q.items.reduce((n, i) => n + (isGone(i) || i.done ? 1 : 0), 0)
        const isOpen = openId === q.id
        return (
          <div key={q.id} className="panel overflow-hidden">
            <button className="w-full px-4 py-3 flex items-center gap-3 text-left" onClick={() => setOpenId(isOpen ? null : q.id)}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>
                <ListChecks size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-[12.5px] clip">{q.name}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  <b style={{ color: 'var(--text)' }}>{done}/{total}</b> คัน · เหลือ <b style={{ color: '#d97706' }}>{total - done}</b>
                </div>
              </div>
              <ChevronLeft size={16} style={{ color: 'var(--muted)', transform: isOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
            </button>
            {isOpen && (
              <div className="border-t hairline divide-y" style={{ borderColor: 'var(--line)' }}>
                {seqCars.map((c) => {
                  const meta = SEQ_STAGE_META[c.stage] ?? SEQ_STAGE_META.queued
                  const label = c.stage === 'queued' && queuedLabel ? queuedLabel : meta.label
                  return (
                    <div key={c.vin} className="px-4 py-2.5 flex items-center gap-3" style={c.done ? { opacity: 0.5 } : undefined}>
                      <div className="min-w-0 flex-1">
                        <div className="vin text-[12.5px] font-bold clip">{c.vin}</div>
                        <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: 'var(--muted)' }}>
                          <span>{c.model}</span><span>· {c.color}</span><span>· {c.grouping}</span>
                        </div>
                        {c.ts && (
                          <div className="text-[10.5px] mt-0.5 flex items-center gap-1" style={{ color: 'var(--faint)' }}>
                            <Clock size={10} />
                            <span>{c.tsLabel} {new Date(c.ts).toLocaleString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                            {c.by && <span>· {c.by}</span>}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="tabular text-[12px] font-bold">{c.location}</div>
                        <div className="flex items-center gap-1 justify-end mt-0.5">
                          <span className="badge" style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)', fontSize: 10 }}>{c.lane}</span>
                          <span className="badge" style={{ background: meta.bg, color: meta.c, fontSize: 10 }}>{label}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
