import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World, car, where } from './helpers/world'

const VIN = 'LC0C74C45TG023404'

describe('smoke: จำลอง 2 เครื่องได้', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-05T09:00:00Z') }) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('เครื่อง A ย้ายรถ → เขียนขึ้นคลาวด์ และ store ของ A เปลี่ยน', async () => {
    const w = new World()
    w.seedCloud(car(VIN, 'Q', 35, 1))
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 35, 1) } })
    A.yard.getState().updateLocations([{ vin: VIN, block: 'Q', slot: 37, row: 1 }])
    await w.advance(1000)
    expect(where(A.yard.getState().units[VIN])).toBe('Q37-1')
    expect(where(w.cloud.get(VIN))).toBe('Q37-1')
  })
})

/**
 * ตำแหน่งเด้งกลับหลังยิงย้าย (Q3501 → Q3701 แต่กลับเป็นช่องเดิม)
 * ทุกกรณี: ยิงย้ายที่เครื่อง A แล้วดูว่า "ตำแหน่งที่คนยิงเพิ่งยิง" อยู่รอดไหม บนเครื่อง A (คนยิง)
 * และเครื่อง B (คนดู) หลังคลาวด์รับงานและสายเงียบแล้ว
 */
describe('ตำแหน่งเด้งกลับ', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-05T09:00:00Z') }) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('S1 เครื่อง B ที่ถือตำแหน่งเก่า ดึงคลาวด์ก่อนงานของ A ถึง → ต้องไม่ทับตำแหน่งที่ A เพิ่งยิง', async () => {
    const w = new World()
    w.writeLatencyMs = 800 // งานของ A ยังไม่ถึงคลาวด์ตอน B ดึง
    w.seedCloud(car(VIN, 'Q', 35, 1))
    const A = await w.createDevice('A')
    const B = await w.createDevice('B')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 35, 1) } })
    B.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 35, 6) } }) // สำเนาเก่าของ B

    A.yard.getState().updateLocations([{ vin: VIN, block: 'Q', slot: 37, row: 1 }]) // ยิงย้ายไป Q37
    await w.advance(100)
    await B.yard.getState().refreshPlacements() // B ดึงคลาวด์ตอนที่ A ยังเขียนไม่ถึง (คลาวด์ยังเป็น Q35-1)
    await w.advance(3000) // งานของ A ถึงคลาวด์, moves ที่ B ส่งไปถึง A

    expect(where(w.cloud.get(VIN)), 'คลาวด์').toBe('Q37-1')
    expect(where(A.yard.getState().units[VIN]), 'เครื่อง A (คนยิง)').toBe('Q37-1')
  })

  it('S2 broadcast moves ที่เก่ากว่า ต้องไม่ทับตำแหน่งที่เครื่องนี้เพิ่งยิง', async () => {
    const w = new World()
    w.seedCloud(car(VIN, 'Q', 35, 1))
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 35, 1) } })
    A.yard.getState().updateLocations([{ vin: VIN, block: 'Q', slot: 37, row: 1 }])
    await w.advance(1000)
    // เครื่องอื่นประกาศ "ตำแหน่งเก่า" มาด้วยเวลาเก่ากว่าที่ A ยิง
    const t = Date.now()
    w.deliver('Z', 'moves', { siteId: 'S1', moves: [{ vin: VIN, block: 'Q', slot: 35, row: 1, status: 'PARKED', at: t - 60_000 }] })
    await w.advance(1000)
    expect(where(A.yard.getState().units[VIN])).toBe('Q37-1')
  })

  it('S3 refreshPlacements ต้องไม่ตั้งรถที่ยังเขียนไม่ถึงคลาวด์ (คิวค้าง) เป็น DEPARTED', async () => {
    const w = new World()
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 37, 1, { parkedAt: Date.now() }) }, pendingPlacements: { [VIN]: { vin: VIN, block: 'Q', slot: 37, row: 1 } } })
    w.seedCloud(car('OTHER', 'Q', 35, 2)) // คลาวด์ยังไม่รู้จักรถคันนี้ (งานเขียนยังค้าง)
    await A.yard.getState().refreshPlacements()
    expect(where(A.yard.getState().units[VIN])).toBe('Q37-1')
  })

  it('S4 เขียนขึ้นคลาวด์ไม่สำเร็จ → งานต้องค้างคิว แล้วลองใหม่จนสำเร็จ', async () => {
    const w = new World()
    w.seedCloud(car(VIN, 'Q', 35, 1))
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: { [VIN]: car(VIN, 'Q', 35, 1) } })
    w.failWrites = true
    A.yard.getState().updateLocations([{ vin: VIN, block: 'Q', slot: 37, row: 1 }])
    await w.advance(20_000) // flushPendingPlacements รอบแรก (15 วิ) ก็ยังล้ม
    expect(Object.keys(A.yard.getState().pendingPlacements), 'ยังค้างในคิว').toContain(VIN)
    w.failWrites = false
    await w.advance(60_000)
    expect(where(w.cloud.get(VIN)), 'คลาวด์').toBe('Q37-1')
    expect(Object.keys(A.yard.getState().pendingPlacements), 'ล้างคิวเมื่อสำเร็จ').not.toContain(VIN)
  })

  it('S5 ยิงเลนรัว 5 คันบนเน็ตช้า แล้วมีการ refresh กลางทาง → ทุกคันต้องมีตำแหน่ง (Location ใน Unit List ไม่ว่าง)', async () => {
    // Unit List แสดง Location จาก units[vin].block/row/slot ในเครื่องล้วน ๆ (yardLocFull) — คันที่ถูกล้างตำแหน่ง
    // ระหว่างที่งานเขียนยังเดินทางไปคลาวด์จึงขึ้น "—" ทั้งที่เพิ่งยิงสำเร็จ
    const w = new World()
    w.writeLatencyMs = 800
    const A = await w.createDevice('A')
    A.yard.setState({ currentSite: 'S1', units: {} })
    const vins = ['C1', 'C2', 'C3', 'C4', 'C5']
    for (let i = 0; i < vins.length; i++) {
      A.yard.getState().updateLocations([{ vin: vins[i], block: 'Q', slot: 37, row: i + 1 }])
      await w.advance(300)
      if (i === 3) await A.yard.getState().refreshPlacements() // refresh ทำงานตอนที่คลาวด์รับแค่ 1-2 คันแรก
    }
    await w.advance(10_000)
    const got = vins.map((v) => where(A.yard.getState().units[v]))
    expect(got).toEqual(['Q37-1', 'Q37-2', 'Q37-3', 'Q37-4', 'Q37-5'])
    expect(vins.map((v) => where(w.cloud.get(v)))).toEqual(got)
  })
})
