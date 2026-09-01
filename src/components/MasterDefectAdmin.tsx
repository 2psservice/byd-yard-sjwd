/**
 * Master Defect List — the office's two bilingual lists, maintained in the app.
 *
 *   PART    ตำแหน่ง      "A pillar LH" / "เสา A ซ้าย"
 *   DEFECT  ข้อบกพร่อง   "Paint Pin Hole" / "หลุมสี"
 *
 * These feed every defect picker: the station sheet, the ops-scan damage form
 * and the Unit List's add/edit rows. Until now they were generated from the
 * office's Excel, so a new part or a corrected Thai wording meant a release —
 * here an admin edits them and every device has the change in seconds.
 *
 * Both languages sit side by side because a record made from this list carries
 * both: the field reads Thai, the office's reports read English.
 */
import { useMemo, useState } from 'react'
import { ClipboardList, Plus, Pencil, Trash2, Check, X, Search, RotateCcw } from 'lucide-react'
import { useYard } from '../store/useYard'
import { useMasterDefect, type MasterKind } from '../store/useMasterDefect'
import { cx } from './ui'

const TABS: { id: MasterKind; label: string; sub: string }[] = [
  { id: 'part', label: 'Part', sub: 'ตำแหน่งบนตัวรถ' },
  { id: 'defect', label: 'Defect', sub: 'ลักษณะข้อบกพร่อง' },
]

const th = 'px-3 py-2 text-left font-semibold whitespace-nowrap border-r hairline last:border-r-0'
const td = 'px-3 py-1.5 align-middle border-r hairline last:border-r-0'

export function MasterDefectAdmin() {
  const toast = useYard((s) => s.toast)
  const canEdit = useYard((s) => s.appUsers.find((u) => u.id === s.loggedInUserId)?.role === 'admin')
  const parts = useMasterDefect((s) => s.parts)
  const defects = useMasterDefect((s) => s.defects)
  const upsert = useMasterDefect((s) => s.upsert)
  const remove = useMasterDefect((s) => s.remove)
  const resetToBuiltIn = useMasterDefect((s) => s.resetToBuiltIn)

  const [kind, setKind] = useState<MasterKind>('part')
  const [q, setQ] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ en: '', th: '' })
  const [adding, setAdding] = useState(false)

  const list = kind === 'part' ? parts : defects
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return list
    return list.filter((e) => e.en.toLowerCase().includes(s) || e.th.toLowerCase().includes(s))
  }, [list, q])

  const cancel = () => { setEditingId(null); setAdding(false); setForm({ en: '', th: '' }) }
  const startAdd = () => { setEditingId(null); setAdding(true); setForm({ en: '', th: '' }) }
  const startEdit = (e: { id: string; en: string; th: string }) => {
    setAdding(false); setEditingId(e.id); setForm({ en: e.en, th: e.th })
  }
  const save = (id?: string) => {
    if (!form.en.trim() && !form.th.trim()) { toast('err', 'ใส่ชื่อภาษาอังกฤษหรือภาษาไทยอย่างน้อยหนึ่งช่อง'); return }
    const res = upsert(kind, { id, en: form.en, th: form.th })
    if (!res) { toast('err', `มีรายการชื่อ "${form.en.trim()}" อยู่แล้ว — ใช้ชื่อซ้ำไม่ได้`); return }
    toast('ok', id ? 'แก้ไขแล้ว' : `เพิ่ม "${form.en.trim() || form.th.trim()}" แล้ว`)
    cancel()
  }
  const doRemove = (e: { id: string; en: string; th: string }) => {
    if (!window.confirm(`ลบรายการนี้ออกจาก Master ${kind === 'part' ? 'Part' : 'Defect'}?\n\n${e.en}\n${e.th}\n\n· รายการที่บันทึกไปแล้วไม่หาย — แค่จะไม่ขึ้นให้เลือกอีก`)) return
    remove(kind, e.id)
    toast('ok', 'ลบออกจากรายการแล้ว')
  }
  const doReset = () => {
    if (!window.confirm(`คืนรายการ ${kind === 'part' ? 'Part' : 'Defect'} กลับเป็นค่าเริ่มต้นของโปรแกรม?\n\nสิ่งที่แก้ไว้เองทั้งหมดจะหายไป`)) return
    resetToBuiltIn(kind)
    toast('ok', 'คืนค่าเริ่มต้นแล้ว')
  }

  // A plain function, NOT a nested component: declaring a component inside the
  // render body gives it a new identity on every keystroke, so React throws the
  // row away and builds a new one — the caret jumps out of the Thai box and
  // autoFocus drags it back to English, making it impossible to type a word.
  const editRow = (id?: string) => (
    <tr key={id ?? '__new__'} style={{ background: 'rgba(37,99,235,0.06)', borderTop: '2px solid var(--brand)' }}>
      <td className={cx(td, 'font-bold')} style={{ color: 'var(--brand)' }}>{id ? '' : 'ใหม่'}</td>
      <td className="px-1 py-1.5 border-r hairline">
        <input className="input w-full" autoFocus placeholder="English" value={form.en}
          onChange={(e) => setForm({ ...form, en: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') save(id); if (e.key === 'Escape') cancel() }} />
      </td>
      <td className="px-1 py-1.5 border-r hairline">
        <input className="input w-full" placeholder="ภาษาไทย" value={form.th}
          onChange={(e) => setForm({ ...form, th: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') save(id); if (e.key === 'Escape') cancel() }} />
      </td>
      <td className="px-1 py-1.5">
        <div className="flex items-center gap-1.5">
          <button onClick={() => save(id)} title="บันทึก" className="w-7 h-7 rounded flex items-center justify-center shrink-0"
            style={{ background: '#16a34a', color: '#fff' }}><Check size={14} /></button>
          <button onClick={cancel} title="ยกเลิก" className="w-7 h-7 rounded flex items-center justify-center shrink-0"
            style={{ background: 'var(--chip)', color: 'var(--muted)' }}><X size={14} /></button>
        </div>
      </td>
    </tr>
  )

  return (
    <div className="panel overflow-hidden fade-up">
      <div className="flex items-center gap-2 px-4 py-3 border-b hairline flex-wrap">
        <ClipboardList size={16} style={{ color: 'var(--brand)' }} />
        <span className="font-semibold text-[14px]">Master Defect List</span>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
          รายการที่ทุกหน้าจอใช้เลือกตอนบันทึก Defect — แก้ที่นี่ที่เดียว ทุกเครื่องเห็นทันที
        </span>
      </div>

      <div className="px-4 pt-3 flex items-center gap-2 flex-wrap">
        {TABS.map((t) => {
          const n = (t.id === 'part' ? parts : defects).length
          return (
            <button key={t.id} onClick={() => { setKind(t.id); cancel(); setQ('') }}
              className={cx('btn px-3 py-1.5 text-[12.5px]', kind === t.id && 'btn-primary')}>
              {t.label} <span className="opacity-70">· {t.sub}</span>
              <span className="badge ml-1" style={kind === t.id
                ? { background: 'rgba(255,255,255,0.22)', color: '#fff' }
                : { background: 'var(--panel)', color: 'var(--muted)' }}>{n}</span>
            </button>
          )
        })}
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
          <input className="input pl-8" style={{ width: 240 }} placeholder="ค้นหา ไทย / อังกฤษ…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {canEdit && (
          <>
            <button className="btn btn-primary py-1.5 px-3 text-[12.5px]" onClick={startAdd}>
              <Plus size={14} /> เพิ่มรายการ
            </button>
            <button className="btn btn-ghost py-1.5 px-2.5 text-[12px]" style={{ color: 'var(--muted)' }}
              title="คืนรายการกลับเป็นค่าเริ่มต้นของโปรแกรม" onClick={doReset}>
              <RotateCcw size={13} /> คืนค่าเริ่มต้น
            </button>
          </>
        )}
      </div>

      <div className="px-4 py-1.5 text-[11.5px]" style={{ color: 'var(--faint)' }}>
        แสดง {shown.length.toLocaleString()} จาก {list.length.toLocaleString()} รายการ
        {!canEdit && ' · ดูอย่างเดียว (แก้ไขได้เฉพาะแอดมิน)'}
      </div>

      <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
        <table className="w-full text-[12.5px]">
          <thead><tr className="border-b hairline" style={{ background: 'var(--chip)', color: 'var(--muted)', position: 'sticky', top: 0, zIndex: 1 }}>
            <th className={th} style={{ width: 64 }}>Seq</th>
            <th className={th}>{kind === 'part' ? 'Part Eng' : 'Name Eng Defect'}</th>
            <th className={th}>{kind === 'part' ? 'Part Thai' : 'Name Thai Defect'}</th>
            <th className={th} style={{ width: 96 }}></th>
          </tr></thead>
          <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {adding && editRow()}
            {shown.length === 0 && !adding && (
              <tr><td colSpan={4} className="text-center py-8" style={{ color: 'var(--faint)' }}>— ไม่พบรายการที่ค้นหา —</td></tr>
            )}
            {shown.map((e, i) =>
              editingId === e.id ? editRow(e.id) : (
                <tr key={e.id}>
                  <td className={cx(td, 'tabular')} style={{ color: 'var(--faint)' }}>{i + 1}</td>
                  <td className={td}>{e.en || <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td className={td}>{e.th || <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td className={td}>
                    {canEdit && (
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => startEdit(e)} title="แก้ไข" className="btn btn-ghost px-2 py-1" style={{ color: 'var(--muted)' }}><Pencil size={13} /></button>
                        <button onClick={() => doRemove(e)} title="ลบ" className="btn btn-ghost px-2 py-1" style={{ color: '#dc2626' }}><Trash2 size={13} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
