/**
 * Control Stock Sheet · Additional Accessories check — the SAME two checklists
 * PDI / FINAL CHECK ask (see finalCheckList.ts), but standalone so Walk Around
 * Check can run them at gate-in, before PDI ever touches the car. An NG here
 * (missing manual, missing NFC card, …) is saved as a normal Defect with
 * source: 'walkcheck', so it shows up in the car's Event log AND under
 * PDI/FINAL CHECK's "NG เพิ่มเติม" list — the office does not have to wait
 * until PDI to learn an accessory is missing.
 */
import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useYard } from '../store/useYard'
import { compressImage } from '../lib/photo'
import { checkItemId, type CheckItemState } from '../lib/checkSheet'
import { WALK_CHECK_TABS } from '../lib/finalCheckList'
import { CheckItemRow } from './CheckItemRow'

export default function StockAccessoryCheck({ vin, accent, station = 'Walk Around Check' }: {
  vin: string
  accent: string
  station?: string
}) {
  const { addDamage, toast } = useYard()
  const [tab, setTab] = useState(0)
  const [state, setState] = useState<Record<string, CheckItemState>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)   // camera (capture)
  const albumRef = useRef<HTMLInputElement | null>(null)  // gallery picker
  const pickingId = useRef<string | null>(null)

  const tabs = WALK_CHECK_TABS
  const activeTab = tabs[tab]
  const get = (id: string): CheckItemState => state[id] ?? { result: 'OK' }
  const setItem = (id: string, patch: Partial<CheckItemState>) =>
    setState(s => ({ ...s, [id]: { ...(s[id] ?? { result: 'OK' }), ...patch } }))

  const onPick = async (files: FileList | null) => {
    const id = pickingId.current
    if (!id || !files?.length) return
    try {
      const added = await Promise.all(Array.from(files).map(f => compressImage(f)))
      setState(s => {
        const cur = s[id] ?? { result: 'OK' as const }
        return { ...s, [id]: { ...cur, photos: [...(cur.photos ?? []), ...added] } }
      })
    } catch { toast('err', 'อัปโหลดรูปไม่สำเร็จ') }
    if (fileRef.current) fileRef.current.value = ''
    if (albumRef.current) albumRef.current.value = ''
  }

  const ngByTab = useMemo(() => tabs.map((t) => {
    let n = 0
    t.groups.forEach((g, gi) => g.items.forEach((_, ii) => {
      const r = state[checkItemId(t.key, gi, ii)]?.result
      if (r === 'NG' || r === 'NG Heavy') n++
    }))
    return n
  }), [state])
  const totalNg = ngByTab.reduce((a, b) => a + b, 0)

  const save = () => {
    tabs.forEach((t) => t.groups.forEach((g, gi) => g.items.forEach((it, ii) => {
      const st = state[checkItemId(t.key, gi, ii)]
      if (!st || (st.result !== 'NG' && st.result !== 'NG Heavy')) return
      addDamage(vin, {
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
        source: 'walkcheck',
        station,
      })
    })))
    toast('ok', totalNg > 0 ? `บันทึกแล้ว — พบของไม่ครบ ${totalNg} รายการ` : 'บันทึกแล้ว — ของครบทุกรายการ')
    setState({})
  }

  return (
    <div className="panel overflow-hidden">
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={e => onPick(e.target.files)} />
      <input ref={albumRef} type="file" accept="image/*" multiple hidden onChange={e => onPick(e.target.files)} />

      <div className="px-4 py-2.5 border-b hairline flex items-center gap-2" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
        <CheckCircle2 size={15} color="#fff" />
        <span className="font-bold text-[13.5px] text-white">ตรวจของประจำรถ</span>
        {totalNg > 0 && (
          <span className="ml-auto badge text-[11px] font-bold" style={{ background: 'rgba(255,255,255,0.22)', color: '#fff' }}>NG {totalNg}</span>
        )}
      </div>

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
      </div>

      <div className="p-3 space-y-4 max-h-[62vh] overflow-y-auto">
        {activeTab.groups.map((g, gi) => (
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
                    onPickPhoto={() => { pickingId.current = id; fileRef.current?.click() }}
                    onPickAlbum={() => { pickingId.current = id; albumRef.current?.click() }} />
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 border-t hairline">
        {totalNg > 0 && (
          <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2" style={{ color: '#dc2626' }}>
            <AlertTriangle size={14} /> ของไม่ครบ {totalNg} รายการ — จะถูกบันทึกเป็น Defect
          </div>
        )}
        <button onClick={save} className="btn w-full py-3 text-[14px] font-bold"
          style={{ background: totalNg ? '#dc2626' : 'var(--st-yard)', color: '#fff', border: 'none' }}>
          <CheckCircle2 size={16} /> บันทึก {totalNg ? `· NG (${totalNg})` : '· ครบ'}
        </button>
      </div>
    </div>
  )
}
