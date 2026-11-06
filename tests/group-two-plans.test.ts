import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupChoices, destPurpose, purposeLabel } from '../src/lib/groupRuns'

/**
 * เลข Grouping เดียวกัน สองงาน (06/11 NYB2): ไฟล์ "FIS Ready to Grouping for delivery" (ขายส่งดีลเลอร์)
 * กับ "NYB2 Phase2 Grouping to 3D RINCHA" (ย้ายลาน) ใช้เลขชุดเดียวกัน 14 เลข · ไม่มีรถคันไหนอยู่ทั้งสองไฟล์
 *  - คิวงานต้องแยกกัน ตัวซิงก์คิวห้ามดึงรถของอีกแผนเข้ารัน
 *  - สแกน DN ที่เลขซ้ำ → เลือกก่อนว่า Grouping for delivery หรือ Grouping to 3D RINCHA
 */

const SN = { id: 'SN', name: 'NYB2 Phase 2', code: 'NYB2', createdAt: 0 }
const SR = { id: 'SR', name: '3D RINCHA', code: '3D RINCHA', createdAt: 0 }
const sites = [SN, SR]
const G = 'SJWD261106-001'
const DEALER = 'HC BKK Co., Ltd. (Pathumthani)'
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
    fetchTrackingRows: async () => [], countTrackingRows: async () => 0, upsertOpsQueue: async () => {}, upsertQueue: async () => {}, upsertQueues: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites, currentSite: 'SN' } as any)
  return { useTracking, ops }
}

const row = (vin: string, dl: string, group = G) => ({
  vin, site: 'SN', updatedAt: 0, history: [],
  cells: { Vin: vin, 'Car Status': 'In Yard', 'Location yard': SN.name, 'Grouping  Number': group, 'Dealer Location': dl },
})
const item = (vin: string, dest: string, at: number) => ({ vin, addedAt: at, done: false, group: G, laneLoad: 'O1', dest })
const vinsOf = (ops: any, id: string) => ops.useOps.getState().queues.find((q: any) => q.id === id).items.map((i: any) => i.vin).sort()

describe('ตัวซิงก์คิว: สองแผนที่ใช้เลขเดียวกันในยาร์ดเดียวกัน ไม่ปนกัน', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-06T13:00:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  const created = Date.now() - 3 * HOUR
  const runs = (dealItems: any[], moveItems: any[]) => [
    { id: 'DEAL', name: 'NYB2 - Grouping to Dealer ( 135 Units / 31 Groups) Date 6 November 2026', createdAt: created, kind: 'sequence', site: 'SN', items: dealItems },
    { id: 'MOVE', name: 'NYB2 Phase2 Grouping to 3D RINCHA ( 210 Units / 30 Groups) Date 06 November 2026', createdAt: created + 1, kind: 'sequence', site: 'SN', items: moveItems },
  ]

  it('รถย้ายลานที่ถือเลขเดียวกัน ไม่ถูกดึงเข้ารันส่งดีลเลอร์ (และกลับกัน)', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { D1: row('D1', DEALER), D2: row('D2', DEALER), T1: row('T1', '3D RINCHA'), T2: row('T2', '3D RINCHA') } } as any)
    ops.useOps.setState({ queues: runs([item('D1', DEALER, created), item('D2', DEALER, created)], [item('T1', '3D RINCHA', created), item('T2', '3D RINCHA', created)]) } as any)
    ops.reconcileGateOuts()
    expect(vinsOf(ops, 'DEAL')).toEqual(['D1', 'D2'])
    expect(vinsOf(ops, 'MOVE')).toEqual(['T1', 'T2'])
  })

  it('รถที่ถูกดึงผิดรันไปแล้ว ออกจากรันนั้น: อีกแผนถือรถคันนี้อยู่ และแถวรถบอกปลายทางของอีกแผน', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { D1: row('D1', DEALER), D2: row('D2', DEALER), T1: row('T1', '3D RINCHA'), T2: row('T2', '3D RINCHA') } } as any)
    ops.useOps.setState({ queues: runs(
      [item('D1', DEALER, created), item('D2', DEALER, created), item('T1', DEALER, created + HOUR)], // T1 pulled in by the old sync
      [item('T1', '3D RINCHA', created), item('T2', '3D RINCHA', created)],
    ) } as any)
    ops.reconcileGateOuts()
    expect(vinsOf(ops, 'DEAL')).toEqual(['D1', 'D2'])
    expect(vinsOf(ops, 'MOVE')).toEqual(['T1', 'T2'])
  })

  it('ไม่มีหลักฐานครบ = ไม่เอาออก: แถวว่างปลายทาง · หรืออีกแผนไม่ได้ถือรถคันนั้น', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: {
      D1: row('D1', DEALER), T1: row('T1', '3D RINCHA'),
      BLANK: row('BLANK', ''),           // Delivery Location not on this device's copy
      LONE: row('LONE', '3D RINCHA'),    // row says move, but no move run holds it
    } } as any)
    ops.useOps.setState({ queues: runs(
      [item('D1', DEALER, created), item('BLANK', DEALER, created), item('LONE', DEALER, created)],
      [item('T1', '3D RINCHA', created)],
    ) } as any)
    ops.reconcileGateOuts()
    expect(vinsOf(ops, 'DEAL')).toEqual(['BLANK', 'D1', 'LONE'])
  })

  it('เลขที่มีแผนเดียว ยังดึงรถที่ติดเลขใหม่เข้ารันเหมือนเดิม', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { D1: row('D1', DEALER), NEW: row('NEW', DEALER) } } as any)
    ops.useOps.setState({ queues: runs([item('D1', DEALER, created)], []) } as any)
    ops.reconcileGateOuts()
    expect(vinsOf(ops, 'DEAL')).toEqual(['D1', 'NEW'])
  })
})

describe('สแกน DN เลขซ้ำ: ตัวเลือกให้เลือกก่อน', () => {
  const q = (id: string, name: string, items: any[]) => ({ id, name, createdAt: 0, kind: 'sequence', site: 'SN', items }) as any

  it('เลขเดียวกันในสองแผน → สองตัวเลือก ส่งดีลเลอร์ขึ้นก่อน · แต่ละตัวเลือกมีแต่รถของแผนนั้น', () => {
    const c = groupChoices([
      q('MOVE', 'NYB2 Phase2 Grouping to 3D RINCHA', [item('T1', '3D RINCHA', 0), item('T2', '3D RINCHA', 0)]),
      q('DEAL', 'NYB2 - Grouping to Dealer', [item('D1', DEALER, 0), { ...item('X', DEALER, 0), group: 'SJWD261106-002' }]),
    ], ' sjwd261106-001 ', sites)
    expect(c.map((x) => x.label)).toEqual(['Grouping for delivery', 'Grouping to 3D RINCHA'])
    expect(c[0]).toMatchObject({ purpose: '', runIds: ['DEAL'], vins: ['D1'] })
    expect(c[1]).toMatchObject({ purpose: 'SR', runIds: ['MOVE'], vins: ['T1', 'T2'] })
  })

  it('เลขที่มีแผนเดียว → ตัวเลือกเดียว (เปิด DN ได้เลย ไม่มี popup) · ปลายทางเป็นชื่อยาร์ดของเรา = ย้ายลาน', () => {
    expect(groupChoices([q('DEAL', 'x', [item('D1', DEALER, 0)])], G, sites)).toHaveLength(1)
    expect(destPurpose('VEHICLE 3D Rincha', sites)).toBe('SR')
    expect(destPurpose(DEALER, sites)).toBe('')
    expect(purposeLabel('SR', sites)).toBe('Grouping to 3D RINCHA')
  })
})
