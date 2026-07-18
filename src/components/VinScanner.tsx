import { ScanLine, Camera, CornerDownLeft } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/** Reusable VIN capture: framed "camera" viewport + manual entry. */
export function VinScanner({
  onScan, onDemo, hint, accent = 'var(--brand)',
}: {
  onScan: (vin: string) => void
  onDemo?: () => string | undefined
  hint?: string
  accent?: string
}) {
  const [v, setV] = useState('')
  const [flash, setFlash] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { ref.current?.focus() }, [])

  const fire = (vin: string) => {
    const clean = vin.trim().toUpperCase()
    if (!clean) return
    setFlash(true)
    setTimeout(() => setFlash(false), 320)
    onScan(clean)
    setV('')
    ref.current?.focus()
  }

  return (
    <div className="panel p-4">
      {/* viewport */}
      <div
        className="relative rounded-xl overflow-hidden mb-3"
        style={{
          height: 150,
          background: 'radial-gradient(120% 80% at 50% 0%, rgba(37,99,235,0.07), #eef2f8)',
          border: `1px solid ${flash ? accent : 'var(--line-strong)'}`,
          transition: 'border-color .2s',
        }}
      >
        {/* corner brackets */}
        {[
          { top: 14, left: 14, bt: 1, bl: 1 }, { top: 14, right: 14, bt: 1, br: 1 },
          { bottom: 14, left: 14, bb: 1, bl: 1 }, { bottom: 14, right: 14, bb: 1, br: 1 },
        ].map((c, i) => (
          <span key={i} style={{
            position: 'absolute', width: 26, height: 26, ...c as any,
            borderTop: c.bt ? `2px solid ${accent}` : undefined,
            borderBottom: c.bb ? `2px solid ${accent}` : undefined,
            borderLeft: c.bl ? `2px solid ${accent}` : undefined,
            borderRight: c.br ? `2px solid ${accent}` : undefined,
            borderRadius: 4,
          }} />
        ))}
        <div className="scanline" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <ScanLine size={26} style={{ color: accent, opacity: 0.85 }} />
          <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{hint ?? 'จ่อกล้องไปที่บาร์โค้ด VIN'}</span>
        </div>
        {flash && <div className="absolute inset-0 pop" style={{ background: `${accent}26` }} />}
      </div>

      {/* manual entry */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            ref={ref}
            className="input vin pr-9 uppercase"
            placeholder="พิมพ์ / สแกนเลข VIN…"
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fire(v)}
          />
          <CornerDownLeft size={15} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--faint)' }} />
        </div>
        <button className="btn btn-primary" onClick={() => fire(v)} style={{ background: `linear-gradient(180deg, ${accent}, ${accent})`, color: '#fff' }}>
          <ScanLine size={16} /> สแกน
        </button>
        {onDemo && (
          <button
            className="btn"
            title="จำลองการสแกนคันถัดไป"
            onClick={() => { const vin = onDemo(); if (vin) fire(vin) }}
          >
            <Camera size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
