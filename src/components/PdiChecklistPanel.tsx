// PDI inspection checklist panel — the structured OK / NG / NG Heavy form for
// the PDI station. Each item defaults to OK; tapping NG / NG Heavy reveals a
// note + photo capture, and on Save every NG / NG Heavy item is written as a
// Defect (source 'pdi') so it flows into the damage / repair system.
import { useMemo, useRef, useState } from 'react'
import { ShieldCheck, CheckCircle2, Camera, X, AlertTriangle } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { compressImage } from '../lib/photo'
import { PDI_CHECKLIST, pdiItemId, type PdiResult } from '../lib/pdiChecklist'
import type { Unit } from '../types'
import type { TrackRow } from '../lib/excelTracking'
import type { WorkQueue, QueueItem } from '../store/useOps'

type ItemState = { result: PdiResult; note?: string; photos?: string[]; spec?: string }

export default function PdiChecklistPanel({ unit, row, activeProc, canRecord, onSaved, stationTitle, accent }: {
  unit: Unit
  row: TrackRow | null
  activeProc: { queue: WorkQueue; item: QueueItem } | null
  canRecord: boolean
  onSaved: (label: string, result: 'OK' | 'NG') => void
  stationTitle: string
  accent: string
}) {
  const { addDamage, setInspected, currentUser, toast } = useYard()
  const { updateCell } = useTracking()
  const { recordCheck } = useOps()

  const [mileage, setMileage] = useState('')
  const [battery, setBattery] = useState('')
  const [cat, setCat] = useState(0) // active category tab
  const [state, setState] = useState<Record<string, ItemState>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)
  const pickingId = useRef<string | null>(null)

  const stationName = activeProc?.queue.name ?? stationTitle
  const get = (id: string): ItemState => state[id] ?? { result: 'OK' }
  const setItem = (id: string, patch: Partial<ItemState>) =>
    setState(s => ({ ...s, [id]: { ...(s[id] ?? { result: 'OK' }), ...patch } }))

  // NG counts (NG or NG Heavy) per category, for the tab badges + save summary
  const ngByCat = useMemo(() => PDI_CHECKLIST.map((c) => {
    let n = 0
    c.groups.forEach((g, gi) => g.items.forEach((_, ii) => {
      const r = state[pdiItemId(c.key, gi, ii)]?.result
      if (r === 'NG' || r === 'NG Heavy') n++
    }))
    return n
  }), [state])
  const totalNg = ngByCat.reduce((a, b) => a + b, 0)

  const onPick = async (files: FileList | null) => {
    const id = pickingId.current
    if (!id || !files?.length) return
    try {
      const added = await Promise.all(Array.from(files).map(f => compressImage(f)))
      setItem(id, { photos: [...(get(id).photos ?? []), ...added] })
    } catch { toast('err', 'อัปโหลดรูปไม่สำเร็จ') }
    if (fileRef.current) fileRef.current.value = ''
  }

  const save = () => {
    // measurements → tracking cells
    if (row) {
      if (mileage.trim()) updateCell(row.vin, 'Mileage', mileage.trim())
      if (battery.trim()) updateCell(row.vin, '% SOC', battery.trim())
    }
    // each NG / NG Heavy item → a Defect
    PDI_CHECKLIST.forEach((c) => c.groups.forEach((g, gi) => g.items.forEach((it, ii) => {
      const st = state[pdiItemId(c.key, gi, ii)]
      if (!st || (st.result !== 'NG' && st.result !== 'NG Heavy')) return
      const heavy = st.result === 'NG Heavy'
      addDamage(unit.vin, {
        area: it.en,
        areaTh: it.th,
        type: '',
        severity: 'major',
        item: `${c.label} · ${g.title}`,
        remark: st.note?.trim() || undefined,
        photos: st.photos?.length ? st.photos : undefined,
        photo: st.photos?.[0],
        categoryNG: heavy ? 'HEAVY NG' : 'NG',
        statusRepair: 'Waiting Repair',
        source: 'pdi',
        station: stationName,
      })
    })))
    const result: 'OK' | 'NG' = totalNg > 0 ? 'NG' : 'OK'
    if (canRecord && activeProc) recordCheck(activeProc.queue.id, unit.vin, result, currentUser)
    else setInspected(unit.vin, result === 'OK')
    if (row) updateCell(row.vin, 'Car Status', `${stationName} ${result}`)
    onSaved(`${stationName} ${result}`, result)
  }

  const category = PDI_CHECKLIST[cat]

  const RESULTS: PdiResult[] = ['OK', 'NG', 'NG Heavy']
  const resultStyle = (r: PdiResult, active: boolean) => {
    if (!active) return { background: 'var(--chip)', color: 'var(--muted)' }
    if (r === 'OK') return { background: '#16a34a', color: '#fff' }
    if (r === 'NG') return { background: '#f59e0b', color: '#fff' }
    return { background: '#dc2626', color: '#fff' } // NG Heavy
  }

  return (
    <div className="panel overflow-hidden">
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={e => onPick(e.target.files)} />

      {/* header */}
      <div className="px-4 py-2.5 border-b hairline flex items-center gap-2" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
        <ShieldCheck size={15} color="#fff" />
        <span className="font-bold text-[13.5px] text-white">{stationTitle} · Inspection</span>
        {totalNg > 0 && (
          <span className="ml-auto badge text-[11px] font-bold" style={{ background: 'rgba(255,255,255,0.22)', color: '#fff' }}>NG {totalNg}</span>
        )}
      </div>

      {/* measurements */}
      <div className="p-4 grid grid-cols-2 gap-3 border-b hairline">
        <div>
          <div className="text-[11px] font-bold mb-1" style={{ color: 'var(--muted)' }}>Mileage (Km)</div>
          <input value={mileage} onChange={e => setMileage(e.target.value)} inputMode="numeric" placeholder="กรอกค่า…"
            className="w-full rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }} />
        </div>
        <div>
          <div className="text-[11px] font-bold mb-1" style={{ color: 'var(--muted)' }}>Main Power Battery (%)</div>
          <input value={battery} onChange={e => setBattery(e.target.value)} inputMode="numeric" placeholder="กรอกค่า…"
            className="w-full rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }} />
        </div>
      </div>

      {/* category tabs */}
      <div className="flex gap-1.5 overflow-x-auto px-3 py-2.5 border-b hairline" style={{ background: '#fbfaff' }}>
        {PDI_CHECKLIST.map((c, ci) => (
          <button key={c.key} onClick={() => setCat(ci)}
            className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-bold transition flex items-center gap-1.5"
            style={ci === cat ? { background: accent, color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
            {c.label}
            {ngByCat[ci] > 0 && (
              <span className="rounded-full px-1.5 text-[10px] font-bold" style={{ background: ci === cat ? 'rgba(255,255,255,0.25)' : 'rgba(220,38,38,0.12)', color: ci === cat ? '#fff' : '#dc2626' }}>{ngByCat[ci]}</span>
            )}
          </button>
        ))}
      </div>

      {/* items of the active category */}
      <div className="p-3 space-y-4 max-h-[62vh] overflow-y-auto">
        {category.groups.map((g, gi) => (
          <div key={gi}>
            <div className="text-[11px] font-bold uppercase tracking-wide mb-2 px-1" style={{ color: accent }}>{g.title}</div>
            <div className="space-y-2">
              {g.items.map((it, ii) => {
                const id = pdiItemId(category.key, gi, ii)
                const st = get(id)
                const isNg = st.result === 'NG' || st.result === 'NG Heavy'
                return (
                  <div key={ii} className="rounded-xl p-2.5" style={{ border: '1px solid var(--line)', background: isNg ? '#fff8f5' : 'var(--panel)' }}>
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] font-bold tabular mt-1 shrink-0" style={{ color: 'var(--faint)', minWidth: 18 }}>{ii + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[12.5px] leading-snug">{it.en}</div>
                        {it.th && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{it.th}</div>}
                      </div>
                    </div>
                    {/* OK / NG / NG Heavy */}
                    <div className="flex gap-1.5 mt-2">
                      {RESULTS.map(r => (
                        <button key={r} onClick={() => setItem(id, { result: r })}
                          className="flex-1 py-1.5 rounded-lg text-[11.5px] font-bold transition active:scale-95"
                          style={resultStyle(r, st.result === r)}>
                          {r}
                        </button>
                      ))}
                    </div>
                    {/* spec field (Qty / Key Code) */}
                    {it.spec && (
                      <input value={st.spec ?? ''} onChange={e => setItem(id, { spec: e.target.value })} placeholder={`ระบุ ${it.spec}…`}
                        className="w-full mt-2 rounded-lg px-2.5 py-2 text-[12px] outline-none" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }} />
                    )}
                    {/* note + photos — only when NG / NG Heavy */}
                    {isNg && (
                      <div className="mt-2 space-y-2">
                        <input value={st.note ?? ''} onChange={e => setItem(id, { note: e.target.value })} placeholder="หมายเหตุ…"
                          className="w-full rounded-lg px-2.5 py-2 text-[12px] outline-none" style={{ background: '#fff', border: '1px solid var(--line)' }} />
                        <div className="flex items-center gap-2 flex-wrap">
                          {(st.photos ?? []).map((p, pi) => (
                            <div key={pi} className="relative">
                              <img src={p} className="w-12 h-12 rounded-lg object-cover" alt="" />
                              <button onClick={() => setItem(id, { photos: (st.photos ?? []).filter((_, x) => x !== pi) })}
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: '#dc2626', color: '#fff' }}>
                                <X size={11} />
                              </button>
                            </div>
                          ))}
                          <button onClick={() => { pickingId.current = id; fileRef.current?.click() }}
                            className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ border: '1px dashed var(--line)', color: 'var(--muted)' }}>
                            <Camera size={16} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* summary + save */}
      <div className="p-3 border-t hairline">
        {totalNg > 0 && (
          <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2" style={{ color: '#dc2626' }}>
            <AlertTriangle size={14} /> พบ NG {totalNg} รายการ — จะถูกบันทึกเป็น Defect
          </div>
        )}
        <button onClick={save} className="btn w-full py-3 text-[14px] font-bold" style={{ background: totalNg ? '#dc2626' : 'var(--st-yard)', color: '#fff', border: 'none' }}>
          <CheckCircle2 size={16} /> บันทึก {totalNg ? `· NG (${totalNg})` : '· OK'}
        </button>
      </div>
    </div>
  )
}
