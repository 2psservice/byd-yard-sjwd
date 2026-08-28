/**
 * Settings — admin site management + general app preferences.
 * Sites created/deleted here feed the post-login "Select Site" modal.
 */
import { useMemo, useState } from 'react'
import {
  Settings as SettingsIcon, MapPin, Plus, Trash2, Check, Building2,
  Car, Hash, Search, ChevronLeft, ChevronRight, AlertCircle, Pencil, X,
  ShieldCheck, Wrench, ScanLine, ClipboardCheck,
} from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import type { UserRole } from '../types'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { PageHead, cx } from '../components/ui'
import { hashPassword } from '../lib/password'

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i

// readable status for yard-unit-only VINs (mirrors tracking "Car Status" wording)
const UNIT_STATUS_LABEL: Record<string, string> = {
  EXPECTED: 'Pre Gate-in', GATE_IN: 'In Yard', ASSIGNED: 'Moving',
  PARKED: 'Parked', LOADED: 'Loaded', DEPARTED: 'Gate-out',
}

type VinRow = { vin: string; model: string; color: string; status: string }

function VinManager() {
  const trackingRows = useTrackingRows()
  const units = useUnits()
  const { addRow, deleteRows } = useTracking()
  const removeUnit = useYard(s => s.removeUnit)

  // merge VINs from tracking rows AND yard units so anything in the system is listed
  const rows = useMemo<VinRow[]>(() => {
    const map = new Map<string, VinRow>()
    for (const r of trackingRows) {
      map.set(r.vin, {
        vin: r.vin,
        model: r.cells['Model name'] ?? r.cells['Model'] ?? '—',
        color: r.cells['Color'] ?? '—',
        status: r.cells['Car Status'] ?? 'Pre Gate-in',
      })
    }
    for (const u of units) {
      if (map.has(u.vin)) continue
      map.set(u.vin, {
        vin: u.vin,
        model: u.modelName || u.model || '—',
        color: u.color || '—',
        status: UNIT_STATUS_LABEL[u.status] ?? u.status,
      })
    }
    return [...map.values()]
  }, [trackingRows, units])
  const [q, setQ] = useState('')
  const [newVin, setNewVin] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newColor, setNewColor] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  const PAGE = 15

  const filtered = useMemo(() => {
    const qs = q.trim().toUpperCase()
    if (!qs) return rows
    return rows.filter(r =>
      r.vin.includes(qs) ||
      r.model.toUpperCase().includes(qs) ||
      r.color.toUpperCase().includes(qs),
    )
  }, [rows, q])

  const searching = q.trim().length > 0 // show the list only while searching, to save space
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const pageRows = filtered.slice((page - 1) * PAGE, page * PAGE)

  const vinInput = newVin.trim().toUpperCase()
  const vinValid = VIN_RE.test(vinInput)

  const doAdd = () => {
    if (!vinInput) { setErr('กรุณาใส่เลข VIN'); return }
    if (!vinValid) { setErr('VIN ต้องเป็นตัวอักษร/ตัวเลข 17 หลัก'); return }
    const ok = addRow(vinInput, {
      ...(newModel.trim() ? { 'Model name': newModel.trim() } : {}),
      ...(newColor.trim() ? { 'Color': newColor.trim() } : {}),
    })
    if (!ok) { setErr(`VIN ${vinInput} มีในระบบแล้ว`); return }
    setNewVin(''); setNewModel(''); setNewColor(''); setErr('')
  }

  const doDelete = (vin: string) => {
    if (!confirm(`ลบ VIN ${vin} ออกจากระบบ?`)) return
    deleteRows([vin])      // tracking store + IndexedDB
    removeUnit(vin)        // yard units + trips
    setSelected(s => { const n = new Set(s); n.delete(vin); return n })
  }

  const doDeleteSelected = () => {
    if (!selected.size) return
    if (!confirm(`ลบ ${selected.size} VIN ที่เลือก?`)) return
    const vins = [...selected]
    deleteRows(vins)
    vins.forEach(removeUnit)
    setSelected(new Set())
  }

  const toggleSelect = (vin: string) =>
    setSelected(s => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n })

  const toggleAll = () => {
    if (pageRows.every(r => selected.has(r.vin)))
      setSelected(s => { const n = new Set(s); pageRows.forEach(r => n.delete(r.vin)); return n })
    else
      setSelected(s => { const n = new Set(s); pageRows.forEach(r => n.add(r.vin)); return n })
  }

  const allChecked = pageRows.length > 0 && pageRows.every(r => selected.has(r.vin))

  return (
    <section className="panel overflow-hidden mb-4">
      <div className="px-4 py-3 border-b hairline flex items-center gap-2">
        <Hash size={16} style={{ color: 'var(--brand)' }} />
        <span className="font-semibold text-[14.5px]">จัดการ VIN</span>
        <span className="badge ml-auto" style={{ color: 'var(--brand)', background: 'var(--brand-soft, #eef4ff)' }}>{rows.length} รายการ</span>
      </div>

      {/* add new VIN */}
      <div className="p-4 border-b hairline" style={{ background: 'var(--app-bg)' }}>
        <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>เพิ่ม VIN ใหม่</div>
        <div className="flex flex-wrap gap-2 items-start">
          <div className="flex-1" style={{ minWidth: 200 }}>
            <input
              className="input py-2 text-[13.5px] w-full vin uppercase"
              placeholder="เลข VIN 17 หลัก"
              maxLength={17}
              value={newVin}
              onChange={e => { setNewVin(e.target.value); setErr('') }}
              onKeyDown={e => e.key === 'Enter' && doAdd()}
            />
            {newVin.trim() && !vinValid && (
              <div className="text-[11.5px] mt-1 flex items-center gap-1" style={{ color: '#dc2626' }}>
                <AlertCircle size={11} /> ต้องเป็นตัวอักษร/ตัวเลข 17 หลัก (ไม่รวม I, O, Q)
              </div>
            )}
          </div>
          <input className="input py-2 text-[13.5px]" style={{ width: 150 }} placeholder="รุ่น (ถ้ามี)" value={newModel} onChange={e => setNewModel(e.target.value)} onKeyDown={e => e.key === 'Enter' && doAdd()} />
          <input className="input py-2 text-[13.5px]" style={{ width: 120 }} placeholder="สี (ถ้ามี)" value={newColor} onChange={e => setNewColor(e.target.value)} onKeyDown={e => e.key === 'Enter' && doAdd()} />
          <button className="btn btn-primary px-4 py-2 shrink-0" onClick={doAdd} disabled={!vinInput}>
            <Plus size={15} /> เพิ่ม VIN
          </button>
        </div>
        {err && <div className="text-[12px] mt-2 flex items-center gap-1" style={{ color: '#dc2626' }}><AlertCircle size={13} />{err}</div>}
      </div>

      {/* search + bulk delete */}
      <div className="px-4 py-3 border-b hairline flex items-center gap-3" style={{ background: 'var(--app-bg)' }}>
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
          <input className="input py-1.5 text-[13px] w-full" style={{ paddingLeft: 30 }} placeholder="ค้นหา VIN / รุ่น / สี…"
            value={q} onChange={e => { setQ(e.target.value); setPage(1) }} />
        </div>
        <div className="text-[12.5px]" style={{ color: 'var(--muted)' }}>{filtered.length} รายการ</div>
        {selected.size > 0 && (
          <button className="btn px-3 py-1.5 text-[12.5px] font-semibold" onClick={doDeleteSelected}
            style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626', border: '1px solid rgba(220,38,38,0.2)' }}>
            <Trash2 size={13} /> ลบ {selected.size} รายการ
          </button>
        )}
      </div>

      {/* VIN list — shown only while searching, to save space */}
      {searching ? (
      <>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr style={{ background: 'var(--chip)' }}>
              <th className="px-4 py-2.5 w-10">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} className="cursor-pointer" />
              </th>
              {['VIN', 'รุ่น', 'สี', 'Car Status', ''].map(h => (
                <th key={h} className="text-left px-3 py-2.5 font-bold text-[11.5px]" style={{ color: 'var(--muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-10" style={{ color: 'var(--faint)' }}>ไม่พบข้อมูล</td></tr>
            ) : pageRows.map((r, i) => (
              <tr key={r.vin} className="border-t hover:bg-chip transition-colors" style={{ borderColor: 'var(--line)', background: selected.has(r.vin) ? 'var(--brand-soft,#eef4ff)' : i % 2 === 1 ? 'var(--panel-2)' : undefined }}>
                <td className="px-4 py-2.5">
                  <input type="checkbox" checked={selected.has(r.vin)} onChange={() => toggleSelect(r.vin)} className="cursor-pointer" />
                </td>
                <td className="px-3 py-2.5 font-mono font-semibold" style={{ color: 'var(--brand)', letterSpacing: '0.03em' }}>{r.vin}</td>
                <td className="px-3 py-2.5" style={{ color: 'var(--text)' }}>{r.model}</td>
                <td className="px-3 py-2.5" style={{ color: 'var(--muted)' }}>{r.color}</td>
                <td className="px-3 py-2.5">
                  <span className="badge text-[11px]" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <button onClick={() => doDelete(r.vin)} className="btn p-1.5" title="ลบ VIN นี้"
                    style={{ color: '#dc2626', background: 'rgba(220,38,38,0.07)' }}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t hairline">
        <div className="text-[12px]" style={{ color: 'var(--muted)' }}>แสดง {Math.min(PAGE, pageRows.length)} จาก {filtered.length} รายการ</div>
        <div className="flex items-center gap-2">
          <button className="btn p-1.5" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={14} /></button>
          <span className="text-[12.5px] font-semibold px-1">{page} / {totalPages}</span>
          <button className="btn p-1.5" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={14} /></button>
        </div>
      </div>
      </>
      ) : (
        <div className="px-4 py-12 text-center">
          <Search size={30} className="mx-auto mb-2.5" style={{ color: 'var(--faint)', opacity: 0.6 }} />
          <div className="text-[14px] font-semibold" style={{ color: 'var(--muted)' }}>พิมพ์ในช่องค้นหาเพื่อแสดงรายการ VIN</div>
          <div className="text-[12.5px] mt-1" style={{ color: 'var(--faint)' }}>ค้นหาด้วยเลข VIN · รุ่น · สี — มีทั้งหมด {rows.length.toLocaleString()} รายการ</div>
        </div>
      )}
    </section>
  )
}

// ── Role metadata ──────────────────────────────────────────────
const ROLES: { value: UserRole; label: string; desc: string; icon: React.ReactNode; color: string; bg: string }[] = [
  { value: 'admin',      label: 'Admin',       desc: 'เข้าถึงทุกหน้า ตั้งค่าระบบได้',           icon: <ShieldCheck size={14} />,    color: '#7c3aed', bg: '#ede9fe' },
  { value: 'driver',     label: 'Driver',      desc: 'หน้า YardOps + ประวัติการขับ',            icon: <Car size={14} />,            color: '#2563eb', bg: '#dbeafe' },
  { value: 'walkAround', label: 'Walk Around', desc: 'Gate In/Out และตรวจสภาพรถ',              icon: <ScanLine size={14} />,       color: '#0d9488', bg: '#ccfbf1' },
  { value: 'pmPdiFinal', label: 'PM/PDI/Final',desc: 'ตรวจคุณภาพ PDI และอนุมัติ Final',        icon: <ClipboardCheck size={14} />, color: '#d97706', bg: '#fef3c7' },
  { value: 'mechanic',   label: 'ช่างซ่อม',    desc: 'รับงานซ่อม บันทึก Damage',               icon: <Wrench size={14} />,         color: '#dc2626', bg: '#fee2e2' },
]
const roleOf = (v: UserRole) => ROLES.find(r => r.value === v) ?? ROLES[1]

/** Password strength, WordPress-style: one label + a coloured bar under the box. */
function pwStrength(p: string): { label: string; pct: number; color: string; bg: string } {
  if (!p) return { label: '', pct: 0, color: 'var(--muted)', bg: 'var(--chip)' }
  let score = 0
  if (p.length >= 8) score++
  if (p.length >= 12) score++
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++
  if (/\d/.test(p)) score++
  if (/[^A-Za-z0-9]/.test(p)) score++
  if (score <= 1) return { label: 'อ่อนมาก', pct: 25, color: '#b91c1c', bg: '#fee2e2' }
  if (score === 2) return { label: 'อ่อน',    pct: 45, color: '#b45309', bg: '#fef3c7' }
  if (score === 3) return { label: 'ปานกลาง', pct: 70, color: '#a16207', bg: '#fef9c3' }
  return { label: 'แข็งแรง', pct: 100, color: '#15803d', bg: '#dcfce7' }
}

/** A password the yard can actually read off a screen and type on a phone —
 *  no 0/O, 1/l/I lookalikes, and drawn from the OS random source. */
function makePassword(len = 12): string {
  const set = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%'
  const buf = new Uint32Array(len)
  crypto.getRandomValues(buf)
  return [...buf].map(n => set[n % set.length]).join('')
}

type BulkAction = '' | 'delete' | 'activate' | 'deactivate'

/**
 * Users — laid out like the WordPress Users screen the office already knows:
 * a title with "Add New" beside it, role filter links carrying live counts,
 * bulk actions over a checkbox table, and per-row Edit/Delete links that
 * appear under the name on hover. Adding and editing open the same full form
 * (WordPress's "Add New User" screen), so every field has a real label instead
 * of a placeholder that vanishes the moment you type.
 */
function UserManager() {
  const appUsers        = useYard(s => s.appUsers)
  const addAppUser      = useYard(s => s.addAppUser)
  const updateAppUser   = useYard(s => s.updateAppUser)
  const removeAppUser   = useYard(s => s.removeAppUser)
  const meId            = useYard(s => s.loggedInUserId)

  // 'list' = the table · 'form' = add/edit screen (editId null ⇒ adding)
  const [screen, setScreen] = useState<'list' | 'form'>('list')
  const [editId, setEditId] = useState<string | null>(null)
  const [fName, setFName]   = useState('')
  const [fUser, setFUser]   = useState('')
  const [fPass, setFPass]   = useState('')
  const [fRole, setFRole]   = useState<UserRole>('driver')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr]       = useState('')
  const [notice, setNotice] = useState<{ text: string; linkId?: string } | null>(null)

  const [filter, setFilter] = useState<'all' | UserRole>('all')
  const [q, setQ]           = useState('')
  const [sel, setSel]       = useState<Set<string>>(new Set())
  const [bulk, setBulk]     = useState<BulkAction>('')
  const [bulkRole, setBulkRole] = useState<UserRole | ''>('')

  // usernames are login identities — compare case-insensitively so "TEST" and
  // "test" are treated as the same account, not two different (one unreachable)
  const sameUsername = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return appUsers.filter(u =>
      (filter === 'all' || u.role === filter) &&
      (!s || u.name.toLowerCase().includes(s) || (u.username || '').toLowerCase().includes(s)),
    )
  }, [appUsers, filter, q])

  const openAdd = () => {
    setEditId(null); setFName(''); setFUser(''); setFPass(''); setFRole('driver')
    setShowPw(false); setErr(''); setNotice(null); setScreen('form')
  }
  const openEdit = (id: string) => {
    const u = appUsers.find(x => x.id === id)
    if (!u) return
    // the password box starts EMPTY — what is stored is a hash, never shown;
    // leaving it blank keeps the current password
    setEditId(u.id); setFName(u.name); setFUser(u.username); setFPass(''); setFRole(u.role)
    setShowPw(false); setErr(''); setNotice(null); setScreen('form')
  }

  const submit = async () => {
    const n = fName.trim(), un = fUser.trim()
    if (!un) { setErr('กรุณาใส่ Username'); return }
    if (!n)  { setErr('กรุณาใส่ชื่อ-นามสกุล'); return }
    if (appUsers.some(u => u.id !== editId && sameUsername(u.username, un))) { setErr(`Username "${un}" ถูกใช้แล้ว`); return }
    if (appUsers.some(u => u.id !== editId && u.name === n)) { setErr(`มีชื่อ "${n}" อยู่แล้ว`); return }
    if (editId) {
      updateAppUser(editId, {
        name: n, role: fRole, username: un,
        ...(fPass ? { password: await hashPassword(fPass) } : {}), // blank = keep current
      })
      setNotice({ text: `บันทึกผู้ใช้ "${n}" แล้ว`, linkId: editId })
    } else {
      if (!fPass) { setErr('กรุณาตั้งรหัสผ่าน'); return }
      addAppUser(n, fRole, un, await hashPassword(fPass)) // never store plaintext
      setNotice({ text: `สร้างผู้ใช้ "${n}" แล้ว` })
    }
    setErr(''); setScreen('list')
  }

  const doDelete = (u: { id: string; name: string }) => {
    if (u.id === meId) return // guarded in the UI too — this is the last line
    if (!confirm(`ลบผู้ใช้ "${u.name}" ?\n\nบัญชีนี้จะเข้าสู่ระบบไม่ได้อีก`)) return
    removeAppUser(u.id)
    setSel(s => { const x = new Set(s); x.delete(u.id); return x })
    setNotice({ text: `ลบผู้ใช้ "${u.name}" แล้ว` })
  }

  const selectable = shown.filter(u => u.id !== meId) // your own row is never bulk-actionable
  const allChecked = selectable.length > 0 && selectable.every(u => sel.has(u.id))
  const toggleAll = () => setSel(s => {
    const x = new Set(s)
    if (allChecked) selectable.forEach(u => x.delete(u.id))
    else selectable.forEach(u => x.add(u.id))
    return x
  })

  const applyBulk = () => {
    const ids = [...sel]
    if (!bulk || !ids.length) return
    if (bulk === 'delete') {
      if (!confirm(`ลบผู้ใช้ ${ids.length} คนที่เลือก?`)) return
      ids.forEach(removeAppUser)
      setNotice({ text: `ลบผู้ใช้ ${ids.length} คนแล้ว` })
    } else {
      const active = bulk === 'activate'
      ids.forEach(id => updateAppUser(id, { active }))
      setNotice({ text: `${active ? 'เปิด' : 'ปิด'}ใช้งาน ${ids.length} บัญชีแล้ว` })
    }
    setSel(new Set()); setBulk('')
  }

  const applyRole = () => {
    const ids = [...sel]
    if (!bulkRole || !ids.length) return
    ids.forEach(id => updateAppUser(id, { role: bulkRole }))
    setNotice({ text: `เปลี่ยนสิทธิ ${ids.length} บัญชีเป็น ${roleOf(bulkRole).label} แล้ว` })
    setSel(new Set()); setBulkRole('')
  }

  const countAll = appUsers.length
  const countOf = (r: UserRole) => appUsers.filter(u => u.role === r).length

  // ── Add / Edit screen ───────────────────────────────────────────────────
  if (screen === 'form') {
    const st = pwStrength(fPass)
    const editing = !!editId
    return (
      <section className="panel overflow-hidden mb-4">
        <div className="px-5 pt-4 pb-3 border-b hairline">
          <button className="btn btn-ghost px-2.5 py-1.5 text-[12.5px] mb-2" onClick={() => { setScreen('list'); setErr('') }}>
            <ChevronLeft size={14} /> กลับไปรายชื่อผู้ใช้
          </button>
          <h2 className="text-[20px] font-bold leading-tight">{editing ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้ใหม่'}</h2>
          <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
            {editing ? 'แก้ไขข้อมูลบัญชีและสิทธิการใช้งาน' : 'สร้างบัญชีใหม่สำหรับเข้าใช้งานระบบ'}
          </div>
        </div>

        <div className="p-5">
          {err && (
            <div className="mb-4 px-4 py-2.5 text-[13px] flex items-center gap-2 rounded-md"
              style={{ background: '#fef2f2', color: '#b91c1c', borderLeft: '4px solid #dc2626' }}>
              <AlertCircle size={14} /> {err}
            </div>
          )}

          <FormRow label="Username" required>
            <input className="input py-2 text-[13.5px] w-full" style={{ maxWidth: 340 }} autoFocus
              value={fUser} onChange={e => { setFUser(e.target.value); setErr('') }}
              onKeyDown={e => e.key === 'Enter' && submit()} />
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--muted)' }}>ชื่อที่ใช้เข้าสู่ระบบ (ตัวพิมพ์เล็ก-ใหญ่ถือว่าเหมือนกัน)</div>
          </FormRow>

          <FormRow label="ชื่อ-นามสกุล" required>
            <input className="input py-2 text-[13.5px] w-full" style={{ maxWidth: 340 }}
              value={fName} onChange={e => { setFName(e.target.value); setErr('') }}
              onKeyDown={e => e.key === 'Enter' && submit()} />
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--muted)' }}>ชื่อที่แสดงในระบบ เช่น ผู้บันทึก Gate-in / ผู้ตรวจ PDI</div>
          </FormRow>

          <FormRow label="รหัสผ่าน" required={!editing}>
            <button className="btn px-3 py-1.5 text-[12.5px] mb-2" onClick={() => { setFPass(makePassword()); setShowPw(true) }}>
              สร้างรหัสผ่านให้อัตโนมัติ
            </button>
            <div className="flex items-stretch gap-2" style={{ maxWidth: 340 }}>
              <input className="input py-2 text-[13.5px] flex-1" type={showPw ? 'text' : 'password'}
                placeholder={editing ? 'เว้นว่าง = ใช้รหัสเดิม' : ''}
                value={fPass} onChange={e => { setFPass(e.target.value); setErr('') }}
                onKeyDown={e => e.key === 'Enter' && submit()} />
              <button className="btn px-3 text-[12.5px] shrink-0" onClick={() => setShowPw(v => !v)}>
                {showPw ? 'ซ่อน' : 'แสดง'}
              </button>
            </div>
            {fPass && (
              <div className="mt-1.5" style={{ maxWidth: 340 }}>
                <div className="h-[6px] rounded-full overflow-hidden" style={{ background: 'var(--chip)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${st.pct}%`, background: st.color }} />
                </div>
                <div className="text-[11.5px] mt-1 font-semibold" style={{ color: st.color }}>ความปลอดภัย: {st.label}</div>
              </div>
            )}
            {editing && !fPass && (
              <div className="text-[11.5px] mt-1" style={{ color: 'var(--muted)' }}>เว้นว่างไว้ถ้าไม่ต้องการเปลี่ยนรหัสผ่าน</div>
            )}
          </FormRow>

          <FormRow label="สิทธิการใช้งาน">
            <select className="input py-2 text-[13.5px] w-full" style={{ maxWidth: 340 }}
              value={fRole} onChange={e => setFRole(e.target.value as UserRole)}>
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--muted)' }}>{roleOf(fRole).desc}</div>
          </FormRow>

          <div className="flex items-center gap-2 pt-1" style={{ paddingLeft: 0 }}>
            <button className="btn btn-primary px-4 py-2" onClick={submit}>
              {editing ? <><Check size={15} /> บันทึกการแก้ไข</> : <><Plus size={15} /> เพิ่มผู้ใช้ใหม่</>}
            </button>
            <button className="btn px-4 py-2" onClick={() => { setScreen('list'); setErr('') }}>ยกเลิก</button>
          </div>
        </div>
      </section>
    )
  }

  // ── List screen ─────────────────────────────────────────────────────────
  return (
    <section className="panel overflow-hidden mb-4">
      {/* title + Add New, WordPress-style */}
      <div className="px-5 pt-4 pb-3 flex items-center gap-3 flex-wrap">
        <h2 className="text-[20px] font-bold leading-none flex items-center gap-2">
          <ShieldCheck size={19} style={{ color: 'var(--brand)' }} /> ผู้ใช้งาน
        </h2>
        <button className="btn px-3 py-1 text-[12.5px] font-semibold"
          style={{ color: 'var(--brand)', borderColor: 'var(--brand)' }} onClick={openAdd}>
          เพิ่มผู้ใช้ใหม่
        </button>
      </div>

      {/* action notice */}
      {notice && (
        <div className="mx-5 mb-3 px-4 py-2.5 text-[13px] flex items-center gap-2 rounded-md"
          style={{ background: '#f0fdf4', color: '#166534', borderLeft: '4px solid #22c55e' }}>
          <Check size={14} /> {notice.text}
          {notice.linkId && (
            <button className="underline font-semibold" onClick={() => openEdit(notice.linkId!)}>แก้ไขผู้ใช้</button>
          )}
          <button className="ml-auto p-0.5" title="ปิด" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      )}

      {/* role filter links with live counts */}
      <div className="px-5 pb-3 flex items-center gap-1.5 flex-wrap text-[12.5px]">
        <FilterLink label="ทั้งหมด" count={countAll} active={filter === 'all'} onClick={() => setFilter('all')} />
        {ROLES.map(r => (
          <span key={r.value} className="flex items-center gap-1.5">
            <span style={{ color: 'var(--line-strong, var(--line))' }}>|</span>
            <FilterLink label={r.label} count={countOf(r.value)} active={filter === r.value} onClick={() => setFilter(r.value)} />
          </span>
        ))}
      </div>

      {/* bulk actions + search */}
      <div className="px-5 pb-3 flex items-end gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <select className="input py-1.5 text-[12.5px]" style={{ minWidth: 130 }}
            value={bulk} onChange={e => setBulk(e.target.value as BulkAction)}>
            <option value="">ดำเนินการกับที่เลือก</option>
            <option value="activate">เปิดใช้งาน</option>
            <option value="deactivate">ปิดใช้งาน</option>
            <option value="delete">ลบ</option>
          </select>
          <button className="btn px-3 py-1.5 text-[12.5px]" disabled={!bulk || !sel.size} onClick={applyBulk}>ทำ</button>
        </div>
        <div className="flex items-center gap-1.5">
          <select className="input py-1.5 text-[12.5px]" style={{ minWidth: 140 }}
            value={bulkRole} onChange={e => setBulkRole(e.target.value as UserRole | '')}>
            <option value="">เปลี่ยนสิทธิเป็น…</option>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <button className="btn px-3 py-1.5 text-[12.5px]" disabled={!bulkRole || !sel.size} onClick={applyRole}>เปลี่ยน</button>
        </div>
        <div className="relative ml-auto" style={{ minWidth: 190 }}>
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
          {/* padding inline, not `pl-8`: .input is declared outside Tailwind's
              cascade layers, so it beats the utility and the icon lands on top
              of the placeholder text */}
          <input className="input py-1.5 text-[12.5px] w-full" style={{ paddingLeft: 30 }} placeholder="ค้นหาผู้ใช้…"
            value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>

      {/* the table */}
      <div className="overflow-x-auto border-t hairline">
        <table className="w-full text-[13px]" style={{ minWidth: 620 }}>
          <thead>
            <tr style={{ background: 'var(--chip)' }}>
              <th className="px-4 py-2.5 w-10">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} className="cursor-pointer"
                  disabled={!selectable.length} />
              </th>
              {['ชื่อผู้ใช้', 'ชื่อ-นามสกุล', 'สิทธิ', 'สถานะ'].map(h => (
                <th key={h} className="text-left px-3 py-2.5 font-bold text-[11.5px]" style={{ color: 'var(--muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-12 text-[13px]" style={{ color: 'var(--faint)' }}>
                {appUsers.length === 0 ? 'ยังไม่มีผู้ใช้ในระบบ' : 'ไม่พบผู้ใช้ที่ค้นหา'}
              </td></tr>
            ) : shown.map((u, i) => {
              const meta = roleOf(u.role)
              const isMe = u.id === meId
              return (
                <tr key={u.id} className="group border-t transition-colors"
                  style={{ borderColor: 'var(--line)', background: sel.has(u.id) ? 'var(--brand-soft,#eef4ff)' : i % 2 === 1 ? 'var(--panel-2)' : undefined }}>
                  <td className="px-4 py-2.5 align-top">
                    <input type="checkbox" className="cursor-pointer mt-1.5" checked={sel.has(u.id)} disabled={isMe}
                      title={isMe ? 'บัญชีที่กำลังใช้งานอยู่ — เลือกไม่ได้' : ''}
                      onChange={() => setSel(s => { const x = new Set(s); x.has(u.id) ? x.delete(u.id) : x.add(u.id); return x })} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-[14px] shrink-0"
                        style={{ background: meta.bg, color: meta.color }}>{(u.name || u.username || '?').slice(0, 1)}</div>
                      <div className="min-w-0">
                        <button className="font-bold text-[13.5px] text-left hover:underline" style={{ color: 'var(--brand)' }}
                          onClick={() => openEdit(u.id)}>{u.username || '—'}</button>
                        {isMe && <span className="badge text-[10px] ml-1.5" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>คุณ</span>}
                        {/* row actions: always shown on touch, on hover for a mouse */}
                        <div className="flex items-center gap-1.5 text-[12px] mt-0.5 transition-opacity
                                        opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                          <button className="hover:underline" style={{ color: 'var(--brand)' }} onClick={() => openEdit(u.id)}>แก้ไข</button>
                          <span style={{ color: 'var(--faint)' }}>|</span>
                          <button className="hover:underline" style={{ color: 'var(--brand)' }}
                            onClick={() => updateAppUser(u.id, { active: !u.active })}>{u.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
                          {!isMe && <>
                            <span style={{ color: 'var(--faint)' }}>|</span>
                            <button className="hover:underline" style={{ color: '#dc2626' }} onClick={() => doDelete(u)}>ลบ</button>
                          </>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top" style={{ color: 'var(--text)' }}>
                    <span className="inline-block mt-1">{u.name || '—'}</span>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold mt-0.5"
                      style={{ background: meta.bg, color: meta.color }}>{meta.icon} {meta.label}</span>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <span className="badge text-[11px] mt-1 inline-block" style={u.active
                      ? { background: 'rgba(34,197,94,0.12)', color: '#16a34a' }
                      : { background: 'var(--chip)', color: 'var(--faint)' }}>
                      {u.active ? 'ใช้งานอยู่' : 'ปิดใช้งาน'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="px-5 py-2.5 border-t hairline text-[12px]" style={{ color: 'var(--muted)' }}>
        {sel.size > 0 ? `เลือกไว้ ${sel.size} รายการ · ` : ''}แสดง {shown.length} จาก {countAll} ผู้ใช้
      </div>
    </section>
  )
}

/** One "All (6) | Administrator (1)" style filter link. */
function FilterLink({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="hover:underline"
      style={{ color: active ? 'var(--text)' : 'var(--brand)', fontWeight: active ? 700 : 500 }}>
      {label} <span style={{ color: 'var(--muted)', fontWeight: 500 }}>({count})</span>
    </button>
  )
}

/** Label-left / field-right row, the shape of every WordPress settings form. */
function FormRow({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row md:items-start gap-1.5 md:gap-4 mb-4">
      <div className="md:w-[170px] md:text-right md:pt-2 shrink-0 font-semibold text-[13.5px]">
        {label}{required && <span style={{ color: '#dc2626' }}> *</span>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function Settings() {
  const {
    sites, currentSite, addSite, updateSite, removeSite, setCurrentSite, toast,
    currentUser, setUser, currentDriver, setDriver,
    lang, setLang, planMode, setPlanMode, groupModelsInRow, setGroupModels,
  } = useYard()

  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCode, setEditCode] = useState('')

  const startEdit = (s: { id: string; name: string; code?: string }) => { setEditId(s.id); setEditName(s.name); setEditCode(s.code ?? '') }
  const cancelEdit = () => { setEditId(null); setEditName(''); setEditCode('') }
  const saveEdit = (id: string) => {
    const n = editName.trim()
    if (!n) { toast('err', 'กรุณาใส่ชื่อ Site'); return }
    if (sites.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) { toast('err', `มี Site "${n}" อยู่แล้ว`); return }
    updateSite(id, { name: n, code: editCode })
    toast('ok', `บันทึก Site "${n}" แล้ว`)
    cancelEdit()
  }

  const add = () => {
    const n = name.trim()
    if (!n) return
    if (sites.some((s) => s.name.toLowerCase() === n.toLowerCase())) { toast('err', `มี Site "${n}" อยู่แล้ว`); return }
    addSite(n, code)
    setName(''); setCode('')
    toast('ok', `เพิ่ม Site "${n}" แล้ว`)
  }
  const del = (id: string, nm: string) => {
    if (window.confirm(`ลบ Site "${nm}" ?`)) { removeSite(id); toast('ok', `ลบ Site "${nm}" แล้ว`) }
  }

  return (
    <div className="max-w-[920px] mx-auto">
      <PageHead
        title={<span className="flex items-center gap-2"><SettingsIcon size={20} style={{ color: 'var(--brand)' }} /> ตั้งค่า</span>}
        sub="จัดการ Site งาน และการตั้งค่าระบบ"
      />

      {/* ── User permissions ── */}
      <UserManager />

      {/* ── VIN management ── */}
      <VinManager />

      {/* ── Site management ── */}
      <section className="panel overflow-hidden mb-4">
        <div className="px-4 py-3 border-b hairline flex items-center gap-2">
          <Building2 size={16} style={{ color: 'var(--brand)' }} />
          <span className="font-semibold text-[14.5px]">จัดการ Site งาน</span>
          <span className="badge ml-auto" style={{ color: 'var(--brand)', background: 'var(--brand-soft, #eef4ff)' }}>{sites.length} Site</span>
        </div>

        {/* add new */}
        <div className="p-4 border-b hairline" style={{ background: 'var(--app-bg)' }}>
          <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>เพิ่ม Site ใหม่</div>
          <div className="flex flex-wrap items-center gap-2">
            <input className="input py-2 text-[13.5px] flex-1" style={{ minWidth: 180 }} placeholder="ชื่อ Site (เช่น A5, ลานระยอง)"
              value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
            <input className="input py-2 text-[13.5px]" style={{ width: 170 }} placeholder="รหัส / โซน (ไม่บังคับ)"
              value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
            <button className="btn btn-primary px-4 py-2" onClick={add} disabled={!name.trim()}>
              <Plus size={16} /> เพิ่ม Site
            </button>
          </div>
        </div>

        {/* list */}
        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          {sites.map((s) => {
            const active = currentSite === s.id
            const editing = editId === s.id
            return (
              <div key={s.id} className="px-4 py-3">
                {editing ? (
                  // ── edit mode: rename + delete are only reachable here (avoids mis-clicks) ──
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--brand-soft, #eef4ff)' }}>
                      <MapPin size={16} style={{ color: 'var(--brand)' }} />
                    </div>
                    <input className="input py-2 text-[13.5px] flex-1" style={{ minWidth: 130 }} placeholder="ชื่อ Site" autoFocus
                      value={editName} onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(s.id); if (e.key === 'Escape') cancelEdit() }} />
                    <input className="input py-2 text-[13.5px]" style={{ width: 140 }} placeholder="รหัส / โซน"
                      value={editCode} onChange={(e) => setEditCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(s.id) }} />
                    <button className="btn btn-primary px-3 py-2 text-[12.5px]" onClick={() => saveEdit(s.id)}><Check size={14} /> บันทึก</button>
                    <button className="btn px-3 py-2 text-[12.5px]" onClick={cancelEdit}><X size={14} /> ยกเลิก</button>
                    <button className="btn px-3 py-2 text-[12.5px] font-semibold" title="ลบ Site"
                      style={{ color: 'var(--st-damage)', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)' }}
                      onClick={() => del(s.id, s.name)}><Trash2 size={14} /> ลบ Site</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                      style={active ? { background: 'var(--brand)' } : { background: 'var(--chip)' }}>
                      <MapPin size={16} style={{ color: active ? '#fff' : 'var(--brand)' }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[14px] flex items-center gap-2">
                        {s.name}
                        {active && <span className="badge" style={{ color: 'var(--st-yard)', background: 'rgba(34,197,94,0.12)' }}><span className="live">●</span> ใช้งานอยู่</span>}
                      </div>
                      <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                        {s.code ? `${s.code} · ` : ''}{s.custom ? 'สร้างโดยแอดมิน' : 'ค่าเริ่มต้น'}
                      </div>
                    </div>
                    {!active && (
                      <button className="btn btn-ghost px-3 py-1.5 text-[12.5px]" onClick={() => { setCurrentSite(s.id); toast('ok', `สลับไป Site ${s.name}`) }}>
                        <Check size={14} /> ใช้งาน
                      </button>
                    )}
                    <button className="btn btn-ghost px-3 py-1.5 text-[12.5px]" title="แก้ไข Site" onClick={() => startEdit(s)}>
                      <Pencil size={14} /> แก้ไข
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

    </div>
  )
}

function Field({ icon, label, desc, children }: { icon: React.ReactNode; label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-[13.5px]">{label}</div>
        {desc && <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="inline-flex p-1 rounded-xl gap-1" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}>
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)}
          className={cx('px-3.5 py-1.5 rounded-lg text-[13px] font-semibold transition')}
          style={value === v
            ? { background: '#fff', color: 'var(--brand)', boxShadow: '0 0 0 1px var(--line-strong), 0 1px 2px rgba(16,24,40,0.12)' }
            : { color: 'var(--muted)' }}>
          {l}
        </button>
      ))}
    </div>
  )
}
