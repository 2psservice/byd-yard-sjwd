/**
 * ตัวอักษรล่องหนที่ติดมากับข้อความที่คัดลอกมาจาก Excel / Windows / LINE
 *
 * 09/11 3D LCB: วาง VIN "LC0CE4CBXT4335837" ในช่องค้นหาหน้า Report 2PS แล้วไม่เจออะไรเลย
 * ทั้งแท็บสถานีและแท็บ Defect · บนจอเห็นเป็นกล่องเล็กซ้อนอยู่หน้าตัว L — มีตัวอักษรล่องหน
 * (เช่น zero-width space / ตัวกำหนดทิศทาง LTR) ติดอยู่ข้างหน้า trim() ไม่ตัดตัวพวกนี้ คำค้นจึง
 * ไม่ตรงกับ VIN คันไหนเลย · ช่องค้นหา/สแกนในแอปมีเป็นสิบที่ ไม่มีที่ไหนตัดตัวนี้
 *
 * จึงตัดทิ้งตั้งแต่ตอนพิมพ์/วางลงช่องข้อความทุกช่องของแอป (installInvisibleCharGuard)
 * ไม่ต้องไปแก้ทีละหน้า · ZWJ (U+200D) ไม่ตัด เพราะอีโมจิในหมายเหตุใช้มันต่อรูป
 */
const INVISIBLE = '­​‌‎‏‪-‮⁠-⁤⁦-⁩﻿'
const HAS_INVISIBLE = new RegExp(`[${INVISIBLE}]`)
const ALL_INVISIBLE = new RegExp(`[${INVISIBLE}]`, 'g')

export const hasInvisible = (s: string) => HAS_INVISIBLE.test(s)
export const stripInvisible = (s: string) => s.replace(ALL_INVISIBLE, '')

const TEXT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email'])

/**
 * ทุกช่อง <input> ข้อความ: ถ้าค่าที่เพิ่งพิมพ์/วางมีตัวล่องหน ตัดออกก่อน React อ่านค่า
 *
 * ฟังเหตุการณ์ input ในเฟส capture ที่ document ซึ่งมาก่อนตัวฟังของ React ที่ root
 * แล้วเขียนค่าใหม่ผ่าน setter ของ prototype (ข้ามตัวติดตามค่าของ React) — React จึงเห็นว่า
 * ค่าเปลี่ยนและส่ง onChange ด้วยค่าที่สะอาดแล้ว · ตำแหน่งเคอร์เซอร์คงไว้ที่เดิม
 */
export function installInvisibleCharGuard(doc: Document = document): () => void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) return () => {}
  const onInput = (e: Event) => {
    const el = e.target
    if (!(el instanceof HTMLInputElement) || !TEXT_TYPES.has(el.type)) return
    const v = el.value
    if (!hasInvisible(v)) return
    let caret: number | null = null
    try { caret = el.selectionStart } catch { /* type without a caret */ }
    setter.call(el, stripInvisible(v))
    if (caret != null) {
      const at = stripInvisible(v.slice(0, caret)).length
      try { el.setSelectionRange(at, at) } catch { /* not focusable */ }
    }
  }
  doc.addEventListener('input', onInput, true)
  return () => doc.removeEventListener('input', onInput, true)
}
