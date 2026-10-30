import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 3D THUNGKRAT 28 ต.ค.: คืน Location ตามบรรทัดล่าสุดใน Event ของชุดที่แอดมินระบุ
 * เช่น LC0C74C40TG031703 "รัชนีกร แก้ไข Location (ว่าง) → C0503" แล้วช่องหาย → กลับไป C0503
 * · สำรองตำแหน่งเดิมลง app_config ก่อนเขียน สำรองไม่ได้ = ไม่เขียนอะไรเลย
 * · บรรทัดที่แอดมินแก้เอง (ไม่ใช่การยิงของคนขับ) คืนได้แม้ unit เป็น GATE_IN ไม่มีช่อง
 */

const SITE = 'S3D'
const T0 = new Date(2026, 9, 24, 14, 4).getTime()

type U = Record<string, unknown>
const unit = (vin: string, extra: U = {}): U => ({ vin, model: 'x', modelName: 'SEALION 5', color: 'WHITE', trailer: 0, damages: [], site: SITE, status: 'GATE_IN', ...extra })
const row = (vin: string, history: U[], status = 'In Yard') => ({
  vin, site: SITE, updatedAt: T0, history, cells: { Vin: vin, 'Car Status': status, 'Location yard': '3D THUNGKRAT' },
})
const edit = (to: string, by = 'รัชนีกร', at = T0) => ({ at, by, field: 'Location', from: '', to })
const scan = (to: string, at = T0) => ({ at, by: 'คนขับ', field: 'Location', from: '', to, src: 'scan' })

async function setup(opts: { backupFails?: boolean } = {}) {
  vi.resetModules(); localStorage.clear()
  const cloudUnits = new Map<string, U>()
  const writes: U[][] = []
  const backups: { id: string; value: any }[] = []
  let rows: Record<string, any> = {}
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    countTrackingRows: async () => null,
    fetchTrackingRows: async () => Object.values(rows).map((r) => JSON.parse(JSON.stringify(r))),
    upsertTrackingRows: async () => {}, upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), bulkUpsert: async () => {}, deleteTrackingRows: async () => {}, upsertStationChecks: async () => {},
    fetchUnitsByVins: async (vins: string[]) => vins.map((v) => cloudUnits.get(v)).filter(Boolean),
    upsertUnitsStrict: async (us: U[]) => { writes.push(us); for (const u of us) cloudUnits.set(u.vin as string, u) },
    saveAppConfig: async (id: string, value: unknown) => {
      if (opts.backupFails) throw new Error('app_config down')
      backups.push({ id, value: JSON.parse(JSON.stringify(value)) })
    },
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const seed = (r: Record<string, any>, units: Record<string, U>) => {
    rows = r
    for (const [v, u] of Object.entries(units)) cloudUnits.set(v, u)
    useTracking.setState({ loaded: true, rows: JSON.parse(JSON.stringify(r)), lastSync: 0 })
    useYard.setState({ currentSite: SITE, currentUser: 'admin', sites: [{ id: SITE, name: '3D THUNGKRAT' }] as any, blocksBySite: {}, units: JSON.parse(JSON.stringify(units)) })
  }
  const run = (vins: string[]) => useTracking.getState().restorePositionsInBlocks(['*'], { onlyVins: vins, anyBlock: true, backupKey: 'restore_backup:sjwd-restore-set-3dtk-20261028' })
  return { useTracking, useYard, seed, run, cloudUnits, writes, backups }
}

describe('คืน Location 3D THUNGKRAT ตามบรรทัดล่าสุดใน Event', () => {
  afterEach(() => { vi.doUnmock('../src/lib/db'); vi.doUnmock('../src/lib/supabase'); vi.resetModules() })

  it('แอดมินแก้ C0503 แล้วช่องหาย → กลับไป C0503 · สำรองตำแหน่งเดิมก่อนเขียน · คันอื่นไม่ถูกแตะ', async () => {
    const t = await setup()
    t.seed({
      // the screenshot car: gate-in 23/10, hand-set C0503 on 24/10, unit now GATE_IN with no slot
      LC0C74C40TG031703: row('LC0C74C40TG031703', [edit('C0503')]),
      // PARKED but its slot was cleared
      PARKED_NOSLOT: row('PARKED_NOSLOT', [edit('C0601'), edit('C0702', 'สมศรี', T0 + 60_000)]),
      // a driver scan then cancel — never reached the slot
      CANCELLED: row('CANCELLED', [scan('C0801')]),
      // already has a slot here — never touched
      PLACED: row('PLACED', [edit('C0901')]),
      // its slot is taken by another car now
      TAKEN: row('TAKEN', [edit('C0902')]),
      // gone out — not In Yard
      LEFT: row('LEFT', [edit('C1001')], 'Gate-out'),
      // nothing to go on
      NOLINE: row('NOLINE', []),
    }, {
      LC0C74C40TG031703: unit('LC0C74C40TG031703'),
      PARKED_NOSLOT: unit('PARKED_NOSLOT', { status: 'PARKED' }),
      CANCELLED: unit('CANCELLED'),
      PLACED: unit('PLACED', { status: 'PARKED', block: 'C', slot: 9, row: 1, parkedAt: T0 }),
      TAKEN: unit('TAKEN'),
      OTHER: unit('OTHER', { status: 'PARKED', block: 'C', slot: 9, row: 2, parkedAt: T0 }),
      LEFT: unit('LEFT'),
      NOLINE: unit('NOLINE'),
    })
    const vins = ['LC0C74C40TG031703', 'PARKED_NOSLOT', 'CANCELLED', 'PLACED', 'TAKEN', 'LEFT', 'NOLINE', 'MISSING']
    const res = await t.run(vins)

    expect(res.fixed).toBe(2)
    const u = t.useYard.getState().units.LC0C74C40TG031703
    expect([u.block, u.slot, u.row, u.status, u.parkedAt]).toEqual(['C', 5, 3, 'PARKED', T0])
    const p = t.useYard.getState().units.PARKED_NOSLOT
    expect([p.block, p.slot, p.row]).toEqual(['C', 7, 2]) // the LATEST line wins
    expect(t.cloudUnits.get('LC0C74C40TG031703')).toMatchObject({ block: 'C', slot: 5, row: 3 })

    const why = Object.fromEntries(res.reasons.map((r) => [r.vin, r.why]))
    expect(why.CANCELLED).toBe('ยกเลิกขับก่อนถึงช่อง')
    expect(why.PLACED).toMatch(/มีช่องบนผังแล้ว/)
    expect(why.TAKEN).toMatch(/มีรถ .* จอดอยู่/)
    expect(why.LEFT).toMatch(/Gate-out/)
    expect(why.NOLINE).toMatch(/ไม่มีบรรทัดยิง/)
    expect(why.MISSING).toMatch(/ไม่พบแถว/)
    expect(t.useYard.getState().units.PLACED).toMatchObject({ block: 'C', slot: 9, row: 1 })

    // backup written BEFORE the units, holding exactly the restored cars as they were
    expect(t.backups).toHaveLength(1)
    expect(t.backups[0].id).toMatch(/^restore_backup:sjwd-restore-set-3dtk-20261028:\d+$/)
    expect(t.backups[0].value.site).toBe(SITE)
    expect(t.backups[0].value.units).toEqual([
      { vin: 'LC0C74C40TG031703', site: SITE, block: null, row: null, slot: null, status: 'GATE_IN', parkedAt: null, importedAt: null },
      { vin: 'PARKED_NOSLOT', site: SITE, block: null, row: null, slot: null, status: 'PARKED', parkedAt: null, importedAt: null },
    ])

    // the Event tab records the restore, marked so it is never read back as a scan
    const h = t.useTracking.getState().rows.LC0C74C40TG031703.history!.at(-1)!
    expect(h).toMatchObject({ field: 'Location', from: '', to: expect.stringContaining('C') })
    expect(h.by).toContain('· คืนตำแหน่งที่ถูกล้าง')
  })

  it('สำรองไม่สำเร็จ → ไม่เขียนตำแหน่งเลย (โยน error ให้งานลองใหม่ครั้งหน้า)', async () => {
    const t = await setup({ backupFails: true })
    t.seed({ V1: row('V1', [edit('C0503')]) }, { V1: unit('V1') })
    await expect(t.run(['V1'])).rejects.toThrow('app_config down')
    expect(t.writes).toHaveLength(0)
    expect(t.useYard.getState().units.V1.block).toBeUndefined()
  })

  it('อีกเครื่องทำงานเดียวกันทีหลัง: คันที่คืนแล้วไม่ถูกเขียนซ้ำ · ไม่มีอะไรให้คืน = ไม่สร้างสำรองทับ', async () => {
    const t = await setup()
    t.seed({ V1: row('V1', [edit('C0503')]) }, { V1: unit('V1') })
    await t.run(['V1'])
    expect(t.backups).toHaveLength(1)
    // second device: cloud already holds C0503
    t.useYard.setState({ units: { V1: unit('V1') as any } })
    const res2 = await t.run(['V1'])
    expect(res2.fixed).toBe(0)
    expect(t.backups).toHaveLength(1)
    expect(t.writes).toHaveLength(1)
  })
})
