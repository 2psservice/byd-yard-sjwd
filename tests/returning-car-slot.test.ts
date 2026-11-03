import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World, car } from './helpers/world'
import { gateOutPredatesArrival } from '../src/lib/carStatus'

/**
 * ตัวเก็บกวาด (App.tsx) ปล่อยช่องของรถที่แถวรถในเครื่องอ่านเป็น Gate-out
 * เคสจริง 28 ต.ค. …018828: รถกลับเข้าลาน Gate-in 08:04 ยิง F1001 แล้ว 11:31 เครื่องที่ยังถือแถวรถเก่า (Gate-out รอบก่อน)
 * เขียน "ออกแล้ว" ขึ้นคลาวด์ ทั้งที่ไม่มีใครยิงอะไร → ช่องหาย ยิงตำแหน่งไม่ได้
 */
describe('gateOutPredatesArrival — Gate-out ในแถวรถเกิดก่อนรถ Gate-in รอบนี้', () => {
  const gateIn = new Date(2026, 9, 28, 8, 4).getTime()

  it('Gate-out รอบก่อน (วันที่ล้วนจากไฟล์ YYYY-MM-DD) → เป็นสำเนาเก่า', () => {
    expect(gateOutPredatesArrival({ 'Car Status': 'Gate-out', 'Gate Out time stamp': '2026-05-20' }, gateIn)).toBe(true)
  })
  it('Gate-out รอบก่อน (เวลาที่ประตูยิง) → เป็นสำเนาเก่า', () => {
    expect(gateOutPredatesArrival({ 'Gate Out Time': String(gateIn - 86_400_000) }, gateIn)).toBe(true)
    expect(gateOutPredatesArrival({ 'Gate Out time stamp': '27/10/2026 15:00' }, gateIn)).toBe(true)
  })
  it('Gate-out หลัง Gate-in (ออกจริงรอบนี้) → ไม่ใช่สำเนาเก่า', () => {
    expect(gateOutPredatesArrival({ 'Gate Out Time': String(gateIn + 3_600_000) }, gateIn)).toBe(false)
    expect(gateOutPredatesArrival({ 'Gate Out time stamp': '28/10/2026 17:30' }, gateIn)).toBe(false)
  })
  it('ไม่รู้เวลา Gate-out หรือไม่รู้เวลา Gate-in → ปล่อยตามเดิม', () => {
    expect(gateOutPredatesArrival({ 'Car Status': 'Gate-out' }, gateIn)).toBe(false)
    expect(gateOutPredatesArrival({ 'Gate Out time stamp': '2026-05-20' }, undefined)).toBe(false)
  })
})

/**
 * Gate-in เขียนขึ้นคลาวด์ครั้งเดียวแล้วเงียบ — 29 ต.ค. เช้า (ฐานข้อมูลช้า) 2 คัน Gate-in แล้วไม่มีแถวในผังเลย
 * ต้องลองใหม่เองจนถึงคลาวด์
 */
describe('Gate-in เขียนไม่สำเร็จ → ลองใหม่อัตโนมัติ', () => {
  let world: World
  beforeEach(() => { vi.useFakeTimers(); world = new World() })
  afterEach(() => { vi.useRealTimers() })

  it('ครั้งแรกล้ม → ลองใหม่แล้วถึงคลาวด์ พร้อมเวลา/ผู้ Gate-in', async () => {
    const d = await world.createDevice('gate')
    d.yard.setState({ currentSite: 'S1', currentUser: 'อัญชลี', units: { G1: car('G1', 'B', 1, 1, { status: 'EXPECTED', block: undefined, row: undefined, slot: undefined }) } })
    world.failWrites = true
    d.yard.getState().gateIn('G1')
    await world.advance(3_000)
    expect(world.cloud.get('G1')).toBeUndefined()
    world.failWrites = false
    await world.advance(20_000)
    const c = world.cloud.get('G1')!
    expect(c).toBeTruthy()
    expect(c.status).not.toBe('EXPECTED')
    expect(c.gateInBy).toBe('อัญชลี')
  })

  it('ถูก Gate-in ใหม่ไปแล้ว (เวลา Gate-in เปลี่ยน) → การลองใหม่ของครั้งเก่าหยุด ไม่ทับ', async () => {
    const d = await world.createDevice('gate')
    d.yard.setState({ currentSite: 'S1', currentUser: 'อัญชลี', units: { G2: car('G2', 'B', 1, 1, { status: 'EXPECTED', block: undefined, row: undefined, slot: undefined }) } })
    world.failWrites = true
    d.yard.getState().gateIn('G2')
    await world.advance(3_000)
    // เครื่องนี้รู้ว่ารถถูกรับเข้าใหม่อีกครั้ง (เวลา Gate-in ใหม่) — การลองใหม่รอบเก่าต้องไม่ส่ง
    d.yard.setState((s) => ({ units: { ...s.units, G2: { ...s.units.G2, gateInAt: (s.units.G2.gateInAt ?? 0) + 1 } } }))
    world.failWrites = false
    await world.advance(120_000)
    expect(world.cloud.get('G2')).toBeUndefined()
  })
})
