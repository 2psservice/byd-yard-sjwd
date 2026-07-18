const LOGO_SRC = '/2ps-logo.png'

/** Brand logo that fills from left → right, faint → dark — the app's loading effect. */
export function LogoLoader({ width = 200, className = '' }: { width?: number; className?: string }) {
  return (
    <div className={`logo-loader ${className}`} style={{ width }}>
      <img className="ll-ghost" src={LOGO_SRC} alt="" />
      <div className="ll-reveal">
        <img src={LOGO_SRC} alt="loading" />
      </div>
    </div>
  )
}

/** Full-screen branded loading overlay. */
export function LogoLoaderOverlay({ width = 230, label }: { width?: number; label?: string }) {
  return (
    <div className="logo-loader-overlay">
      <LogoLoader width={width} />
      {label && <div className="logo-loader-label">{label}</div>}
    </div>
  )
}
