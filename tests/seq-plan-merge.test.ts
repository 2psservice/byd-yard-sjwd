import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seqPlanKey } from '../src/lib/seqPlan'

/**
 * อัปโหลดไฟล์ Grouping ใหม่ของแผนเดิม (ยาร์ด + วันที่เดียวกัน) ต่อเข้าคิวงานเดิม ไม่สร้างคิวใหม่:
 * เดิม 70 คัน ออกไปแล้ว 20 → ไฟล์ใหม่ 140 คัน = คิวเดียว 140 คัน ออกไปแล้ว 20
 */

const S1 = { id: 'S1', name: 'NYB2 Phase 2', code: 'NYB2', createdAt: 0 }
const title = (units: number, groups: number, day = '02 November 2026', yard = 'NYB2') =>
  `${yard} - Grouping to Dealer ( ${units} Units / ${groups} Groups) Date ${day}`

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
    deleteOpsQueue: async () => {}, saveAppConfig: async () => {},
  }))
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [S1], currentSite: 'S1' })
  return ops
}

const vin = (i: number) => `LGXCE4CB${String(i).padStart(9, '0')}`
const group = (i: number) => `SJWD261102-${String(100 + Math.floor(i / 7)).padStart(3, '0')}` // 7 cars per group
const fileItems = (n: number) => Array.from({ length: n }, (_, i) => ({ vin: vin(i), group: group(i), laneLoad: `O${Math.floor(i / 7) + 1}`, dest: 'Dealer' }))

describe('seqPlanKey', () => {
  it('same yard label + plan date = same plan, whatever the counts in the title', () => {
    expect(seqPlanKey(title(133, 28))).toBe('NYB2|2026-11-02')
    expect(seqPlanKey(title(140, 29))).toBe(seqPlanKey(title(133, 28)))
    expect(seqPlanKey('NYB2 - Grouping to Dealer ( 70 Units / 10 Group) Date 2 Nov 2026')).toBe('NYB2|2026-11-02')
  })
  it('another day, another yard label, or a non-Grouping name are different plans', () => {
    expect(seqPlanKey(title(140, 29, '03 November 2026'))).not.toBe(seqPlanKey(title(133, 28)))
    expect(seqPlanKey(title(10, 10, '02 November 2026', 'NYB Phase 2'))).not.toBe(seqPlanKey(title(133, 28)))
    expect(seqPlanKey('PM · Lot 3')).toBe('')
  })
})

describe('อัปโหลดไฟล์ใหม่ของแผนเดิม', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-02T15:00:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('70 cars, 20 gated out → a 140-car file makes ONE run of 140 with the 20 still gated out', async () => {
    const ops = await setup()
    const st = () => ops.useOps.getState()
    const id = st().createSequence(title(70, 10), 'admin', fileItems(70))
    // 20 cars leave the yard
    ops.useOps.setState({ queues: st().queues.map((q) => (q.id !== id ? q : { ...q, items: q.items.map((i, k) => (k < 20 ? { ...i, done: true, gatedOut: true, doneBy: 'gate' } : i)) })) })
    const id2 = st().createSequence(title(140, 20), 'admin', fileItems(140))
    expect(id2).toBe(id)
    const runs = st().queues.filter((q) => q.kind === 'sequence')
    expect(runs).toHaveLength(1)
    expect(runs[0].name).toBe(title(140, 20))
    expect(runs[0].items).toHaveLength(140)
    expect(runs[0].items.filter((i) => i.gatedOut)).toHaveLength(20)
    expect(runs[0].items.find((i) => i.vin === vin(0))).toMatchObject({ gatedOut: true, doneBy: 'gate' })
  })

  it('two runs of the same plan already on the board fold into the one with the cars already sent', async () => {
    const ops = await setup()
    const it = (i: number, extra = {}) => ({ vin: vin(i), addedAt: 1, done: false, group: group(i), laneLoad: 'O1', ...extra })
    ops.useOps.setState({ queues: [
      { id: 'R133', name: title(133, 28), createdAt: 1, kind: 'sequence', site: 'S1', items: Array.from({ length: 133 }, (_, i) => it(i, i < 15 ? { done: true, gatedOut: true } : {})) },
      { id: 'R140', name: title(140, 29), createdAt: 2, kind: 'sequence', site: 'S1', items: Array.from({ length: 140 }, (_, i) => it(i)) },
      { id: 'OTHER', name: title(10, 10, '02 November 2026', 'NYB Phase 2'), createdAt: 3, kind: 'sequence', site: 'S1', items: [it(900)] },
    ] } as any)
    const id = ops.useOps.getState().createSequence(title(140, 29), 'admin', fileItems(140))
    expect(id).toBe('R133')
    const qs = ops.useOps.getState().queues
    expect(qs.map((q) => q.id).sort()).toEqual(['OTHER', 'R133']) // the other plan of the day is left alone
    const run = qs.find((q) => q.id === 'R133')!
    expect(run.items).toHaveLength(140)
    expect(run.items.filter((i) => i.gatedOut)).toHaveLength(15)
  })

  it('a car already sent stays on the run even when the new file no longer lists it; an unsent one the file dropped leaves', async () => {
    const ops = await setup()
    const st = () => ops.useOps.getState()
    const id = st().createSequence(title(3, 1), 'admin', fileItems(3))
    ops.useOps.setState({ queues: st().queues.map((q) => ({ ...q, items: q.items.map((i) => (i.vin === vin(0) ? { ...i, done: true, gatedOut: true } : i)) })) })
    st().createSequence(title(2, 1), 'admin', fileItems(3).slice(2).concat({ vin: vin(5), group: group(0), laneLoad: 'O1', dest: 'Dealer' }))
    const run = st().queues.find((q) => q.id === id)!
    expect(run.items.map((i) => i.vin).sort()).toEqual([vin(0), vin(2), vin(5)].sort())
    expect(run.items.find((i) => i.vin === vin(0))!.gatedOut).toBe(true)
  })

  it('a different plan date still starts a new run', async () => {
    const ops = await setup()
    const st = () => ops.useOps.getState()
    const a = st().createSequence(title(70, 10), 'admin', fileItems(70))
    const b = st().createSequence(title(70, 10, '03 November 2026'), 'admin', fileItems(70))
    expect(b).not.toBe(a)
    expect(st().queues.filter((q) => q.kind === 'sequence')).toHaveLength(2)
  })
})
