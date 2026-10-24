/**
 * EV Charging (แอดมิน) — ตารางงานชาร์จแบตของยาร์ดนี้: รถ · วิน · รุ่น · สี · รูปเลขวิน ·
 * ก่อน/หลังชาร์จ (รูป + % ที่พนักงานบันทึก) · เวลาชาร์จ · สรุปรายวัน (วันละกี่คัน คันละกี่ชั่วโมง)
 * Export Excel ตามรูปแบบไฟล์ที่หน้างานใช้ (รูปฝังในเซลล์) — ดู lib/evExcel.ts
 */
import { useEffect, useMemo, useState } from 'react'
import { BatteryCharging, Download, Search } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useEvCharging } from '../store/useEvCharging'
import { chargeMs, dailySummary, isCharging, fmtDuration, fmtEvDate, fmtEvTime, fmtPct, type EvCharge } from '../lib/evCharging'
import { dateKey } from '../lib/dayKey'
import { fileStamp } from '../lib/printDoc'
import { PageHead, Stat, Segmented, PhotoLightbox } from '../components/ui'

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

export function EvCharging() {
  const site = useYard((s) => s.currentSite)
  const charges = useEvCharging((s) => s.charges)
  const cloudMissing = useEvCharging((s) => s.cloudMissing)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => dateKey(new Date()))
  const [status, setStatus] = useState<StatusFilter>('all')
  const [q, setQ] = useState('')
  const [view, setView] = useState<{ photos: string[]; i: number } | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => { useEvCharging.getState().load(site ?? null, dayStart(from)).catch(() => {}) }, [site, from])

  const list = useMemo(() => {
    const lo = dayStart(from), hi = dayStart(to) + 86_400_000
    const needle = q.trim().toUpperCase()
    return Object.values(charges)
      .filter((c) => !site || !c.site || c.site === site)
      // a car still on the charger is current work — shown whatever the range
      .filter((c) => isCharging(c) || (c.beforeAt >= lo && c.beforeAt < hi))
      .filter((c) => status === 'all' || (status === 'charging') === isCharging(c))
      .filter((c) => !needle || c.vin.includes(needle) || c.model.toUpperCase().includes(needle))
      .sort((a, b) => b.beforeAt - a.beforeAt)
  }, [charges, site, from, to, status, q])

  const days = useMemo(() => dailySummary(list), [list])
  const done = list.filter((c) => !isCharging(c))
  const avgMs = done.length ? done.reduce((s, c) => s + chargeMs(c), 0) / done.length : 0
  const today = days.find((d) => d.day === dateKey(new Date()))

  const doExport = async () => {
    setExporting(true)
    try {
      const { exportEvChargingExcel } = await import('../lib/evExcel')
      await exportEvChargingExcel(list, `EV Charging ${fileStamp()}.xlsx`)
    } finally { setExporting(false) }
  }

  const open = (c: EvCharge, which: 0 | 1 | 2) => {
    const photos = [c.vinPhoto, c.beforePhoto, c.afterPhoto]
    const shown = photos.filter(Boolean)
    setView({ photos: shown, i: Math.max(0, shown.indexOf(photos[which])) })
  }

  return (
    <div className="max-w-[1500px] mx-auto">
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
        <button className="btn btn-primary px-3 py-2 text-[12.5px]" onClick={doExport} disabled={exporting || !list.length} data-ev-export
          title="ออกไฟล์ Excel ตามรูปแบบเดิม (รูปเลขวิน / ก่อน / หลังชาร์จ ฝังในเซลล์) + ชีตสรุปรายวัน">
          <Download size={14} /> {exporting ? 'กำลังสร้างไฟล์…' : 'Export Excel'}
        </button>
      </div>

      {cloudMissing && (
        <div className="panel p-3 mb-4 text-[13px]" style={{ color: 'var(--st-damage)' }}>
          ยังอ่านตาราง ev_charges ไม่ได้ — รันไฟล์ supabase-ev-charging.sql ใน Supabase SQL Editor หนึ่งครั้ง
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="รถในช่วงนี้" value={list.length} sub="คัน" accent={ACCENT} />
        <Stat label="ชาร์จเสร็จ" value={done.length} sub={today ? `วันนี้ ${today.finished} คัน` : 'วันนี้ 0 คัน'} accent={ACCENT} />
        <Stat label="กำลังชาร์จ" value={list.length - done.length} sub="คัน" />
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
            <table className="w-full text-[12.5px] tabular" style={{ minWidth: 1250 }} data-ev-table>
              <thead>
                <tr style={{ color: 'var(--muted)', background: 'var(--chip)' }}>
                  {['No', 'From', 'Vin Number', 'Model', 'Color', 'Export Label', 'Before', 'After', 'เวลาชาร์จ', 'Date', 'เริ่ม', 'เสร็จ', 'Remark', 'ผู้บันทึก'].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold text-center whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr><td colSpan={14} className="py-8 text-center" style={{ color: 'var(--faint)' }}>ยังไม่มีงานชาร์จในช่วงนี้ — เริ่มได้ที่ Yard Ops › EV Charging</td></tr>
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
                    <td className="px-2 py-2">{c.afterPhoto ? <Thumb src={c.afterPhoto} pct={c.afterPct} onOpen={() => open(c, 2)} label={`หลังชาร์จ ${c.vin}`} /> : <span className="block text-center text-[11.5px] font-semibold" style={{ color: ACCENT }}>กำลังชาร์จ</span>}</td>
                    <td className="px-2 py-2 text-center font-bold whitespace-nowrap" data-ev-hours style={{ color: c.afterAt ? 'var(--text)' : 'var(--faint)' }}>
                      {c.afterAt ? fmtDuration(chargeMs(c)) : '—'}
                    </td>
                    <td className="px-2 py-2 text-center whitespace-nowrap">{fmtEvDate(c.beforeAt)}</td>
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
    </div>
  )
}
