import { useMemo, useState } from 'react'
import { Plus, Search, Pencil, Trash2, CheckCircle2, XCircle, ChevronLeft, ChevronRight, FileSpreadsheet, Printer, FileText, X } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { zoneLabel } from '../components/CarDiagramMultiView'
import { partLabel, defectLabel } from '../lib/damageLabel'
import { PageHead } from '../components/ui'
import { YARD_SHEET, FACTORY_SHEET, exportDefectExcel, printDefectReport, type DefectExportRow } from '../lib/defectReport'
import { thaiKbToLatin } from '../lib/findCar'
import type { Damage, Unit } from '../types'

const PAGE_SIZE = 10

function fmt(ts: number) {
  const d = new Date(ts)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function AddDamageModal({ units, onClose }: { units: Unit[]; onClose: () => void }) {
  const { addDamage, currentUser } = useYard()
  const [vin, setVin] = useState('')
  const [area, setArea] = useState('front')
  const [type, setType] = useState('scratch')
  const [sev, setSev] = useState<'minor' | 'major'>('minor')
  const [note, setNote] = useState('')

  const matched = units.find(u => u.vin.toUpperCase().endsWith(vin.toUpperCase()) || u.vin === vin.toUpperCase())

  const save = () => {
    if (!matched) return
    addDamage(matched.vin, { area, type, severity: sev, note: note.trim() || undefined, source: 'update' })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid w-full max-w-sm fade-up p-5" onClick={e => e.stopPropagation()}>
        <div className="text-[16px] font-bold mb-4">+ Add Damage</div>
        <div className="space-y-3">
          <div>
            <label className="text-[11.5px] font-semibold mb-1 block" style={{ color: 'var(--muted)' }}>VIN (or last 5 digits)</label>
            <input className="input vin uppercase w-full" placeholder="เช่น 25694" value={vin} onChange={e => setVin(e.target.value)} />
            {vin && <div className="text-[11.5px] mt-1" style={{ color: matched ? '#16a34a' : '#dc2626' }}>
              {matched ? `✓ ${matched.vin} · ${matched.modelName}` : 'ไม่พบ VIN'}
            </div>}
          </div>
          <div>
            <label className="text-[11.5px] font-semibold mb-1 block" style={{ color: 'var(--muted)' }}>Zone</label>
            <select className="input w-full" value={area} onChange={e => setArea(e.target.value)}>
              {['front','rear','left','right','roof','hood','trunk','windshield','fl-door','fr-door','rl-door','rr-door'].map(z => (
                <option key={z} value={z}>{zoneLabel(z)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11.5px] font-semibold mb-1 block" style={{ color: 'var(--muted)' }}>Type</label>
            <select className="input w-full" value={type} onChange={e => setType(e.target.value)}>
              {['scratch','dent','chip','crack','stain','rust'].map(t => (
                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11.5px] font-semibold mb-1 block" style={{ color: 'var(--muted)' }}>Severity</label>
            <div className="flex gap-2">
              {(['minor','major'] as const).map(s => (
                <button key={s} onClick={() => setSev(s)}
                  className="flex-1 py-1.5 rounded-lg text-[12.5px] font-semibold border transition"
                  style={sev === s ? { background: s === 'minor' ? '#2563eb' : '#dc2626', color: '#fff', borderColor: 'transparent' } : { background: 'var(--chip)', borderColor: 'var(--line-strong)' }}>
                  {s === 'minor' ? 'Minor' : 'Major'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[11.5px] font-semibold mb-1 block" style={{ color: 'var(--muted)' }}>Note</label>
            <input className="input w-full" placeholder="รายละเอียด (ถ้ามี)" value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button className="btn flex-1" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary flex-1" disabled={!matched} onClick={save}>บันทึก</button>
        </div>
      </div>
    </div>
  )
}

type DamageRow = { unit: Unit; damage: Damage }

/** Report a chosen set of VINs → Defect-Yard + Defect-Factory only (Excel / PDF). */
function DamageReportModal({ units, onClose }: { units: Unit[]; onClose: () => void }) {
  const toast = useYard((s) => s.toast)
  const trackingRows = useTrackingRows()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  // match each pasted token to a unit by full VIN or last-5+ suffix; keep found ones
  const { yard, factory, matched, notFound } = useMemo(() => {
    // accept VINs typed on a Thai keyboard too (forgot to switch language)
    const norm = thaiKbToLatin(text)
    const tokens = [...new Set(((text + '\n' + norm).toUpperCase().match(/[A-Z0-9]{4,20}/g) ?? []))]
    const seen = new Set<string>()
    const matchedUnits: Unit[] = []
    const notFound: string[] = []
    for (const tk of tokens) {
      const u = units.find((x) => x.vin === tk) ?? (tk.length >= 4 ? units.find((x) => x.vin.endsWith(tk)) : undefined)
      if (u && !seen.has(u.vin)) { seen.add(u.vin); matchedUnits.push(u) }
      else if (!u) notFound.push(tk)
    }
    const byVinDate = (a: DefectExportRow, b: DefectExportRow) => a.unit.vin.localeCompare(b.unit.vin) || a.dmg.at - b.dmg.at
    const yard: DefectExportRow[] = []
    const factory: DefectExportRow[] = []
    for (const u of matchedUnits) for (const dmg of u.damages) {
      (dmg.source === 'factoryDefect' ? factory : yard).push({ unit: u, dmg }) // only 2 buckets
    }
    return { yard: yard.sort(byVinDate), factory: factory.sort(byVinDate), matched: matchedUnits.length, notFound }
  }, [text, units])

  const trackByVin = useMemo(() => new Map(trackingRows.map((r) => [r.vin, r.cells])), [trackingRows])
  const sheets = [{ spec: YARD_SHEET, rows: yard }, { spec: FACTORY_SHEET, rows: factory }]
  const total = yard.length + factory.length
  const stamp = new Date().toISOString().slice(0, 10)
  const docTitle = `Defect Report — ${matched} คัน (Yard ${yard.length} · Factory ${factory.length})`

  const doExcel = async () => {
    if (!total) { toast('err', 'ยังไม่พบตำหนิของ VIN ที่ใส่'); return }
    setBusy(true)
    try { await exportDefectExcel(sheets, trackByVin, `SJWD-Defect-Report-${matched}คัน-${stamp}.xlsx`); toast('ok', `ออกรายงาน Excel — ${total} รายการ`) }
    catch (e) { console.error('[damage report] excel', e); toast('err', 'ออกรายงานไม่สำเร็จ') }
    setBusy(false)
  }
  const doPdf = () => {
    if (!total) { toast('err', 'ยังไม่พบตำหนิของ VIN ที่ใส่'); return }
    printDefectReport(sheets, trackByVin, docTitle)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid w-full max-w-lg fade-up p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <FileText size={18} style={{ color: 'var(--brand)' }} />
          <div className="text-[16px] font-bold">ดึง Report (Defect)</div>
          <button className="ml-auto p-1.5 rounded-lg" style={{ color: 'var(--muted)' }} onClick={onClose}><X size={18} /></button>
        </div>
        <div className="text-[12px] mb-3" style={{ color: 'var(--muted)' }}>วางเลข VIN (เต็ม หรือ 5 ตัวท้าย) ได้หลายคัน — เว้นวรรค/ขึ้นบรรทัดใหม่ · รายงานจะมี 2 ชีท: <b>Defect-Yard</b> และ <b>Defect-Factory</b></div>
        <textarea className="input w-full" style={{ minHeight: 120, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
          placeholder={'เช่น\nLGXCE4CB0TG025322\n25314\n76C47SG037508'} value={text} onChange={(e) => setText(e.target.value)} />

        <div className="flex items-center gap-3 text-[12px] mt-2.5" style={{ color: 'var(--muted)' }}>
          <span>พบรถ <b style={{ color: 'var(--text)' }}>{matched}</b> คัน</span>
          <span style={{ color: '#0f766e' }}>● Yard <b>{yard.length}</b></span>
          <span style={{ color: '#b45309' }}>● Factory <b>{factory.length}</b></span>
          {notFound.length > 0 && <span style={{ color: '#dc2626' }} title={notFound.join(', ')}>ไม่พบ {notFound.length}</span>}
        </div>

        <div className="flex gap-2 mt-4">
          <button className="btn flex-1" onClick={onClose}>ปิด</button>
          <button className="btn btn-ghost flex-1" disabled={busy || !total} onClick={doPdf}><Printer size={15} /> PDF</button>
          <button className="btn btn-primary flex-1" disabled={busy || !total} onClick={doExcel}><FileSpreadsheet size={15} /> Excel</button>
        </div>
      </div>
    </div>
  )
}

export function Damages() {
  const units = useUnits()
  const { removeDamage, updateDamage } = useYard()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [addOpen, setAddOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

  const all: DamageRow[] = useMemo(() =>
    units.flatMap(u => u.damages.map(d => ({ unit: u, damage: d }))),
    [units],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    if (!q) return all
    return all.filter(r =>
      r.unit.vin.includes(q) ||
      r.unit.modelName.toUpperCase().includes(q) ||
      (r.damage.by ?? '').toUpperCase().includes(q) ||
      (r.damage.note ?? '').toUpperCase().includes(q),
    )
  }, [all, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const toggleFixed = (r: DamageRow) => {
    const isFixed = !!r.damage.repairDate
    updateDamage(r.unit.vin, r.damage.id, isFixed
      ? { statusRepair: undefined, repairDate: undefined }
      : { statusRepair: 'Repaired', repairDate: Date.now() },
    )
  }

  return (
    <div>
      <PageHead
        title="Damages"
        sub="See a list of all damages to your vehicles."
        right={
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost" onClick={() => setReportOpen(true)}>
              <FileText size={15} /> ดึง Report
            </button>
            <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
              <Plus size={15} /> Add Damage
            </button>
          </div>
        }
      />

      {/* toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
          <input
            className="input pl-8 w-full text-[13px]"
            placeholder="Search VIN, model, inspector…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <div className="text-[13px]" style={{ color: 'var(--muted)' }}>
          {filtered.length} record{filtered.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* table */}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b hairline" style={{ background: 'var(--chip)' }}>
                {['Vehicle', 'Zone / Type', 'Inspector', 'Date/Time', 'Images', 'Fixed', 'Fixed at', ''].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-[11.5px] font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y" style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}>
              {pageRows.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12" style={{ color: 'var(--faint)' }}>ไม่พบข้อมูลความเสียหาย</td></tr>
              ) : pageRows.map(r => {
                const isFixed = !!r.damage.repairDate
                return (
                  <tr key={r.damage.id} className="hover:bg-chip transition-colors">
                    {/* Vehicle */}
                    <td className="px-4 py-3">
                      <div className="vin text-[12px] font-bold" style={{ color: 'var(--brand)' }}>{r.unit.vin}</div>
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{r.unit.modelName}</div>
                    </td>
                    {/* Zone / Type */}
                    <td className="px-4 py-3">
                      <div className="font-semibold">
                        {partLabel(r.damage, 'en')}
                        {partLabel(r.damage, 'th') && partLabel(r.damage, 'th') !== partLabel(r.damage, 'en') && (
                          <span className="block font-normal text-[11px]" style={{ color: 'var(--muted)' }}>{partLabel(r.damage, 'th')}</span>
                        )}
                      </div>
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                        {defectLabel(r.damage, 'en')}
                        {defectLabel(r.damage, 'th') && defectLabel(r.damage, 'th') !== defectLabel(r.damage, 'en') && <span> · {defectLabel(r.damage, 'th')}</span>}
                      </div>
                    </td>
                    {/* Inspector */}
                    <td className="px-4 py-3 whitespace-nowrap">{r.damage.by}</td>
                    {/* Date/Time */}
                    <td className="px-4 py-3 whitespace-nowrap tabular" style={{ color: 'var(--muted)' }}>{fmt(r.damage.at)}</td>
                    {/* Images */}
                    <td className="px-4 py-3 text-center">
                      <span className={r.damage.photo ? 'font-semibold' : ''} style={{ color: r.damage.photo ? 'var(--brand)' : 'var(--faint)' }}>
                        {r.damage.photo ? 1 : 0}
                      </span>
                    </td>
                    {/* Fixed */}
                    <td className="px-4 py-3">
                      <button onClick={() => toggleFixed(r)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-semibold border transition hover:opacity-80"
                        style={isFixed
                          ? { background: 'rgba(22,163,74,0.1)', color: '#16a34a', borderColor: 'rgba(22,163,74,0.25)' }
                          : { background: 'rgba(220,38,38,0.08)', color: '#dc2626', borderColor: 'rgba(220,38,38,0.2)' }}>
                        {isFixed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                        {isFixed ? 'Yes' : 'No'}
                      </button>
                    </td>
                    {/* Fixed at */}
                    <td className="px-4 py-3 tabular text-[12.5px]" style={{ color: 'var(--muted)' }}>
                      {r.damage.repairDate ? fmt(r.damage.repairDate) : 'N/A'}
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => updateDamage(r.unit.vin, r.damage.id, { severity: r.damage.severity === 'minor' ? 'major' : 'minor' })}
                          className="btn p-1.5" title="Toggle severity"
                          style={{ color: 'var(--brand)', background: 'rgba(37,99,235,0.08)' }}>
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => { if (confirm('ลบรายการนี้?')) removeDamage(r.unit.vin, r.damage.id) }}
                          className="btn p-1.5" title="Delete"
                          style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t hairline">
          <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Show {PAGE_SIZE} of {filtered.length} total
          </div>
          <div className="flex items-center gap-2">
            <button className="btn p-1.5" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={14} /></button>
            <span className="text-[12.5px] font-semibold px-1">{page} / {totalPages}</span>
            <button className="btn p-1.5" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={14} /></button>
          </div>
        </div>
      </div>

      {addOpen && <AddDamageModal units={units} onClose={() => setAddOpen(false)} />}
      {reportOpen && <DamageReportModal units={units} onClose={() => setReportOpen(false)} />}
    </div>
  )
}
