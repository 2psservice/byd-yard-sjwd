import {
  LayoutDashboard, Upload, FileSpreadsheet, ScanLine, Car, Map, List, SlidersHorizontal,
  Search, Menu, Zap, Globe, Plug, X, Bell, Smartphone, Radar, MapPin, ChevronDown, Settings, ClipboardList, User, ShieldAlert, LogOut, Layers,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useYard, useUnits } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { makeT } from '../i18n'
import type { View } from '../types'
import { Segmented, cx } from './ui'
import { LogoMark } from './Logo'

const NAV: { view: View; icon: ReactNode }[] = [
  { view: 'dashboard', icon: <LayoutDashboard size={18} /> },
  { view: 'units', icon: <List size={18} /> },
  { view: 'yard', icon: <Map size={18} /> },
  { view: 'tracking', icon: <Radar size={18} /> },
  { view: 'operation', icon: <ClipboardList size={18} /> },
  { view: 'damages',   icon: <ShieldAlert size={18} /> },
  { view: 'grouping',  icon: <Layers size={18} /> },
  { view: 'report', icon: <FileSpreadsheet size={18} /> },
  { view: 'gatein', icon: <ScanLine size={18} /> },
  { view: 'driver', icon: <Car size={18} /> },
  { view: 'import', icon: <Upload size={18} /> },
  { view: 'rules', icon: <SlidersHorizontal size={18} /> },
  { view: 'yardops', icon: <Smartphone size={18} /> },
  { view: 'settings', icon: <Settings size={18} /> },
]

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', driver: 'Driver', walkAround: 'Walk Around', pmPdiFinal: 'PM/PDI/Final', mechanic: 'ช่างซ่อม',
}

function UserMenu({ onGoSettings }: { onGoSettings: () => void }) {
  const currentUser   = useYard(s => s.currentUser)
  const appUsers      = useYard(s => s.appUsers)
  const loggedInId    = useYard(s => s.loggedInUserId)
  const logout        = useYard(s => s.logout)
  const [open, setOpen] = useState(false)
  const [dropPos, setDropPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const ref    = useRef<HTMLDivElement>(null)

  const me = appUsers.find(u => u.id === loggedInId)

  const openMenu = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setDropPos({ top: r.bottom + 8, right: window.innerWidth - r.right })
    }
    setOpen(o => !o)
  }

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div className="hidden md:flex items-center gap-2 pl-2.5 ml-0.5 border-l hairline">
      <button
        ref={btnRef}
        onClick={openMenu}
        className="flex items-center gap-2 rounded-xl px-2 py-1 transition hover:bg-[var(--chip)]"
      >
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0"
          style={{ background: 'var(--brand)', color: '#fff' }}>
          {currentUser.slice(0, 1)}
        </div>
        <span className="text-[12.5px] font-medium hidden lg:block">{currentUser}</span>
        <ChevronDown size={12} style={{ color: 'var(--muted)' }} className="hidden lg:block" />
      </button>

      {open && createPortal(
        <div ref={ref}
          className="panel-solid rounded-xl overflow-hidden"
          style={{ position: 'fixed', top: dropPos.top, right: dropPos.right, minWidth: 200, zIndex: 99999, boxShadow: '0 8px 32px -6px rgba(0,0,0,0.22)' }}>
          <div className="px-4 py-3 border-b hairline">
            <div className="font-semibold text-[14px]">{currentUser}</div>
            {me && <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>{ROLE_LABEL[me.role] ?? me.role}</div>}
          </div>
          <button className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 text-[13px] hover:bg-[var(--chip)] transition-colors"
            onClick={() => { onGoSettings(); setOpen(false) }}>
            <Settings size={14} style={{ color: 'var(--muted)' }} /> ตั้งค่า
          </button>
          <button className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 text-[13px] border-t hairline hover:bg-[var(--chip)] transition-colors font-semibold"
            style={{ color: '#dc2626' }}
            onClick={() => { logout(); setOpen(false) }}>
            <LogOut size={14} /> ออกจากระบบ
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const { lang, view, setView, planMode, setPlanMode, setLang, currentUser, sites, currentSite, openSiteModal } = useYard()
  const siteName = sites.find((s) => s.id === currentSite)?.name ?? null
  const units = useUnits()
  const t = makeT(lang)
  const [mobileNav, setMobileNav] = useState(false)
  const [palette, setPalette] = useState(false)
  const [railHover, setRailHover] = useState(false)
  const RAIL = 64
  const FULL = 244
  const inYard = units.filter((u) => (!currentSite || u.site === currentSite) && ['GATE_IN', 'ASSIGNED', 'PARKED'].includes(u.status)).length
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const go = (v: View) => { setView(v); setMobileNav(false) }

  const renderSidebar = (expanded: boolean) => (
    <aside className="flex flex-col gap-1 p-3 h-full w-full overflow-hidden">
      <div className={cx('flex items-center gap-2.5 py-3 mb-2', expanded ? 'px-2' : 'justify-center')}>
        <LogoMark size={36} />
        {expanded && (
          <div className="min-w-0">
            <div className="display font-bold text-[15px] leading-none whitespace-nowrap">{t('appName')}</div>
            <div className="text-[11px] mt-0.5 whitespace-nowrap" style={{ color: 'var(--muted)' }}>{t('appSub')}</div>
          </div>
        )}
      </div>
      {NAV.map((n) => (
        <div key={n.view} className={cx('nav-item', view === n.view && 'active', !expanded && 'justify-center')}
          onClick={() => go(n.view)} title={!expanded ? t(n.view) : undefined}
          style={!expanded ? { paddingLeft: 0, paddingRight: 0 } : undefined}>
          <span className="shrink-0 flex">{n.icon}</span>
          {expanded && <span className="whitespace-nowrap">{t(n.view)}</span>}
        </div>
      ))}
      <div className={cx('mt-auto py-3 text-[11px] whitespace-nowrap', expanded ? 'px-2' : 'text-center')} style={{ color: 'var(--faint)' }}>
        {expanded ? 'v1.0 · 2PS Service' : 'v1.0'}
      </div>
    </aside>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      {/* desktop rail — collapses to icons, expands on hover */}
      <div className="hidden lg:block shrink-0 relative" style={{ width: RAIL }}>
        <div
          onMouseEnter={() => setRailHover(true)}
          onMouseLeave={() => setRailHover(false)}
          className="absolute top-0 left-0 h-full border-r hairline overflow-hidden"
          style={{
            width: railHover ? FULL : RAIL, zIndex: 50,
            background: 'var(--glass)', backdropFilter: 'blur(22px) saturate(180%)', WebkitBackdropFilter: 'blur(22px) saturate(180%)',
            transition: 'width 0.18s cubic-bezier(0.22,1,0.36,1)',
            boxShadow: railHover ? '0 12px 40px -10px rgba(0,0,0,0.18)' : 'none',
          }}
        >
          {renderSidebar(railHover)}
        </div>
      </div>

      {/* mobile slide-over */}
      {mobileNav && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="panel-solid h-full" style={{ borderRadius: 0, width: FULL }} onClick={(e) => e.stopPropagation()}>{renderSidebar(true)}</div>
          <div className="flex-1" style={{ background: 'rgba(15,23,42,0.4)' }} onClick={() => setMobileNav(false)} />
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* topbar */}
        <header className="flex items-center gap-3 px-4 h-14 border-b hairline shrink-0" style={{ background: 'var(--glass)', backdropFilter: 'blur(22px) saturate(180%)', WebkitBackdropFilter: 'blur(22px) saturate(180%)' }}>
          <button className="btn btn-ghost p-2 lg:hidden" onClick={() => setMobileNav(true)}><Menu size={18} /></button>

          <button className="btn flex-1 max-w-[320px] justify-start text-left" style={{ color: 'var(--muted)' }} onClick={() => setPalette(true)}>
            <Search size={15} /> <span className="text-[13px]">{t('search')} VIN…</span>
            <kbd className="k ml-auto">⌘K</kbd>
          </button>

          <div className="ml-auto flex items-center gap-2.5">
            {/* site switcher */}
            <button onClick={openSiteModal} title="เปลี่ยน Site งาน"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-semibold transition-all hover:shadow-sm whitespace-nowrap shrink-0"
              style={siteName
                ? { background: 'var(--brand-soft, #eef4ff)', color: 'var(--brand)', border: '1px solid rgba(37,99,235,0.2)' }
                : { background: 'rgba(234,179,8,0.12)', color: '#a16207', border: '1px solid rgba(234,179,8,0.3)' }}>
              <MapPin size={14} className="shrink-0" />
              <span className="hidden sm:inline clip" style={{ maxWidth: 120 }}>{siteName ?? 'เลือก Site'}</span>
              <ChevronDown size={13} style={{ opacity: 0.6 }} className="shrink-0" />
            </button>
            <div className="hidden sm:flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-md" style={{ color: 'var(--st-yard)', background: '#e7f6ec' }}>
              <span className="live">●</span> Connected
            </div>
            <div className="hidden md:flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-md" style={{ color: 'var(--muted)', background: 'var(--chip)' }}>
              <Plug size={12} /> {inYard.toLocaleString()} In Yard
            </div>
            <Segmented
              value={planMode}
              onChange={setPlanMode}
              options={[
                { value: 'AUTO', label: <span className="flex items-center gap-1"><Zap size={12} /> Auto</span> },
                { value: 'SEMI', label: 'Semi' },
              ]}
            />
            <button className="btn p-2" title="TH / EN" onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>
              <Globe size={15} /> <span className="text-[12px] font-bold">{lang.toUpperCase()}</span>
            </button>
            <button className="btn btn-ghost p-2 hidden sm:flex"><Bell size={16} style={{ color: 'var(--muted)' }} /></button>
            <UserMenu onGoSettings={() => go('settings')} />
          </div>
        </header>

        <main className="flex-1 overflow-auto p-4 md:p-6" style={{ background: 'var(--app-bg)' }}>{children}</main>

        {/* bottom status bar (TOS chrome) */}
        <footer className="flex items-center gap-4 px-4 h-7 border-t hairline shrink-0 text-[11.5px]" style={{ background: 'var(--glass)', backdropFilter: 'blur(22px) saturate(180%)', WebkitBackdropFilter: 'blur(22px) saturate(180%)', color: 'var(--muted)' }}>
          <span className="flex items-center gap-1.5" style={{ color: 'var(--st-yard)' }}><span className="live">●</span> Connected</span>
          <span>SJWD Yard Control</span>
          <span className="hidden sm:flex items-center gap-1" style={{ color: siteName ? 'var(--brand)' : 'var(--faint)' }}>
            <MapPin size={11} /> {siteName ?? 'ยังไม่เลือก Site'}
          </span>
          <span className="hidden sm:flex items-center gap-1"><User size={11} /> {currentUser}</span>
          <span className="ml-auto tabular">{today}</span>
        </footer>
      </div>

      {palette && <CommandPalette onClose={() => setPalette(false)} onGo={go} />}
    </div>
  )
}

function CommandPalette({ onClose, onGo }: { onClose: () => void; onGo: (v: View) => void }) {
  const { lang, setFocus } = useYard()
  const rows = useTrackingRows() // every VIN in the system (imported + added), not just gated-in units
  const t = makeT(lang)
  const [q, setQ] = useState('')

  const results = useMemo(() => {
    const query = q.trim().toUpperCase()
    const navMatches = NAV.filter((n) => t(n.view).toUpperCase().includes(query) || n.view.toUpperCase().includes(query))
      .map((n) => ({ kind: 'nav' as const, view: n.view, icon: n.icon, label: t(n.view) }))
    if (!query) return { nav: navMatches, units: [] as { vin: string; model: string; status: string }[] }
    const unitMatches = rows
      .filter((r) =>
        r.vin.toUpperCase().includes(query) ||
        (r.cells['Model name'] || r.cells['Model'] || '').toUpperCase().includes(query) ||
        (r.cells['Color'] || '').toUpperCase().includes(query))
      .slice(0, 8)
      .map((r) => ({ vin: r.vin, model: r.cells['Model name'] || r.cells['Model'] || '—', status: r.cells['Car Status'] || 'Pre Gate-in' }))
    return { nav: navMatches, units: unitMatches }
  }, [q, rows, t])

  const openUnit = (vin: string) => { setFocus(vin); onGo('units'); onClose() }

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] px-4" style={{ background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid glow-ring w-full pop overflow-hidden" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b hairline">
          <Search size={17} style={{ color: 'var(--muted)' }} />
          <input autoFocus className="flex-1 bg-transparent outline-none text-[15px] uppercase vin" placeholder="VIN / รุ่น / สี / เมนู…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && results.units[0]) openUnit(results.units[0].vin) }} />
          <button className="btn btn-ghost p-1.5" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="max-h-[52vh] overflow-auto p-2">
          {results.units.length > 0 && (
            <>
              <div className="text-[11px] font-bold px-2 py-1.5" style={{ color: 'var(--faint)' }}>VEHICLES</div>
              {results.units.map((u) => (
                <button key={u.vin} className="w-full text-left nav-item flex items-center gap-2" onClick={() => openUnit(u.vin)}>
                  <Car size={14} style={{ color: 'var(--muted)', flex: 'none' }} />
                  <span className="vin text-[13px]">{u.vin}</span>
                  <span className="text-[12px] clip" style={{ color: 'var(--muted)' }}>{u.model}</span>
                  <span className="badge ml-auto shrink-0" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>{u.status}</span>
                </button>
              ))}
            </>
          )}
          {q.trim() && results.units.length === 0 && (
            <div className="text-[12.5px] px-2 py-3 text-center" style={{ color: 'var(--faint)' }}>ไม่พบ VIN ที่ตรงกับ “{q.trim()}”</div>
          )}
          <div className="text-[11px] font-bold px-2 py-1.5 mt-1" style={{ color: 'var(--faint)' }}>MENU</div>
          {results.nav.map((n) => (
            <button key={n.view} className="w-full text-left nav-item" onClick={() => { onGo(n.view); onClose() }}>
              {n.icon}<span>{n.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
