import { beforeEach, describe, expect, it } from 'vitest'
import { AUTO_UPDATE_COOLDOWN_MS, AUTO_UPDATE_WINDOW_MS, markAutoUpdate, readLastAutoUpdate, shouldAutoUpdate, trackInteraction } from '../src/lib/autoUpdate'

/**
 * อัปเดตเวอร์ชันอัตโนมัติ "ตอนเปิดแอปใหม่ ก่อนผู้ใช้แตะอะไร" — เครื่องที่ไม่กดแถบ "มีเวอร์ชันใหม่" ค้างเวอร์ชันเก่าเป็นวัน
 * (ซิงก์ล้ม/ตำแหน่งถูกล้าง) แต่ห้ามรีโหลดกลางงาน (เคยทำให้ฟอร์ม PDI/defect ที่กรอกค้างหาย)
 */
const base = { now: 1_000_000, loadedAt: 1_000_000 - 3_000, interacted: false, lastAutoAt: null as number | null }

describe('shouldAutoUpdate', () => {
  it('เพิ่งเปิดแอป ยังไม่แตะอะไร → อัปเดตเองได้', () => {
    expect(shouldAutoUpdate(base)).toBe(true)
  })
  it('ผู้ใช้แตะ/พิมพ์แล้ว → ห้าม (อาจมีงานค้าง) ใช้แถบให้กดเอง', () => {
    expect(shouldAutoUpdate({ ...base, interacted: true })).toBe(false)
  })
  it('เปิดมานานเกินช่วงเปิดแอป → ห้าม', () => {
    expect(shouldAutoUpdate({ ...base, loadedAt: base.now - AUTO_UPDATE_WINDOW_MS - 1 })).toBe(false)
    expect(shouldAutoUpdate({ ...base, loadedAt: base.now - AUTO_UPDATE_WINDOW_MS })).toBe(true)
  })
  it('เพิ่งอัปเดตอัตโนมัติไปไม่ถึง cooldown → ห้าม (กันรีโหลดวน)', () => {
    expect(shouldAutoUpdate({ ...base, lastAutoAt: base.now - 60_000 })).toBe(false)
    expect(shouldAutoUpdate({ ...base, lastAutoAt: base.now - AUTO_UPDATE_COOLDOWN_MS })).toBe(true)
  })
  it('เวลาเครื่องย้อนหลัง (lastAutoAt อยู่อนาคต) → ห้าม ไม่เสี่ยงวน', () => {
    expect(shouldAutoUpdate({ ...base, lastAutoAt: base.now + 5_000 })).toBe(false)
  })
})

describe('trackInteraction', () => {
  it('ยังไม่มีการแตะ → false; pointerdown / keydown / touchstart ทำให้เป็น true', () => {
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      const t = new EventTarget()
      const got = trackInteraction(t)
      expect(got()).toBe(false)
      t.dispatchEvent(new Event(type))
      expect(got(), type).toBe(true)
    }
  })
  it('เหตุการณ์ที่ไม่ใช่การแตะ (เช่น scroll/visibilitychange) ไม่นับ', () => {
    const t = new EventTarget(); const got = trackInteraction(t)
    t.dispatchEvent(new Event('scroll')); t.dispatchEvent(new Event('visibilitychange'))
    expect(got()).toBe(false)
  })
})

describe('markAutoUpdate / readLastAutoUpdate', () => {
  beforeEach(() => localStorage.clear())
  it('จดเวลาและอ่านกลับได้; ค่าเสียถือว่าไม่เคยทำ', () => {
    expect(readLastAutoUpdate()).toBeNull()
    markAutoUpdate(123_456)
    expect(readLastAutoUpdate()).toBe(123_456)
    localStorage.setItem('sjwd-auto-update-at', 'not-a-number')
    expect(readLastAutoUpdate()).toBeNull()
  })
})
