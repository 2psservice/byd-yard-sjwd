/**
 * Station inspection sheet — the paper form on one screen, shared by PDI and
 * FINAL CHECK: vehicle identity, the four measurements (with every previous
 * reading beside each), the station's checklist tabs, and a free NG tab.
 *
 * Saving writes the measurements onto the tracking row, turns every NG (both
 * checklist items and free NG entries) into a Defect, and records the station's
 * verdict — which stamps the station's date on the car's Overview.
 */
import { useMemo, useRef, useState } from 'react'
import { ShieldCheck, CheckCircle2, AlertTriangle, Plus, Trash2, Camera, X } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'
import { useOps, stampStationDate } from '../store/useOps'
import { compressImage } from '../lib/photo'
import { CAR_STATUS_META } from '../lib/carStatus'
import { MASTER_PARTS, MASTER_DEFECTS, resolvePart, resolveDefect } from '../lib/masterDefect'
import { checkItemId, type CheckItemState, type CheckTab } from '../lib/checkSheet'
import { MeasurementField, TirePressureField, TIRE_WHEELS, joinTirePressure } from './MeasurementField'
import { CheckItemRow } from './CheckItemRow'
import type { Unit } from '../types'
import type { TrackRow } from '../lib/excelTracking'
import type { WorkQueue, QueueItem, QueueType } from '../store/useOps'

/** One free NG line on the NG tab: ตำแหน่ง · ข้อบกพร่อง · หมายเหตุ. */
interface NgEntry { id: string; position: string; defect: string; note: string; photos: string[] }

/** Single-value measurements, each with the tracking cell it reads / writes.
 *  Tire pressure is measured per wheel and handled by TirePressureField. */
const MEASUREMENTS = [
  { key: '% SOC', label: '% SOC', unit: '%' },
  { key: 'Mileage', label: 'Mileage (Km)', unit: 'กม.' },
  { key: 'Voltage of 12V', label: 'Voltage of 12V / Date', unit: 'V' },
] as const

const TIRE_LABEL = 'Tire Pressure (310–340 Kpal)'

let ngSeq = 0

export default function StationSheet({ unit, row, activeProc, onSaved, stationTitle, accent, tabs, stationType }: {
  unit: Unit
  row: TrackRow | null
  activeProc: { queue: WorkQueue; item: QueueItem } | null
  onSaved: (label: string, result: 'OK' | 'NG') => void
  stationTitle: string
  accent: string
  /** The station's checklist tabs — the NG tab is added after them. */
  tabs: CheckTab[]
  /** Which date ladder a queue-less save stamps (PDI → RE-PDI, FINAL → Final check date). */
  stationType: Extract<QueueType, 'PDI' | 'FINAL'>
}) {
  const { addDamage, setInspected, currentUser, toast } = useYard()
  const { updateCell } = useTracking()
  const columns = useTracking(st => st.columns)
  const { recordCheck } = useOps()

  const [meas, setMeas] = useState<Record<string, string>>({})
  const [tab, setTab] = useState(0)
  const [state, setState] = useState<Record<string, CheckItemState>>({})
  const [ngList, setNgList] = useState<NgEntry[]>([])
  const fileRef = useRef<HTMLInputElement | null>(null)
  const pickingId = useRef<string | null>(null)   // item id, or "ng:<entry id>"

  const stationName = activeProc?.queue.name ?? stationTitle
  const get = (id: string): CheckItemState => state[id] ?? { result: 'OK' }
  const setItem = (id: string, patch: Partial<CheckItemState>) =>
    setState(s => ({ ...s, [id]: { ...(s[id] ?? { result: 'OK' }), ...patch } }))

  // NG counts per tab, for the tab badges and the save summary
  const ngByTab = useMemo(() => tabs.map((t) => {
    let n = 0
    t.groups.forEach((g, gi) => g.items.forEach((_, ii) => {
      const r = state[checkItemId(t.key, gi, ii)]?.result
      if (r === 'NG' || r === 'NG Heavy') n++
    }))
    return n
  }), [state])
  const listNg = ngList.filter(e => e.position.trim() || e.defect.trim()).length
  const totalNg = ngByTab.reduce((a, b) => a + b, 0) + listNg

  const onPick = async (files: FileList | null) => {
    const id = pickingId.current
    if (!id || !files?.length) return
    try {
      const added = await Promise.all(Array.from(files).map(f => compressImage(f)))
      // functional updates — an upload takes seconds, and a second shot started
      // meanwhile must not overwrite the first
      if (id.startsWith('ng:')) {
        const eid = id.slice(3)
        setNgList(list => list.map(e => (e.id === eid ? { ...e, photos: [...e.photos, ...added] } : e)))
      } else {
        setState(s => {
          const cur = s[id] ?? { result: 'OK' as const }
          return { ...s, [id]: { ...cur, photos: [...(cur.photos ?? []), ...added] } }
        })
      }
    } catch { toast('err', 'อัปโหลดรูปไม่สำเร็จ') }
    if (fileRef.current) fileRef.current.value = ''
  }

  const addNg = () => setNgList(l => [...l, { id: `ng${++ngSeq}`, position: '', defect: '', note: '', photos: [] }])
  const setNg = (id: string, patch: Partial<NgEntry>) =>
    setNgList(l => l.map(e => (e.id === id ? { ...e, ...patch } : e)))

  const savedRef = useRef(false) // double-tap guard — a 2nd save duplicates defects
  const save = () => {
    if (savedRef.current) return

    // every NG needs evidence — this sheet is what a claim is argued from
    const noPhoto: string[] = []
    tabs.forEach((t) => t.groups.forEach((g, gi) => g.items.forEach((it, ii) => {
      const st = state[checkItemId(t.key, gi, ii)]
      if (st && (st.result === 'NG' || st.result === 'NG Heavy') && !st.photos?.length)
        noPhoto.push(it.th ?? it.en ?? '')
    })))
    for (const e of ngList) {
      if ((e.position.trim() || e.defect.trim()) && !e.photos.length) noPhoto.push(e.position || e.defect)
    }
    if (noPhoto.length) {
      toast('err', `กรุณาถ่ายรูปรายการ NG: ${noPhoto.slice(0, 3).join(', ')}${noPhoto.length > 3 ? ` และอีก ${noPhoto.length - 3} รายการ` : ''}`)
      return
    }
    savedRef.current = true

    if (row) {
      for (const m of MEASUREMENTS) {
        const v = (meas[m.key] ?? '').trim()
        if (v) updateCell(row.vin, m.key, v)
      }
      // per-wheel readings, plus a combined "Tire Pressure" so the single-value
      // history (and anything reading that cell) still shows the whole set
      const wheels = TIRE_WHEELS.filter(w => (meas[w.key] ?? '').trim())
      for (const w of wheels) updateCell(row.vin, w.key, meas[w.key].trim())
      if (wheels.length) updateCell(row.vin, 'Tire Pressure', joinTirePressure(meas))
    }

    // checklist NG → Defect
    tabs.forEach((t) => t.groups.forEach((g, gi) => g.items.forEach((it, ii) => {
      const st = state[checkItemId(t.key, gi, ii)]
      if (!st || (st.result !== 'NG' && st.result !== 'NG Heavy')) return
      addDamage(unit.vin, {
        area: it.en ?? it.th ?? '—',
        areaTh: it.th,
        type: '',
        severity: 'major',
        item: `${t.label} · ${g.title}`,
        remark: [st.note?.trim(), st.spec?.trim()].filter(Boolean).join(' · ') || undefined,
        photos: st.photos?.length ? st.photos : undefined,
        photo: st.photos?.[0],
        categoryNG: st.result === 'NG Heavy' ? 'HEAVY NG' : 'NG',
        statusRepair: 'Waiting Repair',
        source: 'pdi',
        station: stationName,
      })
    })))

    // free NG entries → Defect, resolved through the master lists like Gate-in
    for (const e of ngList) {
      const pos = e.position.trim(), def = e.defect.trim()
      if (!pos && !def) continue
      const p = resolvePart(pos), d = resolveDefect(def)
      addDamage(unit.vin, {
        area: p.en || pos || '—',
        areaTh: p.th || undefined,
        type: def || '—',
        item: d.en || undefined,
        itemTh: d.th || undefined,
        severity: 'major',
        remark: e.note.trim() || undefined,
        photos: e.photos.length ? e.photos : undefined,
        photo: e.photos[0],
        categoryNG: 'NG',
        statusRepair: 'Waiting Repair',
        source: 'pdi',
        station: stationName,
      })
    }

    const result: 'OK' | 'NG' = totalNg > 0 ? 'NG' : 'OK'
    if (activeProc) {
      recordCheck(activeProc.queue.id, unit.vin, result, currentUser)
    } else {
      setInspected(unit.vin, result === 'OK')
      stampStationDate(unit.vin, stationType) // no queue → still record the date
    }
    // Car Status stays a lifecycle value; only heal a legacy station string
    if (row && !CAR_STATUS_META[(row.cells['Car Status'] || '').trim()]) updateCell(row.vin, 'Car Status', 'In Yard')
    onSaved(`${stationName} ${result}`, result)
  }

  const activeTab = tabs[tab]
  const isNgTab = tab === tabs.length
  const cells = row?.cells ?? {}
  // history entries are logged under the COLUMN LABEL, not the cell key
  const colLabel = (k: string) => columns.find(c => c.key === k)?.label

  return (
    <div className="panel overflow-hidden">
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={e => onPick(e.target.files)} />

      <div className="px-4 py-2.5 border-b hairline flex items-center gap-2" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
        <ShieldCheck size={15} color="#fff" />
        <span className="font-bold text-[13.5px] text-white">{stationTitle}</span>
        {totalNg > 0 && (
          <span className="ml-auto badge text-[11px] font-bold" style={{ background: 'rgba(255,255,255,0.22)', color: '#fff' }}>NG {totalNg}</span>
        )}
      </div>

      {/* vehicle identity — the same three fields the paper form carries */}
      <div className="px-4 py-3 border-b hairline space-y-1.5 text-[12.5px]">
        {([
          ['Vin No.', unit.vin],
          // 'company' is the handling company (it reads "Auto…" on these rows),
          // not the vehicle brand — this yard handles BYD only
          ['Brand Name', 'BYD'],
          ['Model Code', cells['Model Code']?.trim() || '—'],
          ['Model Name', unit.modelName || cells['Model name'] || cells['Model'] || '—'],
        ] as [string, string][]).map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-2">
            <span className="shrink-0" style={{ color: 'var(--muted)', width: 92 }}>{k}</span>
            <span className={`font-semibold break-all ${k === 'Vin No.' ? 'vin' : ''}`}>{v}</span>
          </div>
        ))}
      </div>

      {/* measurements — entered on the left, the reading history on the right */}
      <div className="p-4 space-y-2.5 border-b hairline">
        <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
          ค่าที่วัดได้ <span style={{ color: 'var(--faint)' }}>· ล่าสุดทางขวา — แตะเพื่อดูค่าที่บันทึกไว้ทั้งหมด</span>
        </div>
        {MEASUREMENTS.map(m => (
          <MeasurementField key={m.key} label={m.label} cellKey={m.key} columnLabel={colLabel(m.key)} row={row}
            value={meas[m.key] ?? ''} onChange={v => setMeas(s => ({ ...s, [m.key]: v }))} />
        ))}
        <TirePressureField label={TIRE_LABEL} row={row} values={meas}
          onChange={(k, v) => setMeas(s => ({ ...s, [k]: v }))} />
      </div>

      {/* tabs — the three checklists plus the free NG page */}
      <div className="flex gap-1.5 overflow-x-auto px-3 py-2.5 border-b hairline" style={{ background: '#fbfaff' }}>
        {tabs.map((t, ti) => (
          <button key={t.key} onClick={() => setTab(ti)}
            className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-bold transition flex items-center gap-1.5"
            style={ti === tab ? { background: accent, color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
            {t.label}
            {ngByTab[ti] > 0 && (
              <span className="rounded-full px-1.5 text-[10px] font-bold"
                style={ti === tab ? { background: 'rgba(255,255,255,0.25)', color: '#fff' } : { background: 'rgba(220,38,38,0.12)', color: '#dc2626' }}>{ngByTab[ti]}</span>
            )}
          </button>
        ))}
        <button onClick={() => setTab(tabs.length)}
          className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-bold transition flex items-center gap-1.5"
          style={isNgTab ? { background: '#dc2626', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
          NG
          {listNg > 0 && (
            <span className="rounded-full px-1.5 text-[10px] font-bold"
              style={isNgTab ? { background: 'rgba(255,255,255,0.25)', color: '#fff' } : { background: 'rgba(220,38,38,0.12)', color: '#dc2626' }}>{listNg}</span>
          )}
        </button>
      </div>

      <div className="p-3 space-y-4 max-h-[62vh] overflow-y-auto">
        {/* ── checklist tabs ── */}
        {!isNgTab && activeTab.groups.map((g, gi) => (
          <div key={gi}>
            <div className="text-[11px] font-bold uppercase tracking-wide mb-2 px-1" style={{ color: accent }}>
              {g.title}
            </div>
            <div className="space-y-2">
              {g.items.map((it, ii) => {
                const id = checkItemId(activeTab.key, gi, ii)
                return (
                  <CheckItemRow key={ii} n={ii + 1} item={it} state={get(id)}
                    onChange={patch => setItem(id, patch)}
                    onPickPhoto={() => { pickingId.current = id; fileRef.current?.click() }} />
                )
              })}
            </div>
          </div>
        ))}

        {/* ── NG tab — free entries: ตำแหน่ง / ข้อบกพร่อง / หมายเหตุ ── */}
        {isNgTab && (
          <div className="space-y-2.5">
            <datalist id="fc-pos">{MASTER_PARTS.map(p => <option key={p.id} value={p.th} label={p.en} />)}</datalist>
            <datalist id="fc-def">{MASTER_DEFECTS.map(d => <option key={d.id} value={d.th} label={d.en} />)}</datalist>

            {ngList.length === 0 && (
              <div className="rounded-xl px-3 py-4 text-center text-[12.5px]" style={{ border: '1px dashed var(--line)', color: 'var(--faint)' }}>
                — ยังไม่มีรายการ NG —
              </div>
            )}

            {ngList.map((e, i) => (
              <div key={e.id} className="rounded-xl p-2.5 space-y-2" style={{ border: '1px solid var(--line)', background: '#fff8f5' }}>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold tabular" style={{ color: 'var(--faint)' }}>{i + 1}</span>
                  <span className="text-[11.5px] font-semibold" style={{ color: '#dc2626' }}>NG</span>
                  <button onClick={() => setNgList(l => l.filter(x => x.id !== e.id))}
                    className="ml-auto btn btn-ghost px-2 py-1" style={{ color: 'var(--faint)' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <input list="fc-pos" value={e.position} onChange={ev => setNg(e.id, { position: ev.target.value })}
                  placeholder="ตำแหน่ง (Position)…"
                  className="w-full rounded-lg px-2.5 py-2 text-[12.5px] outline-none" style={{ background: '#fff', border: '1px solid var(--line)' }} />
                <input list="fc-def" value={e.defect} onChange={ev => setNg(e.id, { defect: ev.target.value })}
                  placeholder="ข้อบกพร่อง (Defect)…"
                  className="w-full rounded-lg px-2.5 py-2 text-[12.5px] outline-none" style={{ background: '#fff', border: '1px solid var(--line)' }} />
                <input value={e.note} onChange={ev => setNg(e.id, { note: ev.target.value })} placeholder="หมายเหตุ…"
                  className="w-full rounded-lg px-2.5 py-2 text-[12.5px] outline-none" style={{ background: '#fff', border: '1px solid var(--line)' }} />
                <div className="flex items-center gap-2 flex-wrap">
                  {e.photos.map((p, pi) => (
                    <div key={pi} className="relative">
                      <img src={p} className="w-12 h-12 rounded-lg object-cover" alt="" />
                      <button onClick={() => setNg(e.id, { photos: e.photos.filter((_, x) => x !== pi) })}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                        style={{ background: '#dc2626', color: '#fff' }}>
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => { pickingId.current = `ng:${e.id}`; fileRef.current?.click() }}
                    className="w-12 h-12 rounded-lg flex items-center justify-center"
                    style={{ border: '1px dashed var(--line)', color: 'var(--muted)' }}>
                    <Camera size={16} />
                  </button>
                </div>
              </div>
            ))}

            <button onClick={addNg} className="btn w-full py-2.5 text-[13px] font-semibold" style={{ color: '#dc2626' }}>
              <Plus size={15} /> เพิ่มรายการ NG
            </button>
          </div>
        )}
      </div>

      <div className="p-3 border-t hairline">
        {totalNg > 0 && (
          <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2" style={{ color: '#dc2626' }}>
            <AlertTriangle size={14} /> พบ NG {totalNg} รายการ — จะถูกบันทึกเป็น Defect
          </div>
        )}
        <button onClick={save} className="btn w-full py-3 text-[14px] font-bold"
          style={{ background: totalNg ? '#dc2626' : 'var(--st-yard)', color: '#fff', border: 'none' }}>
          <CheckCircle2 size={16} /> บันทึก {totalNg ? `· NG (${totalNg})` : '· OK'}
        </button>
      </div>
    </div>
  )
}
