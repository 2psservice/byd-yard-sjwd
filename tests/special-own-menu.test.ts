import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * คิวงานพิเศษ "ตรวจสอบรถคลุมผ้า" (11/11): ขึ้น 4/2626 ทั้งที่หน้างานยังไม่มีใครบันทึก
 * งานพิเศษนับเฉพาะที่บันทึก OK/NG จากเมนูคิวงานพิเศษเท่านั้น — คนขับคืนช่อง / Gate-out ไม่นับ
 */

async function load() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({ ...(await orig<object>()), isConfigured: () => true, upsertOpsQueue: async () => {} }))
  return import('../src/store/useOps')
}
const T = new Date(2026, 10, 11, 10, 0).getTime()
const special = (items: object[]) => ({ id: 'S', name: 'ตรวจสอบรถคลุมผ้า', createdAt: T, type: 'SPECIAL', items }) as any

describe('คิวงานพิเศษนับเฉพาะการบันทึกจากเมนูของตัวเอง', () => {
  afterEach(() => { vi.resetModules() })

  const items = () => [
    { vin: 'REC', addedAt: T, done: false, stage: 'checked', result: 'OK', checkedAt: T + 1, checkedBy: 'สมชาย' }, // บันทึกที่เมนูงานพิเศษ
    { vin: 'DRV', addedAt: T, done: true, doneAt: T + 2, doneBy: 'คนขับ', returnedBy: 'คนขับ', returnedAt: T + 2 }, // คนขับคืนช่อง
    { vin: 'OUT', addedAt: T, done: true, gatedOut: true, doneAt: T + 3 },                                         // Gate-out ไปแล้ว ไม่ได้บันทึก
    { vin: 'NEW', addedAt: T, done: false },                                                                     // ยังไม่มีใครแตะ
  ]

  it('ความคืบหน้า = บันทึกจากเมนูงานพิเศษ · รถที่ออกไปโดยไม่ได้บันทึกไม่นับทั้งเสร็จและคงเหลือ', async () => {
    const ops = await load()
    const q = special(items())
    expect(ops.stationProgress(q)).toMatchObject({ done: 1, total: 3, remaining: 2 })
    expect(ops.queueProgress(q)).toMatchObject({ done: 1, total: 3, remaining: 2 })
    expect(ops.isQueueComplete(q)).toBe(false)
    expect(ops.isStationWorkComplete(q)).toBe(false)
  })

  it('รถที่คนขับคืนช่องแล้วแต่ยังไม่บันทึก ยังอยู่ในรายการและบันทึกได้ที่เมนูงานพิเศษ', async () => {
    const ops = await load()
    const q = special(items())
    expect(q.items.filter((i: any) => ops.itemPendingIn(q, i)).map((i: any) => i.vin)).toEqual(['DRV', 'NEW'])
    expect(ops.activeProcess('DRV', [q], ops.itemPendingIn)?.item.vin).toBe('DRV')
    expect(ops.activeProcess('REC', [q], ops.itemPendingIn)).toBeNull()
  })

  it('ทุกคันบันทึกแล้ว (หรือออกไปแล้ว) = คิวจบ · คิวสถานีอื่นยังนับแบบเดิม', async () => {
    const ops = await load()
    const done = special([items()[0], items()[2], { vin: 'X', addedAt: T, stage: 'checked', result: 'NG', checkedAt: T + 5 }])
    expect(ops.isQueueComplete(done)).toBe(true)
    expect(ops.stationProgress(done)).toMatchObject({ done: 2, total: 2 })
    const pdi = { ...special(items()), type: 'PDI' }
    expect(ops.stationProgress(pdi)).toMatchObject({ done: 3, total: 4 })
  })
})
