import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * คิวส่งรถ 60 RAI (07/11): LC0CE4CB8T4319894 ยังอยู่ในลาน ไม่มีใครสแกนออก แต่หน้า Ops Scan ขึ้น "gate out"
 * เพราะรถเคยออกจากลานนี้ไปตั้งแต่เดือนก่อน (รอบที่ปิดไปแล้ว) แล้วกลับเข้ามา
 * รายการคิวต้องนับเฉพาะการออก "หลังรันเริ่ม" เหมือนตัวกระทบยอด
 */

const SEP = new Date('2026-09-10T04:40:00+07:00').getTime()
const RUN = new Date('2026-11-07T09:30:00+07:00').getTime()
const ADDED = new Date('2026-11-07T14:24:00+07:00').getTime()

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    upsertOpsQueue: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [{ id: 'r60', name: '60 RAI', code: '60 RAI', createdAt: 0 }, { id: 'lcb', name: '3D LCB', code: '3D LCB', createdAt: 0 }] } as any)
  const trip = (yard: string, out: number) => ({ yard, closedAt: out + 60_000, cells: { 'Gate Out Time': String(out) } })
  const row = (vin: string, trips: object[], extra: Record<string, string> = {}) => ({
    vin, site: 'r60', history: [], updatedAt: 1,
    cells: { Vin: vin, 'Car Status': 'In Yard', 'Location yard': '60 RAI', __trips: JSON.stringify(trips), ...extra },
  })
  useTracking.setState({ loaded: true, rows: {
    OLD: row('OLD', [trip('60 RAI', SEP)]),                                     // left in September, back since
    NOW: row('NOW', [trip('60 RAI', ADDED + 3_600_000)]),                       // left during this run
    MARK: row('MARK', [], { 'Gate Out From Site': 'r60', 'Gate Out From At': String(SEP) }), // old origin marker
    LOST: row('LOST', [trip('60 RAI', RUN + 3_600_000)]),                       // left during the run; item re-added later
  } } as any)
  const run = { id: 'R', name: 'Grouping to Dealer', kind: 'sequence', site: 'r60', createdAt: RUN, items: [
    { vin: 'OLD', addedAt: ADDED }, { vin: 'NOW', addedAt: ADDED }, { vin: 'MARK', addedAt: ADDED },
    { vin: 'LOST', addedAt: RUN + 7_200_000 },
  ] } as any
  return { ops, run }
}

describe('คิวส่งรถ: รถที่เคยออกจากลานนี้ก่อนรันเริ่ม ไม่ขึ้น gate out', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T16:00:00+07:00')) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('ออกเดือนก่อนแล้วกลับมา (รอบเก่า / ตราออกเก่า) = ยังรอส่ง · ออกระหว่างรัน = ออกแล้ว', async () => {
    const { ops, run } = await setup()
    const gone = Object.fromEntries(run.items.map((i: any) => [i.vin, ops.seqCarGone(i, run)]))
    expect(gone).toEqual({ OLD: false, NOW: true, MARK: false, LOST: true })
    expect(ops.isQueueComplete(run)).toBe(false)
  })
})
