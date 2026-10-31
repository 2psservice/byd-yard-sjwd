/**
 * แถบโหลดเส้นบางบนสุดของจอ ตอนเปลี่ยนหน้าแอดมิน (ดู lib/pageSwitch)
 * กดเมนู: แถบวิ่งออกไปเกือบเต็ม · หน้าใหม่ขึ้นจริง: วิ่งจนเต็มแล้วจางหาย · หน้ายังโหลดไม่เสร็จ: แถบค้างรอ
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

type Phase = 'idle' | 'run' | 'done'

export function NavProgress({ busy }: { busy: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const raf = useRef(0)

  useLayoutEffect(() => {
    cancelAnimationFrame(raf.current)
    if (busy) {
      // เริ่มจากศูนย์ทุกครั้ง (กดซ้ำตอนแถบกำลังจางอยู่ แถบต้องไม่วิ่งถอยหลัง) — รอให้ความกว้าง 0 ขึ้นจอก่อนแล้วค่อยวิ่ง
      setPhase('idle')
      raf.current = requestAnimationFrame(() => { raf.current = requestAnimationFrame(() => setPhase('run')) })
    } else {
      setPhase((p) => (p === 'idle' ? 'idle' : 'done'))
    }
    return () => cancelAnimationFrame(raf.current)
  }, [busy])

  useEffect(() => {
    if (phase !== 'done') return
    const t = setTimeout(() => setPhase('idle'), 700)
    return () => clearTimeout(t)
  }, [phase])

  return <div className={`nav-progress nav-progress-${phase}`} aria-hidden="true" data-nav-progress={phase} />
}
