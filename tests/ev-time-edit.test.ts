import { describe, expect, it } from 'vitest'
import { chargeMs, editChargeTimes, evChargeId, fromLocalInput, toLocalInput, type EvCharge } from '../src/lib/evCharging'

/** แอดมินแก้วันที่ / เวลาเริ่มและเสร็จของรอบชาร์จ (หน้า EV Charging) */

const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s).getTime()
const NOW = at(30, 15)

function ev(before: number, after = 0, pauses?: EvCharge['pauses']): EvCharge {
  return {
    id: evChargeId('LC0CE4CB0T0255065', before), vin: 'LC0CE4CB0T0255065', model: 'M6 (7-SEATS)', color: 'BLACK', from: '', remark: '',
    vinPhoto: 'v', beforePhoto: 'b', beforePct: 10, beforeAt: before, beforeBy: 'A',
    afterPhoto: after ? 'a' : '', afterPct: after ? 43 : null, afterAt: after, afterBy: after ? 'B' : '', pauses, updatedAt: after || before,
  }
}

describe('แก้เวลารอบชาร์จ', () => {
  it('ช่อง datetime-local ไปกลับได้ (เวลาเครื่อง)', () => {
    expect(toLocalInput(at(30, 9, 2))).toBe('2026-10-30T09:02')
    expect(fromLocalInput('2026-10-30T09:02')).toBe(at(30, 9, 2))
    expect(fromLocalInput('')).toBeNaN()
  })

  it('แก้เวลาเริ่มและเวลาเสร็จ → เวลาชาร์จคิดใหม่ · id รอบเดิม · updatedAt ใหม่', () => {
    const c = ev(at(30, 9, 2, 41), at(30, 13, 14, 5))
    const r = editChargeTimes(c, at(30, 8, 30), at(30, 13, 45), NOW)
    if (!('ok' in r)) throw new Error(r.error)
    expect(r.changed).toBe(true)
    expect(r.ok).toMatchObject({ id: c.id, beforeAt: at(30, 8, 30), afterAt: at(30, 13, 45), updatedAt: NOW })
    expect(chargeMs(r.ok)).toBe(5.25 * 3_600_000)
  })

  it('นาทีที่ไม่ได้แก้คงค่าเดิมทั้งวินาที · ไม่แก้อะไร = ไม่เปลี่ยน', () => {
    const c = ev(at(30, 9, 2, 41), at(30, 13, 14, 5))
    const same = editChargeTimes(c, at(30, 9, 2), at(30, 13, 14), NOW)
    expect(same).toMatchObject({ changed: false, ok: c })
    const endOnly = editChargeTimes(c, at(30, 9, 2), at(30, 14, 0), NOW)
    if (!('ok' in endOnly)) throw new Error(endOnly.error)
    expect(endOnly.ok.beforeAt).toBe(at(30, 9, 2, 41))
    expect(endOnly.ok.afterAt).toBe(at(30, 14, 0))
  })

  it('เปลี่ยนวันที่ได้ (ข้ามวัน)', () => {
    const c = ev(at(30, 9, 2), at(30, 13, 14))
    const r = editChargeTimes(c, at(29, 22, 0), at(30, 13, 14), NOW)
    expect('ok' in r && r.ok.beforeAt).toBe(at(29, 22, 0))
  })

  it('ห้าม: เสร็จก่อนเริ่ม · เวลาในอนาคต · ช่องว่าง', () => {
    const c = ev(at(30, 9, 2), at(30, 13, 14))
    expect(editChargeTimes(c, at(30, 14, 0), at(30, 13, 14), NOW)).toEqual({ error: 'เวลาชาร์จเสร็จต้องหลังเวลาเริ่มชาร์จ' })
    expect(editChargeTimes(c, at(30, 9, 2), at(30, 16, 0), NOW)).toEqual({ error: 'เวลาชาร์จเสร็จอยู่ในอนาคต' })
    expect(editChargeTimes(c, at(31, 9, 0), at(30, 13, 14), NOW)).toEqual({ error: 'เวลาเริ่มชาร์จอยู่ในอนาคต' })
    expect(editChargeTimes(c, NaN, at(30, 13, 14), NOW)).toEqual({ error: 'ใส่วันที่และเวลาเริ่มชาร์จ' })
    expect(editChargeTimes(c, at(30, 9, 2), NaN, NOW)).toEqual({ error: 'ใส่วันที่และเวลาชาร์จเสร็จ' })
  })

  it('ช่วงหยุดพักต้องอยู่ระหว่างเริ่มกับเสร็จ', () => {
    const c = ev(at(30, 9, 0), at(30, 14, 0), [{ at: at(30, 10, 0), by: 'A', until: at(30, 11, 0), untilBy: 'A' }])
    expect(editChargeTimes(c, at(30, 10, 30), at(30, 14, 0), NOW)).toMatchObject({ error: expect.stringContaining('หยุดพักครั้งแรก') })
    expect(editChargeTimes(c, at(30, 9, 0), at(30, 10, 30), NOW)).toMatchObject({ error: expect.stringContaining('ชาร์จต่อครั้งล่าสุด') })
    const ok = editChargeTimes(c, at(30, 9, 30), at(30, 13, 0), NOW)
    expect('ok' in ok && chargeMs(ok.ok)).toBe(2.5 * 3_600_000)
  })

  it('รอบที่ยังชาร์จอยู่: แก้ได้แค่เวลาเริ่ม เวลาเสร็จยังว่าง', () => {
    const c = ev(at(30, 9, 48))
    const r = editChargeTimes(c, at(30, 9, 30), at(30, 12, 0), NOW)
    if (!('ok' in r)) throw new Error(r.error)
    expect(r.ok.beforeAt).toBe(at(30, 9, 30))
    expect(r.ok.afterAt).toBe(0)
  })
})
