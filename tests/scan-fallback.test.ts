import { describe, expect, it } from 'vitest'
import { sampleFrame, nextScanStep, BLANK_RANGE, BAD_STREAK, type ScanFault } from '../src/lib/scanDecoder'

/**
 * 11 พ.ย.: Android ที่อัปเดต Chrome 157 — ภาพกล้องขึ้นจอปกติแต่สแกนไม่ติดเลย ลูปเดิมนับภาพว่าง/ค้าง
 * และ error ของตัวถอดรหัสเป็น "ไม่เจอโค้ด" เงียบ ๆ ตลอดไป ตอนนี้ตรวจภาพทุกรอบแล้วถอยทางเอง
 */
const rgba = (w: number, h: number, px: (i: number) => number) => {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) { const v = px(i); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255 }
  return d
}

describe('sampleFrame — ภาพว่าง / ภาพค้าง', () => {
  it('ภาพดำทั้งภาพ → ช่วงความสว่างต่ำกว่าเกณฑ์', () => {
    expect(sampleFrame(rgba(640, 360, () => 0)).range).toBeLessThan(BLANK_RANGE)
  })
  it('กระจกมืดตอนกลางคืน (ช่วงความสว่างแคบ ~4) → ไม่ใช่ภาพว่าง', () => {
    expect(sampleFrame(rgba(640, 360, (i) => 10 + (i % 5))).range).toBeGreaterThanOrEqual(BLANK_RANGE)
  })
  it('ภาพมีลาย (QR/สติกเกอร์) → ผ่านเกณฑ์', () => {
    expect(sampleFrame(rgba(640, 360, (i) => (i % 7 < 3 ? 20 : 230))).range).toBeGreaterThanOrEqual(BLANK_RANGE)
  })
  it('ภาพเดียวกัน → ลายเซ็นเท่ากัน · ต่างกันจุดเดียวที่ถูกสุ่ม → ลายเซ็นต่าง', () => {
    const a = rgba(64, 64, (i) => i % 251)
    const b = rgba(64, 64, (i) => i % 251)
    expect(sampleFrame(a).sig).toBe(sampleFrame(b).sig)
    b[1] = 7 // จุดแรกที่ถูกสุ่มเสมอ (ช่องเขียวของพิกเซล 0)
    expect(sampleFrame(a).sig).not.toBe(sampleFrame(b).sig)
  })
  it('ภาพว่างเปล่า (0 พิกเซล) ไม่พัง', () => {
    expect(sampleFrame(new Uint8ClampedArray(0))).toEqual({ range: 0, sig: 0 })
  })
})

describe('nextScanStep — ถอยทางเมื่อพังติดกัน', () => {
  const run = (faults: (ScanFault | null)[], can = { path: true, decoder: true }) => {
    let streak: { fault: ScanFault | null; n: number } = { fault: null, n: 0 }
    const actions: string[] = []
    for (const f of faults) { const r = nextScanStep(streak, f, can); streak = r.streak; if (r.action !== 'none') actions.push(r.action) }
    return actions
  }

  it(`ภาพว่าง ${BAD_STREAK} รอบติด → เปลี่ยนทางดึงภาพ`, () => {
    expect(run(Array(BAD_STREAK).fill('blank'))).toEqual(['switch-path'])
  })
  it('ภาพว่างกับภาพค้างนับรวมกัน', () => {
    expect(run(Array.from({ length: BAD_STREAK }, (_, i) => (i % 2 ? 'blank' : 'frozen')))).toEqual(['switch-path'])
  })
  it(`ตัวถอดรหัส error ${BAD_STREAK} รอบติด → เปลี่ยนตัวถอดรหัส`, () => {
    expect(run(Array(BAD_STREAK).fill('error'))).toEqual(['switch-decoder'])
  })
  it('มีภาพดีคั่น (อ่านแล้วไม่เจอโค้ด) → นับใหม่ ไม่ถอยทาง', () => {
    const faults: (ScanFault | null)[] = [...Array(BAD_STREAK - 1).fill('blank'), null, ...Array(BAD_STREAK - 1).fill('blank')]
    expect(run(faults)).toEqual([])
  })
  it('ภาพว่างสลับกับ error → ไม่นับต่อกัน', () => {
    expect(run(Array.from({ length: BAD_STREAK * 2 }, (_, i) => (i % 2 ? 'blank' : 'error')))).toEqual([])
  })
  it('ไม่มีทางดึงภาพเหลือ → exhausted (ไม่สลับตัวถอดรหัสแทน — ไม่ช่วยภาพว่าง)', () => {
    expect(run(Array(BAD_STREAK).fill('blank'), { path: false, decoder: true })).toEqual(['exhausted'])
  })
  it('ตัวถอดรหัสตัวสุดท้ายแล้ว → exhausted', () => {
    expect(run(Array(BAD_STREAK).fill('error'), { path: true, decoder: false })).toEqual(['exhausted'])
  })
})
