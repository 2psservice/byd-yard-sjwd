/**
 * คลื่นตอนกดปุ่ม (ripple) — วงกระจายออกจากจุดที่กด แบบ Material / Naive UI
 *
 * ตัวฟังเดียวทั้งแอป (pointerdown ช่วง capture ก่อน React — ปุ่มที่ stopPropagation ก็ยังได้คลื่น)
 * ใช้กับ <button> ทุกปุ่ม · .btn · เมนูซ้าย (.nav-item) · [role=button] · [data-ripple] — ปิดรายปุ่มด้วย data-no-ripple
 * วงคลื่นวาดใน span ที่ซ้อนอยู่ในปุ่มเอง (popup ที่เปิดทับปุ่มก็บังคลื่นตามปกติ) และไม่แตะสไตล์ของปุ่ม
 * ยกเว้นปุ่มที่ position: static ซึ่งต้องตั้ง relative ให้ span อ้างอิง — ปุ่มแบบนั้นที่มีลูกเป็น absolute
 * (อ้างตำแหน่งกับกล่องนอกปุ่ม) จะข้ามไม่ใส่คลื่น ไม่ให้ตำแหน่งของลูกเพี้ยน
 * เครื่องที่ตั้งลดการเคลื่อนไหว ไม่มีคลื่น
 */

const TARGET = 'button, .btn, .nav-item, [role="button"], [data-ripple]'

/** ขนาด/ตำแหน่งของวงคลื่น: ศูนย์กลางที่จุดกด รัศมีถึงมุมที่ไกลที่สุด จึงคลุมทั้งปุ่มพอดี */
export function rippleGeometry(w: number, h: number, x: number, y: number): { size: number; left: number; top: number } {
  const r = Math.ceil(Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y)))
  return { size: r * 2, left: x - r, top: y - r }
}

const reduceMotion = () => {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false } catch { return false }
}

function hostOf(el: HTMLElement): HTMLElement | null {
  const existing = el.querySelector<HTMLElement>(':scope > .ripple-host')
  if (existing) return existing
  if (getComputedStyle(el).position === 'static') {
    for (const d of el.querySelectorAll<HTMLElement>('*')) {
      const p = getComputedStyle(d).position
      if (p === 'absolute' || p === 'fixed') return null
    }
    el.style.position = 'relative'
  }
  const host = document.createElement('span')
  host.className = 'ripple-host'
  host.setAttribute('aria-hidden', 'true')
  // ใส่เป็นลูกตัวแรก: ลูกตัวสุดท้ายเดิมยังเป็นตัวสุดท้าย (คลาส space-x-* ไม่ไปเติมระยะให้มัน ข้อความในปุ่มไม่ขยับ)
  el.insertBefore(host, el.firstChild)
  return host
}

function onDown(e: PointerEvent): void {
  if (e.button !== 0 || reduceMotion()) return
  const el = (e.target as Element | null)?.closest?.(TARGET) as HTMLElement | null
  if (!el || el.closest('[data-no-ripple]')) return
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  const host = hostOf(el)
  if (!host) return
  const { size, left, top } = rippleGeometry(rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top)
  const dot = document.createElement('span')
  dot.className = 'ripple'
  dot.style.width = dot.style.height = `${size}px`
  dot.style.left = `${left}px`
  dot.style.top = `${top}px`
  const done = () => {
    dot.remove()
    if (!host.childElementCount) host.remove()
  }
  dot.addEventListener('animationend', done, { once: true })
  setTimeout(done, 1200) // แท็บที่ถูกซ่อนไม่เล่นแอนิเมชัน — ไม่ให้ span ค้าง
  host.appendChild(dot)
}

let installed = false
export function installRipple(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true })
}
