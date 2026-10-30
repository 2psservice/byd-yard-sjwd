import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Gate-out "ไม่มีคิวงาน" ทั้งที่ชีตบอกว่ารถอยู่ใน DN: รายการของรถในคิวส่งรถถูกตรา "ออกไปแล้ว" ถาวร
 * (ยิงออกแล้วยกเลิก / เคยออกจากลานนี้แล้วกลับมา) ตัวปรับคิวจึงไม่เติมกลับ · ด่านใส่รถกลับเข้ารันด้วย reviveVin
 * แล้วรายการต้องไม่ถูกตราซ้ำจากรอยเก่า
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
    upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    fetchTrackingRows: async () => [], countTrackingRows: async () => 0, upsertQueue: async () => {}, upsertQueues: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [S1], currentSite: 'S1' })
  return { useTracking, ops }
}

/** รถจอดอยู่ (In Yard) ใน group G20 แต่มีรอย "ออกจาก S1" เก่าจากการยิงออกที่ยกเลิกไปแล้ว */
const row = (vin: string, leftAt?: number) => ({
  vin, site: 'S1', updatedAt: leftAt ?? 0, history: [],
  cells: { Vin: vin, 'Car Status': 'In Yard', 'Location yard': S1.name, 'Grouping  Number': 'SJWD26104-020',
    ...(leftAt ? { 'Gate Out From Site': 'S1', 'Gate Out From At': String(leftAt) } : {}) },
})
const itemOf = (ops: any, vin: string) => ops.useOps.getState().queues[0].items.find((i: any) => i.vin === vin)

describe('Gate-out: ใส่รถที่ DN วางแผนไว้กลับเข้าคิวส่งรถ', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-24T13:32:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('รายการถูกตรา "ออกแล้ว" จากการยิงออกที่ยกเลิก → reviveVin เปิดใหม่ (เก็บ group/lane/dealer) และตัวปรับคิวไม่ตราซ้ำ', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now() - 5 * HOUR
    const mistakenOut = Date.now() - 3 * HOUR
    useTracking.setState({ loaded: true, rows: { A: row('A'), STUCK: row('STUCK', mistakenOut) } } as any)
    ops.useOps.setState({ queues: [{ id: 'Q', name: 'run 24/10', createdAt: created, kind: 'sequence', site: 'S1', items: [
      { vin: 'A', addedAt: created, done: false, group: 'SJWD26104-020', laneLoad: 'O12', dest: 'Dealer X' },
      { vin: 'STUCK', addedAt: created, done: true, gatedOut: true, doneAt: mistakenOut, group: 'SJWD26104-020', laneLoad: 'O12', dest: 'Dealer X' },
    ] }] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'STUCK')).toMatchObject({ done: true, gatedOut: true }) // the stamp stays — the gate saw "ไม่มีคิวงาน"

    expect(ops.useOps.getState().reviveVin('Q', 'STUCK', { group: 'SJWD26104-020' })).toBe(true)
    expect(itemOf(ops, 'STUCK')).toMatchObject({ done: false, group: 'SJWD26104-020', laneLoad: 'O12', dest: 'Dealer X' })
    expect(itemOf(ops, 'STUCK').gatedOut).toBeFalsy()

    ops.reconcileGateOuts()
    expect(itemOf(ops, 'STUCK')).toMatchObject({ done: false })
    expect(itemOf(ops, 'STUCK').gatedOut).toBeFalsy()
    expect(ops.useOps.getState().queues[0].items).toHaveLength(2)
  })

  it('รถไม่มีรายการในคิวเลย และเคยออกจากลานนี้ (ตัวปรับคิวไม่เติมให้) → reviveVin เพิ่มด้วย group / lane / dealer ของรัน', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now() - 5 * HOUR
    useTracking.setState({ loaded: true, rows: { A: row('A'), BACK: row('BACK', Date.now() - 40 * 24 * HOUR) } } as any)
    ops.useOps.setState({ queues: [{ id: 'Q', name: 'run', createdAt: created, kind: 'sequence', site: 'S1', items: [
      { vin: 'A', addedAt: created, done: false, group: 'SJWD26104-020', laneLoad: 'O12', dest: 'Dealer X' },
    ] }] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'BACK')).toBeUndefined() // never re-added: it once left this yard

    ops.useOps.getState().reviveVin('Q', 'BACK', { group: 'SJWD26104-020', laneLoad: 'O12', dest: 'Dealer X' })
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'BACK')).toMatchObject({ done: false, group: 'SJWD26104-020', laneLoad: 'O12', dest: 'Dealer X' })
  })
})
