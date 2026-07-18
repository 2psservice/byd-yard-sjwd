/**
 * 2PS Services brand assets.
 * Logo     — the full horizontal wordmark ("2PS" + "2PS SERVICES CO.,LTD").
 * LogoMark — a square app-icon badge showing just the 2PS symbol (no subtitle).
 */
const WORDMARK = '/2ps-logo.png'
const MARK = '/2ps-mark.png'

export function Logo({ height = 30, className }: { height?: number; className?: string }) {
  return (
    <img src={WORDMARK} alt="2PS Services" className={className} draggable={false}
      style={{ height, width: 'auto', display: 'block', maxWidth: 'none' }} />
  )
}

export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <div className="shrink-0 flex items-center justify-center"
      style={{ width: size, height: size, borderRadius: size * 0.28, background: '#fff', border: '1px solid var(--line)' }}>
      <img src={MARK} alt="2PS Services" draggable={false}
        style={{ width: '82%', height: '82%', objectFit: 'contain' }} />
    </div>
  )
}
