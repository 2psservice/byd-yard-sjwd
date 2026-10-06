import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World, car, where } from './helpers/world'

const VIN = 'DEP0001'

describe('รถออก (markDeparted) / วางรถ (assign, confirmParked)', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-06T09:00:00Z') }); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetModules() })

  it('markDepartedMany เขียนไม่สำเร็จ → ลองใหม่จนคลาวด์รู้ว่ารถออกแล้ว (เดิมพลาดเงียบ ๆ รถผีกินช่อง)', async () => {
    const w = new World()
    w.seedCloud(car(VIN, 'Q', 37, 1))
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 37, 1) } })
    w.failWrites = true
    A.yard.getState().markDepartedMany([VIN])
    expect(A.yard.getState().units[VIN].status).toBe('DEPARTED') // ในเครื่องว่างช่องทันที
    await w.advance(5_000)
    expect(where(w.cloud.get(VIN)), 'ยังพลาดอยู่').toBe('Q37-1')
    w.failWrites = false
    await w.advance(60_000)
    expect(w.cloud.get(VIN)?.status).toBe('DEPARTED')
    expect(w.cloud.get(VIN)?.block).toBeUndefined()
  })

  it('markDeparted ทิ้งตำแหน่งที่ค้างรอส่งของรถคันนั้น และคิวเขียนซ้ำไม่ใส่ช่องกลับให้', async () => {
    const w = new World()
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 37, 1) }, pendingPlacements: { [VIN]: { vin: VIN, block: 'Q', row: 1, slot: 37 } } })
    A.yard.getState().markDeparted(VIN)
    expect(A.yard.getState().pendingPlacements[VIN]).toBeUndefined()
    await A.yard.getState().flushPendingPlacements()
    expect(w.cloud.get(VIN)?.block, 'ไม่มีช่องกลับไปที่คลาวด์').toBeUndefined()
    // คิวที่เหลือจากรอบก่อน (กรณีมีรายการหลุดมา) ก็ไม่ resurrect รถที่ DEPARTED
    A.yard.setState({ pendingPlacements: { [VIN]: { vin: VIN, block: 'Q', row: 1, slot: 37 } } })
    await A.yard.getState().flushPendingPlacements()
    expect(A.yard.getState().pendingPlacements[VIN]).toBeUndefined()
    expect(w.cloud.get(VIN)?.block).toBeUndefined()
  })

  it('assign: ช่องชนกับรถคันอื่น → คืน false, ไม่เขียน, ไม่เรียก onSettled; ช่องว่าง → true และ onSettled ok', async () => {
    const w = new World()
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: { ...car(VIN, 'Q', 35, 1), status: 'EXPECTED' }, OTHER: car('OTHER', 'Q', 37, 2) } })
    const settled = vi.fn()
    expect(A.yard.getState().assign(VIN, { block: 'Q', slot: 37, row: 2 }, 'driver', 'AUTO', settled)).toBe(false)
    await w.advance(2_000)
    expect(settled).not.toHaveBeenCalled()
    expect(w.cloud.has(VIN)).toBe(false)
    expect(A.yard.getState().assign(VIN, { block: 'Q', slot: 37, row: 3 }, 'driver', 'AUTO', settled)).toBe(true)
    await w.advance(2_000)
    expect(settled).toHaveBeenCalledWith('ok')
    expect(where(w.cloud.get(VIN))).toBe('Q37-3')
  })

  it('assign เขียนไม่สำเร็จ → onSettled queued และเข้าคิวรอลองใหม่ แล้วขึ้นคลาวด์เมื่อเน็ตกลับมา', async () => {
    const w = new World()
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: { ...car(VIN, 'Q', 35, 1), status: 'EXPECTED' } } })
    const settled = vi.fn()
    w.failWrites = true
    A.yard.getState().assign(VIN, { block: 'Q', slot: 37, row: 1 }, 'driver', 'AUTO', settled)
    await w.advance(20_000)
    expect(settled).toHaveBeenCalledWith('queued')
    expect(A.yard.getState().pendingPlacements[VIN]).toBeDefined()
    w.failWrites = false
    await w.advance(60_000)
    expect(where(w.cloud.get(VIN))).toBe('Q37-1')
    expect(A.yard.getState().pendingPlacements[VIN]).toBeUndefined()
  })

  it('assign แล้ว confirmParked ต่อกัน → ลำดับบนคลาวด์ ASSIGNED → PARKED เสมอ แม้คำขอแรกช้ากว่า', async () => {
    const w = new World()
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: { ...car(VIN, 'Q', 35, 1), status: 'EXPECTED' } } })
    const seen: string[] = []
    const orig = w.write.bind(w)
    w.write = async (units) => { seen.push(units.map((u) => u.status).join(',')); return orig(units) }
    w.writeLatencyMs = 1500 // คำขอแรกช้า…
    A.yard.getState().assign(VIN, { block: 'Q', slot: 37, row: 1 }, 'driver', 'AUTO')
    w.writeLatencyMs = 100  // …คำขอที่สองเร็วกว่า: ถ้าวิ่งขนานกัน PARKED จะลงก่อนแล้วถูก ASSIGNED ทับ
    A.yard.getState().confirmParked(VIN)
    expect(A.yard.getState().units[VIN].status, 'ในเครื่องเป็น PARKED ทันที').toBe('PARKED')
    await w.advance(5_000)
    expect(seen).toEqual(['ASSIGNED', 'PARKED'])
    expect(w.cloud.get(VIN)?.status).toBe('PARKED')
  })

  it('realtime-reconnect/dmg: ตำแหน่งที่เพิ่งยิงและกำลังเดินทางขึ้นคลาวด์ ไม่ถูกสำเนาเก่าจากคลาวด์ทับ', async () => {
    const w = new World()
    w.writeLatencyMs = 1500
    w.seedCloud(car(VIN, 'Q', 35, 1))
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 35, 1) } })
    A.yard.getState().updateLocations([{ vin: VIN, block: 'Q', slot: 37, row: 1 }])
    await w.advance(200) // งานเขียนยังอยู่ระหว่างทาง คลาวด์ยังเป็น Q35-1
    w.deliver('Z', 'dmg', { vins: [VIN] }) // เครื่องอื่นแจ้งว่าข้อมูลรถคันนี้เปลี่ยน → A ดึงสำเนาจากคลาวด์
    await w.advance(300)
    expect(where(A.yard.getState().units[VIN]), 'ไม่เด้งกลับ').toBe('Q37-1')
    await w.advance(5_000)
    expect(where(w.cloud.get(VIN))).toBe('Q37-1')
  })
})
