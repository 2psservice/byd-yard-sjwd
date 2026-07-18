import { ChevronLeft, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UnitStatus } from '../types'
import { STATUS_META } from '../lib/format'
import { useYard } from '../store/useYard'

export const cx = (...a: (string | false | undefined | null)[]) => a.filter(Boolean).join(' ')

export function Badge({ color, bg, children, dotted = true }: { color: string; bg?: string; children: ReactNode; dotted?: boolean }) {
  return (
    <span className="badge" style={{ color, background: bg ?? `${color}22`, borderColor: `${color}33` }}>
      {dotted && <span className="dot" style={{ background: color }} />}
      {children}
    </span>
  )
}

export function StatusBadge({ status }: { status: UnitStatus }) {
  const lang = useYard((s) => s.lang)
  const m = STATUS_META[status]
  return (
    <Badge color={m.color} bg={m.bg}>
      {lang === 'th' ? m.th : m.en}
    </Badge>
  )
}

export function Stat({
  label, value, sub, accent, icon, onClick, image, imageVariant = 'side',
}: {
  label: string; value: ReactNode; sub?: ReactNode; accent?: string; icon?: ReactNode; onClick?: () => void
  image?: string; imageVariant?: 'side' | 'top'
}) {
  const fade = 'linear-gradient(90deg, transparent 0%, #000 56%)'
  const imgStyle: CSSProperties = imageVariant === 'top'
    ? { position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', height: '124%', width: 'auto',
        opacity: 0.24, pointerEvents: 'none', zIndex: 0, WebkitMaskImage: fade, maskImage: fade }
    : { position: 'absolute', right: 4, bottom: 2, width: '62%', height: 'auto',
        opacity: 0.26, pointerEvents: 'none', zIndex: 0, WebkitMaskImage: fade, maskImage: fade }
  return (
    <div
      className={cx('panel p-4 fade-up', onClick ? 'cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5 active:scale-[0.98]' : '')}
      onClick={onClick}
      style={{ position: 'relative', overflow: 'hidden', ...(onClick ? { userSelect: 'none' } : {}) }}
    >
      {image && <img src={image} alt="" aria-hidden style={imgStyle} />}
      <div className="relative" style={{ zIndex: 1 }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>{label}</span>
          {icon && <span style={{ color: accent ?? 'var(--brand)' }}>{icon}</span>}
        </div>
        <div className="kpi-value display tabular" style={{ color: accent ?? 'var(--text)' }}>{value}</div>
        {sub && <div className="text-[12px] mt-1" style={{ color: 'var(--faint)' }}>{sub}</div>}
        {onClick && <div className="text-[10.5px] mt-2 font-medium" style={{ color: accent ?? 'var(--brand)', opacity: 0.65 }}>คลิกเพื่อดูรายละเอียด ›</div>}
      </div>
    </div>
  )
}

export function Modal({
  open, onClose, title, children, wide, footer,
}: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
    >
      <div
        className="panel-solid glow-ring pop w-full overflow-hidden flex flex-col"
        style={{ maxWidth: wide ? 1080 : 560, maxHeight: '92vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b hairline">
            <div className="font-semibold display text-[15px]">{title}</div>
            <button className="btn-ghost btn p-2" onClick={onClose}><X size={17} /></button>
          </div>
        )}
        <div className="overflow-auto p-5">{children}</div>
        {footer && <div className="px-5 py-4 border-t hairline flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * Full-screen photo viewer — click any damage/inspection thumbnail to open.
 * Shared across YardOps (mobile walk-around/mechanic) and the Unit List
 * Damages tab so every "N photos taken at the station" spot behaves the same:
 * prev/next when there are several, scroll-wheel or +/- buttons to zoom
 * (drag to pan once zoomed, double-click to toggle 2×), and a download button
 * (the photos are already-compressed JPEG dataURLs, so this is just a save-as).
 */
export function PhotoLightbox({ photos, index, onClose }: { photos: string[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null)

  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [i])

  const clamp = (z: number) => Math.max(1, Math.min(4, z))
  const setZoomClamped = (z: number) => { const nz = clamp(z); setZoom(nz); if (nz === 1) setPan({ x: 0, y: 0 }) }
  const zoomIn = () => setZoomClamped(zoom + 0.5)
  const zoomOut = () => setZoomClamped(zoom - 0.5)
  const prev = () => setI((p) => (p - 1 + photos.length) % photos.length)
  const next = () => setI((p) => (p + 1) % photos.length)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && photos.length > 1) prev()
      else if (e.key === 'ArrowRight' && photos.length > 1) next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, photos.length])

  const onWheel = (e: React.WheelEvent) => { e.preventDefault(); setZoomClamped(zoom + (e.deltaY < 0 ? 0.25 : -0.25)) }
  const onImgDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y }
  }
  const onImgMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return
    setPan({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) })
  }
  const onImgUp = () => { dragRef.current = null }

  const download = () => {
    const a = document.createElement('a')
    a.href = photos[i]
    a.download = `damage-photo-${i + 1}.jpg`
    document.body.appendChild(a); a.click(); a.remove()
  }

  const iconBtn = { background: 'rgba(255,255,255,0.14)', color: '#fff' }
  return createPortal(
    <div className="fixed inset-0 z-[300] flex flex-col items-center justify-center select-none"
      style={{ background: 'rgba(8,15,28,0.94)' }} onClick={onClose}>
      <div className="absolute top-4 left-4 right-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {photos.length > 1 && (
          <span className="text-[13px] font-bold px-2.5 py-1 rounded-lg" style={{ color: '#fff', background: 'rgba(255,255,255,0.14)' }}>{i + 1} / {photos.length}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={zoomOut} disabled={zoom <= 1} className="w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-40" style={iconBtn} title="ซูมออก"><ZoomOut size={17} /></button>
          <span className="text-[12px] font-bold w-11 text-center tabular" style={{ color: '#fff' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={zoomIn} disabled={zoom >= 4} className="w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-40" style={iconBtn} title="ซูมเข้า"><ZoomIn size={17} /></button>
          <button onClick={download} className="w-9 h-9 rounded-full flex items-center justify-center" style={iconBtn} title="ดาวน์โหลด"><Download size={16} /></button>
          <button onClick={onClose} className="w-9 h-9 rounded-full flex items-center justify-center" style={iconBtn} title="ปิด"><X size={18} /></button>
        </div>
      </div>

      <div className="w-full h-full flex items-center justify-center overflow-hidden" onWheel={onWheel} onClick={(e) => e.stopPropagation()}>
        <img src={photos[i]} alt="" draggable={false}
          onPointerDown={onImgDown} onPointerMove={onImgMove} onPointerUp={onImgUp} onPointerLeave={onImgUp}
          onDoubleClick={() => setZoomClamped(zoom > 1 ? 1 : 2)}
          className="max-w-[92vw] max-h-[80vh] rounded-xl object-contain"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, cursor: zoom > 1 ? 'grab' : 'zoom-in', transition: dragRef.current ? 'none' : 'transform 0.1s' }} />
      </div>

      {photos.length > 1 && (
        <div className="absolute bottom-6 flex items-center gap-4" onClick={(e) => e.stopPropagation()}>
          <button onClick={prev} className="w-11 h-11 rounded-full flex items-center justify-center" style={iconBtn}><ChevronLeft size={20} /></button>
          <button onClick={next} className="w-11 h-11 rounded-full flex items-center justify-center" style={iconBtn}><ChevronLeft size={20} style={{ transform: 'rotate(180deg)' }} /></button>
        </div>
      )}
    </div>,
    document.body,
  )
}

export function Segmented<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-1 rounded-xl gap-1" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className="px-3.5 py-1.5 rounded-lg text-[13px] font-semibold transition"
          style={
            value === o.value
              ? { background: '#fff', color: 'var(--brand)', boxShadow: '0 0 0 1px var(--line-strong), 0 1px 2px rgba(16,24,40,0.12)' }
              : { color: 'var(--muted)' }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="relative rounded-full transition shrink-0"
      style={{ width: 42, height: 24, background: checked ? 'var(--brand)' : '#cbd5e1' }}
    >
      <span
        className="absolute rounded-full bg-white transition-all"
        style={{ width: 18, height: 18, top: 3, left: checked ? 21 : 3, boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }}
      />
    </button>
  )
}

export function ProgressBar({ value, max, color }: { value: number; max: number; color?: string }) {
  const p = max ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="track">
      <div className="fill" style={{ width: `${p}%`, background: color }} />
    </div>
  )
}

export function Toaster() {
  const toasts = useYard((s) => s.toasts)
  const dismiss = useYard((s) => s.dismissToast)
  const map = { ok: 'var(--st-yard)', err: 'var(--st-damage)', info: 'var(--brand-2)' } as const
  return (
    <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="panel-solid pop px-4 py-3 flex items-center gap-3 shadow-2xl cursor-pointer"
          style={{ borderLeft: `3px solid ${map[t.kind]}`, minWidth: 240 }}
          onClick={() => dismiss(t.id)}
        >
          <span className="dot" style={{ background: map[t.kind] }} />
          <span className="text-[13.5px] font-medium">{t.msg}</span>
        </div>
      ))}
    </div>
  )
}

export function PageHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-5 flex-wrap">
      <div>
        <h1 className="display text-[22px] font-bold leading-tight">{title}</h1>
        {sub && <p className="text-[13.5px] mt-1" style={{ color: 'var(--muted)' }}>{sub}</p>}
      </div>
      {right}
    </div>
  )
}
