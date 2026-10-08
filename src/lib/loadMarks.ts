/**
 * ตัวจับเวลาแต่ละช่วงตอนโหลดยาร์ด — ไว้ตอบว่า "ป้าย Loading นาน N วินาที หมดไปกับอะไร"
 * (อ่านแถวในเครื่อง · นับแถวในคลาวด์ · ดึงแถวของยาร์ด · ดึงรถ · ซิงก์ · ป้ายหาย)
 *
 * บันทึกเสมอ (ถูกมาก) แต่แสดงผลเฉพาะเมื่อเปิดด้วย `?loadmarks=1` (จำไว้ในเครื่อง, `?loadmarks=0` ปิด):
 * พิมพ์ลง Console และขึ้นข้อความเล็กๆ มุมบนซ้ายของหน้า — มือถือเปิด Console ไม่สะดวก
 * เวลาเป็น ms นับจาก 'site-load-start' ล่าสุด (เริ่มโหลดแถวของยาร์ดที่เลือก)
 */
export interface LoadMark { name: string; ms: number }

const marks: LoadMark[] = []
let t0 = 0

const flagOn = (() => {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('loadmarks') : null
    if (q != null) { if (q === '0' || q === '') localStorage.removeItem('loadmarks'); else localStorage.setItem('loadmarks', q) }
    return localStorage.getItem('loadmarks') === '1'
  } catch { return false }
})()

let box: HTMLElement | null = null
function paint(): void {
  if (!flagOn || typeof document === 'undefined') return
  if (!box) {
    box = document.createElement('pre')
    box.setAttribute('data-testid', 'load-marks')
    box.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;margin:0;padding:3px 5px;font:10px/1.25 monospace;color:#0f0;background:rgba(0,0,0,.72);pointer-events:none;max-width:60vw;white-space:pre-wrap'
    document.body.appendChild(box)
  }
  box.textContent = marks.map((m) => `${String(m.ms).padStart(6)} ${m.name}`).join('\n')
}

export function loadMark(name: string): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (name === 'site-load-start') { t0 = now; marks.length = 0 }
  marks.push({ name, ms: Math.round(now - t0) })
  if (marks.length > 40) marks.shift()
  if (flagOn) { try { console.info(`[load] ${name} +${Math.round(now - t0)}ms`) } catch { /* ไม่มี console */ } paint() }
}

/** สำหรับเทสต์/ดีบัก */
export const getLoadMarks = (): LoadMark[] => marks.slice()
