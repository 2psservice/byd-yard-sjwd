import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Lane load ของคิวส่งรถ: บันทึก Lane load มีผลแค่รันที่เปิดอยู่ และจำว่าใครแก้ เมื่อไหร่ ·
 * อัปโหลดไฟล์เดิมซ้ำ lane ที่ไม่เปลี่ยนยังเก็บชื่อคนแก้ · ใส่รถกลับเข้าคิวที่ Gate-out ใช้ lane ของกลุ่มปัจจุบัน
 */

const S1 = { id: 'S1', name: 'NYB2 Phase 2', code: 'NYB2', createdAt: 0 }
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
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [S1], currentSite: 'S1' })
  return ops
}

const item = (vin: string, group: string, laneLoad: string, extra: object = {}) =>
  ({ vin, addedAt: Date.now() - 5 * HOUR, done: false, group, laneLoad, dest: `Dealer ${group}`, ...extra })
const itemOf = (ops: any, q: string, vin: string) => ops.useOps.getState().queues.find((x: any) => x.id === q).items.find((i: any) => i.vin === vin)

describe('Lane load', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-24T13:32:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('บันทึก Lane load แก้เฉพาะรันที่เปิดอยู่ และจำชื่อคนแก้ + เวลา · รันอื่นที่มีเลขกลุ่มเดียวกันไม่ถูกแตะ', async () => {
    const ops = await setup()
    ops.useOps.setState({ queues: [
      { id: 'TODAY', name: 'run 24/10', createdAt: 1, kind: 'sequence', site: 'S1', items: [item('A', 'G-031', 'O16'), item('B', 'G-031', 'O16'), item('C', 'G-030', 'O15')] },
      { id: 'OTHER', name: 'run 20/10', createdAt: 0, kind: 'sequence', site: 'S1', items: [item('Z', 'G-031', 'O3')] },
    ] } as any)
    const n = ops.useOps.getState().setLaneLoads('TODAY', { 'G-031': 'O7' }, 'สมชาย')
    expect(n).toBe(2)
    expect(itemOf(ops, 'TODAY', 'A')).toMatchObject({ laneLoad: 'O7', laneBy: 'สมชาย', laneAt: Date.now() })
    expect(itemOf(ops, 'TODAY', 'B')).toMatchObject({ laneLoad: 'O7', laneBy: 'สมชาย' })
    expect(itemOf(ops, 'TODAY', 'C')).toMatchObject({ laneLoad: 'O15' })
    expect(itemOf(ops, 'TODAY', 'C').laneBy).toBeUndefined()
    expect(itemOf(ops, 'OTHER', 'Z')).toMatchObject({ laneLoad: 'O3' })
    expect(itemOf(ops, 'OTHER', 'Z').laneBy).toBeUndefined()
    // same value again = nothing changed, the first editor's name stays
    expect(ops.useOps.getState().setLaneLoads('TODAY', { 'G-031': 'O7' }, 'สมหญิง')).toBe(0)
    expect(itemOf(ops, 'TODAY', 'A').laneBy).toBe('สมชาย')
  })

  it('อัปโหลดไฟล์เดิมซ้ำ: lane ที่ยังเหมือนเดิมเก็บชื่อคนแก้ไว้ · lane ที่ไฟล์ใหม่ตั้งต่างไปไม่มีชื่อ', async () => {
    const ops = await setup()
    ops.useOps.setState({ queues: [
      { id: 'Q', name: 'run 24/10', createdAt: 1, kind: 'sequence', site: 'S1', items: [
        item('A', 'G-031', 'O7', { laneBy: 'สมชาย', laneAt: 111 }), item('C', 'G-030', 'O9', { laneBy: 'สมชาย', laneAt: 111 })] },
    ] } as any)
    ops.useOps.getState().createSequence('run 24/10', 'admin', [
      { vin: 'A', laneLoad: 'O7', group: 'G-031' }, { vin: 'C', laneLoad: 'O15', group: 'G-030' }])
    expect(itemOf(ops, 'Q', 'A')).toMatchObject({ laneLoad: 'O7', laneBy: 'สมชาย', laneAt: 111 })
    expect(itemOf(ops, 'Q', 'C')).toMatchObject({ laneLoad: 'O15' })
    expect(itemOf(ops, 'Q', 'C').laneBy).toBeUndefined()
  })

  it('Gate-out ใส่รถกลับเข้าคิว: รถที่ย้ายกลุ่มมาใช้ lane / dealer ของกลุ่มปัจจุบัน ไม่ใช่ของกลุ่มเก่า', async () => {
    const ops = await setup()
    ops.useOps.setState({ queues: [
      { id: 'Q', name: 'run', createdAt: 1, kind: 'sequence', site: 'S1', items: [
        item('X', 'G-020', 'O11', { done: true, gatedOut: true, remark: 'ติดป้าย Fleet' }), item('M', 'G-019', 'O10')] },
    ] } as any)
    ops.useOps.getState().reviveVin('Q', 'X', { group: 'G-019', laneLoad: 'O10', dest: 'Dealer G-019' })
    expect(itemOf(ops, 'Q', 'X')).toMatchObject({ group: 'G-019', laneLoad: 'O10', dest: 'Dealer G-019', done: false, remark: 'ติดป้าย Fleet' })
    expect(itemOf(ops, 'Q', 'X').gatedOut).toBeFalsy()
  })

  it('Gate-out ใส่รถกลับเข้าคิว กลุ่มเดิม: เก็บ lane เดิมพร้อมชื่อคนแก้ · ด่าน Gate-in ที่ไม่ส่งแผนมาก็ใช้ค่าเดิม', async () => {
    const ops = await setup()
    ops.useOps.setState({ queues: [
      { id: 'Q', name: 'run', createdAt: 1, kind: 'sequence', site: 'S1', items: [
        item('X', 'G-020', 'O7', { done: true, gatedOut: true, laneBy: 'สมชาย', laneAt: 222 }), item('Y', 'G-020', 'O7', { done: true })] },
    ] } as any)
    ops.useOps.getState().reviveVin('Q', 'X', { group: 'g-020 ' })
    expect(itemOf(ops, 'Q', 'X')).toMatchObject({ group: 'G-020', laneLoad: 'O7', laneBy: 'สมชาย', laneAt: 222, dest: 'Dealer G-020', done: false })
    ops.useOps.getState().reviveVin('Q', 'Y')
    expect(itemOf(ops, 'Q', 'Y')).toMatchObject({ group: 'G-020', laneLoad: 'O7', dest: 'Dealer G-020', done: false })
  })
})
