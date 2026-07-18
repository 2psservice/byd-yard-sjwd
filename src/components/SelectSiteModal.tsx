/**
 * SelectSiteModal — shown after login so the operator picks which work site
 * (yard) they're stationed at. Site *management* (create / delete) lives in the
 * Settings page; this modal only selects.
 */
import { useEffect, useState } from 'react'
import { MapPin, X, Check } from 'lucide-react'
import { useYard } from '../store/useYard'

export function SelectSiteModal() {
  const open = useYard((s) => s.siteModalOpen)
  const sites = useYard((s) => s.sites)
  const currentSite = useYard((s) => s.currentSite)
  const { setCurrentSite, closeSiteModal } = useYard()

  const [picked, setPicked] = useState<string | null>(currentSite)

  useEffect(() => { if (open) setPicked(currentSite ?? sites[0]?.id ?? null) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes only when a site is already active — before the first pick
  // the modal is mandatory (no silent dismissal into a site-less session)
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && currentSite) closeSiteModal() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, closeSiteModal, currentSite])

  if (!open) return null

  const confirm = () => { if (picked) setCurrentSite(picked) }
  const pickedName = picked ? sites.find((s) => s.id === picked)?.name ?? '' : ''

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(20px) saturate(1.2)', WebkitBackdropFilter: 'blur(20px) saturate(1.2)' }}
      onClick={() => currentSite && closeSiteModal()}>
      <div className="pop w-full overflow-hidden flex flex-col"
        style={{
          maxWidth: 640, borderRadius: 18, background: 'var(--panel)',
          border: '0.5px solid rgba(0,0,0,0.10)',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.45), 0 8px 24px -12px rgba(0,0,0,0.25), inset 0 0.5px 0 rgba(255,255,255,0.7)',
        }}
        onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4">
          <div className="flex items-center gap-3">
            <img src="/2ps-logo.png" alt="2PS Services" className="shrink-0"
              style={{ height: 30, width: 'auto', objectFit: 'contain' }} />
            <div className="w-px h-8 shrink-0" style={{ background: 'var(--line)' }} />
            <div>
              <div className="display text-[18px] leading-tight" style={{ letterSpacing: '-0.02em' }}>Select Work Site</div>
              <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--muted)' }}>Choose the yard you're working at</div>
            </div>
          </div>
          {currentSite && (
            <button className="w-8 h-8 rounded-full flex items-center justify-center transition-colors shrink-0"
              style={{ background: 'var(--chip)', color: 'var(--muted)' }} onClick={closeSiteModal} title="Close">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="divider mx-6" />

        {/* site grid */}
        <div className="px-5 py-4 overflow-auto" style={{ maxHeight: '58vh' }}>
          <div className="grid sm:grid-cols-2 gap-2.5">
            {sites.map((s) => {
              const active = picked === s.id
              return (
                <button key={s.id} onClick={() => setPicked(s.id)}
                  className="relative flex items-center gap-3 rounded-[14px] px-3.5 py-3 text-left transition-all duration-150 active:scale-[0.985]"
                  style={active
                    ? { background: 'var(--brand-soft)', boxShadow: 'inset 0 0 0 1.5px var(--brand)' }
                    : { background: 'var(--panel)', boxShadow: 'inset 0 0 0 1px var(--line)' }}>
                  <div className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 transition-colors"
                    style={active
                      ? { background: 'var(--brand)', boxShadow: '0 3px 8px -3px var(--brand-glow)' }
                      : { background: 'var(--chip)' }}>
                    <MapPin size={17} style={{ color: active ? '#fff' : 'var(--muted)' }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[14.5px] clip" style={{ color: 'var(--text)', letterSpacing: '-0.01em' }}>{s.name}</div>
                    {s.code && <div className="text-[11.5px] mt-0.5 clip" style={{ color: 'var(--muted)' }}>{s.code}</div>}
                  </div>
                  {active && (
                    <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0"
                      style={{ background: 'var(--brand)' }}>
                      <Check size={14} strokeWidth={3} style={{ color: '#fff' }} />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* footer */}
        <div className="px-5 py-4 flex items-center gap-2.5"
          style={{ borderTop: '0.5px solid var(--line)', background: 'var(--panel-2)' }}>
          <button onClick={confirm} disabled={!picked}
            className="flex-1 h-11 rounded-[10px] text-[14.5px] font-semibold flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
            style={picked
              ? { background: 'var(--brand)', color: '#fff', boxShadow: '0 6px 16px -6px var(--brand-glow)' }
              : { background: 'var(--chip)', color: 'var(--faint)', cursor: 'not-allowed' }}>
            <MapPin size={17} /> Confirm Site{pickedName ? ` · ${pickedName}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
