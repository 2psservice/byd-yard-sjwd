import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * คิวส่งรถ (Grouping to Dealer) ตรารายการว่า "ออกไปแล้ว" ถาวรเมื่อเห็นรอยออกจากลาน — รอยที่เก่ากว่าเวลารถเข้าคิว
 * ไม่ใช่การออกของรันนี้ (21 ต.ค.: เครื่องที่ถือแถวก่อนแก้ย้ายยาร์ดผิด ตราคิว 2 คันว่าออกแล้ว ทั้งที่รถยังจอดอยู่)
 */

const S1 = { id: 'S1', name: 'NYB2 Phase 2', code: 'NYB2', createdAt: 0 }
const S2 = { id: 'S2', name: '3D LCB', code: '3DLCB', createdAt: 0 }
const HOUR = 3_600_000

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    fetchTrackingRows: async () => [], countTrackingRows: async () => 0, upsertQueue: async () => {}, upsertQueues: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [S1, S2], currentSite: 'S1' })
  return { useTracking, ops }
}

/** แถวรถที่ยังจอดอยู่ (In Yard) แต่มีรอย "ออกจาก S1" ที่เวลา `leftAt` */
const rowLeftAt = (vin: string, leftAt: number) => ({
  vin, site: 'S2', updatedAt: leftAt, history: [],
  cells: { Vin: vin, 'Car Status': 'In Yard', 'Location yard': S2.name, 'Grouping  Number': 'G1',
    'Gate Out From Site': 'S1', 'Gate Out From At': String(leftAt) },
})

const itemOf = (ops: any, vin: string) => ops.useOps.getState().queues[0].items.find((i: any) => i.vin === vin)

describe('คิวส่งรถ: รอยออกจากลานที่เก่ากว่าคิวไม่ตรารายการ', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-21T13:08:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('รอยออกเมื่อวาน (ก่อนสร้างคิว) → ไม่ตราว่าออกแล้ว', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { V1: rowLeftAt('V1', created - 17 * HOUR) } } as any)
    ops.useOps.setState({ queues: [{ id: 'Q', name: 'run', createdAt: created, kind: 'sequence', site: 'S1',
      items: [{ vin: 'V1', addedAt: created, done: false, group: 'G1' }] }] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'V1')).toMatchObject({ done: false })
    expect(itemOf(ops, 'V1').gatedOut).toBeFalsy()
  })

  it('(ควบคุม) รอยออกหลังสร้างคิว → ตราว่าออกแล้ว', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { V1: rowLeftAt('V1', created + HOUR) } } as any)
    ops.useOps.setState({ queues: [{ id: 'Q', name: 'run', createdAt: created, kind: 'sequence', site: 'S1',
      items: [{ vin: 'V1', addedAt: created, done: false, group: 'G1' }] }] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'V1')).toMatchObject({ done: true, gatedOut: true })
  })

  it('(ควบคุม) นาฬิกาเครื่องยิงออกช้ากว่าเครื่องสร้างคิวไม่กี่นาที → ยังตราว่าออกแล้ว', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { V1: rowLeftAt('V1', created - 5 * 60_000) } } as any)
    ops.useOps.setState({ queues: [{ id: 'Q', name: 'run', createdAt: created, kind: 'sequence', site: 'S1',
      items: [{ vin: 'V1', addedAt: created, done: false, group: 'G1' }] }] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'V1')).toMatchObject({ done: true, gatedOut: true })
  })

  it('อัปโหลดชีตซ้ำ: เก็บเวลาเข้าคิวเดิม — รถที่ออกระหว่างนั้นยังตราว่าออกแล้ว', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: {} } as any)
    ops.useOps.getState().createSequence('run', 'admin', [{ vin: 'V1', group: 'G1' }, { vin: 'V2', group: 'G1' }])
    expect(itemOf(ops, 'V1').addedAt).toBe(created)
    // V1 ออกจาก S1 ตอน 14:00 แต่เครื่องนี้ยังไม่ได้กระทบยอด แล้วแอดมินอัปโหลดชีตแก้ตอน 16:00
    vi.setSystemTime(created + 3 * HOUR)
    ops.useOps.getState().createSequence('run', 'admin', [{ vin: 'V1', group: 'G1' }, { vin: 'V2', group: 'G1' }, { vin: 'V3', group: 'G1' }])
    expect(itemOf(ops, 'V1').addedAt).toBe(created)
    expect(itemOf(ops, 'V3').addedAt).toBe(created + 3 * HOUR)
    useTracking.setState({ loaded: true, rows: { V1: rowLeftAt('V1', created + HOUR) } } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'V1')).toMatchObject({ done: true, gatedOut: true })
  })
})
