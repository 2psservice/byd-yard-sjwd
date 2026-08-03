// PDI inspection checklist panel — the structured OK / NG / NG Heavy form for
// the PDI station. Each item defaults to OK; tapping NG / NG Heavy reveals a
// note + photo capture, and on Save every NG / NG Heavy item is written as a
// Defect (source 'pdi') so it flows into the damage / repair system.
import { useMemo, useRef, useState } from 'react'
import { ShieldCheck, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'
import { useOps, stampStationDate } from '../store/useOps'
import { compressImage } from '../lib/photo'
import { CAR_STATUS_META } from '../lib/carStatus'
import { PDI_CHECKLIST, pdiItemId, type PdiResult } from '../lib/pdiChecklist'
import { CheckItemRow } from './CheckItemRow'
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
      // FUNCTIONAL update — the upload takes seconds; reading render-time state
      // here made a second photo shot mid-upload overwrite the first
      setState(s => {
        const cur = s[id] ?? { result: 'OK' as const }
        return { ...s, [id]: { ...cur, photos: [...(cur.photos ?? []), ...added] } }
      })
    } catch { toast('err', 'อัปโหลดรูปไม่สำเร็จ') }
    if (fileRef.current) fileRef.current.value = ''
  }

  const savedRef = useRef(false) // double-tap guard — a 2nd save duplicates defects + burns a RE-PDI slot
  const save = () => {
    if (savedRef.current) return
    // every NG/NG Heavy needs ≥1 photo — same rule as every other defect path
    // (this station generates the most defects; photo-less ones can't evidence
    // a repair/claim later)
    const noPhoto: string[] = []
    PDI_CHECKLIST.forEach((c) => c.groups.forEach((g, gi) => g.items.forEach((it, ii) => {
      const st = state[pdiItemId(c.key, gi, ii)]
      if (st && (st.result === 'NG' || st.result === 'NG Heavy') && !st.photos?.length) noPhoto.push(it.en)
    })))
    if (noPhoto.length) { toast('err', `กรุณาถ่ายรูปรายการ NG: ${noPhoto.slice(0, 3).join(', ')}${noPhoto.length > 3 ? ` และอีก ${noPhoto.length - 3} รายการ` : ''}`); return }
    savedRef.current = true
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
    if (activeProc) {
      // record even when already checked — a corrected re-save must update the
      // queue's result (the `stamped` guard prevents a second date stamp)
      recordCheck(activeProc.queue.id, unit.vin, result, currentUser)
    } else {
      setInspected(unit.vin, result === 'OK')
      // no queue → still stamp the PDI-date ladder (PDI → RE-PDI #1 → #2…) so the
      // admin Unit sheet records this inspection's date (OK or NG alike)
      stampStationDate(unit.vin, 'PDI')
    }
    // Car Status stays a lifecycle value — a car at the PDI station is still In
    // Yard, and the inspection is recorded on the Overview date ladder + the
    // queue. Only heal a row still carrying a legacy station string.
    if (row && !CAR_STATUS_META[(row.cells['Car Status'] || '').trim()]) updateCell(row.vin, 'Car Status', 'In Yard')
    onSaved(`${stationName} ${result}`, result)
  }

  const category = PDI_CHECKLIST[cat]

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
                return (
                  <CheckItemRow key={ii} n={ii + 1} item={it} state={get(id)}
                    onChange={patch => setItem(id, patch)}
                    onPickPhoto={() => { pickingId.current = id; fileRef.current?.click() }} />
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
