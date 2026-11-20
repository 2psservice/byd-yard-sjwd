import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 20/11: Supabase Realtime ~660k ข้อความ/วัน (โควตา 5M/เดือน) — แก้รถ 1 คันกินข้อความ ~250 แทน ~24
 *   Loop A: เครื่องที่ได้แถวมาทาง postgres_changes เอาไป broadcast 'status' ต่อ (ทุกเครื่องที่รับ)
 *   Loop B: ซิงก์รายนาทีส่งแถวที่เพิ่งได้รับจากคลาวด์ กลับขึ้นคลาวด์ซ้ำ (ข้อมูลเดิมทุกไบต์ → UPDATE ส่งให้ทุกเครื่องอีกรอบ)
 */

const T = 1_763_600_000_000

async function setup(cloudRows: any[] = []) {
  vi.resetModules(); localStorage.clear()
  const pg: ((p: any) => void)[] = []
  const sent: { event: string; payload: any }[] = []
  const upserts: string[][] = []
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: {
      channel: () => ({
        on(type: string, _f: unknown, cb: (p: any) => void) { if (type === 'postgres_changes') pg.push(cb); return this },
        subscribe() { return this }, send: async () => 'ok',
      }),
      removeChannel() {},
    },
  }))
  vi.doMock('../src/lib/syncBus', async (orig) => ({
    ...(await orig<object>()),
    onSync: () => {},
    sendSync: (event: string, payload: object) => { sent.push({ event, payload }) },
  }))
  vi.doMock('../src/lib/deviceInfo', async (orig) => ({ ...(await orig<object>()), chooseSyncMode: () => 'incremental' }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertTrackingRows: async (rows: any[]) => { upserts.push(rows.map((r) => r.vin)) },
    fetchTrackingRows: async () => cloudRows,
    fetchTrackingRowsByVins: async () => [],
    countTrackingRows: async () => 2,
    upsertStationChecks: async () => {}, upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)),
    bulkUpsert: async () => {}, deleteTrackingRows: async () => {}, purgeTrackingTombstones: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  useYard.setState({ currentUser: 'admin', currentSite: 'S1' })
  const row = (vin: string, at: number, status: string) =>
    ({ vin, site: 'S1', updatedAt: at, history: [{ at, by: 'gate1', field: 'Car Status', from: '', to: status }], cells: { Vin: vin, 'Car Status': status } })
  useTracking.setState({ loaded: true, lastSync: T - 60_000, rows: { V1: row('V1', T - 600_000, 'Pre Gate-in'), V2: row('V2', T - 600_000, 'In Yard') } })
  await new Promise((r) => setTimeout(r, 300)) // let the initial-load announcer pass settle
  sent.length = 0
  useTracking.getState().subscribeRealtime()
  return { useTracking, pg, sent, upserts, row }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Realtime: แถวที่มาจากคลาวด์ไม่ถูกส่งซ้ำ', () => {
  afterEach(() => { vi.resetModules() })

  it('Loop A: ได้แถวทาง postgres_changes → ไม่ broadcast "status" ต่อ · แก้ในเครื่องเองยัง broadcast ตามเดิม', async () => {
    const { useTracking, pg, sent, row } = await setup()
    expect(pg.length).toBe(1)
    const r = row('V1', T, 'In Yard')
    pg[0]({ eventType: 'UPDATE', new: { vin: 'V1', cells: r.cells, updated_at: new Date(T).toISOString(), site: 'S1', history: r.history } })
    expect(useTracking.getState().rows.V1.cells['Car Status']).toBe('In Yard') // applied on screen
    await wait(400)
    expect(sent.filter((m) => m.event === 'status')).toHaveLength(0)

    // control: an edit made on THIS device is still announced to the others
    useTracking.getState().updateCell('V2', 'Car Status', 'Pre Gate-out')
    await wait(400)
    const st = sent.filter((m) => m.event === 'status')
    expect(st).toHaveLength(1)
    expect(st[0].payload.rows.map((m: any) => m.vin)).toEqual(['V2'])
  })

  it('Loop B: ซิงก์รายนาทีไม่ส่งแถวที่คลาวด์มีฉบับเดียวกันอยู่แล้ว · แก้ตอนออฟไลน์ (ใหม่กว่าคลาวด์) ยังส่ง', async () => {
    const r1 = { vin: 'V1', site: 'S1', updatedAt: T, history: [], cells: { Vin: 'V1', 'Car Status': 'In Yard' } }
    const cloudV2 = { vin: 'V2', site: 'S1', updatedAt: T - 30_000, history: [], cells: { Vin: 'V2', 'Car Status': 'In Yard' } }
    const { useTracking, pg, upserts } = await setup([r1, cloudV2])
    // V1 arrives by realtime (same stamp as the cloud copy)
    pg[0]({ eventType: 'UPDATE', new: { vin: 'V1', cells: r1.cells, updated_at: new Date(T).toISOString(), site: 'S1', history: [] } })
    // V2 edited here while the push failed / offline: newer than the cloud copy
    useTracking.setState((s) => ({ rows: { ...s.rows, V2: { ...s.rows.V2, updatedAt: T + 5_000, cells: { Vin: 'V2', 'Car Status': 'Pre Gate-out' } } } }))
    upserts.length = 0
    await useTracking.getState().syncCloud()
    await wait(50)
    const pushed = upserts.flat()
    expect(pushed).not.toContain('V1')
    expect(pushed).toContain('V2')
  })
})
