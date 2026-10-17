import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World, car, where } from './helpers/world'
import { planLaneUpdates } from '../src/lib/laneRebuild'
import type { Unit } from '../src/types'

/**
 * ยิงตามแถว: ชุดผสม (คันที่ยิง + คันเดิมที่ถูกเลื่อน) ต้องเขียนคันที่ถูกเลื่อนก่อน
 * ถ้าคำขอหลังไม่ถึงคลาวด์ (สัญญาณหลุด/ปิดแอป) ต้องไม่เหลือ 2 คันในช่องเดียว (D2202 16 ต.ค.)
 */
const codeOf = (b: string, slot: number, row: number) => `${b}${String(slot).padStart(2, '0')}${String(row).padStart(2, '0')}`

function laneBatch(units: Unit[]) {
  const by = new Map(units.map((u) => [u.vin, u]))
  return planLaneUpdates({
    seq: ['A'], inc: [by.get('I1')!, by.get('I2')!], blockId: 'Q', slot: 37,
    unitOf: (v) => by.get(v), rowOf: () => undefined, codeOf, locOf: () => '',
  }).updates
}

const dupSlots = (w: World) => {
  const seen = new Map<string, string[]>()
  for (const u of w.cloud.values()) {
    if (!u.block || u.status === 'DEPARTED') continue
    const k = `${u.block}-${u.slot}-${u.row}`
    seen.set(k, [...(seen.get(k) ?? []), u.vin])
  }
  return [...seen.entries()].filter(([, v]) => v.length > 1)
}

describe('ลำดับเขียนของยิงตามแถว', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-17T09:00:00Z') }) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  const seed = () => [car('A', 'Q', 35, 1), car('I1', 'Q', 37, 1), car('I2', 'Q', 37, 2)]

  it('คันที่ถูกเลื่อนถึงคลาวด์ก่อนคันที่ยิง (ท้ายสุดก่อน)', async () => {
    const w = new World()
    for (const u of seed()) w.seedCloud(u)
    const order: string[] = []
    const write = w.write.bind(w)
    w.write = async (units: Unit[]) => { order.push(...units.map((u) => u.vin)); return write(units) }
    const D = await w.createDevice('D')
    D.yard.setState({ currentSite: 'S1', units: Object.fromEntries(seed().map((u) => [u.vin, u])) })
    D.yard.getState().updateLocations(laneBatch(seed()))
    await w.advance(1000)
    expect(order).toEqual(['I2', 'I1', 'A'])
    expect(['A', 'I1', 'I2'].map((v) => where(w.cloud.get(v)))).toEqual(['Q37-1', 'Q37-2', 'Q37-3'])
    expect(dupSlots(w)).toEqual([])
  })

  it('ขาดตอนหลังคำขอแรก → ไม่มีช่องซ้อนในคลาวด์ (คันที่ยิงยังไม่ลง ยิงใหม่ได้)', async () => {
    const w = new World()
    for (const u of seed()) w.seedCloud(u)
    let n = 0
    const write = w.write.bind(w)
    w.write = async (units: Unit[]) => { if (++n >= 2) throw new Error('network down'); return write(units) }
    const D = await w.createDevice('D')
    D.yard.setState({ currentSite: 'S1', units: Object.fromEntries(seed().map((u) => [u.vin, u])) })
    D.yard.getState().updateLocations(laneBatch(seed()))
    await w.advance(1000)
    expect(where(w.cloud.get('I2'))).toBe('Q37-3') // คำขอแรกถึง
    expect(where(w.cloud.get('A'))).toBe('Q35-1') // คันที่ยิงยังไม่ถึง (รอส่งในเครื่อง)
    expect(dupSlots(w)).toEqual([])
  })
})
