import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World, car, where } from './helpers/world'
import { planLaneUpdates } from '../src/lib/laneRebuild'
import type { Unit } from '../src/types'

/**
 * ยิงตามแถวรัว ๆ เข้าเลนที่มีรถอยู่แล้ว (P05 NYB2 17 ต.ค. 11:21–11:22)
 * ยิงคันที่สองก่อนคำขอของคันแรกถึงคลาวด์ → รอบแรกข้ามการเลื่อนคันเดิม ("รอบใหม่เขียนแทน")
 * แต่รอบใหม่ใช้ตำแหน่งที่เครื่องคาดไว้ (ยังไม่ถึงคลาวด์) เป็น compare-and-set → ถูกปฏิเสธ → คันเดิมไม่ขยับ = ช่องซ้อน
 */
const codeOf = (b: string, slot: number, row: number) => `${b}${String(slot).padStart(2, '0')}${String(row).padStart(2, '0')}`
const occupants = (list: Unit[]) => list.filter((u) => u.block === 'P' && u.slot === 5).sort((a, b) => (a.row ?? 0) - (b.row ?? 0))

const dupSlots = (w: World) => {
  const seen = new Map<string, string[]>()
  for (const u of w.cloud.values()) {
    if (!u.block || u.status === 'DEPARTED') continue
    const k = `${u.block}${u.slot}-${u.row}`
    seen.set(k, [...(seen.get(k) ?? []), u.vin])
  }
  return [...seen.entries()].filter(([, v]) => v.length > 1)
}

describe('ยิงตามแถวรัว ๆ เข้าเลนที่มีรถ', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-17T04:21:00Z') }) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('ยิง 3 คันติดกันก่อนคลาวด์ตอบ → คันเดิมเลื่อนลงครบ ไม่มีช่องซ้อน', async () => {
    const w = new World()
    w.writeLatencyMs = 1500 // สัญญาณหน้าลาน: ยิงคันถัดไปก่อนคำขอก่อนหน้าถึง
    const seed = [
      car('I1', 'P', 5, 1), car('I2', 'P', 5, 2), car('I3', 'P', 5, 3),
      car('A', 'P', 16, 2), car('B', 'P', 19, 1), car('C', 'P', 15, 5),
    ]
    for (const u of seed) w.seedCloud(u)
    const D = await w.createDevice('D')
    const lane = await import('../src/lib/laneCloud')
    D.yard.setState({ currentSite: 'S1', units: Object.fromEntries(seed.map((u) => [u.vin, { ...u }])) })

    const ord: string[] = []
    const scan = async (vin: string) => {
      ord.push(vin)
      const local = Object.values(D.yard.getState().units)
      const fromCloud = await lane.laneFromCloud(local, 'S1', 'P', 5)
      const inc = occupants(fromCloud).filter((u) => !ord.includes(u.vin))
      const byVin = new Map(local.map((u) => [u.vin, u]))
      const { updates } = planLaneUpdates({
        seq: [...ord], inc, blockId: 'P', slot: 5,
        unitOf: (v) => byVin.get(v), rowOf: () => undefined, codeOf, locOf: () => '',
      })
      if (updates.length) D.yard.getState().updateLocations(updates)
    }
    await scan('A'); await w.advance(300)
    await scan('B'); await w.advance(300)
    await scan('C')
    await w.advance(20_000)

    expect(['A', 'B', 'C', 'I1', 'I2', 'I3'].map((v) => where(w.cloud.get(v))))
      .toEqual(['P5-1', 'P5-2', 'P5-3', 'P5-4', 'P5-5', 'P5-6'])
    expect(dupSlots(w)).toEqual([])
  })
})
