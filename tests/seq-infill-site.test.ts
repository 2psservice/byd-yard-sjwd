import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * คิวส่งรถดึงรถที่ถือเลข Grouping เดียวกันเข้ารันเอง — ต้องเป็นรถที่อยู่ในยาร์ดของรันนั้นจริง
 * (60 Rai 09/10 ATL261009-037 ได้ LC0CE4CC4TG027909 เพิ่มเข้ามา ทั้งที่รถคันนี้ไม่เคยเข้า 60 Rai)
 */

const S60 = { id: 'S60', name: '60 RAI', createdAt: 0 }
const S38 = { id: 'S38', name: 'Auto Tran 38Rai', createdAt: 0 }
const G = 'ATL261009-037'
const HOUR = 3_600_000

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    fetchTrackingRows: async () => [], countTrackingRows: async () => 0, upsertQueue: async () => {}, upsertQueues: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [S60, S38], currentSite: 'S60' } as any)
  return { useTracking, ops }
}

const row = (vin: string, site: string | undefined, status: string, yard: string) => ({
  vin, ...(site ? { site } : {}), updatedAt: 0, history: [],
  cells: { Vin: vin, 'Car Status': status, 'Location yard': yard, 'Grouping  Number': G },
})

describe('คิวส่งรถ: รถถือเลขกลุ่มเดียวกันเข้ารันได้เฉพาะคันที่อยู่ในยาร์ดของรัน', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-27T13:00:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('ไม่ดึง: รถยาร์ดอื่น · แถวไม่ติดยาร์ดที่บอกว่าอยู่ยาร์ดอื่น / ไม่บอกยาร์ด · รถ Pre Gate-in ที่ยังไม่มาถึง — ดึง: รถในยาร์ดนี้', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now() - 5 * HOUR
    useTracking.setState({ loaded: true, rows: {
      PLAN: row('PLAN', 'S60', 'In Yard', S60.name),
      OTHER: row('OTHER', 'S38', 'In Yard', S38.name),           // tagged to the other Auto Tran yard
      UNTAGGED_OTHER: row('UNTAGGED_OTHER', undefined, 'In Yard', S38.name),
      UNTAGGED_BLANK: row('UNTAGGED_BLANK', undefined, 'In Yard', ''), // no yard at all
      NOT_ARRIVED: row('NOT_ARRIVED', 'S60', 'Pre Gate-in', S60.name),  // announced here, never came
      HERE: row('HERE', 'S60', 'In Yard', S60.name),
      HERE_UNTAGGED: row('HERE_UNTAGGED', undefined, 'In Yard', S60.name),
    } } as any)
    ops.useOps.setState({ queues: [{ id: 'Q', name: '60 Rai - Grouping to Dealer 09/10', createdAt: created, kind: 'sequence', site: 'S60', items: [
      { vin: 'PLAN', addedAt: created, done: false, group: G, laneLoad: 'O1', dest: 'Dealer' },
    ] }] } as any)
    ops.reconcileGateOuts()
    const vins = ops.useOps.getState().queues[0].items.map((i: any) => i.vin).sort()
    expect(vins).toEqual(['HERE', 'HERE_UNTAGGED', 'PLAN'])
    expect(ops.useOps.getState().queues[0].items.find((i: any) => i.vin === 'HERE')).toMatchObject({ group: G, laneLoad: 'O1', dest: 'Dealer' })
  })

  it('รถ Pre Gate-in เข้ารันเองเมื่อยิงเข้าลานแล้ว', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now() - 5 * HOUR
    useTracking.setState({ loaded: true, rows: { PLAN: row('PLAN', 'S60', 'In Yard', S60.name), LATE: row('LATE', 'S60', 'Pre Gate-in', S60.name) } } as any)
    ops.useOps.setState({ queues: [{ id: 'Q', name: 'run', createdAt: created, kind: 'sequence', site: 'S60', items: [
      { vin: 'PLAN', addedAt: created, done: false, group: G, laneLoad: 'O1', dest: 'Dealer' },
    ] }] } as any)
    ops.reconcileGateOuts()
    expect(ops.useOps.getState().queues[0].items).toHaveLength(1)
    useTracking.setState({ rows: { ...useTracking.getState().rows, LATE: row('LATE', 'S60', 'In Yard', S60.name) } } as any)
    ops.reconcileGateOuts()
    expect(ops.useOps.getState().queues[0].items.map((i: any) => i.vin)).toEqual(['PLAN', 'LATE'])
  })
})
