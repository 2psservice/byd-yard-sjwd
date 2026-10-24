/**
 * EV Charging station (Ops Scan) — ดู lib/evCharging.ts
 *
 * สแกนวิน → ถ้ารถยังไม่มีรอบที่ชาร์จค้าง = ขั้น "ก่อนชาร์จ": บังคับรูปเลขวิน + รูปหน้าจอแบต
 * แล้วพนักงานพิมพ์ % แบตตามหน้าจอ → บันทึก · ยิงคันเดิมอีกครั้ง = ขั้น "หลังชาร์จ": บังคับรูปหน้าจอ
 * แบต + % → บันทึก แล้วสรุปเวลาชาร์จของคันนั้น
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { BatteryCharging, Camera, Images, X, CheckCircle2, Clock, Zap, ChevronLeft, ChevronRight } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'
import { useEvCharging } from '../store/useEvCharging'
import { compressToDataUrl } from '../lib/photo'
import { storePhoto } from '../lib/photoStore'
import {
  EV_CELL, SOC_CELL, evChargeId, evCellText, openChargeOf, isCharging, chargeMs, dailySummary, parsePct,
  fmtDuration, fmtEvTime, fmtDayKey, fmtPct, monthKey, fmtMonth, shiftMonth, monthRange, monthSummary, type EvCharge,
} from '../lib/evCharging'
import { fetchEvTimes } from '../lib/db'
import { dateKey } from '../lib/dayKey'
import { PhotoLightbox, cx } from './ui'

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

const PACK_CELLS = 20

/** ก้อนแบตแบบแอป BYD — 20 ก้อน ก้อนละ 5% เติมเขียวตาม % ที่บันทึกไว้จริง
 *  (ระหว่างชาร์จไม่มีใครรู้ % ปัจจุบัน จึงไม่เดา) · charging = แสงเขียววิ่งผ่านก้อนจากซ้ายไปขวา */
function BatteryPack({ pct, charging, label, height = 26 }: {
  pct: number | null; charging?: boolean; label: string; height?: number
}) {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const lit = pct == null ? 0 : Math.min(PACK_CELLS, Math.max(p > 0 ? 1 : 0, Math.round(p / (100 / PACK_CELLS))))
  return (
    <div className="flex items-center gap-2.5" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={label}
      data-ev-batt={pct ?? ''} data-ev-lit={lit} data-ev-charging={charging ? '1' : undefined}>
      {/* the top band is one slanted strip over the front band, so each cell's seam runs from its front face up the top */}
      <div className="ev-pack flex-1" style={{ height, maxWidth: 260 }}>
        {(['top', 'front'] as const).map((face) => (
          <div key={face} className={`ev-pack-${face}`}>
            {Array.from({ length: PACK_CELLS }, (_, i) => <div key={i} className={cx('ev-cell', i < lit && 'on')} />)}
          </div>
        ))}
        {charging && <div className="ev-pack-clip"><div className="ev-pack-sweep" /></div>}
      </div>
      <div className="flex items-center gap-1 shrink-0 text-[12.5px] font-bold tabular" style={{ color: 'var(--text)' }}>
        {charging && <Zap size={14} className="ev-bolt" style={{ color: EV_ACCENT }} />}
        {label}
      </div>
    </div>
  )
}

/** รอบชาร์จของยาร์ดนี้ที่เริ่มหรือจบในเดือน ym — ดึงเฉพาะเวลา/% จากคลาวด์ (ย้อนหลังได้ทุกเดือน)
 *  แล้วทับด้วยของในเครื่อง (รอบที่เพิ่งบันทึก/ยังไม่ขึ้นคลาวด์) · ดึงใหม่ทุกครั้งที่มีการบันทึก */
function useEvMonth(ym: string): { list: EvCharge[]; ready: boolean } {
  const site = useYard((s) => s.currentSite) ?? null
  const charges = useEvCharging((s) => s.charges)
  const [cloud, setCloud] = useState<{ key: string; rows: EvCharge[] | null } | null>(null)
  const key = `${site}|${ym}`
  const version = useMemo(() => {
    let v = 0
    for (const c of Object.values(charges)) v = Math.max(v, c.updatedAt)
    return `${Object.keys(charges).length}:${v}`
  }, [charges])
  useEffect(() => {
    let off = false
    const [a, b] = monthRange(ym)
    fetchEvTimes(site, a, b).then((rows) => { if (!off) setCloud({ key, rows }) }).catch(() => { if (!off) setCloud({ key, rows: null }) })
    return () => { off = true }
  }, [key, version])
  return useMemo(() => {
    const merged = new Map<string, EvCharge>()
    if (cloud?.key === key && cloud.rows) for (const r of cloud.rows) merged.set(r.id, r)
    for (const c of Object.values(charges)) {
      if (site && c.site && c.site !== site) continue
      const cur = merged.get(c.id)
      if (!cur || cur.updatedAt <= c.updatedAt) merged.set(c.id, c)
    }
    return { list: [...merged.values()], ready: cloud?.key === key }
  }, [cloud, charges, key, site])
}

/** ยอดเดือน (เดือนนี้ + ย้อนหลังทีละเดือน) · ดูรายวันของเดือนนั้นได้ */
function EvMonthCard() {
  const thisMonth = monthKey()
  const [ym, setYm] = useState(thisMonth)
  const [showDays, setShowDays] = useState(false)
  const { list, ready } = useEvMonth(ym)
  const sum = monthSummary(list, ym)
  const navBtn = 'w-9 h-9 rounded-xl flex items-center justify-center transition disabled:opacity-30'
  return (
    <div className="panel p-3" data-ev-month={ym}>
      <div className="flex items-center gap-2">
        <button className={navBtn} style={{ border: '1px solid var(--line)' }} aria-label="เดือนก่อน" data-ev-month-prev
          onClick={() => { setYm(shiftMonth(ym, -1)); setShowDays(false) }}>
          <ChevronLeft size={17} />
        </button>
        <div className="flex-1 text-center">
          <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>{ym === thisMonth ? 'ยอดเดือนนี้' : 'ยอดเดือน'}</div>
          <div className="text-[15px] font-bold">{fmtMonth(ym)}</div>
        </div>
        <button className={navBtn} style={{ border: '1px solid var(--line)' }} aria-label="เดือนถัดไป" data-ev-month-next
          disabled={ym >= thisMonth} onClick={() => { setYm(shiftMonth(ym, 1)); setShowDays(false) }}>
          <ChevronRight size={17} />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-center">
        {[
          ['ชาร์จเสร็จ', `${sum.finished}`, 'คัน', 'finished'],
          ['เฉลี่ย/คัน', sum.finished ? fmtDuration(sum.avgMs).replace(' ชม.', '') : '—', 'ชม.', 'avg'],
          ['เวลารวม', sum.totalMs ? fmtDuration(sum.totalMs).replace(' ชม.', '') : '—', 'ชม.', 'total'],
        ].map(([label, v, unit, id]) => (
          <div key={id} className="rounded-xl py-2" style={{ background: 'var(--panel-2)' }}>
            <div className="text-[10.5px] font-bold" style={{ color: 'var(--muted)' }}>{label}</div>
            <div className="text-[20px] font-bold tabular leading-tight" style={{ color: EV_ACCENT }} data-ev-month-stat={id}>{v}</div>
            <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>{unit}</div>
          </div>
        ))}
      </div>
      <div className="text-[11.5px] text-center mt-2" style={{ color: 'var(--muted)' }}>
        {ready ? `เริ่มชาร์จในเดือนนี้ ${sum.started} คัน` : 'กำลังโหลด…'}
      </div>
      {sum.days.length > 0 && (
        <button onClick={() => setShowDays(!showDays)} className="w-full mt-2 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ color: EV_ACCENT, background: EV_ACCENT + '12' }} data-ev-month-days>
          {showDays ? 'ซ่อนรายวัน' : `ดูรายวัน (${sum.days.length} วัน)`}
        </button>
      )}
      {showDays && (
        <table className="w-full mt-2 text-[12px] tabular">
          <thead>
            <tr style={{ color: 'var(--muted)' }}>
              <th className="text-left py-1 font-semibold">วันที่</th>
              <th className="text-right py-1 font-semibold">เริ่ม</th>
              <th className="text-right py-1 font-semibold">เสร็จ</th>
              <th className="text-right py-1 font-semibold">เฉลี่ย/คัน</th>
            </tr>
          </thead>
          <tbody>
            {sum.days.map((d) => (
              <tr key={d.day} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="py-1">{fmtDayKey(d.day)}</td>
                <td className="py-1 text-right">{d.started}</td>
                <td className="py-1 text-right font-bold" style={{ color: EV_ACCENT }}>{d.finished}</td>
                <td className="py-1 text-right">{d.finished ? fmtDuration(d.avgMs).replace(' ชม.', '') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
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

      <EvMonthCard />

      <div className="panel p-3">
        <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
          กำลังชาร์จ · แตะเพื่อบันทึกหลังชาร์จ
        </div>
        {charging.length === 0 && <div className="text-[12.5px] py-2" style={{ color: 'var(--muted)' }}>ยังไม่มีรถที่ชาร์จค้างอยู่ — สแกนวินเพื่อเริ่มชาร์จ</div>}
        <div className="space-y-1.5">
          {charging.map((c) => (
            <button key={c.id} onClick={() => onPick(c.vin)} data-ev-open={c.vin}
              className="w-full p-2.5 rounded-xl text-left transition hover:bg-[var(--chip)]"
              style={{ border: '1px solid var(--line)', touchAction: 'manipulation' }}>
              <div className="flex items-center gap-3">
                <BatteryCharging size={18} className="ev-bolt shrink-0" style={{ color: EV_ACCENT }} />
                <div className="min-w-0 flex-1">
                  <div className="mono text-[13px] font-bold truncate">{c.vin}</div>
                  <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{c.model || '—'} · เริ่ม {fmtEvTime(c.beforeAt)}</div>
                </div>
                <div className="text-[12px] font-bold tabular" style={{ color: EV_ACCENT }}>{fmtDuration(chargeMs(c, now))}</div>
              </div>
              <div className="mt-2" style={{ paddingLeft: 30 }}>
                <BatteryPack pct={c.beforePct} charging label={`เริ่ม ${fmtPct(c.beforePct)}`} />
              </div>
            </button>
          ))}
        </div>
      </div>

      {doneToday.length > 0 && (
        <div className="panel p-3">
          <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>เสร็จวันนี้</div>
          <div className="space-y-2.5">
            {doneToday.map((c) => (
              <div key={c.id} className="space-y-1" data-ev-done={c.vin}>
                <div className="flex items-center gap-2 text-[12px]">
                  <CheckCircle2 size={14} style={{ color: EV_ACCENT }} />
                  <span className="mono font-semibold">{c.vin.slice(-8)}</span>
                  <span className="ml-auto tabular font-semibold">{fmtDuration(chargeMs(c))}</span>
                </div>
                <div style={{ paddingLeft: 22 }}>
                  <BatteryPack pct={c.afterPct} height={20} label={`${fmtPct(c.beforePct)} → ${fmtPct(c.afterPct)}`} />
                </div>
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
  const take = async (file: File): Promise<void> => {
    const my = ++token.current
    setBusy(true)
    try {
      const small = await compressToDataUrl(file, 900)
      if (my !== token.current) return
      setPhoto(small)
      storePhoto(small).then((url) => { if (my === token.current) { setPhoto(url); setBusy(false) } })
    } catch {
      if (my === token.current) setBusy(false)
    }
  }
  const clear = () => { token.current++; setPhoto(''); setBusy(false) }
  return { photo, busy, take, clear }
}

/** รูปหน้าจอแบต + ช่อง % ที่พนักงานพิมพ์ตามหน้าจอ */
function useBatteryShot() {
  const ph = usePhoto()
  const [pct, setPct] = useState('')
  return { ...ph, pct, edit: setPct, value: parsePct(pct) }
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
      <div className="text-[11.5px]" style={{ color: bad ? 'var(--st-damage)' : 'var(--muted)' }}>
        {bad ? 'กรอกตัวเลข 0–100' : 'ใส่ตัวเลข % แบตตามที่เห็นบนหน้าจอรถ'}
      </div>
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

  const model = (cells['Model'] || (cells['Model name'] || '').replace(/^BYD\s+/i, '') || unitModel || open?.model || '').trim()
  const color = (cells['Color'] || unitColor || open?.color || '').trim()
  const from = (cells['From'] || open?.from || '').trim()
  const last = list.find((c) => c.vin === vin && !isCharging(c))

  const missing: string[] = []
  if (!open && !vinShot.photo) missing.push('รูปเลขวิน')
  if (!shot.photo) missing.push(open ? 'รูปหลังชาร์จ' : 'รูปก่อนชาร์จ')
  if (shot.value == null) missing.push(open ? '% หลังชาร์จ' : '% ก่อนชาร์จ')
  const uploading = vinShot.busy || shot.busy
  const canSave = !missing.length && !uploading && !saving

  // ช่องในชีตของรถ: สรุปรอบชาร์จ + % SOC = ค่าที่เพิ่งบันทึก (ก่อนชาร์จตอนเริ่ม · หลังชาร์จตอนจบ) ให้หน้า Units เห็นค่าล่าสุด
  const writeCell = (c: EvCharge) => {
    if (!useTracking.getState().rows[vin]) return
    const soc = c.afterAt ? c.afterPct : c.beforePct
    useTracking.getState().updateCells(vin, { [EV_CELL]: evCellText(c), ...(soc != null ? { [SOC_CELL]: String(soc) } : {}) }, 'scan')
  }

  const save = async () => {
    if (!canSave || shot.value == null) return
    const by = useYard.getState().currentUser
    const at = Date.now()
    let c: EvCharge
    if (open) {
      if (shot.value < (open.beforePct ?? 0) && !window.confirm(`% หลังชาร์จ (${shot.value}%) น้อยกว่าก่อนชาร์จ (${open.beforePct}%) — บันทึกต่อไหม`)) return
      c = { ...open, remark: remark.trim(), afterPhoto: shot.photo, afterPct: shot.value, afterAt: at, afterBy: by, updatedAt: at }
    } else {
      c = {
        id: evChargeId(vin, at), site: useYard.getState().currentSite ?? undefined, vin, model, color, from, remark: remark.trim(),
        vinPhoto: vinShot.photo, beforePhoto: shot.photo, beforePct: shot.value, beforeAt: at, beforeBy: by,
        afterPhoto: '', afterPct: null, afterAt: 0, afterBy: '', updatedAt: at,
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
            <div className="mt-1.5"><BatteryPack pct={open.beforePct} charging height={22} label={`เริ่ม ${fmtPct(open.beforePct)}`} /></div>
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
          hint="ถ่ายหน้าจอที่เห็นเปอร์เซ็นต์แบตชัด ๆ"
          photo={shot.photo} busy={shot.busy} onFile={(f) => { shot.take(f) }} onClear={shot.clear} />
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
