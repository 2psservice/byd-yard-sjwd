import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * ลด egress: คิวงาน/แถวรอบดึงเฉพาะส่วนที่เปลี่ยน — เดิมทุกเครื่องดึงคิวทั้งชุด (~300 KB) ทุกนาที + ทุกสัญญาณ 'ops'
 * และดึง visits ทั้งตาราง (~1 MB) ทุกสัญญาณ 'visits' (26 ต.ค. egress วันละ 3–4 GB)
 */
const MIN = 60_000
const q = (id: string, createdAt: number, extra: object = {}) => ({ id, name: id, createdAt, items: [], ...extra })

async function setupOps(cloud: { queues: any[] }) {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  const calls: { since?: string; ids?: string[] }[] = []
  let idCalls = 0
  let gate: Promise<void> | null = null
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    fetchAppConfig: async () => null,
    fetchOpsQueues: async (opts: { sinceIso?: string; ids?: string[] } = {}) => {
      calls.push({ since: opts.sinceIso, ids: opts.ids })
      if (gate) await gate
      if (opts.ids) return cloud.queues.filter((x) => opts.ids!.includes(x.id))
      if (opts.sinceIso) return cloud.queues.filter((x) => (x.updatedAt ?? 0) > Date.parse(opts.sinceIso!))
      return cloud.queues
    },
    fetchOpsQueueIds: async () => { idCalls++; return cloud.queues.map((x) => x.id) },
    deleteOpsQueue: async () => {},
    upsertOpsQueue: async () => {},
  }))
  const ops = await import('../src/store/useOps')
  return { ops, calls, idCalls: () => idCalls, setGate: (g: Promise<void> | null) => { gate = g } }
}

describe('คิวงาน: ดึงส่วนต่าง', () => {
  afterEach(() => { vi.useRealTimers() })

  it('รอบแรกดึงทั้งชุด · รอบถัดไปส่ง since และรับเฉพาะคิวที่เปลี่ยน · คิวที่หายจากคลาวด์ถูกตัด', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-26T10:00:00+07:00') })
    const t0 = Date.now()
    const cloud = { queues: [q('A', t0 - 3 * MIN, { updatedAt: t0 - 3 * MIN }), q('B', t0 - 2 * MIN, { updatedAt: t0 - 2 * MIN })] }
    const { ops, calls } = await setupOps(cloud)
    await ops.useOps.getState().loadFromCloud()
    expect(calls).toEqual([{ since: undefined, ids: undefined }])
    expect(ops.useOps.getState().queues.map((x) => x.id)).toEqual(['A', 'B'])

    // 1 นาทีต่อมา: B ถูกแก้ · A ถูกลบ · C คิวใหม่
    vi.setSystemTime(t0 + MIN)
    cloud.queues = [q('B', t0 - 2 * MIN, { name: 'B2', updatedAt: t0 + 30_000 }), q('C', t0 + 40_000, { updatedAt: t0 + 40_000 })]
    await ops.useOps.getState().loadFromCloud()
    expect(calls[1].since).toBe(new Date(t0 - ops.OPS_DELTA_OVERLAP_MS).toISOString())
    expect(ops.useOps.getState().queues.map((x) => [x.id, x.name])).toEqual([['B', 'B2'], ['C', 'C']])
  })

  it('คิวที่เครื่องนี้ยังไม่มีแต่ updated_at เก่า → ดึงตาม id', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-26T10:00:00+07:00') })
    const t0 = Date.now()
    const cloud = { queues: [q('A', t0 - 3 * MIN, { updatedAt: t0 - 3 * MIN })] }
    const { ops, calls } = await setupOps(cloud)
    await ops.useOps.getState().loadFromCloud()
    vi.setSystemTime(t0 + MIN)
    cloud.queues = [...cloud.queues, q('OLD', t0 - 10 * 86_400_000, { updatedAt: t0 - 10 * 86_400_000 })]
    await ops.useOps.getState().loadFromCloud()
    expect(calls.some((c) => c.ids?.includes('OLD'))).toBe(true)
    expect(ops.useOps.getState().queues.map((x) => x.id).sort()).toEqual(['A', 'OLD'])
  })

  it('ครบ 15 นาที → ดึงทั้งชุดอีกครั้ง', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-26T10:00:00+07:00') })
    const t0 = Date.now()
    const { ops, calls } = await setupOps({ queues: [q('A', t0, { updatedAt: t0 })] })
    await ops.useOps.getState().loadFromCloud()
    vi.setSystemTime(t0 + ops.OPS_FULL_EVERY_MS + 1)
    await ops.useOps.getState().loadFromCloud()
    expect(calls.map((c) => c.since)).toEqual([undefined, undefined])
  })

  it('คำขอซ้อนระหว่างกำลังดึง รวมเป็นอีกรอบเดียว', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-26T10:00:00+07:00') })
    const t0 = Date.now()
    const { ops, calls, setGate } = await setupOps({ queues: [q('A', t0, { updatedAt: t0 })] })
    let release!: () => void
    setGate(new Promise<void>((r) => { release = r }))
    const p1 = ops.useOps.getState().loadFromCloud()
    await vi.waitFor(() => expect(calls.length).toBe(1))
    const p2 = ops.useOps.getState().loadFromCloud()
    const p3 = ops.useOps.getState().loadFromCloud(true)
    setGate(null); release()
    await Promise.all([p1, p2, p3])
    expect(calls.length).toBe(2) // รอบแรก + อีกรอบเดียว (ไม่ใช่ 3)
  })
})

describe('visits: ดึงส่วนต่าง', () => {
  it('รอบแรกทั้งตาราง · สัญญาณถัดไปส่ง since · แถวที่หายจากคลาวด์ถูกตัด · แถวใหม่ที่ updated_at เก่าดึงตาม id', async () => {
    vi.resetModules(); localStorage.clear()
    vi.useFakeTimers({ now: new Date('2026-10-26T10:00:00+07:00') })
    const t0 = Date.now()
    const v = (id: string, updatedAt: number) => ({ id, vin: id.split('#')[0], site: 'S1', cells: {}, history: [], updatedAt })
    let cloud = [v('A#1', t0 - MIN), v('B#1', t0 - MIN)]
    const calls: { since?: string; ids?: string[] }[] = []
    vi.doMock('../src/lib/supabase', () => ({
      isConfigured: () => true,
      supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
    }))
    vi.doMock('../src/lib/idb', async (orig) => ({ ...(await orig<object>()), idbGetAllVisits: async () => [], idbPutVisits: async () => {}, idbDeleteVisits: async () => {} }))
    vi.doMock('../src/lib/db', async (orig) => ({
      ...(await orig<object>()), isConfigured: () => true,
      fetchVisits: async (opts: { sinceIso?: string; ids?: string[] } = {}) => {
        calls.push({ since: opts.sinceIso, ids: opts.ids })
        if (opts.ids) return cloud.filter((x) => opts.ids!.includes(x.id))
        if (opts.sinceIso) return cloud.filter((x) => x.updatedAt > Date.parse(opts.sinceIso!))
        return cloud
      },
      fetchVisitIds: async () => cloud.map((x) => x.id),
      upsertVisits: async () => true, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)),
    }))
    const { useVisits, VISITS_DELTA_OVERLAP_MS } = await import('../src/store/useVisits')
    await useVisits.getState().load()
    expect(calls).toEqual([{ since: undefined, ids: undefined }])
    vi.setSystemTime(t0 + MIN)
    cloud = [v('B#1', t0 + 30_000), v('C#1', t0 - 60 * MIN)] // A ถูกลบ · B แก้ · C ใหม่แต่ updated_at เก่า
    await useVisits.getState().load()
    expect(calls[1].since).toBe(new Date(t0 - VISITS_DELTA_OVERLAP_MS).toISOString())
    expect(calls.some((c) => c.ids?.includes('C#1'))).toBe(true)
    expect(Object.keys(useVisits.getState().visits).sort()).toEqual(['B#1', 'C#1'])
    expect(useVisits.getState().visits['B#1'].updatedAt).toBe(t0 + 30_000)
    vi.useRealTimers()
  })
})
