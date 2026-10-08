/**
 * อัปเดตเวอร์ชันอัตโนมัติ "ตอนเปิดแอปใหม่ ก่อนผู้ใช้แตะอะไร"
 *
 * ปัญหา: อัปเดตเป็นแบบ "เตือนให้กดเอง" (ตั้งใจ — เคยรีโหลดเองแล้วฟอร์ม PDI/defect ที่กรอกค้างหาย) แต่เครื่องที่ไม่กดแถบ
 * ค้างเวอร์ชันเก่าเป็นวัน ๆ → ซิงก์ล้ม/ตำแหน่งรถถูกล้างด้วยตัวกวางานเก่า/ไม่ได้แพตช์ใหม่
 *
 * ทางสายกลาง: ตอนเปิดแอปใหม่ (หน้าเพิ่งโหลด) ยังไม่มีงานค้างให้หาย → ถ้ามีเวอร์ชันใหม่รออยู่และผู้ใช้ "ยังไม่แตะอะไรเลย"
 * ให้อัปเดตเองได้ทันที; แตะแล้ว/เปิดมานานแล้ว → ใช้แถบให้กดเองเหมือนเดิม
 * กันรีโหลดวน: อัตโนมัติได้ไม่เกินหนึ่งครั้งต่อ AUTO_UPDATE_COOLDOWN_MS
 */
/** ช่วง "เพิ่งเปิดแอป" ที่ยังถือว่าไม่มีงานค้าง */
export const AUTO_UPDATE_WINDOW_MS = 90_000
export const AUTO_UPDATE_COOLDOWN_MS = 10 * 60_000
const KEY = 'sjwd-auto-update-at'

export interface AutoUpdateInput {
  now: number
  /** เวลาที่หน้านี้เริ่มโหลด */
  loadedAt: number
  /** ผู้ใช้แตะ/พิมพ์อะไรบนหน้านี้แล้วหรือยัง */
  interacted: boolean
  /** ครั้งล่าสุดที่อัปเดตอัตโนมัติ (null = ไม่เคย) */
  lastAutoAt: number | null
}

export function shouldAutoUpdate(i: AutoUpdateInput): boolean {
  if (i.interacted) return false
  if (i.now - i.loadedAt > AUTO_UPDATE_WINDOW_MS) return false
  if (i.lastAutoAt != null) {
    const since = i.now - i.lastAutoAt
    if (since < 0 || since < AUTO_UPDATE_COOLDOWN_MS) return false // เวลาเครื่องย้อน = ไม่เสี่ยง
  }
  return true
}

/** เริ่มฟังการแตะ/พิมพ์ — คืนฟังก์ชันถามว่า "มีการแตะแล้วหรือยัง" (ฟังแบบ capture ไม่ขวางเหตุการณ์) */
export function trackInteraction(target: EventTarget = window): () => boolean {
  let touched = false
  const mark = () => { touched = true }
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    target.addEventListener(type, mark, { capture: true, passive: true })
  }
  return () => touched
}

export function readLastAutoUpdate(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

export function markAutoUpdate(at: number): void {
  try { localStorage.setItem(KEY, String(at)) } catch { /* เต็ม/ปิด: ไม่เป็นไร cooldown แค่ไม่ทำงาน */ }
}
