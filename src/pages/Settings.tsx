/**
 * Settings — admin site management + general app preferences.
 * Sites created/deleted here feed the post-login "Select Site" modal.
 */
import { useMemo, useState } from 'react'
import {
  Settings as SettingsIcon, MapPin, Plus, Trash2, Check, Building2,
  User, Car, Globe, Zap, Hand, SlidersHorizontal, Hash, Search,
  ChevronLeft, ChevronRight, AlertCircle, Pencil, X, ShieldCheck,
  Wrench, ScanLine, ClipboardCheck,
} from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import type { UserRole } from '../types'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { PageHead, Toggle, cx } from '../components/ui'

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i

// readable status for yard-unit-only VINs (mirrors tracking "Car Status" wording)
const UNIT_STATUS_LABEL: Record<string, string> = {
  EXPECTED: 'Pre Gate-in', GATE_IN: 'Gate-in', ASSIGNED: 'Moving',
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
          <input className="input pl-8 py-1.5 text-[13px] w-full" placeholder="ค้นหา VIN / รุ่น / สี…"
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

function UserManager() {
  const appUsers        = useYard(s => s.appUsers)
  const addAppUser      = useYard(s => s.addAppUser)
  const updateAppUser   = useYard(s => s.updateAppUser)
  const removeAppUser   = useYard(s => s.removeAppUser)

  const [newName,  setNewName]  = useState('')
  const [newRole,  setNewRole]  = useState<UserRole>('driver')
  const [newUser,  setNewUser]  = useState('')
  const [newPass,  setNewPass]  = useState('')
  const [editId,   setEditId]   = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState<UserRole>('driver')
  const [editUser, setEditUser] = useState('')
  const [editPass, setEditPass] = useState('')
  const [err, setErr]           = useState('')
  const [showPw,   setShowPw]   = useState<Record<string, boolean>>({})

  // usernames are login identities — compare case-insensitively so "TEST" and
  // "test" are treated as the same account, not two different (one unreachable)
  const sameUsername = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

  const doAdd = () => {
    const n = newName.trim()
    if (!n) { setErr('กรุณาใส่ชื่อ'); return }
    if (!newUser.trim()) { setErr('กรุณาใส่ Username'); return }
    if (appUsers.some(u => u.name === n)) { setErr(`มีชื่อ "${n}" อยู่แล้ว`); return }
    if (appUsers.some(u => sameUsername(u.username, newUser))) { setErr(`Username "${newUser.trim()}" ถูกใช้แล้ว`); return }
    addAppUser(n, newRole, newUser.trim(), newPass)
    setNewName(''); setNewUser(''); setNewPass(''); setErr('')
  }

  const startEdit = (u: { id: string; name: string; role: UserRole; username: string; password: string }) => {
    setEditId(u.id); setEditName(u.name); setEditRole(u.role); setEditUser(u.username); setEditPass(u.password); setErr('')
  }
  const saveEdit = () => {
    const n = editName.trim()
    if (!n || !editId) return
    if (!editUser.trim()) { setErr('กรุณาใส่ Username'); return }
    if (appUsers.some(u => u.id !== editId && sameUsername(u.username, editUser))) { setErr(`Username "${editUser.trim()}" ถูกใช้แล้ว`); return }
    updateAppUser(editId, { name: n, role: editRole, username: editUser.trim(), password: editPass })
    setEditId(null); setErr('')
  }

  const countByRole = (r: UserRole) => appUsers.filter(u => u.role === r && u.active).length

  return (
    <section className="panel overflow-hidden mb-4">
      <div className="px-4 py-3 border-b hairline flex items-center gap-2">
        <ShieldCheck size={16} style={{ color: 'var(--brand)' }} />
        <span className="font-semibold text-[14.5px]">สิทธิการใช้งาน</span>
        <span className="badge ml-auto" style={{ color: 'var(--brand)', background: 'var(--brand-soft,#eef4ff)' }}>
          {appUsers.length} ผู้ใช้
        </span>
      </div>

      {/* role summary chips */}
      <div className="px-4 py-3 flex flex-wrap gap-2 border-b hairline" style={{ background: 'var(--app-bg)' }}>
        {ROLES.map(r => (
          <div key={r.value} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-semibold"
            style={{ background: r.bg, color: r.color }}>
            {r.icon} {r.label}
            <span className="ml-1 font-black">{countByRole(r.value)}</span>
          </div>
        ))}
      </div>

      {/* add form */}
      <div className="p-4 border-b hairline" style={{ background: 'var(--app-bg)' }}>
        <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>เพิ่มผู้ใช้ใหม่</div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input className="input py-2 text-[13.5px]" placeholder="ชื่อ-นามสกุล"
            value={newName} onChange={e => { setNewName(e.target.value); setErr('') }} onKeyDown={e => e.key === 'Enter' && doAdd()} />
          <select className="input py-2 text-[13px]" value={newRole} onChange={e => setNewRole(e.target.value as UserRole)}>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <input className="input py-2 text-[13.5px]" placeholder="Username"
            value={newUser} onChange={e => { setNewUser(e.target.value); setErr('') }} onKeyDown={e => e.key === 'Enter' && doAdd()} />
          <input className="input py-2 text-[13.5px]" placeholder="Password" type="text"
            value={newPass} onChange={e => { setNewPass(e.target.value); setErr('') }} onKeyDown={e => e.key === 'Enter' && doAdd()} />
        </div>
        <button className="btn btn-primary px-4 py-2 shrink-0" onClick={doAdd} disabled={!newName.trim() || !newUser.trim()}>
          <Plus size={15} /> เพิ่มผู้ใช้
        </button>
        {err && <div className="text-[12px] mt-2 flex items-center gap-1" style={{ color: '#dc2626' }}><AlertCircle size={13} />{err}</div>}
      </div>

      {/* user list */}
      <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
        {appUsers.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px]" style={{ color: 'var(--faint)' }}>ยังไม่มีผู้ใช้ในระบบ</div>
        )}
        {appUsers.map(u => {
          const meta = roleOf(u.role)
          const isEdit = editId === u.id
          return (
            <div key={u.id} className="px-4 py-3 flex items-center gap-3">
              {/* avatar */}
              <div className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-[15px] shrink-0"
                style={{ background: meta.bg, color: meta.color }}>
                {u.name.slice(0, 1)}
              </div>

              {isEdit ? (
                /* edit mode */
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input className="input py-1.5 text-[13.5px]" style={{ minWidth: 130 }} autoFocus placeholder="ชื่อ-นามสกุล"
                      value={editName} onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditId(null) }} />
                    <select className="input py-1.5 text-[13px]" style={{ minWidth: 150 }}
                      value={editRole} onChange={e => setEditRole(e.target.value as UserRole)}>
                      {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input className="input py-1.5 text-[13px]" style={{ minWidth: 130 }} placeholder="Username"
                      value={editUser} onChange={e => { setEditUser(e.target.value); setErr('') }} />
                    <input className="input py-1.5 text-[13px]" style={{ minWidth: 130 }} placeholder="Password" type="text"
                      value={editPass} onChange={e => setEditPass(e.target.value)} />
                    <button className="btn btn-primary px-3 py-1.5 text-[12.5px]" onClick={saveEdit}><Check size={14} /> บันทึก</button>
                    <button className="btn px-3 py-1.5 text-[12.5px]" onClick={() => setEditId(null)}><X size={14} /></button>
                  </div>
                </div>
              ) : (
                /* view mode */
                <>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[13.5px] flex items-center gap-2">
                      {u.name}
                      {!u.active && <span className="badge text-[10px]" style={{ background: 'var(--chip)', color: 'var(--faint)' }}>ปิดใช้งาน</span>}
                    </div>
                    <div className="text-[11.5px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--muted)' }}>
                      <span className="font-mono">@{u.username || '—'}</span>
                      <span style={{ color: 'var(--faint)' }}>·</span>
                      <span>{meta.desc}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold shrink-0"
                    style={{ background: meta.bg, color: meta.color }}>
                    {meta.icon} {meta.label}
                  </div>
                  <Toggle checked={u.active} onChange={v => updateAppUser(u.id, { active: v })} />
                  <button className="btn btn-ghost px-2.5 py-1.5" title="แก้ไข" onClick={() => startEdit({ id: u.id, name: u.name, role: u.role, username: u.username, password: u.password })}>
                    <Pencil size={14} />
                  </button>
                  <button className="btn px-2.5 py-1.5" title="ลบ"
                    style={{ color: '#dc2626', background: 'rgba(220,38,38,0.07)' }}
                    onClick={() => { if (confirm(`ลบผู้ใช้ "${u.name}" ?`)) removeAppUser(u.id) }}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </section>
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
