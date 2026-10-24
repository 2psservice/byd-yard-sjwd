/**
 * EV Charging station (Ops Scan) — ดู lib/evCharging.ts
 *
 * สแกนวิน → ถ้ารถยังไม่มีรอบที่ชาร์จค้าง = ขั้น "ก่อนชาร์จ": บังคับรูปเลขวิน + รูปหน้าจอแบต
 * (AI อ่าน % ให้ แก้เองได้) → บันทึก · ยิงคันเดิมอีกครั้ง = ขั้น "หลังชาร์จ": บังคับรูปหน้าจอ
 * แบต + % → บันทึก แล้วสรุปเวลาชาร์จของคันนั้น
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { BatteryCharging, Camera, Images, Sparkles, X, CheckCircle2, Clock } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'
import { useEvCharging } from '../store/useEvCharging'
import { compressToDataUrl } from '../lib/photo'
import { storePhoto } from '../lib/photoStore'
import {
  EV_CELL, evChargeId, evCellText, openChargeOf, isCharging, chargeMs, dailySummary, readBatteryPercent, parsePct,
  fmtDuration, fmtEvTime, fmtPct, type EvCharge, type BatteryRead,
} from '../lib/evCharging'
import { dateKey } from '../lib/dayKey'
import { PhotoLightbox } from './ui'

export const EV_ACCENT = '#16a34a'

/** รอบชาร์จของยาร์ดนี้ที่โหลดไว้ (เรียงใหม่สุดก่อน) */
function useSiteCharges(): EvCharge[] {
  const charges = useEvCharging((s) => s.charges)
  const site = useYard((s) => s.currentSite)
  return useMemo(() => Object.values(charges).filter((c) => !site || !c.site || c.site === site)
    .sort((a, b) => b.beforeAt - a.beforeAt), [charges, site])
}

/** โหลดรอบชาร์จของยาร์ดนี้ตั้งแต่เมื่อวาน (+ รอบที่ยังชาร์จอยู่) — สถานีใช้แค่วันนี้กับรถที่ค้าง */
export function useEvStationLoad(): void {
  const site = useYard((s) => s.currentSite)
  useEffect(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1)
    useEvCharging.getState().load(site ?? null, d.getTime()).catch(() => {})
  }, [site])
}

/** นาฬิกาเดินทุกนาที — เวลาชาร์จของรถที่ยังเสียบอยู่ */
function useMinuteTick(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t) }, [])
  return now
}

// ── หน้าแรกของสถานี: สรุปวันนี้ + รถที่กำลังชาร์จ ─────────────────────────────

export function EvStationHome({ onPick }: { onPick: (vin: string) => void }) {
  const list = useSiteCharges()
  const cloudMissing = useEvCharging((s) => s.cloudMissing)
  const pendingN = useEvCharging((s) => Object.keys(s.pending).length)
  const now = useMinuteTick()
  const charging = list.filter(isCharging)
  const today = dailySummary(list).find((d) => d.day === dateKey(new Date()))
  const doneToday = list.filter((c) => c.afterAt && dateKey(new Date(c.afterAt)) === dateKey(new Date()))

  return (
    <div className="space-y-3">
      {cloudMissing && (
        <div className="panel p-3 text-[12px]" style={{ color: 'var(--st-damage)', borderColor: '#fca5a5' }}>
          ยังบันทึกขึ้นระบบไม่ได้ {pendingN ? `(ค้างในเครื่อง ${pendingN} รายการ จะส่งให้อัตโนมัติ)` : ''} — แจ้งผู้ดูแลให้รัน supabase-ev-charging.sql
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {[
          ['เสร็จวันนี้', `${today?.finished ?? 0}`, 'คัน'],
          ['เฉลี่ย/คัน', today?.finished ? fmtDuration(today.avgMs).replace(' ชม.', '') : '—', 'ชม.'],
          ['กำลังชาร์จ', `${charging.length}`, 'คัน'],
        ].map(([label, v, unit]) => (
          <div key={label} className="panel p-3 text-center">
            <div className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{label}</div>
            <div className="text-[22px] font-bold tabular leading-tight" style={{ color: EV_ACCENT }}>{v}</div>
            <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>{unit}</div>
          </div>
        ))}
      </div>

      <div className="panel p-3">
        <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
          กำลังชาร์จ · แตะเพื่อบันทึกหลังชาร์จ
        </div>
        {charging.length === 0 && <div className="text-[12.5px] py-2" style={{ color: 'var(--muted)' }}>ยังไม่มีรถที่ชาร์จค้างอยู่ — สแกนวินเพื่อเริ่มชาร์จ</div>}
        <div className="space-y-1.5">
          {charging.map((c) => (
            <button key={c.id} onClick={() => onPick(c.vin)} data-ev-open={c.vin}
              className="w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition hover:bg-[var(--chip)]"
              style={{ border: '1px solid var(--line)', touchAction: 'manipulation' }}>
              <BatteryCharging size={18} style={{ color: EV_ACCENT }} />
              <div className="min-w-0 flex-1">
                <div className="mono text-[13px] font-bold truncate">{c.vin}</div>
                <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{c.model || '—'} · เริ่ม {fmtEvTime(c.beforeAt)} · {fmtPct(c.beforePct)}</div>
              </div>
              <div className="text-[12px] font-bold tabular" style={{ color: EV_ACCENT }}>{fmtDuration(chargeMs(c, now))}</div>
            </button>
          ))}
        </div>
      </div>

      {doneToday.length > 0 && (
        <div className="panel p-3">
          <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>เสร็จวันนี้</div>
          <div className="space-y-1">
            {doneToday.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[12px]">
                <CheckCircle2 size={14} style={{ color: EV_ACCENT }} />
                <span className="mono font-semibold">{c.vin.slice(-8)}</span>
                <span style={{ color: 'var(--muted)' }}>{fmtPct(c.beforePct)} → {fmtPct(c.afterPct)}</span>
                <span className="ml-auto tabular font-semibold">{fmtDuration(chargeMs(c))}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── ช่องรูป (บังคับ) ─────────────────────────────────────────────────────────

function EvPhotoSlot({ label, hint, photo, busy, onFile, onClear, slot }: {
  label: string; hint: string; photo: string; busy: boolean
  onFile: (f: File) => void; onClear: () => void; slot: string
}) {
  const camRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useState(false)
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] font-bold">{label} <span style={{ color: 'var(--st-damage)' }}>*</span></div>
      {photo ? (
        <div className="relative">
          <img src={photo} alt={label} onClick={() => setView(true)} data-ev-photo={slot}
            className="w-full rounded-xl object-cover cursor-zoom-in" style={{ height: 170, border: '1px solid var(--line)' }} />
          {busy && <div className="absolute inset-0 rounded-xl flex items-center justify-center text-[12px] font-bold text-white" style={{ background: 'rgba(15,23,42,.45)' }}>กำลังอัปโหลด…</div>}
          <button onClick={onClear} title="ถ่ายใหม่" aria-label={`ลบ${label}`}
            className="absolute top-2 right-2 rounded-full flex items-center justify-center"
            style={{ width: 28, height: 28, background: '#0f172a', color: '#fff' }}>
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => camRef.current?.click()} disabled={busy}
            className="flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed py-5 text-[12.5px] font-semibold disabled:opacity-50"
            style={{ borderColor: '#fca5a5', color: 'var(--st-damage)' }}>
            <Camera size={20} /> ถ่ายรูป
          </button>
          <button onClick={() => albumRef.current?.click()} disabled={busy}
            className="flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed py-5 text-[12.5px] font-semibold disabled:opacity-50"
            style={{ borderColor: 'var(--line-strong)', color: 'var(--muted)' }}>
            <Images size={20} /> อัลบั้ม
          </button>
        </div>
      )}
      {!photo && <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{hint}</div>}
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" data-ev-input={slot}
        onChange={(e) => { if (e.target.files?.[0]) onFile(e.target.files[0]); e.target.value = '' }} />
      <input ref={albumRef} type="file" accept="image/*" className="hidden" data-ev-album={slot}
        onChange={(e) => { if (e.target.files?.[0]) onFile(e.target.files[0]); e.target.value = '' }} />
      {view && photo && <PhotoLightbox photos={[photo]} index={0} onClose={() => setView(false)} />}
    </div>
  )
}

/** รูป 1 ช่อง: ย่อ → อัปโหลด (ลิงก์สั้น) · ลบ/ถ่ายใหม่ได้ · ผลที่มาช้าของรูปเก่าถูกทิ้ง */
function usePhoto() {
  const [photo, setPhoto] = useState('')
  const [busy, setBusy] = useState(false)
  const token = useRef(0)
  /** withBig: also return a sharper copy for the AI reader (the stored copy stays 900px like every other photo) */
  const take = async (file: File, withBig = false): Promise<{ big: string; my: number } | null> => {
    const my = ++token.current
    setBusy(true)
    try {
      const [small, big] = await Promise.all([compressToDataUrl(file, 900), withBig ? compressToDataUrl(file, 1280) : Promise.resolve('')])
      if (my !== token.current) return null
      setPhoto(small)
      storePhoto(small).then((url) => { if (my === token.current) { setPhoto(url); setBusy(false) } })
      return { big, my }
    } catch {
      if (my === token.current) setBusy(false)
      return null
    }
  }
  const clear = () => { token.current++; setPhoto(''); setBusy(false) }
  return { photo, busy, take, clear, isCurrent: (my: number) => my === token.current }
}

type AiState = 'idle' | 'reading' | 'ok' | Extract<BatteryRead, { ok: false }>['reason']

const AI_TEXT: Record<Exclude<AiState, 'idle'>, string> = {
  reading: 'AI กำลังอ่าน % จากรูป…',
  ok: 'AI อ่านได้ — ตรวจให้ตรงกับหน้าจอ แก้ได้',
  unreadable: 'AI อ่านไม่ออก — กรอก % เอง',
  off: 'ยังไม่ได้เปิดระบบ AI — กรอก % เอง',
  error: 'AI อ่านไม่ได้ (เน็ต/ระบบ) — กรอก % เอง',
}

/** รูปหน้าจอแบต + ช่อง % ที่ AI เติมให้ */
function useBatteryShot() {
  const ph = usePhoto()
  const [pct, setPct] = useState('')
  const [ai, setAi] = useState<number | null>(null)
  const [aiState, setAiState] = useState<AiState>('idle')
  const touched = useRef(false)
  const onFile = async (file: File) => {
    touched.current = false
    setAi(null); setAiState('reading')
    const got = await ph.take(file, true)
    if (!got) { setAiState('idle'); return }
    const r = await readBatteryPercent(got.big)
    if (!ph.isCurrent(got.my)) return
    if (r.ok) {
      setAi(r.percent); setAiState('ok')
      if (!touched.current) setPct(String(r.percent))
    } else setAiState(r.reason)
  }
  const clear = () => { ph.clear(); setAi(null); setAiState('idle') }
  const edit = (v: string) => { touched.current = true; setPct(v) }
  return { ...ph, onFile, clear, pct, edit, ai, aiState, value: parsePct(pct) }
}

function PctField({ shot, label }: { shot: ReturnType<typeof useBatteryShot>; label: string }) {
  const bad = shot.pct.trim() !== '' && shot.value == null
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="text-[12px] font-bold shrink-0">{label} <span style={{ color: 'var(--st-damage)' }}>*</span></label>
        <div className="flex items-center rounded-xl overflow-hidden ml-auto" style={{ border: `1.5px solid ${bad ? 'var(--st-damage)' : 'var(--line-strong)'}` }}>
          <input value={shot.pct} onChange={(e) => shot.edit(e.target.value)} inputMode="numeric" placeholder="0–100"
            data-ev-pct={label} aria-label={label}
            className="w-20 px-3 py-2 text-[18px] font-bold tabular text-right bg-transparent outline-none" />
          <span className="pr-3 text-[15px] font-bold" style={{ color: 'var(--muted)' }}>%</span>
        </div>
      </div>
      {shot.aiState !== 'idle' && (
        <div className="flex items-center gap-1.5 text-[11.5px]" data-ev-ai={shot.aiState}
          style={{ color: shot.aiState === 'ok' ? EV_ACCENT : shot.aiState === 'reading' ? 'var(--muted)' : '#b45309' }}>
          <Sparkles size={13} /> {AI_TEXT[shot.aiState]}{shot.aiState === 'ok' && shot.ai != null ? ` (${shot.ai}%)` : ''}
        </div>
      )}
      {bad && <div className="text-[11.5px]" style={{ color: 'var(--st-damage)' }}>กรอกตัวเลข 0–100</div>}
    </div>
  )
}

const REMARK_CHIPS = ['แบตต่ำ', 'Jump start', 'รถขาย']

// ── รถ 1 คัน: ก่อนชาร์จ / หลังชาร์จ ─────────────────────────────────────────

export function EvChargePanel({ vin, cells, unitModel, unitColor, onClose }: {
  vin: string; cells: Record<string, string>; unitModel?: string; unitColor?: string; onClose: () => void
}) {
  const toast = useYard((s) => s.toast)
  const list = useSiteCharges()
  const open = openChargeOf(list, vin)
  const now = useMinuteTick()
  const vinShot = usePhoto()
  const shot = useBatteryShot()
  const [remark, setRemark] = useState(open?.remark ?? '')
  const [saving, setSaving] = useState(false)

  const model = (cells['Model'] || (cells['Model name'] || '').replace(/^BYD\s+/i, '') || unitModel || '').trim()
  const color = (cells['Color'] || unitColor || '').trim()
  const from = (cells['From'] || '').trim()
  const last = list.find((c) => c.vin === vin && !isCharging(c))

  const missing: string[] = []
  if (!open && !vinShot.photo) missing.push('รูปเลขวิน')
  if (!shot.photo) missing.push(open ? 'รูปหลังชาร์จ' : 'รูปก่อนชาร์จ')
  if (shot.value == null) missing.push(open ? '% หลังชาร์จ' : '% ก่อนชาร์จ')
  const uploading = vinShot.busy || shot.busy
  const canSave = !missing.length && !uploading && !saving

  const writeCell = (c: EvCharge) => {
    if (useTracking.getState().rows[vin]) useTracking.getState().updateCell(vin, EV_CELL, evCellText(c), 'scan')
  }

  const save = async () => {
    if (!canSave || shot.value == null) return
    const by = useYard.getState().currentUser
    const at = Date.now()
    let c: EvCharge
    if (open) {
      if (shot.value < (open.beforePct ?? 0) && !window.confirm(`% หลังชาร์จ (${shot.value}%) น้อยกว่าก่อนชาร์จ (${open.beforePct}%) — บันทึกต่อไหม`)) return
      c = { ...open, remark: remark.trim(), afterPhoto: shot.photo, afterPct: shot.value, afterAi: shot.ai, afterAt: at, afterBy: by, updatedAt: at }
    } else {
      c = {
        id: evChargeId(vin, at), site: useYard.getState().currentSite ?? undefined, vin, model, color, from, remark: remark.trim(),
        vinPhoto: vinShot.photo, beforePhoto: shot.photo, beforePct: shot.value, beforeAi: shot.ai, beforeAt: at, beforeBy: by,
        afterPhoto: '', afterPct: null, afterAi: null, afterAt: 0, afterBy: '', updatedAt: at,
      }
    }
    // the round lands on this device at once (store + sheet cell) and the panel closes — the cloud write
    // carries on behind it, so a slow yard network never holds the operator on this screen
    setSaving(true)
    const landed = useEvCharging.getState().save(c)
    writeCell(c)
    toast('ok', open ? `ชาร์จเสร็จ ${vin.slice(-6)} · ${fmtPct(c.beforePct)} → ${fmtPct(c.afterPct)} · ${fmtDuration(chargeMs(c))}` : `เริ่มชาร์จ ${vin.slice(-6)} · ${fmtPct(c.beforePct)}`)
    onClose()
    if (!(await landed)) toast('err', `EV ${vin.slice(-6)} ยังขึ้นระบบไม่ได้ — เก็บไว้ในเครื่องแล้ว จะส่งให้อัตโนมัติ`)
  }

  const toggleChip = (t: string) => {
    const parts = remark.split('/').map((s) => s.trim()).filter(Boolean)
    setRemark((parts.includes(t) ? parts.filter((p) => p !== t) : [...parts, t]).join('/'))
  }

  return (
    <div className="space-y-3" data-ev-panel={open ? 'after' : 'before'}>
      {/* car */}
      <div className="panel p-3 flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: EV_ACCENT + '18', color: EV_ACCENT }}>
          <BatteryCharging size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mono text-[14px] font-bold truncate">{vin}</div>
          <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{[model, color, from && `From ${from}`].filter(Boolean).join(' · ') || '—'}</div>
          {!open && last && <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>ครั้งก่อน: {evCellText(last)}</div>}
        </div>
        <button onClick={onClose} aria-label="ปิด" className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ border: '1px solid var(--line)' }}>
          <X size={15} />
        </button>
      </div>

      {open && (
        <div className="panel p-3 flex items-center gap-3" style={{ borderColor: EV_ACCENT + '66' }}>
          {open.beforePhoto && <img src={open.beforePhoto} alt="ก่อนชาร์จ" className="w-16 h-16 rounded-lg object-cover" style={{ border: '1px solid var(--line)' }} />}
          <div className="flex-1 min-w-0 text-[12.5px]">
            <div className="font-bold" style={{ color: EV_ACCENT }}>กำลังชาร์จ · ก่อนชาร์จ {fmtPct(open.beforePct)}</div>
            <div style={{ color: 'var(--muted)' }}>เริ่ม {fmtEvTime(open.beforeAt)} โดย {open.beforeBy || '—'}</div>
          </div>
          <div className="flex items-center gap-1 text-[13px] font-bold tabular"><Clock size={14} /> {fmtDuration(chargeMs(open, now))}</div>
        </div>
      )}

      <div className="panel p-3 space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: EV_ACCENT }}>
          {open ? 'ขั้นที่ 2 · หลังชาร์จ' : 'ขั้นที่ 1 · ก่อนชาร์จ'}
        </div>
        {!open && (
          <EvPhotoSlot slot="vin" label="รูปเลขวิน (Export Label)" hint="ถ่ายป้ายเลขวินของคันนี้ให้อ่านออก"
            photo={vinShot.photo} busy={vinShot.busy} onFile={(f) => { vinShot.take(f) }} onClear={vinShot.clear} />
        )}
        <EvPhotoSlot slot={open ? 'after' : 'before'} label={open ? 'รูปหน้าจอแบต หลังชาร์จ' : 'รูปหน้าจอแบต ก่อนชาร์จ'}
          hint="ถ่ายหน้าจอที่เห็นเปอร์เซ็นต์แบตชัด ๆ — AI จะอ่าน % ให้"
          photo={shot.photo} busy={shot.busy} onFile={shot.onFile} onClear={shot.clear} />
        <PctField shot={shot} label={open ? '% หลังชาร์จ' : '% ก่อนชาร์จ'} />
        <div className="space-y-1.5">
          <div className="text-[12px] font-bold">Remark</div>
          <div className="flex gap-1.5 flex-wrap">
            {REMARK_CHIPS.map((t) => {
              const on = remark.split('/').map((s) => s.trim()).includes(t)
              return (
                <button key={t} onClick={() => toggleChip(t)} className="px-2.5 py-1 rounded-full text-[11.5px] font-semibold"
                  style={on ? { background: EV_ACCENT, color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>{t}</button>
              )
            })}
          </div>
          <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="หมายเหตุ (ไม่บังคับ)"
            className="w-full px-3 py-2 rounded-xl text-[13px] bg-transparent outline-none" style={{ border: '1px solid var(--line-strong)' }} />
        </div>
      </div>

      <button onClick={save} disabled={!canSave} data-ev-save
        className="w-full py-3.5 rounded-2xl text-[15px] font-bold text-white transition disabled:opacity-40"
        style={{ background: EV_ACCENT, touchAction: 'manipulation' }}>
        {saving ? 'กำลังบันทึก…' : open ? 'บันทึกหลังชาร์จ' : 'บันทึกก่อนชาร์จ · เริ่มชาร์จ'}
      </button>
      {(missing.length > 0 || uploading) && (
        <div className="text-[11.5px] text-center" style={{ color: 'var(--st-damage)' }}>
          {uploading ? 'รอรูปอัปโหลดเสร็จ' : `ยังขาด: ${missing.join(' · ')}`}
        </div>
      )}
    </div>
  )
}
