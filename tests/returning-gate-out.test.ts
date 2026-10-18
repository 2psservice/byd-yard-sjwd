import { describe, expect, it } from 'vitest'
import { returningGateOut } from '../src/lib/carStatus'

/** การ์ดรับรถเตือนเมื่อยิง Gate-in รถที่ Gate-out ไปแล้ว (…194405 ออก 14 ต.ค. ถูกยิงเข้าผิดคัน 17 ต.ค.) */
describe('returningGateOut', () => {
  const out = { at: 1791983281678, by: 'นางสาว จตุพร วงศ์คำภู', field: 'Car Status', from: 'In Yard', to: 'Pre Gate-out' }

  it('Pre Gate-out → เวลาจาก Gate Out Time และคนยิงจากประวัติ', () => {
    expect(returningGateOut({ 'Car Status': 'Pre Gate-out', 'Gate Out Time': '1791983281678' }, [out]))
      .toEqual({ at: 1791983281678, by: 'นางสาว จตุพร วงศ์คำภู' })
  })

  it('Gate-out ไม่มี Gate Out Time → ใช้เวลาจากประวัติ', () => {
    const ev = { at: 1792000000000, by: 'admin', field: 'Car Status', from: 'In Yard', to: 'Gate-out' }
    expect(returningGateOut({ 'Car Status': 'Gate-out' }, [out, ev])).toEqual({ at: 1792000000000, by: 'admin' })
  })

  it('ไม่มีประวัติ/เวลา → ยังเตือน (at 0, by ว่าง)', () => {
    expect(returningGateOut({ 'Car Status': 'Gate-out' })).toEqual({ at: 0, by: '' })
  })

  it('Pre Gate-in / In Yard / ไม่มีสถานะ → ไม่เตือน', () => {
    expect(returningGateOut({ 'Car Status': 'Pre Gate-in' }, [out])).toBeNull()
    expect(returningGateOut({ 'Car Status': 'In Yard' }, [out])).toBeNull()
    expect(returningGateOut({}, [out])).toBeNull()
  })
})
