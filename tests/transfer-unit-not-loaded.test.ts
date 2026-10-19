import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World, car } from './helpers/world'

/**
 * Gate-out ข้ามยาร์ดจากเครื่องที่ยังไม่มีรถคันนั้นในเครื่อง (เพิ่งเปิดแอป ข้อมูลรถยังโหลดไม่ครบ)
 * เดิม markDeparted / moveUnitsToSite ข้ามไปเงียบ ๆ → ตำแหน่งยาร์ดต้นทางค้าง = รถผีบนผัง (NYB2 9 คัน 19 ต.ค.)
 */
describe('รถที่ยังไม่อยู่ในเครื่อง', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-19T06:30:00Z') }) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('markDeparted: ดึงจากคลาวด์แล้วปล่อยช่อง', async () => {
    const w = new World()
    w.seedCloud(car('X', 'G', 23, 3))
    const D = await w.createDevice('D')
    D.yard.setState({ currentSite: 'S1', units: {} }) // เครื่องยังไม่มีรถคันนี้
    D.yard.getState().markDeparted('X')
    await w.advance(2000)
    const c = w.cloud.get('X')!
    expect(c.status).toBe('DEPARTED')
    expect(c.block).toBeUndefined()
  })

  it('moveUnitsToSite: ดึงจากคลาวด์แล้วย้ายไปยาร์ดปลายทาง (ไม่ค้างช่องเดิม)', async () => {
    const w = new World()
    w.seedCloud(car('X', 'G', 23, 3))
    const D = await w.createDevice('D')
    D.yard.setState({ currentSite: 'S1', units: {} })
    D.yard.getState().moveUnitsToSite(['X'], 'S2')
    await w.advance(2000)
    const c = w.cloud.get('X')!
    expect(c.site).toBe('S2')
    expect(c.status).toBe('EXPECTED')
    expect(c.block).toBeUndefined()
  })

  it('รถที่ไม่มีในคลาวด์เลย (มีแค่แถวติดตาม) → ไม่เขียนอะไร ไม่วนซ้ำ', async () => {
    const w = new World()
    const D = await w.createDevice('D')
    D.yard.setState({ currentSite: 'S1', units: {} })
    D.yard.getState().markDeparted('NOPE')
    D.yard.getState().moveUnitsToSite(['NOPE'], 'S2')
    await w.advance(2000)
    expect(w.cloud.has('NOPE')).toBe(false)
  })
})
