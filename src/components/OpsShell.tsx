/**
 * OpsShell — minimal chrome for field roles (Driver / Walk Around / PM / ช่างซ่อม).
 * These accounts only ever see the Yard Ops mobile station: no sidebar, no admin
 * pages. The top bar shows which yard they're stamped into (tap to switch) and
 * a logout button; everything else is the station content.
 */
import type { ReactNode } from 'react'
import { MapPin, LogOut, ChevronDown } from 'lucide-react'
import { useYard } from '../store/useYard'
import { LogoMark } from './Logo'

export function OpsShell({ children }: { children: ReactNode }) {
  const { sites, currentSite, openSiteModal, currentUser, logout } = useYard()
  const siteName = sites.find((s) => s.id === currentSite)?.name ?? null

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <header className="flex items-center gap-2.5 px-3 h-14 border-b hairline shrink-0"
        style={{ background: 'var(--glass)', backdropFilter: 'blur(22px) saturate(180%)', WebkitBackdropFilter: 'blur(22px) saturate(180%)' }}>
        <LogoMark size={30} />
        <div className="min-w-0">
          <div className="font-bold text-[13.5px] leading-tight whitespace-nowrap">SJWD Yard Control</div>
          <div className="text-[10.5px] leading-tight" style={{ color: 'var(--muted)' }}>{currentUser}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* active yard — tap to switch (forces an explicit choice, never silent) */}
          <button onClick={openSiteModal} title="เปลี่ยน Site งาน"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-semibold whitespace-nowrap"
            style={siteName
              ? { background: 'var(--brand-soft, #eef4ff)', color: 'var(--brand)', border: '1px solid rgba(37,99,235,0.2)' }
              : { background: 'rgba(234,179,8,0.12)', color: '#a16207', border: '1px solid rgba(234,179,8,0.3)' }}>
            <MapPin size={14} className="shrink-0" />
            <span className="clip" style={{ maxWidth: 110 }}>{siteName ?? 'เลือก Site'}</span>
            <ChevronDown size={13} style={{ opacity: 0.6 }} className="shrink-0" />
          </button>
          <button onClick={logout} title="ออกจากระบบ"
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626', border: '1px solid rgba(220,38,38,0.18)' }}>
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-4" style={{ background: 'var(--app-bg)' }}>{children}</main>
    </div>
  )
}
