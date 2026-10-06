import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * รถ 1 คัน = แถวเดียวที่ทุกยาร์ดใช้ร่วมกัน (tracking_rows) — Gate-out ข้ามยาร์ดจึงต้องไม่ถูกดึงกลับด้วยไฟล์/การเขียนทับ
 * ชุดนี้จำลองเหตุที่ผู้ใช้พบ: รถ Gate-out จากยาร์ด 1 ไปยาร์ด 2 แล้วสถานะ/ป้ายยาร์ดย้อนกลับเป็น Pre Gate-in ที่ยาร์ด 1
 */

const S1 = { id: 'S1', name: 'NYB2 Phase 2', code: 'NYB2', createdAt: 0 }
const S2 = { id: 'S2', name: '60 RAI', code: '60RAI', createdAt: 0 }

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    fetchTrackingRows: async () => [], countTrackingRows: async () => 0,
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  useYard.setState({ sites: [S1, S2], currentSite: 'S1' })
  const row = (vin: string, site: string, cells: Record<string, string>) =>
    ({ vin, site, cells: { Vin: vin, ...cells }, history: [], updatedAt: 1_000 })
  const fileRes = (cells: Record<string, string>) => ({
    rows: [{ vin: cells.Vin, cells, updatedAt: Date.now() }], gateOutRows: [], defects: [], defectSheets: [], headers: [], options: {}, total: 1, inYard: 1, gatedOut: 0,
  }) as never
  return { useTracking, useYard, row, fileRes }
}

describe('Gate-out ข้ามยาร์ด แล้วอัปโหลดไฟล์ Co-Inspection ที่ปลายทาง', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-06T08:00:00Z')) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('รถที่เพิ่งย้ายมา (Pre Gate-in รอยิงรับ) ต้องอยู่ยาร์ดปลายทางต่อ ไม่ถูกไฟล์ที่ยังเขียนยาร์ดเก่าลากกลับ', async () => {
    const { useTracking, useYard, row, fileRes } = await setup()
    useTracking.setState({ loaded: true, rows: { V1: row('V1', 'S1', { 'Car Status': 'In Yard', 'Location yard': S1.name, 'Gate In (Rayong yard)': '20/09/2026' }) } })
    expect(useTracking.getState().transferToYard('V1', 'S2', { queue: false })).toBe(true)
    const moved = useTracking.getState().rows.V1
    expect(moved.site).toBe('S2'); expect(moved.cells['Car Status']).toBe('Pre Gate-in')

    // ผู้ใช้ยาร์ด 2 อัปโหลดไฟล์หลัก — บรรทัดของ V1 ยังเขียนยาร์ดเดิม (ไฟล์หลักไม่ทันอัปเดต)
    useYard.setState({ currentSite: 'S2' })
    useTracking.getState().commitCoInspection(fileRes({ Vin: 'V1', 'Location yard': S1.name }))

    const after = useTracking.getState().rows.V1
    expect(after.site, 'ป้ายไซต์ต้องไม่ย้อนกลับไปยาร์ด 1').toBe('S2')
    expect(after.cells['Location yard']).toBe(S2.name)
  })

  it('(ควบคุม) รถ Pre Gate-in ที่ติดป้ายผิดและไม่เคยย้ายยาร์ดเลย ยังถูกไฟล์แก้ป้ายได้ตามเดิม', async () => {
    const { useTracking, useYard, row, fileRes } = await setup()
    useYard.setState({ currentSite: 'S2' })
    useTracking.setState({ loaded: true, rows: { V2: row('V2', 'S2', { 'Car Status': 'Pre Gate-in', 'Location yard': S2.name }) } })
    useTracking.getState().commitCoInspection(fileRes({ Vin: 'V2', 'Location yard': S1.name }))
    expect(useTracking.getState().rows.V2.site).toBe('S1')
  })
})

describe('realtime broadcast ต้องพาป้ายไซต์ไปพร้อมข้อมูลช่อง', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(new Date('2026-10-06T08:00:00Z')) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  async function setupBus() {
    vi.resetModules(); localStorage.clear()
    const handlers: Record<string, (p: unknown) => void> = {}
    const sent: { event: string; payload: any }[] = []
    vi.doMock('../src/lib/supabase', () => ({
      isConfigured: () => true,
      supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
    }))
    vi.doMock('../src/lib/syncBus', async (orig) => ({
      ...(await orig<object>()),
      onSync: (e: string, h: (p: unknown) => void) => { handlers[e] = h },
      sendSync: (event: string, payload: object) => { sent.push({ event, payload }) },
    }))
    vi.doMock('../src/lib/db', async (orig) => ({
      ...(await orig<object>()), isConfigured: () => true,
      upsertVisits: async () => {}, upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    }))
    const { useTracking } = await import('../src/store/useTracking')
    const { useYard } = await import('../src/store/useYard')
    useYard.setState({ sites: [S1, S2], currentSite: 'S1' })
    return { useTracking, handlers, sent }
  }
  const base = { vin: 'V1', history: [], updatedAt: 1_000, site: 'S1', cells: { Vin: 'V1', 'Car Status': 'In Yard', 'Location yard': S1.name } }

  it('รับข้อความที่ยาร์ดปลายทางส่งมา: ป้ายไซต์ต้องเปลี่ยนไปพร้อมข้อมูลช่อง (ไม่ค้าง S1 แล้วโผล่เป็น Pre Gate-in ที่ยาร์ดเก่า)', async () => {
    const { useTracking, handlers } = await setupBus()
    useTracking.setState({ loaded: true, rows: { V1: base } })
    handlers.status({ rows: [{ vin: 'V1', at: Date.now(), site: 'S2', cells: { Vin: 'V1', 'Car Status': 'Pre Gate-in', 'Location yard': S2.name } }] })
    const r = useTracking.getState().rows.V1
    expect(r.cells['Car Status']).toBe('Pre Gate-in')
    expect(r.site).toBe('S2')
  })

  it('ข้อความแบบเก่า (ไม่มี site) ยังรับได้ และคงป้ายเดิมของเครื่องนี้', async () => {
    const { useTracking, handlers } = await setupBus()
    useTracking.setState({ loaded: true, rows: { V1: base } })
    handlers.status({ rows: [{ vin: 'V1', at: Date.now(), cells: { Vin: 'V1', 'Car Status': 'PDI', 'Location yard': S1.name } }] })
    const r = useTracking.getState().rows.V1
    expect(r.cells['Car Status']).toBe('PDI'); expect(r.site).toBe('S1')
  })

  it('ฝั่งส่ง: แนบ site ของแถวไปกับ broadcast', async () => {
    const { useTracking, sent } = await setupBus()
    useTracking.setState({ loaded: true, rows: { V1: base } })
    useTracking.setState((s) => ({ rows: { ...s.rows, V1: { ...s.rows.V1, site: 'S2', updatedAt: Date.now(), cells: { ...s.rows.V1.cells, 'Car Status': 'Pre Gate-in' } } } }))
    await vi.advanceTimersByTimeAsync(300)
    const msg = sent.find((x) => x.event === 'status')?.payload.rows[0]
    expect(msg?.vin).toBe('V1'); expect(msg?.site).toBe('S2')
  })
})
