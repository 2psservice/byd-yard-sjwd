import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Filterable bilingual dropdown — a real tappable list (native <datalist> does
 *  not show a usable dropdown on mobile). Value stored is Thai; English shows
 *  under each option. Type to filter by either language. The list renders in a
 *  portal with fixed positioning so no `overflow:hidden` ancestor clips it.
 *  Shared by the Gate-in walk-around Defect form and the PDI / Final Check NG tab. */
export function MasterCombo({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void; options: { id: string; en: string; th: string }[]; placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null)
  const measure = () => {
    const r = inputRef.current?.getBoundingClientRect()
    if (r) setBox({ left: r.left, top: r.bottom, width: r.width })
  }
  const q = value.trim().toLowerCase()
  const matches = useMemo(() => {
    const list = q ? options.filter(o => o.th.toLowerCase().includes(q) || o.en.toLowerCase().includes(q)) : options
    return list.slice(0, 60)
  }, [q, options])
  useEffect(() => {
    if (!open) return
    const reposition = () => measure()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) }
  }, [open])
  const openList = () => { measure(); setOpen(true) }
  const pick = (v: string) => { onChange(v); setOpen(false) }
  return (
    <>
      <input
        ref={inputRef}
        className="input text-[12.5px] w-full" style={{ padding: '7px 8px' }}
        placeholder={placeholder} value={value}
        onFocus={openList} onClick={openList}
        onChange={e => { onChange(e.target.value); measure(); setOpen(true) }}
      />
      {open && box && matches.length > 0 && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: 90 }} onMouseDown={() => setOpen(false)} onTouchStart={() => setOpen(false)} />
          <div className="rounded-xl overflow-auto" style={{ position: 'fixed', left: box.left, top: box.top + 4, width: box.width, maxHeight: 240, zIndex: 91, background: 'var(--panel)', border: '1px solid var(--line-strong)', boxShadow: '0 12px 32px -8px rgba(15,23,42,0.4)' }}>
            {matches.map(o => (
              <button key={o.id} type="button" onMouseDown={e => e.preventDefault()}
                onClick={() => pick(o.th)}
                className="w-full text-left px-3 py-2 border-b hairline last:border-0 active:bg-chip">
                <div className="text-[13px] font-semibold">{o.th}</div>
                <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{o.en}</div>
              </button>
            ))}
          </div>
        </>, document.body)
      }
    </>
  )
}
