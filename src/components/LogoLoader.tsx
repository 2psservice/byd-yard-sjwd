import { useEffect, useState } from 'react'

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
      <BootLogo />
      <div className="boot-bar" aria-hidden="true">
        <div className={known ? 'boot-fill' : 'boot-fill boot-creep'} style={known ? { width: `${Math.max(2, Math.min(100, pct!))}%` } : undefined} />
      </div>
      {label && <div className="boot-label">{label}</div>}
    </div>
  )
}

/**
 * โลโก้ 2PS วิ่งเข้ามาทีละตัว: 2 → P → S → เส้นโค้ง → ชื่อบริษัท
 * ใช้รูปโลโก้รูปเดียว ซ้อนกันหลายชั้น แต่ละชั้นตัด (clip-path) เหลือชิ้นเดียว แล้วเลื่อนเข้ามาตามลำดับ
 * พอประกอบครบ ชิ้นต่อกันพอดีเป็นโลโก้เดิม · เล่นครั้งเดียวต่อการเปิดแอป — หน้า Loading ถัดไป
 * (โหลดยาร์ด / เปิดหน้า) โชว์โลโก้นิ่ง ไม่วิ่งซ้ำทุกครั้ง
 */
// พิกัดเป็น % ของรูป 1000×399: "2" จบที่ x 264 · P / S แยกตามรอยต่อ x ≈ 485–525 · S จบที่ x 765
// · แถบตัวหนังสือ y 255–315 · ที่เหลือ (เส้นโค้งน้ำเงิน / เทา และเส้นใต้) เป็นชิ้นสุดท้าย
const LOGO_PIECES: { key: string; clip: string }[] = [
  { key: 'two', clip: 'polygon(0 0, 26.4% 0, 26.4% 64%, 0 64%)' },
  { key: 'p', clip: 'polygon(26.4% 0, 52.5% 0, 50.5% 32.5%, 50% 47.6%, 48.5% 64%, 26.4% 64%)' },
  { key: 's', clip: 'polygon(52.5% 0, 76.5% 0, 76.5% 64%, 48.5% 64%, 50% 47.6%, 50.5% 32.5%)' },
  { key: 'arc', clip: 'polygon(76.5% 0, 100% 0, 100% 100%, 0 100%, 0 79%, 64.8% 79%, 65% 64%, 76.5% 64%)' },
  { key: 'name', clip: 'polygon(0 64%, 65% 64%, 64.8% 79%, 0 79%)' },
]
let logoIntroPlayed = false

function BootLogo() {
  const [intro] = useState(() => !logoIntroPlayed)
  useEffect(() => { logoIntroPlayed = true }, [])
  // the clipped pieces leave a hairline seam where they meet — once assembled, the whole image takes over
  return (
    <div className={intro ? 'boot-logo boot-logo-intro' : 'boot-logo'} role="img" aria-label="2PS Services">
      {intro && LOGO_PIECES.map((p) => (
        <img key={p.key} className={`bl-piece bl-${p.key}`} src={LOGO_SRC} alt="" draggable={false} style={{ clipPath: p.clip, WebkitClipPath: p.clip }} />
      ))}
      <img className="bl-piece bl-full" src={LOGO_SRC} alt="" draggable={false} />
    </div>
  )
}

/** Full-screen loading screen (app start, roster, lazy pages). */
export function LogoLoaderOverlay({ label }: { width?: number; label?: string }) {
  return <BootScreen label={label} />
}
