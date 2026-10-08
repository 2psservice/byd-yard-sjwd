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
/** ทิ้งแอปไว้เบื้องหลังนานเท่านี้ขึ้นไป ถึงถือว่า "กลับมาเริ่มงานใหม่" (สลับ LINE ไปตอบสั้น ๆ อาจมีฟอร์มที่กรอกค้าง ไม่นับ) */
export const AUTO_UPDATE_RESUME_HIDDEN_MS = 4 * 60 * 60_000
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

export interface ResumeInput {
  now: number
  /** ครั้งล่าสุดที่หน้าแอปถูกซ่อน (สลับไปแอปอื่น/ล็อกจอ) — null = ยังไม่เคย */
  hiddenAt: number | null
  /** เวลาที่กลับมาเห็นหน้าแอปอีกครั้ง */
  resumedAt: number
  /** แตะ/พิมพ์อะไรตั้งแต่กลับมาแล้วหรือยัง */
  interactedSinceResume: boolean
  lastAutoAt: number | null
}

/**
 * กลับมาเปิดแอปหลังทิ้งเบื้องหลังนาน (หน้าแอปค้างในหน่วยความจำเป็นวัน ไม่เคย "เปิดใหม่" เลยไม่เข้ากฎตอนเปิดแอป)
 * ทิ้งนานเกิน AUTO_UPDATE_RESUME_HIDDEN_MS + เพิ่งกลับมา + ยังไม่แตะ → อัปเดตเองได้ (ความเสี่ยง: ฟอร์มที่กรอกค้างแล้วทิ้งนานขนาดนั้นจะหาย)
 */
export function shouldAutoUpdateOnResume(i: ResumeInput): boolean {
  if (i.hiddenAt == null) return false
  if (i.resumedAt - i.hiddenAt < AUTO_UPDATE_RESUME_HIDDEN_MS) return false
  if (i.interactedSinceResume) return false
  if (i.now - i.resumedAt > AUTO_UPDATE_WINDOW_MS) return false
  if (i.lastAutoAt != null) {
    const since = i.now - i.lastAutoAt
    if (since < 0 || since < AUTO_UPDATE_COOLDOWN_MS) return false
  }
  return true
}

/** เริ่มฟังการแตะ/พิมพ์ — คืนฟังก์ชันถามว่า "มีการแตะแล้วหรือยัง" (ฟังแบบ capture ไม่ขวางเหตุการณ์) · `.reset()` เริ่มนับใหม่ */
export function trackInteraction(target: EventTarget = window): (() => boolean) & { reset: () => void } {
  let touched = false
  const mark = () => { touched = true }
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    target.addEventListener(type, mark, { capture: true, passive: true })
  }
  return Object.assign(() => touched, { reset: () => { touched = false } })
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
