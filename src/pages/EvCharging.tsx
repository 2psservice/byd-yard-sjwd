/**
 * EV Charging (แอดมิน) — ตารางงานชาร์จแบตของยาร์ดนี้: รถ · วิน · รุ่น · สี · รูปเลขวิน ·
 * ก่อน/หลังชาร์จ (รูป + % ที่พนักงานบันทึก) · เวลาชาร์จ · สรุปรายวัน (วันละกี่คัน คันละกี่ชั่วโมง)
 * Export Excel ตามไฟล์ "Plan ชาร์จแบต" ที่หน้างานส่ง BYD (3 ชีต: Plan/Actual · รายชื่อรถตามแผน · รูปก่อน-หลัง)
 * เลือกรุ่น / วันละกี่คัน / วันเริ่มแผน ก่อนดาวน์โหลด — ดู lib/evExcel.ts
 */
import { useEffect, useMemo, useState } from 'react'
import { BatteryCharging, Download, Pencil, Search } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useEvCharging } from '../store/useEvCharging'
import { useTracking, useTrackingRows } from '../store/useTracking'
import * as db from '../lib/db'
import { chargeMs, dailySummary, editChargeTimes, evCellText, evModelOf, EV_CELL, fromLocalInput, isCharging, openPause, pausedMs, toLocalInput, fmtDayKey, fmtDuration, fmtEvDate, fmtEvTime, fmtPct, type EvCharge } from '../lib/evCharging'
import { buildEvPlan, evPlanCars, exportEvPlanExcel } from '../lib/evExcel'
import { dateKey } from '../lib/dayKey'
import { rowInSite } from '../lib/siteScope'
import { deriveCarStatus, IN_YARD_STATUSES } from '../lib/carStatus'
import { siteGroupingConfig, yardLocCode } from '../lib/groupingImport'
import { PageHead, Stat, Segmented, PhotoLightbox, Modal } from '../components/ui'
import { BatteryPack, EV_PAUSE } from '../components/BatteryPack'

const ACCENT = '#16a34a'
type StatusFilter = 'all' | 'charging' | 'done'

const firstOfMonth = () => { const d = new Date(); return dateKey(new Date(d.getFullYear(), d.getMonth(), 1)) }
const dayStart = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime() }

function Thumb({ src, pct, onOpen, label }: { src: string; pct?: number | null; onOpen: () => void; label: string }) {
  if (!src) return <span style={{ color: 'var(--faint)' }}>—</span>
  return (
    <button onClick={onOpen} className="relative block mx-auto" title={label} aria-label={label}>
      <img src={src} alt={label} loading="lazy" className="rounded-lg object-cover" style={{ width: 84, height: 63, border: '1px solid var(--line)' }} />
      {pct !== undefined && (
        <span className="absolute bottom-1 right-1 px-1.5 rounded-md text-[11px] font-bold tabular text-white" style={{ background: 'rgba(15,23,42,.78)' }}>{fmtPct(pct)}</span>
      )}
    </button>
  )
}

/** ก่อนดาวน์โหลด: เลือกรุ่นที่อยู่ในแผน · วันละกี่คัน · วันเริ่มแผน (ค่าเริ่มต้น = วันที่เริ่มชาร์จคันแรกในช่วง) */
function EvPlanDialog({ site, ranged, from, onClose }: { site: string | null; ranged: EvCharge[]; from: string; onClose: () => void }) {
  const sites = useYard((s) => s.sites)
  const units = useYard((s) => s.units)
  const toast = useYard((s) => s.toast)
  const rows = useTrackingRows()
  const siteObj = sites.find((x) => x.id === site)
  const siteName = siteObj?.name ?? ''

  const yardCars = useMemo(() => rows
    .filter((r) => rowInSite(r, site, sites) && IN_YARD_STATUSES.has(deriveCarStatus(r.cells)))
    .map((r) => {
      const u = units[r.vin]
      return { vin: r.vin, model: evModelOf(r.cells, u?.modelName), modelName: r.cells['Model name'] || u?.modelName || '', color: r.cells['Color'] || u?.color || '', from: r.cells['From'] || '' }
    })
    .filter((r) => r.model), [rows, site, sites, units])

  const options = useMemo(() => {
    const m = new Map<string, { vins: Set<string>; charged: Set<string> }>()
    const of = (k: string) => { let o = m.get(k); if (!o) m.set(k, (o = { vins: new Set(), charged: new Set() })); return o }
    for (const r of yardCars) of(r.model).vins.add(r.vin)
    for (const c of ranged) if (c.model) { const o = of(c.model); o.vins.add(c.vin); o.charged.add(c.vin) }
    return [...m].map(([model, o]) => ({ model, cars: o.vins.size, charged: o.charged.size }))
      .sort((a, b) => b.charged - a.charged || b.cars - a.cars || a.model.localeCompare(b.model))
  }, [yardCars, ranged])

  const [sel, setSel] = useState<string[]>(() => options.filter((o) => o.charged).map((o) => o.model))
  const [perDay, setPerDay] = useState(4)
  const [start, setStart] = useState('')
  const [busy, setBusy] = useState(false)

  const prefix = siteGroupingConfig(siteName).prefix
  const locOf = (vin: string) => {
    const u = units[vin]
    const code = u && (!u.site || u.site === site) ? yardLocCode({ block: u.block, slot: u.slot }) : ''
    return code ? `${prefix}-${code}` : ''
  }
  const cars = useMemo(() => evPlanCars(sel, yardCars, ranged, () => ''), [sel, yardCars, ranged])
  const vins = useMemo(() => new Set(cars.map((c) => c.vin)), [cars])
  const charges = useMemo(() => ranged.filter((c) => vins.has(c.vin)), [ranged, vins])
  const autoStart = charges.length ? dateKey(new Date(Math.min(...charges.map((c) => c.beforeAt)))) : from
  const startKey = start || autoStart
  const plan = useMemo(() => buildEvPlan(cars, charges, perDay, startKey), [cars, charges, perDay, startKey])
  const doneCars = new Set(charges.filter((c) => !isCharging(c)).map((c) => c.vin)).size

  const download = async () => {
    setBusy(true)
    try {
      const located = evPlanCars(sel, yardCars, ranged, locOf)
      await exportEvPlanExcel({ siteName, siteCode: siteObj?.code ?? '', perDay, start: startKey, cars: located, charges })
      onClose()
    } catch (e: any) {
      toast('err', e?.message || 'สร้างไฟล์ไม่สำเร็จ')
    } finally { setBusy(false) }
  }

  const toggle = (m: string) => setSel((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]))
  const label = 'text-[12px] font-bold uppercase tracking-wider mb-1.5'
  return (
    <Modal open onClose={onClose} title="Export Excel · แผนชาร์จแบต"
      footer={<>
        <button className="btn px-3 py-2 text-[13px]" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary px-3 py-2 text-[13px]" onClick={download} disabled={busy || !cars.length} data-ev-plan-download>
          <Download size={14} /> {busy ? 'กำลังสร้างไฟล์…' : 'ดาวน์โหลด Excel'}
        </button>
      </>}>
      <div className="grid gap-4 text-[13px]" data-ev-plan>
        <div>
          <div className={label} style={{ color: 'var(--muted)' }}>รุ่นที่อยู่ในแผน</div>
          <div className="flex flex-wrap gap-2">
            {options.length === 0 && <span style={{ color: 'var(--faint)' }}>ไม่มีรถในลานนี้</span>}
            {options.map((o) => {
              const on = sel.includes(o.model)
              return (
                <button key={o.model} onClick={() => toggle(o.model)} data-ev-plan-model={o.model} aria-pressed={on}
                  className="px-3 py-1.5 rounded-xl text-[12.5px] font-semibold"
                  style={{ background: on ? `${ACCENT}22` : 'var(--chip)', color: on ? ACCENT : 'var(--text)', border: `1.5px solid ${on ? ACCENT : 'transparent'}` }}>
                  {o.model} · {o.cars} คัน{o.charged ? ` · ชาร์จแล้ว ${o.charged}` : ''}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="grid">
            <span className={label} style={{ color: 'var(--muted)' }}>แผนวันละ (คัน)</span>
            <input type="number" min={1} value={perDay} onChange={(e) => setPerDay(Math.max(1, Math.floor(Number(e.target.value)) || 1))} data-ev-plan-perday
              className="px-3 py-2 rounded-xl w-28 tabular font-bold outline-none" style={{ background: 'var(--chip)' }} />
          </label>
          <label className="grid">
            <span className={label} style={{ color: 'var(--muted)' }}>เริ่มแผนวันที่</span>
            <input type="date" value={startKey} onChange={(e) => setStart(e.target.value)} data-ev-plan-start
              className="px-3 py-2 rounded-xl tabular font-bold outline-none" style={{ background: 'var(--chip)' }} />
          </label>
        </div>
        <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--chip)' }} data-ev-plan-summary>
          {cars.length
            ? <>แผน <b>{cars.length}</b> คัน · {plan.days.length} วัน ({fmtDayKey(plan.days[0])} – {fmtDayKey(plan.days[plan.days.length - 1])}) · ชาร์จเสร็จแล้ว <b style={{ color: ACCENT }}>{doneCars}</b> คัน</>
            : 'เลือกรุ่นอย่างน้อย 1 รุ่น'}
          <div className="text-[12px] mt-1" style={{ color: 'var(--muted)' }}>ไฟล์มี 3 ชีต: Plan / Actual รายวัน · รายชื่อรถตามแผน · รูปก่อน-หลังชาร์จ</div>
        </div>
      </div>
    </Modal>
  )
}

/** แอดมินแก้วันที่ / เวลาเริ่มและเสร็จของรอบชาร์จ — เวลาชาร์จ สรุปรายวัน และ Excel คำนวณใหม่จากเวลาที่แก้
 *  เวลาเดิมเก็บไว้ใน app_config "ev_time_edit:<รอบ>:<เวลาแก้>" ก่อนบันทึกทุกครั้ง (ย้อนดู / คืนค่าได้) */
function EvTimeDialog({ c, onClose }: { c: EvCharge; onClose: () => void }) {
  const toast = useYard((s) => s.toast)
  const by = useYard((s) => s.currentUser)
  const [start, setStart] = useState(() => toLocalInput(c.beforeAt))
  const [end, setEnd] = useState(() => toLocalInput(c.afterAt))
  const [busy, setBusy] = useState(false)
  // รอบนี้ถูกบันทึกใหม่ระหว่างเปิดหน้าต่าง (สถานีบันทึกหลังชาร์จ / หยุดพัก / เครื่องอื่นแก้) — ห้ามบันทึกทับด้วยสำเนาเก่า
  const live = useEvCharging((s) => s.charges[c.id])
  const stale = !!live && live.updatedAt !== c.updatedAt
  const done = !isCharging(c)
  const res = editChargeTimes(c, fromLocalInput(start), fromLocalInput(end))
  const err = 'error' in res ? res.error : ''
  const next = 'ok' in res ? res.ok : null
  const changed = 'ok' in res && res.changed
  const maxNow = toLocalInput(Date.now())

  const save = async () => {
    if (!next || !changed || busy || stale) return
    setBusy(true)
    try {
      if (db.isConfigured()) {
        await db.saveAppConfig(`ev_time_edit:${c.id}:${next.updatedAt}`, {
          id: c.id, vin: c.vin, by, at: next.updatedAt,
          from: { beforeAt: c.beforeAt, afterAt: c.afterAt }, to: { beforeAt: next.beforeAt, afterAt: next.afterAt },
        })
      }
      const cloud = await useEvCharging.getState().save(next)
      // ช่อง EV Charging ในชีตของรถยังเป็นข้อความของรอบนี้ → เขียนใหม่ตามเวลาที่แก้ (รอบใหม่กว่าที่เขียนทับไปแล้วไม่แตะ)
      const row = useTracking.getState().rows[c.vin]
      if (row && row.cells[EV_CELL] === evCellText(c)) useTracking.getState().updateCells(c.vin, { [EV_CELL]: evCellText(next) })
      toast(cloud ? 'ok' : 'info', cloud ? `แก้เวลา ${c.vin} แล้ว` : `แก้เวลา ${c.vin} แล้ว · ยังไม่ขึ้นระบบ จะส่งให้เองเมื่อเชื่อมต่อได้`)
      onClose()
    } catch (e: any) {
      toast('err', `บันทึกไม่สำเร็จ: ${e?.message || e}`)
    } finally { setBusy(false) }
  }

  const label = 'text-[12px] font-bold uppercase tracking-wider mb-1.5'
  const input = 'px-3 py-2 rounded-xl tabular font-bold outline-none'
  return (
    <Modal open onClose={onClose} title="แก้วันที่ / เวลาชาร์จ"
      footer={<>
        <button className="btn px-3 py-2 text-[13px]" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary px-3 py-2 text-[13px]" onClick={save} disabled={busy || !changed || !!err || stale} data-ev-time-save>
          {busy ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </>}>
      <div className="grid gap-4 text-[13px]" data-ev-time-dialog={c.vin}>
        <div>
          <div className="mono font-bold">{c.vin}</div>
          <div style={{ color: 'var(--muted)' }}>{[c.model, c.color].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="grid">
            <span className={label} style={{ color: 'var(--muted)' }}>เริ่มชาร์จ</span>
            <input type="datetime-local" value={start} max={maxNow} onChange={(e) => setStart(e.target.value)} data-ev-time-start
              className={input} style={{ background: 'var(--chip)' }} />
          </label>
          <label className="grid">
            <span className={label} style={{ color: 'var(--muted)' }}>ชาร์จเสร็จ</span>
            {done
              ? <input type="datetime-local" value={end} max={maxNow} onChange={(e) => setEnd(e.target.value)} data-ev-time-end
                  className={input} style={{ background: 'var(--chip)' }} />
              : <span className="px-3 py-2 rounded-xl font-semibold" style={{ background: 'var(--chip)', color: ACCENT }}>ยังชาร์จอยู่</span>}
          </label>
        </div>
        <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--chip)' }} data-ev-time-preview>
          {next && done ? <>เวลาชาร์จ <b>{fmtDuration(chargeMs(next))}</b></> : next ? 'เวลาเสร็จแก้ได้หลังสถานีบันทึกหลังชาร์จ' : '—'}
          {(c.pauses?.length ?? 0) > 0 && <span style={{ color: EV_PAUSE }}> · หยุดพัก {c.pauses!.length} ครั้ง ไม่นับเป็นเวลาชาร์จ</span>}
        </div>
        {err && <div className="text-[12.5px] font-semibold" style={{ color: 'var(--st-damage)' }} data-ev-time-error>{err}</div>}
        {stale && <div className="text-[12.5px] font-semibold" style={{ color: 'var(--st-damage)' }} data-ev-time-stale>รอบนี้เพิ่งถูกบันทึกใหม่ระหว่างที่เปิดหน้าต่างนี้ ปิดแล้วเปิดใหม่อีกครั้งเพื่อแก้จากข้อมูลล่าสุด</div>}
      </div>
    </Modal>
  )
}

export function EvCharging() {
  const site = useYard((s) => s.currentSite)
  const isAdmin = useYard((s) => s.appUsers.find((u) => u.id === s.loggedInUserId)?.role === 'admin')
  const [editing, setEditing] = useState<EvCharge | null>(null)
  const charges = useEvCharging((s) => s.charges)
  const cloudMissing = useEvCharging((s) => s.cloudMissing)
  const pausesMissing = useEvCharging((s) => s.pausesMissing)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => dateKey(new Date()))
  const [status, setStatus] = useState<StatusFilter>('all')
  const [q, setQ] = useState('')
  const [view, setView] = useState<{ photos: string[]; i: number } | null>(null)
  const [planOpen, setPlanOpen] = useState(false)

  useEffect(() => { useEvCharging.getState().load(site ?? null, dayStart(from)).catch(() => {}) }, [site, from])

  const ranged = useMemo(() => {
    const lo = dayStart(from), hi = dayStart(to) + 86_400_000
    return Object.values(charges)
      .filter((c) => !site || !c.site || c.site === site)
      // a car still on the charger is current work — shown whatever the range
      .filter((c) => isCharging(c) || (c.beforeAt >= lo && c.beforeAt < hi))
  }, [charges, site, from, to])
  const list = useMemo(() => {
    const needle = q.trim().toUpperCase()
    return ranged
      .filter((c) => status === 'all' || (status === 'charging') === isCharging(c))
      .filter((c) => !needle || c.vin.includes(needle) || c.model.toUpperCase().includes(needle))
      .sort((a, b) => b.beforeAt - a.beforeAt)
  }, [ranged, status, q])

  const days = useMemo(() => dailySummary(list), [list])
  const done = list.filter((c) => !isCharging(c))
  const avgMs = done.length ? done.reduce((s, c) => s + chargeMs(c), 0) / done.length : 0
  const today = days.find((d) => d.day === dateKey(new Date()))

  const open = (c: EvCharge, which: 0 | 1 | 2) => {
    const photos = [c.vinPhoto, c.beforePhoto, c.afterPhoto]
    const shown = photos.filter(Boolean)
    setView({ photos: shown, i: Math.max(0, shown.indexOf(photos[which])) })
  }

  return (
    <div className="w-full">
      <div className="panel p-4 mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <PageHead
            title={<span className="flex items-center gap-2"><BatteryCharging size={20} style={{ color: ACCENT }} /> EV Charging</span>}
            sub="งานชาร์จแบตจากสถานี EV Charging (Ops Scan) — รูปเลขวิน · รูป/เปอร์เซ็นต์ก่อนและหลังชาร์จ · เวลาชาร์จต่อคัน · สรุปรายวัน"
          />
        </div>
        <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--chip)' }}>
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>ตั้งแต่</span>
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="ตั้งแต่วันที่"
            className="bg-transparent outline-none text-[13px] font-bold tabular" style={{ color: 'var(--brand)' }} />
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>ถึง</span>
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="ถึงวันที่"
            className="bg-transparent outline-none text-[13px] font-bold tabular" style={{ color: 'var(--brand)' }} />
        </label>
        <button className="btn btn-primary px-3 py-2 text-[12.5px]" onClick={() => setPlanOpen(true)} data-ev-export
          title="ไฟล์แผนชาร์จแบต 3 ชีต: Plan / Actual รายวัน · รายชื่อรถตามแผน · รูปก่อน-หลังชาร์จ">
          <Download size={14} /> Export Excel
        </button>
      </div>

      {cloudMissing && (
        <div className="panel p-3 mb-4 text-[13px]" style={{ color: 'var(--st-damage)' }}>
          ยังอ่านตาราง ev_charges ไม่ได้ — รันไฟล์ supabase-ev-charging.sql ใน Supabase SQL Editor หนึ่งครั้ง
        </div>
      )}
      {!cloudMissing && pausesMissing && (
        <div className="panel p-3 mb-4 text-[13px]" style={{ color: EV_PAUSE }} data-ev-pauses-missing>
          ตาราง ev_charges ยังไม่มีช่องเก็บเวลาหยุดพัก — รันไฟล์ supabase-ev-charging.sql ใน Supabase SQL Editor อีกครั้ง
          (ข้อมูลอื่นขึ้นระบบแล้ว เวลาหยุดพักเก็บไว้ในเครื่องที่บันทึก และจะส่งให้เองหลังรัน)
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="รถในช่วงนี้" value={list.length} sub="คัน" accent={ACCENT} />
        <Stat label="ชาร์จเสร็จ" value={done.length} sub={today ? `วันนี้ ${today.finished} คัน` : 'วันนี้ 0 คัน'} accent={ACCENT} />
        <Stat label="กำลังชาร์จ" value={list.length - done.length} sub={list.some((c) => isCharging(c) && openPause(c)) ? `หยุดพัก ${list.filter((c) => isCharging(c) && openPause(c)).length} คัน` : 'คัน'} />
        <Stat label="เฉลี่ยต่อคัน" value={done.length ? fmtDuration(avgMs) : '—'} sub="เวลาชาร์จ" />
      </div>

      <div className="grid 2xl:grid-cols-[300px_1fr] gap-4 items-start">
        {/* daily summary */}
        <div className="panel p-3">
          <div className="text-[12px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>สรุปรายวัน · วันละกี่คัน คันละกี่ชั่วโมง</div>
          <div className="overflow-auto" style={{ maxHeight: 260 }}>
            <table className="w-full text-[12.5px] tabular" data-ev-days>
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  <th className="text-left py-1.5 font-semibold">วันที่</th>
                  <th className="text-right py-1.5 font-semibold">เริ่ม</th>
                  <th className="text-right py-1.5 font-semibold">เสร็จ</th>
                  <th className="text-right py-1.5 font-semibold">เฉลี่ย/คัน</th>
                </tr>
              </thead>
              <tbody>
                {days.length === 0 && <tr><td colSpan={4} className="py-3 text-center" style={{ color: 'var(--faint)' }}>ไม่มีข้อมูล</td></tr>}
                {days.map((d) => (
                  <tr key={d.day} style={{ borderTop: '1px solid var(--line)' }}>
                    <td className="py-1.5">{fmtEvDate(dayStart(d.day))}</td>
                    <td className="py-1.5 text-right">{d.started}</td>
                    <td className="py-1.5 text-right font-bold" style={{ color: ACCENT }}>{d.finished}</td>
                    <td className="py-1.5 text-right">{d.finished ? fmtDuration(d.avgMs).replace(' ชม.', '') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* register */}
        <div className="panel p-3 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <Segmented<StatusFilter> value={status} onChange={setStatus}
              options={[{ value: 'all', label: 'ทั้งหมด' }, { value: 'charging', label: 'กำลังชาร์จ' }, { value: 'done', label: 'เสร็จแล้ว' }]} />
            <label className="flex items-center gap-2 px-3 py-2 rounded-xl ml-auto" style={{ background: 'var(--chip)' }}>
              <Search size={14} style={{ color: 'var(--muted)' }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา VIN / รุ่น" aria-label="ค้นหา VIN หรือรุ่น"
                className="bg-transparent outline-none text-[13px] w-44" />
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] tabular" style={{ minWidth: 1500 }} data-ev-table>
              <thead>
                <tr style={{ color: 'var(--muted)', background: 'var(--chip)' }}>
                  {['No', 'From', 'Vin Number', 'Model', 'Color', 'Export Label', 'Before', 'After', 'แบตเตอรี่', 'เวลาชาร์จ', 'Date', 'เริ่ม', 'เสร็จ', 'Remark', 'ผู้บันทึก'].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold text-center whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr><td colSpan={15} className="py-8 text-center" style={{ color: 'var(--faint)' }}>ยังไม่มีงานชาร์จในช่วงนี้ — เริ่มได้ที่ Yard Ops › EV Charging</td></tr>
                )}
                {list.map((c, i) => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--line)' }} data-ev-row={c.vin}>
                    <td className="px-2 py-2 text-center">{i + 1}</td>
                    <td className="px-2 py-2 text-center">{c.from || '—'}</td>
                    <td className="px-2 py-2 mono font-semibold whitespace-nowrap">{c.vin}</td>
                    <td className="px-2 py-2 text-center">{c.model || '—'}</td>
                    <td className="px-2 py-2 text-center">{c.color || '—'}</td>
                    <td className="px-2 py-2"><Thumb src={c.vinPhoto} onOpen={() => open(c, 0)} label={`รูปเลขวิน ${c.vin}`} /></td>
                    <td className="px-2 py-2"><Thumb src={c.beforePhoto} pct={c.beforePct} onOpen={() => open(c, 1)} label={`ก่อนชาร์จ ${c.vin}`} /></td>
                    <td className="px-2 py-2">{c.afterPhoto ? <Thumb src={c.afterPhoto} pct={c.afterPct} onOpen={() => open(c, 2)} label={`หลังชาร์จ ${c.vin}`} />
                      : isCharging(c) && openPause(c)
                        ? <span className="block text-center text-[11.5px] font-semibold" style={{ color: EV_PAUSE }} data-ev-paused>หยุดพัก {fmtEvTime(openPause(c)!.at)}</span>
                        : <span className="block text-center text-[11.5px] font-semibold" style={{ color: ACCENT }}>กำลังชาร์จ</span>}</td>
                    <td className="px-2 py-2" style={{ minWidth: 250 }}>
                      {isCharging(c)
                        ? <BatteryPack pct={c.beforePct} charging={!openPause(c)} height={22} label={`${openPause(c) ? 'หยุดพัก · ' : ''}เริ่ม ${fmtPct(c.beforePct)}`} />
                        : <BatteryPack pct={c.afterPct} height={22} label={`${fmtPct(c.beforePct)} → ${fmtPct(c.afterPct)}`} />}
                    </td>
                    <td className="px-2 py-2 text-center font-bold whitespace-nowrap" data-ev-hours style={{ color: c.afterAt ? 'var(--text)' : 'var(--faint)' }}>
                      {c.afterAt ? fmtDuration(chargeMs(c)) : '—'}
                      {(c.pauses?.length ?? 0) > 0 && (
                        <div className="text-[11px] font-semibold" style={{ color: EV_PAUSE }} data-ev-row-paused title={`หยุดพัก ${c.pauses!.length} ครั้ง`}>
                          พัก {fmtDuration(pausedMs(c))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center whitespace-nowrap">
                      {fmtEvDate(c.beforeAt)}
                      {isAdmin && (
                        <button className="ml-1.5 align-middle opacity-50 hover:opacity-100" onClick={() => setEditing(c)} data-ev-edit-time={c.vin}
                          title="แก้วันที่ / เวลา" aria-label={`แก้วันที่ เวลา ${c.vin}`} style={{ color: 'var(--brand)' }}>
                          <Pencil size={13} />
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center">{fmtEvTime(c.beforeAt)}</td>
                    <td className="px-2 py-2 text-center whitespace-nowrap">{c.afterAt ? `${fmtEvDate(c.afterAt) !== fmtEvDate(c.beforeAt) ? fmtEvDate(c.afterAt) + ' ' : ''}${fmtEvTime(c.afterAt)}` : '—'}</td>
                    <td className="px-2 py-2 text-center">{c.remark || '—'}</td>
                    <td className="px-2 py-2 text-center text-[11.5px]" style={{ color: 'var(--muted)' }}>
                      {[c.beforeBy, c.afterBy].filter(Boolean).filter((v, k, a) => a.indexOf(v) === k).join(' / ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {view && <PhotoLightbox photos={view.photos} index={view.i} onClose={() => setView(null)} />}
      {editing && <EvTimeDialog c={editing} onClose={() => setEditing(null)} />}
      {planOpen && <EvPlanDialog site={site ?? null} ranged={ranged} from={from} onClose={() => setPlanOpen(false)} />}
    </div>
  )
}
