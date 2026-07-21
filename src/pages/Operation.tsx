/**
 * Operation — admin work-queue board. Create queues (PM / Wash for sale / PDI /
 * FINAL CHECK / custom), drop VINs in, and track a live countdown + per-vehicle
 * progress. Styled after the lot/"ลำดับงาน" reference.
 */
import { useMemo, useRef, useState } from 'react'
import {
  ClipboardList, Plus, X, Search, Trash2, Check, Car, Wrench, Sparkles,
  ShieldCheck, ClipboardCheck, Layers, QrCode, ListChecks, CheckCircle2, MapPin,
} from 'lucide-react'
import { useOps, useActiveQueues, queueProgress, isSequenceQueue, queueTypeOf, QUEUE_TYPES, type QueueType, type WorkQueue } from '../store/useOps'
import { useTrackingRows } from '../store/useTracking'
import { useYard, useUnits } from '../store/useYard'
import { siteGroupingConfig, yardLocCode, byYardLocation } from '../lib/groupingImport'
import { PageHead, cx } from '../components/ui'

const typeIcon = (type: QueueType, size = 18) => {
  switch (type) {
    case 'PM': return <Wrench size={size} />
    case 'WASH': return <Sparkles size={size} />
    case 'PDI': return <ShieldCheck size={size} />
    case 'FINAL': return <ClipboardCheck size={size} />
    default: return <Layers size={size} />
  }
}
const queueIcon = (q: WorkQueue, size = 18) => typeIcon(queueTypeOf(q), size)

/** What each queue type stamps back into a finished car's Overview. */
const TYPE_WRITEBACK: Record<QueueType, string> = {
  PM: 'ลงวันที่ในช่อง PM ถัดไป (PM1→PM15)',
  PDI: 'ลงวันที่ PDI ครั้งแรก · ครั้งถัดไปลง RE-PDI',
  FINAL: 'ลงวันที่ในช่อง Final check date',
  WASH: 'บันทึกใน Event log',
  SPECIAL: 'บันทึกใน Event log',
}

// queues auto-created by import ("(M-D-N)" pre-gate-in) don't belong on this board
const isPreGateInQueue = (name: string) => name.trim().startsWith('(')

export function Operation() {
  const all = useActiveQueues() // gated-out cars filtered out of every queue view
  const { createTypedQueue } = useOps()
  const toast = useYard((s) => s.toast)
  const currentUser = useYard((s) => s.currentUser)
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const [type, setType] = useState<QueueType>('PM')
  const [label, setLabel] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const siteName = sites.find((s) => s.id === currentSite)?.name ?? ''

  // ── per-site scope: work queues are separated by yard, never combined ──
  const queues = useMemo(
    () => all.filter((q) =>
      !isSequenceQueue(q) && !isPreGateInQueue(q.name) &&
      (!currentSite || !q.site || q.site === currentSite),
    ),
    [all, currentSite],
  )

  const totals = useMemo(() => {
    let vehicles = 0, done = 0
    for (const q of queues) { vehicles += q.items.length; done += q.items.reduce((n, i) => n + (i.done ? 1 : 0), 0) }
    return { queues: queues.length, vehicles, done, remaining: vehicles - done }
  }, [queues])

  const make = () => {
    const l = label.trim()
    if (type === 'SPECIAL' && !l) { toast('err', 'ใส่ชื่องานพิเศษก่อน'); return }
    const typeName = QUEUE_TYPES.find((t) => t.type === type)?.name ?? type
    const name = type === 'SPECIAL' ? l : (l ? `${typeName} · ${l}` : typeName)
    createTypedQueue(type, name, currentUser)
    setLabel('')
    toast('ok', `สร้างคิวงาน "${name}"`)
  }

  const openQueue = openId ? queues.find((q) => q.id === openId) ?? null : null

  return (
    <div className="max-w-[1200px] mx-auto">
      <PageHead
        title={<span className="flex items-center gap-2"><ClipboardList size={20} style={{ color: 'var(--brand)' }} /> Operation · คิวงาน</span>}
        sub={<span className="flex items-center gap-1.5">สร้างคิวงาน PDI / PM / FINAL CHECK หรืองานพิเศษ · บันทึกเสร็จแล้วข้อมูลเข้า Overview{siteName && <><span style={{ color: 'var(--line-strong)' }}>·</span><MapPin size={12} style={{ color: 'var(--brand)' }} /><b style={{ color: 'var(--brand)' }}>{siteName}</b></>}</span>}
      />

      {/* totals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="คิวงาน" value={totals.queues} accent="var(--brand)" icon={<Layers size={16} />} />
        <Stat label="รถทั้งหมด" value={totals.vehicles} accent="var(--text)" icon={<Car size={16} />} />
        <Stat label="เสร็จ" value={totals.done} accent="var(--st-yard)" icon={<CheckCircle2 size={16} />} />
        <Stat label="คงเหลือ" value={totals.remaining} accent="#d97706" icon={<ListChecks size={16} />} />
      </div>

      {/* create */}
      <div className="panel p-4 mb-4">
        <div className="text-[11px] font-bold uppercase tracking-wider mb-2.5" style={{ color: 'var(--muted)' }}>สร้างคิวงานใหม่</div>
        {/* type picker */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {QUEUE_TYPES.map((t) => {
            const on = type === t.type
            return (
              <button key={t.type} onClick={() => setType(t.type)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-semibold transition-all active:scale-95"
                style={on
                  ? { background: 'var(--brand)', color: '#fff', border: '1px solid var(--brand)' }
                  : { background: 'var(--brand-soft, #eef4ff)', color: 'var(--brand)', border: '1px solid rgba(37,99,235,0.2)' }}>
                {typeIcon(t.type, 14)} {t.th}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input py-2 text-[13.5px] flex-1" style={{ minWidth: 220 }}
            placeholder={type === 'SPECIAL' ? 'ชื่องานพิเศษ (เช่น เปลี่ยนล้อ Lot 5, ตรวจกระจก)…' : 'ระบุ Lot / รายละเอียด (ไม่ใส่ก็ได้ เช่น Lot 3)…'}
            value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') make() }} />
          <button className="btn btn-primary px-4 py-2" onClick={make}>
            <Plus size={16} /> สร้างคิว
          </button>
        </div>
        <div className="text-[11.5px] mt-2 flex items-center gap-1.5" style={{ color: 'var(--faint)' }}>
          <CheckCircle2 size={12} /> เมื่อกด “เสร็จ” ระบบจะ{TYPE_WRITEBACK[type]} · สร้างคิวเดิมซ้ำได้หลายครั้ง (หลาย lot)
        </div>
      </div>

      {/* queues */}
      {queues.length === 0 ? (
        <div className="panel p-12 text-center" style={{ color: 'var(--faint)' }}>
          <ClipboardList size={36} className="mx-auto mb-3" style={{ color: 'var(--line-strong)' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--muted)' }}>ยังไม่มีคิวงาน{siteName && ` ใน ${siteName}`}</div>
          <div className="text-[13px] mt-1">เลือกประเภทด้านบน (PM / PDI / FINAL CHECK / งานพิเศษ) แล้วกดสร้างคิว</div>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b hairline" style={{ background: 'var(--chip)' }}>
                  {['คิวงาน', 'ประเภท', 'รถทั้งหมด', 'เสร็จ', 'ความคืบหน้า', 'สถานะ', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[11.5px] font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}>
                {queues.map((q) => <QueueRow key={q.id} q={q} onOpen={() => setOpenId(q.id)} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {openQueue && <QueueDetail q={openQueue} onClose={() => setOpenId(null)} />}
    </div>
  )
}

const TYPE_BADGE: Record<QueueType, { th: string; color: string; bg: string }> = {
  PM: { th: 'PM', color: '#c2680b', bg: 'rgba(194,104,11,0.12)' },
  PDI: { th: 'PDI', color: '#7c3aed', bg: 'rgba(124,58,237,0.12)' },
  FINAL: { th: 'FINAL CHECK', color: '#0891b2', bg: 'rgba(8,145,178,0.12)' },
  WASH: { th: 'Wash', color: '#2563eb', bg: 'rgba(37,99,235,0.12)' },
  SPECIAL: { th: 'งานพิเศษ', color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
}

function Stat({ label, value, accent, icon }: { label: string; value: number; accent: string; icon: React.ReactNode }) {
  return (
    <div className="panel p-3.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>{label}</span>
        <span style={{ color: accent }}>{icon}</span>
      </div>
      <div className="display text-[28px] font-black tabular leading-none" style={{ color: accent }}>{value.toLocaleString()}</div>
    </div>
  )
}

function QueueRow({ q, onOpen }: { q: WorkQueue; onOpen: () => void }) {
  const removeQueue = useOps((s) => s.removeQueue)
  const { total, done, remaining, pct } = queueProgress(q)
  const complete = total > 0 && remaining === 0
  const empty = total === 0 // no cars left (e.g. all gated out) — nothing to do
  const badge = TYPE_BADGE[queueTypeOf(q)]

  return (
    <tr className="hover:bg-chip transition-colors cursor-pointer" onClick={onOpen}>
      {/* queue name */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: complete ? 'rgba(34,197,94,0.14)' : 'var(--brand-soft, #eef4ff)', color: complete ? 'var(--st-yard)' : 'var(--brand)' }}>
            {complete ? <Check size={16} /> : queueIcon(q, 15)}
          </div>
          <span className="font-bold clip" style={{ color: 'var(--brand)' }}>{q.name}</span>
        </div>
      </td>
      {/* type */}
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap" style={{ color: badge.color, background: badge.bg }}>
          {badge.th}
        </span>
      </td>
      {/* total */}
      <td className="px-4 py-3 tabular whitespace-nowrap">{total.toLocaleString()} คัน</td>
      {/* done */}
      <td className="px-4 py-3 tabular font-semibold whitespace-nowrap" style={{ color: complete ? 'var(--st-yard)' : 'var(--text)' }}>{done}/{total}</td>
      {/* progress */}
      <td className="px-4 py-3" style={{ minWidth: 160 }}>
        <div className="flex items-center gap-2">
          <div className="track flex-1"><div className="fill" style={{ width: `${pct}%`, background: complete ? 'var(--st-yard)' : undefined }} /></div>
          <span className="text-[11.5px] font-bold tabular shrink-0" style={{ color: complete ? 'var(--st-yard)' : 'var(--muted)', minWidth: 30 }}>{pct}%</span>
        </div>
      </td>
      {/* status */}
      <td className="px-4 py-3">
        {empty ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-semibold border whitespace-nowrap"
            style={{ background: 'var(--chip)', color: 'var(--muted)', borderColor: 'var(--line)' }}>
            ไม่มีรถในคิว
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-semibold border whitespace-nowrap"
            style={complete
              ? { background: 'rgba(22,163,74,0.1)', color: '#16a34a', borderColor: 'rgba(22,163,74,0.25)' }
              : { background: 'rgba(217,119,6,0.1)', color: '#d97706', borderColor: 'rgba(217,119,6,0.25)' }}>
            {complete ? <CheckCircle2 size={12} /> : <ListChecks size={12} />}
            {complete ? 'เสร็จสมบูรณ์' : `เหลือ ${remaining}`}
          </span>
        )}
      </td>
      {/* actions */}
      <td className="px-4 py-3">
        <button
          onClick={(e) => { e.stopPropagation(); if (window.confirm(`ลบคิวงาน "${q.name}" ?`)) removeQueue(q.id) }}
          className="btn p-1.5" title="ลบคิวงาน"
          style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>
          <Trash2 size={13} />
        </button>
      </td>
    </tr>
  )
}

function QueueDetail({ q, onClose }: { q: WorkQueue; onClose: () => void }) {
  const { addVins, removeVin, toggleDone, setAllDone } = useOps()
  const toast = useYard((s) => s.toast)
  const currentUser = useYard((s) => s.currentUser)
  const rows = useTrackingRows()
  const units = useUnits()
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const [search, setSearch] = useState('')
  const [bulk, setBulk] = useState('')
  const [adding, setAdding] = useState(false)
  const addRef = useRef<HTMLTextAreaElement>(null)

  const { total, done, remaining, pct } = queueProgress(q)

  // Same per-car detail the Gate-out queue shows — model · color · grouping + the
  // yard location and loading lane — so the office reads one consistent card
  // everywhere, ordered the way a driver walks the yard (block A→B→…→WCL, col ↑).
  const locPrefix = useMemo(
    () => siteGroupingConfig(sites.find((s) => s.id === currentSite)?.name ?? '').prefix,
    [sites, currentSite],
  )
  const shown = useMemo(() => {
    const rowByVin = new Map(rows.map((r) => [r.vin, r]))
    const unitByVin = new Map(units.map((u) => [u.vin, u]))
    const s = search.trim().toUpperCase()
    return q.items
      .map((it) => {
        const r = rowByVin.get(it.vin)
        const u = unitByVin.get(it.vin)
        return {
          it,
          model: r?.cells['Model'] || r?.cells['Model name'] || u?.modelName || '—',
          color: r?.cells['Color'] || u?.color || '—',
          grouping: r?.cells['Grouping  Number'] || '—',
          location: yardLocCode(u, locPrefix) || '—',
          lane: it.laneLoad || '—',
        }
      })
      .filter((c) => !s || c.it.vin.toUpperCase().includes(s))
      .sort((a, b) => byYardLocation(a.location, b.location))
  }, [q.items, rows, units, locPrefix, search])

  const doAdd = () => {
    const tokens = bulk.toUpperCase().match(/[A-Z0-9]{5,20}/g) ?? []
    if (!tokens.length) { toast('err', 'ไม่พบเลข VIN'); return }
    const { added, dup } = addVins(q.id, tokens)
    toast('ok', `เพิ่ม ${added} คัน${dup ? ` · ซ้ำ ${dup}` : ''}`)
    setBulk(''); setAdding(false)
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid glow-ring pop w-full overflow-hidden flex flex-col" style={{ maxWidth: 620, maxHeight: '92vh' }} onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="px-5 py-4 shrink-0" style={{ background: 'linear-gradient(135deg,#0d1726,#1b2c45)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff' }}>
              {queueIcon(q, 20)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold text-[17px] text-white leading-tight clip">{q.name}</div>
              <div className="text-[12.5px]" style={{ color: 'rgba(255,255,255,0.6)' }}>
                เหลือ <b style={{ color: remaining > 0 ? '#fbbf24' : '#4ade80' }}>{remaining}</b> · เสร็จ {done}/{total} คัน
              </div>
            </div>
            <button className="p-1.5 rounded-lg shrink-0" style={{ color: 'rgba(255,255,255,0.7)' }} onClick={onClose}><X size={18} /></button>
          </div>
          {/* progress */}
          <div className="mt-3">
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.14)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: remaining === 0 && total > 0 ? '#4ade80' : '#60a5fa' }} />
            </div>
            <div className="text-right text-[11px] mt-1 font-semibold" style={{ color: 'rgba(255,255,255,0.6)' }}>{pct}%</div>
          </div>
        </div>

        {/* toolbar */}
        <div className="p-3 border-b hairline shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl flex-1" style={{ background: 'var(--chip)' }}>
              <Search size={15} style={{ color: 'var(--muted)' }} />
              <input className="bg-transparent outline-none text-[13px] w-full vin" placeholder="ค้นหา 5 ตัวท้าย VIN…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <button onClick={() => setSearch('')}><X size={14} style={{ color: 'var(--muted)' }} /></button>}
            </div>
            <button className={cx('btn px-3 py-2', adding && 'btn-blue')} onClick={() => { setAdding((v) => !v); setTimeout(() => addRef.current?.focus(), 0) }}>
              <Plus size={15} /> ใส่ VIN
            </button>
          </div>
          {adding && (
            <div className="fade-up">
              <textarea ref={addRef} className="input" style={{ minHeight: 76, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                placeholder={'วาง/พิมพ์เลข VIN (เว้นวรรค หรือขึ้นบรรทัดใหม่)\nLGXCE4CB0TG025322\nLGXCE4CB1TG025314'} value={bulk} onChange={(e) => setBulk(e.target.value)} />
              <div className="flex items-center gap-2 mt-1.5">
                <button className="btn btn-primary py-1.5 px-3" onClick={doAdd}><Plus size={14} /> เพิ่มเข้าคิว</button>
                <button className="btn btn-ghost py-1.5 px-3" onClick={() => { setAdding(false); setBulk('') }}>ยกเลิก</button>
                <span className="text-[11.5px] ml-auto" style={{ color: 'var(--faint)' }}><QrCode size={12} className="inline -mt-0.5" /> หรือสแกน QR ได้ในแอป Yard Ops</span>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 text-[12px]">
            <span style={{ color: '#d97706' }}>● ยังไม่บันทึก <b>{remaining}</b></span>
            <span style={{ color: 'var(--st-yard)' }}>● บันทึกแล้ว <b>{done}</b></span>
            {total > 0 && (
              <button className="btn btn-ghost py-0.5 px-2 ml-auto text-[11.5px]" onClick={() => setAllDone(q.id, remaining > 0, currentUser)}>
                {remaining > 0 ? <><Check size={12} /> บันทึกทั้งหมด</> : <><X size={12} /> รีเซ็ตทั้งหมด</>}
              </button>
            )}
          </div>
        </div>

        {/* vin list */}
        <div className="overflow-auto p-3 flex-1" style={{ background: 'var(--app-bg)' }}>
          {total === 0 ? (
            <div className="text-center py-12 text-[13px]" style={{ color: 'var(--faint)' }}>
              ยังไม่มีรถในคิวนี้ — กด <b>ใส่ VIN</b> เพื่อเพิ่มรถเข้าคิว
            </div>
          ) : shown.length === 0 ? (
            <div className="text-center py-10 text-[13px]" style={{ color: 'var(--faint)' }}>ไม่พบ VIN ที่ลงท้าย “{search}”</div>
          ) : (
            <div className="space-y-2">
              {shown.map(({ it, model, color, grouping, location, lane }) => {
                const out = it.gatedOut === true // car has left the yard — closed work
                return (
                  <div key={it.vin} className="rounded-xl px-3 py-2.5 flex items-center gap-3"
                    style={{ background: '#fff', opacity: out ? 0.55 : 1, borderLeft: `4px solid ${out ? '#94a3b8' : it.done ? 'var(--st-yard)' : '#f59e0b'}`, boxShadow: '0 1px 2px rgba(16,24,40,0.05)' }}>
                    <button onClick={() => !out && toggleDone(q.id, it.vin, currentUser)} title={out ? 'รถออกจากลานแล้ว' : it.done ? 'ยกเลิกการบันทึก' : 'บันทึกว่าเสร็จ'}
                      className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition active:scale-90"
                      style={out ? { background: '#94a3b8', color: '#fff', cursor: 'default' } : it.done ? { background: 'var(--st-yard)', color: '#fff' } : { background: 'var(--chip)', color: 'var(--faint)', border: '1px solid var(--line)' }}>
                      <Check size={15} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="vin text-[13.5px] font-bold clip">{it.vin}</div>
                      <div className="text-[11.5px] flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: 'var(--muted)' }}>
                        <span>{model}</span><span>· {color}</span><span>· {grouping}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="tabular text-[12.5px] font-bold">{location}</div>
                      <div className="flex items-center gap-1 justify-end mt-0.5">
                        {lane !== '—' && <span className="badge" style={{ fontSize: 10, background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>{lane}</span>}
                        <span className="badge" style={{ fontSize: 10, ...(out
                          ? { color: '#64748b', background: 'rgba(100,116,139,0.14)' }
                          : it.done
                            ? { color: 'var(--st-yard)', background: 'rgba(34,197,94,0.12)' }
                            : { color: '#d97706', background: 'rgba(234,179,8,0.14)' }) }}>
                          {out ? 'Gate-out' : it.done ? 'บันทึกแล้ว' : 'ยังไม่บันทึก'}
                        </span>
                      </div>
                    </div>
                    <button onClick={() => removeVin(q.id, it.vin)} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ color: 'var(--faint)' }} title="เอาออกจากคิว">
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
