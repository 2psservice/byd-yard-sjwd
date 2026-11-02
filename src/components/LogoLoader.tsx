const LOGO_SRC = '/2ps-logo.png'

/** Brand logo that fills from left → right, faint → dark (kept for small inline spinners). */
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

/**
 * หน้า Loading แบบ macOS: พื้นขาวล้วน โลโก้นิ่งกลางจอ แถบความคืบหน้าเส้นบางใต้โลโก้ ตัวหนังสือเล็กสีเทา
 * pct = ตัวเลขจริง (เช่นโหลดแถวของยาร์ด) · ไม่ส่ง = ยังไม่รู้ว่าเหลือเท่าไร แถบค่อย ๆ ขยับเอง (ไม่เกิน ~25%
 * เพื่อให้ต่อกับหน้าโหลดยาร์ดที่มีตัวเลขจริงได้โดยแถบไม่ถอยหลังมาก)
 */
export function BootScreen({ pct, label, testId }: { pct?: number | null; label?: string; testId?: string }) {
  const known = pct != null
  return (
    <div className="boot-screen" data-testid={testId} role="status" aria-live="polite">
      <img className="boot-logo" src={LOGO_SRC} alt="2PS Services" />
      <div className="boot-bar" aria-hidden="true">
        <div className={known ? 'boot-fill' : 'boot-fill boot-creep'} style={known ? { width: `${Math.max(2, Math.min(100, pct!))}%` } : undefined} />
      </div>
      {label && <div className="boot-label">{label}</div>}
    </div>
  )
}

/** Full-screen loading screen (app start, roster, lazy pages). */
export function LogoLoaderOverlay({ label }: { width?: number; label?: string }) {
  return <BootScreen label={label} />
}
