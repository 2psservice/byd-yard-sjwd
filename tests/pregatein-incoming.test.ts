import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ล็อตรับรถของยาร์ดปลายทาง (Pre Gate-in) กับรถที่ยังอยู่ยาร์ดอื่น — 28 ต.ค. ไฟล์ NYB2 210 คัน (Move From RY):
 * 103 คันยัง In Yard ที่ Rayong ล็อต NYB2 นับว่ามาถึงแล้วตั้งแต่สร้างล็อต · ประตู NYB2 ยิงรับไม่ได้ · Dashboard ไม่นับ
 * กติกาใหม่: มาถึงยาร์ดของล็อตเฉพาะคันที่แถวเป็นของยาร์ดนั้นแล้ว (ยิงรับที่ประตูนี้) หรือมีรอยออกจากยาร์ดนั้นหลังเข้าล็อต
 */

const RY = { id: 'RY', name: 'Rayong', code: 'RY', createdAt: 0 }
const NY = { id: 'NY', name: 'NYB2 Phase 2', code: 'NYB2', createdAt: 0 }
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
    saveQueue: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [RY, NY], currentSite: 'NY' })
  return { useTracking, useYard, ops }
}

const at = (site: typeof RY, vin: string, status: string, extra: Record<string, string> = {}) => ({
  vin, site: site.id, updatedAt: 1_000, history: [],
  cells: { Vin: vin, 'Car Status': status, 'Location yard': site.name, 'Gate In Time': '1000', ...extra },
})

/** ล็อต NYB2: N1 = รถใหม่ (Pre Gate-in ที่ NYB2) · R1 = รถ Rayong ที่ล็อตเก่าตราว่า "มาแล้ว" (ระบบตรา ไม่มีชื่อคน) */
const lotOf = (created: number, items: Record<string, unknown>[]) => ({
  id: 'L', name: '(NYB2 Phase 2 · 10-28 · Move From RY · 210)', createdAt: created, site: 'NY', type: 'GATEIN',
  items: items.map((i) => ({ addedAt: created, done: false, ...i })),
})

const item = (ops: any, vin: string) => ops.useOps.getState().queues[0].items.find((i: any) => i.vin === vin)

describe('ล็อตรับรถ: รถที่ยังอยู่ยาร์ดอื่น', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-28T10:00:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('รถ In Yard ที่ Rayong ในล็อต NYB2 = ยังไม่มาถึง และนับเป็นรถกำลังย้ายมา แม้ธง done ถูกตราไว้', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { N1: at(NY, 'N1', 'Pre Gate-in', { 'Gate In Time': '' }), R1: at(RY, 'R1', 'In Yard') } } as any)
    const q = lotOf(created, [{ vin: 'N1' }, { vin: 'R1', done: true, doneAt: created }])
    expect(ops.gateInArrived(q.items[1] as any, q as any)).toBe(false)
    expect(ops.isIncomingLotItem(q.items[1] as any, q as any)).toBe(true)
    expect(ops.isIncomingLotItem(q.items[0] as any, q as any)).toBe(false) // แถวของ NYB2 เอง ไม่ใช่รถจากยาร์ดอื่น
    expect(ops.queueProgress(q as any)).toMatchObject({ total: 2, done: 0, remaining: 2 })
    expect(ops.gateInPendingItems(q as any).map((i) => i.vin)).toEqual(['N1', 'R1'])
    expect(ops.isQueueComplete(q as any)).toBe(false)
  })

  it('Rayong ยิงออกแล้ว (Pre Gate-out) และล็อตเก่าตรา gatedOut ผิดไว้ = ยังไม่มาถึง', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { R1: at(RY, 'R1', 'Pre Gate-out', { 'Gate Out Time': String(created + HOUR) }) } } as any)
    const q = lotOf(created, [{ vin: 'R1', done: true, gatedOut: true, doneAt: created + HOUR }])
    expect(ops.gateInArrived(q.items[0] as any, q as any)).toBe(false)
    expect(ops.isIncomingLotItem(q.items[0] as any, q as any)).toBe(true)
  })

  it('ยิงรับที่ NYB2 (แถวย้ายมา NYB2 + In Yard) = มาถึงแล้ว ไม่ใช่รถกำลังย้ายมาอีก', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { R1: at(RY, 'R1', 'In Yard') } } as any)
    vi.setSystemTime(created + 2 * HOUR)
    expect(useTracking.getState().transferToYard('R1', 'NY', { queue: false })).toBe(true)
    useTracking.getState().updateCells('R1', { 'Car Status': 'In Yard', 'Gate In Time': String(Date.now()) })
    const q = lotOf(created, [{ vin: 'R1' }])
    expect(ops.gateInArrived(q.items[0] as any, q as any)).toBe(true)
    expect(ops.isIncomingLotItem(q.items[0] as any, q as any)).toBe(false)
    expect(ops.queueProgress(q as any)).toMatchObject({ total: 1, done: 1 })
  })

  it('ยิงรับที่ NYB2 บันทึก Gate-out ที่ Rayong ณ เวลาเดียวกัน (Rayong เห็นว่ารถออกไปแล้ว)', async () => {
    const { useTracking } = await setup()
    const { departureFromSite } = await import('../src/lib/siteScope')
    useTracking.setState({ loaded: true, rows: { R1: at(RY, 'R1', 'In Yard') } } as any)
    const scanAt = Date.now() + 3 * HOUR
    vi.setSystemTime(scanAt)
    useTracking.getState().transferToYard('R1', 'NY', { queue: false })
    const r = useTracking.getState().rows.R1
    expect(r.site).toBe('NY')
    expect(departureFromSite(r.cells, 'RY', [RY, NY])?.at).toBe(scanAt)
  })

  it('มาถึง NYB2 แล้วย้ายต่อไปยาร์ดอื่น (มีรอยออกจาก NYB2 หลังเข้าล็อต) = มาถึงแล้ว', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { R1: at(RY, 'R1', 'In Yard', { 'Gate Out From Site': 'NY', 'Gate Out From At': String(created + HOUR) }) } } as any)
    const q = lotOf(created, [{ vin: 'R1' }])
    expect(ops.gateInArrived(q.items[0] as any, q as any)).toBe(true)
  })

  it('(ควบคุม) ล็อตเก่าที่จด gatedOut ไว้ แต่รอยออกหาย และรถอยู่ยาร์ดใหม่ในลาน = ยังนับว่ามาถึง ล็อตไม่เด้งกลับมาค้าง', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: { R1: at(RY, 'R1', 'In Yard') } } as any)
    const q = lotOf(created, [{ vin: 'R1', done: true, gatedOut: true }])
    expect(ops.gateInArrived(q.items[0] as any, q as any)).toBe(true)
    expect(ops.isQueueComplete(q as any)).toBe(true)
  })

  it('(ควบคุม) เรียกแบบไม่ส่งล็อต อ่านแบบเดิม', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { R1: at(RY, 'R1', 'In Yard') } } as any)
    expect(ops.gateInArrived({ vin: 'R1', addedAt: 0, done: false } as any)).toBe(true)
  })

  it('ตัวซิงก์คิว: ไม่ตรารถ In Yard / Pre Gate-out ของ Rayong ว่ามาถึงหรือออกไปแล้วในล็อต NYB2', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: {
      R1: at(RY, 'R1', 'In Yard'),
      R2: at(RY, 'R2', 'Pre Gate-out', { 'Gate Out Time': String(created + HOUR) }),
      N1: at(NY, 'N1', 'In Yard'),
    } } as any)
    ops.useOps.setState({ queues: [lotOf(created, [{ vin: 'R1' }, { vin: 'R2' }, { vin: 'N1' }])] } as any)
    vi.setSystemTime(created + 2 * HOUR)
    ops.reconcileGateOuts()
    expect(item(ops, 'R1')).toMatchObject({ done: false })
    expect(item(ops, 'R2')).toMatchObject({ done: false })
    expect(item(ops, 'R2').gatedOut).toBeFalsy()
    expect(item(ops, 'N1')).toMatchObject({ done: true }) // รถของ NYB2 เองยังตราตามเดิม
  })

  it('ตัวซิงก์คิว: รถที่มาถึง NYB2 แล้วออกจาก NYB2 ไปยาร์ดอื่น ยังตรา gatedOut ตามเดิม', async () => {
    const { useTracking, ops } = await setup()
    const created = Date.now()
    useTracking.setState({ loaded: true, rows: {
      R1: at(RY, 'R1', 'Pre Gate-in', { 'Gate In Time': '', 'Gate Out From Site': 'NY', 'Gate Out From At': String(created + HOUR) }),
    } } as any)
    ops.useOps.setState({ queues: [lotOf(created, [{ vin: 'R1' }])] } as any)
    vi.setSystemTime(created + 2 * HOUR)
    ops.reconcileGateOuts()
    expect(item(ops, 'R1')).toMatchObject({ done: true, gatedOut: true })
  })
})
