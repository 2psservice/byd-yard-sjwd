import { describe, expect, it } from 'vitest'
import { firstPdiDate, lastPmDate, pmCountFrom } from '../src/lib/trackingColumns'
import { pmDueDay } from '../src/lib/pmPlan'

/** ตารางแผน PM: รถไม่เคยทำ PM นับจากวัน PDI ไปอีกหนึ่งรอบ · รถเคยทำ PM แล้วนับจาก PM ล่าสุด (= Aging PM) */

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day).getTime()
const OCT = [2026, 10] as const

describe('pmCountFrom — วันตั้งต้นนับรอบ PM', () => {
  it('ไม่เคยทำ PM: นับจากวัน PDI (ไม่ใช่วัน Gate In)', () => {
    const c = { PDI: '10/09/2026', 'Gate In (Rayong yard)': '01/08/2026' }
    expect(pmCountFrom(c)).toBe(d(2026, 9, 10))
  })
  it('เคยทำ PM แล้ว: นับจาก PM ล่าสุด แม้มีวัน PDI และ Gate In เก่ากว่า', () => {
    const c = { PDI: '10/08/2026', PM1: '05/09/2026', PM2: '07/10/2026', 'Gate In (Rayong yard)': '01/08/2026' }
    expect(lastPmDate(c)).toBe(d(2026, 10, 7))
    expect(pmCountFrom(c)).toBe(d(2026, 10, 7))
  })
  it('ไม่เคยทำ PM และช่อง PDI ว่าง: ใช้วัน RE PDI ที่เก่าที่สุด', () => {
    const c = { 'RE PDI  Date #2': '25/09/2026', 'RE PDI  Date #1': '20/09/2026', 'Gate In Date': '01/08/2026' }
    expect(firstPdiDate(c)).toBe(d(2026, 9, 20))
    expect(pmCountFrom(c)).toBe(d(2026, 9, 20))
  })
  it('ไม่มีวัน PDI เลย: ถอยไปวัน Gate In เหมือนเดิม (รถยังขึ้นแผน)', () => {
    expect(pmCountFrom({ 'Gate In (Rayong yard)': '15/09/2026' })).toBe(d(2026, 9, 15))
    expect(pmCountFrom({ 'Gate In Date': '16/09/2026' })).toBe(d(2026, 9, 16))
  })
  it('ช่อง PDI ที่ไม่ใช่วันที่ (เช่น ข้อความ) ไม่ถูกนับเป็นวัน PDI', () => {
    expect(pmCountFrom({ PDI: 'NG', 'Gate In Date': '16/09/2026' })).toBe(d(2026, 9, 16))
  })
  it('ไม่มีวันที่อะไรเลย: null', () => {
    expect(pmCountFrom({})).toBeNull()
  })
})

describe('pmDueDay — วันที่ครบกำหนดในเดือน (คันละครั้งต่อเดือน)', () => {
  it('PDI 10 ก.ย. + 30 วัน = 10 ต.ค.', () => {
    expect(pmDueDay(d(2026, 9, 10), 30, ...OCT)).toBe(10)
  })
  it('PM ล่าสุด 5 ก.ย. + 30 วัน = 5 ต.ค. (รอบถัดไป 4 พ.ย. ไม่อยู่ในเดือนนี้)', () => {
    expect(pmDueDay(d(2026, 9, 5), 30, ...OCT)).toBe(5)
  })
  it('ครบกำหนดวันที่ 1 ต.ค.: ขึ้นแผนวันที่ 1 วันเดียว รอบที่สองวันที่ 31 ต.ค. ไม่ขึ้นแผน (นับคันละครั้งต่อเดือน)', () => {
    expect(pmDueDay(d(2026, 9, 1), 30, ...OCT)).toBe(1)
  })
  it('ยาร์ด 38 ไร่ รอบ 90 วัน: PDI 12 ก.ค. + 90 วัน = 10 ต.ค.', () => {
    expect(pmDueDay(d(2026, 7, 12), 90, ...OCT)).toBe(10)
  })
  it('วันครบกำหนดอยู่เดือนหน้า: ไม่ขึ้นแผนเดือนนี้', () => {
    expect(pmDueDay(d(2026, 10, 10), 30, ...OCT)).toBeNull()
  })
  it('ครบกำหนดไปก่อนเดือนนี้แล้ว: ขึ้นตามรอบ 30 วันถัดไปที่ตกในเดือนนี้ วันเดียว', () => {
    // 20 ส.ค. + 60 วัน = 19 ต.ค.
    expect(pmDueDay(d(2026, 8, 20), 30, ...OCT)).toBe(19)
  })
  it('ทุกวันที่เป็นวันตั้งต้น: แต่ละคันได้ไม่เกินหนึ่งวันต่อเดือน', () => {
    for (let k = 0; k < 120; k++) {
      const day = pmDueDay(d(2026, 7, 1) + k * 86_400_000, 30, ...OCT)
      expect(day === null || (day >= 1 && day <= 31)).toBe(true)
    }
  })
})
