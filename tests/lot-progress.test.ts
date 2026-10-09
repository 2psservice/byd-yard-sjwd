import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** ล็อตรับรถ (Pre Gate-in) นับความคืบหน้าจากรถจริง — รถที่ล็อตจดไว้ว่า "มาแล้วออกไปแล้ว" (gatedOut) ต้องไม่ถูกนับเป็น "ยังไม่มาถึง" */

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    upsertQueue: async () => {}, saveQueue: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const ops = await import('../src/store/useOps')
  const row = (vin: string, status: string) => ({ vin, site: 'S1', history: [], updatedAt: 1_000, cells: { Vin: vin, 'Car Status': status, 'Location yard': 'NYB2 Phase 2' } })
  const lot = (items: { vin: string; done?: boolean; gatedOut?: boolean }[]) => ({
    id: 'q1', name: '(60 RAI · 06-10 · 2)', createdAt: 1, site: 'S1', type: 'GATEIN' as const,
    items: items.map((i) => ({ addedAt: 2, done: false, ...i })),
  })
  return { useTracking, ops, row, lot }
}

describe('ความคืบหน้าล็อตรับรถ', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-06T08:00:00Z')) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('รถที่ล็อตจดว่า gatedOut (มาแล้วออกไปยาร์ดอื่น แถวสดเป็น Pre Gate-in รอบใหม่ของปลายทาง) นับว่ามาถึงแล้ว ล็อตจบได้', async () => {
    const { useTracking, ops, row, lot } = await setup()
    useTracking.setState({ loaded: true, rows: { A: row('A', 'In Yard'), B: row('B', 'Pre Gate-in') } })
    const q = lot([{ vin: 'A', done: true }, { vin: 'B', done: true, gatedOut: true }])
    expect(ops.queueProgress(q as never)).toMatchObject({ total: 2, done: 2 })
    expect(ops.gateInArrived(q.items[1] as never)).toBe(true)
    expect(ops.isQueueComplete(q as never)).toBe(true)
  })

  it('(ควบคุม) Pre Gate-in ที่ยังไม่ gatedOut ยังนับว่าไม่มาถึง', async () => {
    const { useTracking, ops, row, lot } = await setup()
    useTracking.setState({ loaded: true, rows: { A: row('A', 'In Yard'), B: row('B', 'Pre Gate-in') } })
    const q = lot([{ vin: 'A', done: true }, { vin: 'B', done: true }])
    expect(ops.queueProgress(q as never)).toMatchObject({ total: 2, done: 1 })
    expect(ops.gateInArrived(q.items[1] as never)).toBe(false)
    expect(ops.isQueueComplete(q as never)).toBe(false)
  })

  it('(ควบคุม) รถ In Yard นับว่ามาถึง แม้ธง done/gatedOut ไม่ได้ติ๊ก (อ่านจากสถานะรถจริงเหมือนเดิม)', async () => {
    const { useTracking, ops, row, lot } = await setup()
    useTracking.setState({ loaded: true, rows: { A: row('A', 'In Yard') } })
    const q = lot([{ vin: 'A' }])
    expect(ops.queueProgress(q as never)).toMatchObject({ total: 1, done: 1 })
  })
})
