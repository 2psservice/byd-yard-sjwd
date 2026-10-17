import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Unit } from '../src/types'

/**
 * 16 ต.ค. 10:48 NYB2: ยิง Re-location สองคันเข้า F15 ห่างกัน 7 วิ ได้ "คันที่ 4" ทั้งคู่ (รถซ้อนช่อง)
 * คันแรกยังเขียนขึ้นคลาวด์ไม่เสร็จ — คลาวด์ตอบว่าคันแรกยังอยู่ช่องเดิม (F1501) และ laneFromCloud เอาค่าคลาวด์ทับตำแหน่งใหม่ในเครื่อง
 */
const car = (vin: string, row: number, slot = 15, block = 'F'): Unit => ({
  vin, model: 'm', modelName: 'ATTO 1', color: 'White', trailer: 0, damages: [], importedAt: 0,
  status: 'PARKED', block, row, slot, site: 'S1',
})

async function load(cloudLane: Unit[], byVin: Unit[] = []) {
  vi.resetModules()
  vi.doUnmock('../src/lib/db')
  vi.doMock('../src/lib/db', () => ({
    isConfigured: () => true,
    fetchUnitsInLane: async () => cloudLane.map((u) => ({ ...u })),
    fetchUnitsByVins: async (vins: string[]) => byVin.filter((u) => vins.includes(u.vin)).map((u) => ({ ...u })),
  }))
  return import('../src/lib/laneCloud')
}
const depths = (list: Unit[]) => list.filter((u) => u.block === 'F' && u.slot === 15).map((u) => u.row).sort()

describe('laneFromCloud กับตำแหน่งที่เพิ่งยิงแต่ยังเขียนไม่ถึงคลาวด์', () => {
  afterEach(() => { vi.doUnmock('../src/lib/db') })

  it('คันแรกยังเขียนไม่เสร็จ → ใช้ตำแหน่งใหม่ในเครื่อง (F1504) ไม่ใช่ช่องเก่าจากคลาวด์ (F1501) → คันถัดไปไม่ได้คันที่ 4 ซ้ำ', async () => {
    // คลาวด์: A ยังอยู่คันที่ 1 (ยังไม่รู้ว่าย้าย), B C อยู่คันที่ 2 3 · เครื่อง: A ย้ายไปคันที่ 4 แล้ว
    const lane = await load([car('A', 1), car('B', 2), car('C', 3)])
    lane._resetPlacementInFlight()
    lane.markPlacementInFlight(['A'], 1)
    const merged = await lane.laneFromCloud([car('A', 4), car('B', 2), car('C', 3)], 'S1', 'F', 15)
    expect(merged.find((u) => u.vin === 'A')!.row).toBe(4)
    expect(depths(merged)).toEqual([2, 3, 4]) // คันที่ว่างแรก = 1 (ช่องเก่าของ A) ไม่ใช่ 4 ซ้ำ
  })

  it('เขียนเสร็จแล้ว (ล้างเครื่องหมาย) → คลาวด์เป็นฝ่ายชนะตามเดิม', async () => {
    const lane = await load([car('A', 4), car('B', 2)])
    lane._resetPlacementInFlight()
    lane.markPlacementInFlight(['A'], 7)
    lane.clearPlacementInFlight(['A'], 7)
    const merged = await lane.laneFromCloud([car('A', 9), car('B', 2)], 'S1', 'F', 15)
    expect(merged.find((u) => u.vin === 'A')!.row).toBe(4)
  })

  it('คำสั่งเก่าเขียนเสร็จทีหลังคำสั่งใหม่ → ไม่ลบเครื่องหมายของคำสั่งใหม่', async () => {
    const lane = await load([])
    lane._resetPlacementInFlight()
    lane.markPlacementInFlight(['A'], 1)
    lane.markPlacementInFlight(['A'], 2)
    lane.clearPlacementInFlight(['A'], 1)
    expect(lane.isPlacementInFlight('A')).toBe(true)
    lane.clearPlacementInFlight(['A'], 2)
    expect(lane.isPlacementInFlight('A')).toBe(false)
  })

  it('ค้างเกิน 10 นาที (เช่นเขียนล้มแล้วไปรอคิว) → หมดอายุ คลาวด์กลับมาเป็นฝ่ายชนะ', async () => {
    const lane = await load([])
    lane._resetPlacementInFlight()
    lane.markPlacementInFlight(['A'], 1, 1_000_000)
    expect(lane.isPlacementInFlight('A', 1_000_000 + lane.PLACEMENT_IN_FLIGHT_TTL_MS + 1)).toBe(false)
  })

  it('รถที่เครื่องนี้ยังไม่ได้ยิง → คลาวด์ทับสำเนาเก่าในเครื่องเหมือนเดิม (ไม่กระทบพฤติกรรมเดิม)', async () => {
    const lane = await load([car('B', 2)], [car('X', 7, 34, 'N')])
    lane._resetPlacementInFlight()
    // X: เครื่องนี้จำว่าอยู่ F15/1 แต่จริงย้ายไป N34 แล้ว (ghost) — ต้องถูกแก้ตามคลาวด์
    const merged = await lane.laneFromCloud([car('B', 5), car('X', 1)], 'S1', 'F', 15)
    expect(merged.find((u) => u.vin === 'B')!.row).toBe(2)
    expect(merged.find((u) => u.vin === 'X')!.block).toBe('N')
  })
})

describe('updateLocations ใส่และล้างเครื่องหมาย', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('ระหว่างเขียนเป็น in-flight · เขียนเสร็จแล้วไม่ใช่', async () => {
    const { World } = await import('./helpers/world')
    const world = new World()
    world.writeLatencyMs = 5_000
    const d = await world.createDevice('phone')
    const lane = await import('../src/lib/laneCloud')
    d.yard.setState({ currentSite: 'S1', units: { A: car('A', 1) } })
    d.yard.getState().updateLocations([{ vin: 'A', block: 'F', row: 4, slot: 15 }])
    expect(lane.isPlacementInFlight('A')).toBe(true)
    await world.advance(6_000)
    expect(lane.isPlacementInFlight('A')).toBe(false)
    expect(world.cloud.get('A')!.row).toBe(4)
  })
})

describe('laneFromCloudStrict (ยิงตามแถว: อ่านเลนไม่ได้ = ไม่เดา)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.doUnmock('../src/lib/db') })

  async function loadWith(fetchLane: () => Promise<Unit[]>) {
    vi.resetModules()
    vi.doUnmock('../src/lib/db')
    vi.doMock('../src/lib/db', () => ({
      isConfigured: () => true,
      fetchUnitsInLane: fetchLane,
      fetchUnitsByVins: async () => [],
    }))
    return import('../src/lib/laneCloud')
  }

  it('คลาวด์ตอบ → ได้เลนจากคลาวด์ (รวมรถที่เครื่องนี้ไม่มี)', async () => {
    const lane = await loadWith(async () => [car('I1', 1), car('I2', 2)])
    lane._resetPlacementInFlight()
    const got = await lane.laneFromCloudStrict([], 'S1', 'F', 15)
    expect(depths(got)).toEqual([1, 2])
  })

  it('ครั้งแรกหมดเวลา ครั้งที่สองตอบ → ได้เลน (ลองซ้ำหนึ่งครั้ง)', async () => {
    let n = 0
    const lane = await loadWith(() => (++n === 1 ? new Promise<Unit[]>(() => {}) : Promise.resolve([car('I1', 1)])))
    lane._resetPlacementInFlight()
    const p = lane.laneFromCloudStrict([], 'S1', 'F', 15)
    await vi.advanceTimersByTimeAsync(lane.STRICT_LANE_TIMEOUTS_MS[0] + 10)
    expect(depths(await p)).toEqual([1])
    expect(n).toBe(2)
  })

  it('หมดเวลาทั้งสองครั้ง → โยน error ไม่คืนข้อมูลในเครื่อง (laneFromCloud เดิมคืนข้อมูลในเครื่อง)', async () => {
    const lane = await loadWith(() => new Promise<Unit[]>(() => {}))
    lane._resetPlacementInFlight()
    const p = lane.laneFromCloudStrict([car('X', 9)], 'S1', 'F', 15)
    const settled = p.then(() => 'ok', () => 'threw')
    await vi.advanceTimersByTimeAsync(lane.STRICT_LANE_TIMEOUTS_MS.reduce((a, b) => a + b, 0) + 10)
    expect(await settled).toBe('threw')
    // ตัวเดิมยังทำแบบเดิม (ใช้กับ Re-location ทีละคัน/ผัง)
    const loose = lane.laneFromCloud([car('X', 9)], 'S1', 'F', 15)
    await vi.advanceTimersByTimeAsync(3000)
    expect((await loose).map((u) => u.vin)).toEqual(['X'])
  })
})
