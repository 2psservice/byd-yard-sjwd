import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 27 ต.ค. 11:39: นำเข้า Vin List Inventory ที่เครื่องซึ่งเปิดยาร์ด NYB2 — เครื่องโหลดแถวรถเฉพาะยาร์ดของตัวเอง
 * รถ 466 คันที่รอบปัจจุบันอยู่ 3D LCB / 3D THUNGKRAT จึงไม่อยู่ในเครื่อง → ถูกนับเป็น "ใหม่" แล้วเขียนทับทั้งแถวในคลาวด์
 * (ยาร์ด · ข้อมูลรอบ 3D · ประวัติ หายหมด) → รถถูกปลดจากผัง · IR ออกเป็น NYB2
 * กติกา: การนำเข้าเพิ่มได้เฉพาะ VIN ที่คลาวด์ยังไม่มี — VIN ที่มีอยู่แล้วไม่ถูกแตะ ไม่ว่าเครื่องจะโหลดครบหรือไม่
 */
type Row = { vin: string; site?: string; cells: Record<string, string>; history?: any[]; updatedAt?: number; deletedAt?: number }

async function setup(cloudRows: Row[], insertDelayMs = 0) {
  vi.resetModules(); localStorage.clear()
  const cloud = new Map<string, Row>(cloudRows.map((r) => [r.vin, JSON.parse(JSON.stringify(r))]))
  const upserted: string[] = []
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), bulkUpsert: async () => {}, deleteTrackingRows: async () => {}, upsertStationChecks: async () => {},
    upsertTrackingRows: async (rows: Row[]) => { for (const r of rows) { upserted.push(r.vin); cloud.set(r.vin, JSON.parse(JSON.stringify(r))) } },
    // ON CONFLICT DO NOTHING — แถวที่มีอยู่แล้ว (รวมแถวที่ถูกลบ) ไม่ถูกแตะ
    insertTrackingRowsIfAbsent: async (rows: Row[]) => {
      if (insertDelayMs) await new Promise((r) => setTimeout(r, insertDelayMs))
      const inserted = new Set<string>()
      for (const r of rows) if (!cloud.has(r.vin)) { cloud.set(r.vin, JSON.parse(JSON.stringify(r))); inserted.add(r.vin) }
      return inserted
    },
    fetchTrackingRowsByVins: async (vins: string[]) =>
      vins.map((v) => cloud.get(v)).filter((r): r is Row => !!r).map((r) => JSON.parse(JSON.stringify(r))),
  }))
  const { useYard } = await import('../src/store/useYard')
  useYard.setState({
    currentUser: 'admin', currentSite: 'site-7-nyb',
    sites: [{ id: 'site-7-nyb', name: 'NYB2 Phase 2' }, { id: 'site-1-3d-lcb', name: '3D LCB' }] as any,
  })
  const { useTracking } = await import('../src/store/useTracking')
  useTracking.setState({ loaded: true, rows: {} })
  const settle = () => new Promise((r) => setTimeout(r, 30))
  return { cloud, upserted, useTracking, settle }
}

const parsed = (rows: Row[]) => ({ rows, gateOutRows: [], headers: [], options: {}, total: rows.length, gatedOut: 0 } as any)

describe('นำเข้า Vin List Inventory ไม่เขียนทับแถวที่มีในคลาวด์', () => {
  afterEach(() => { vi.doUnmock('../src/lib/db'); vi.doUnmock('../src/lib/supabase'); vi.resetModules() })

  const atLcb: Row = {
    vin: 'LC0CE4CB5T4338905', site: 'site-1-3d-lcb', updatedAt: 1000,
    cells: { Vin: 'LC0CE4CB5T4338905', 'Car Status': 'In Yard', 'Location yard': '3D LCB', 'Grouping  Number': 'SJWD261027-001' },
    history: [{ at: 900, by: 'จตุพร', field: 'Location', from: '', to: 'C2203' }],
  }
  const fileRow: Row = {
    vin: 'LC0CE4CB5T4338905',
    cells: { Vin: 'LC0CE4CB5T4338905', 'Car Status': 'Gate-out', 'Location yard': 'NYB2 Phase 2', 'Gate Out time stamp': '2026-10-05' },
  }

  it('รถที่คลาวด์มีแล้ว (อยู่ยาร์ดอื่น) แต่เครื่องไม่มี → คลาวด์ไม่เปลี่ยน · เครื่องรับฉบับคลาวด์', async () => {
    const { cloud, upserted, useTracking, settle } = await setup([atLcb])
    useTracking.getState().commitImport(parsed([fileRow]))
    await settle()
    expect(upserted).not.toContain(atLcb.vin)
    expect(cloud.get(atLcb.vin)).toEqual(atLcb)
    const local = useTracking.getState().rows[atLcb.vin]
    expect(local.site).toBe('site-1-3d-lcb')
    expect(local.cells['Car Status']).toBe('In Yard')
    expect(local.history).toEqual(atLcb.history)
    // ฉบับในเครื่องต้องไม่ใหม่กว่าคลาวด์ ไม่งั้นการซิงก์รอบถัดไปส่งฉบับไฟล์ขึ้นไปทับ
    expect(local.updatedAt).toBe(atLcb.updatedAt)
  })

  it('รถใหม่จริง (คลาวด์ไม่มี) → เพิ่มเข้าคลาวด์ตามไฟล์', async () => {
    const { cloud, useTracking, settle } = await setup([])
    const fresh: Row = { vin: 'LGXCE4CB6TG041525', cells: { Vin: 'LGXCE4CB6TG041525', 'Car Status': 'Pre Gate-in', 'Location yard': 'NYB2 Phase 2' } }
    useTracking.getState().commitImport(parsed([fresh]))
    await settle()
    expect(cloud.get(fresh.vin)?.cells['Car Status']).toBe('Pre Gate-in')
    expect(cloud.get(fresh.vin)?.site).toBe('site-7-nyb')
    expect(useTracking.getState().rows[fresh.vin]?.cells['Car Status']).toBe('Pre Gate-in')
  })

  it('ระหว่างรอคลาวด์ตอบ (ฐานข้อมูลช้า): ฉบับไฟล์ไม่อยู่ในเครื่อง · การแก้คันนั้นไม่ทำให้คลาวด์ถูกทับ', async () => {
    const { cloud, upserted, useTracking } = await setup([atLcb], 80)
    useTracking.getState().commitImport(parsed([fileRow]))
    // ฉบับไฟล์ (NYB2 Gate-out) ต้องไม่ค้างในเครื่อง — ตัวกระทบยอดจะอ่านเป็นรถออกแล้วปลดช่องในผัง
    expect(useTracking.getState().rows[atLcb.vin]).toBeUndefined()
    useTracking.getState().updateCell(atLcb.vin, 'Remark', 'x')
    await new Promise((r) => setTimeout(r, 150))
    expect(upserted).not.toContain(atLcb.vin)
    expect(cloud.get(atLcb.vin)).toEqual(atLcb)
    expect(useTracking.getState().rows[atLcb.vin]?.site).toBe('site-1-3d-lcb')
  })

  it('นำเข้า Co Inspection: รถที่เครื่องไม่มีแต่คลาวด์มี → ไม่ทับ', async () => {
    const { cloud, upserted, useTracking, settle } = await setup([atLcb])
    useTracking.getState().commitCoInspection(parsed([{ vin: atLcb.vin, cells: { Vin: atLcb.vin, 'Location yard': 'NYB2 Phase 2', PDI: '1-Oct-26' } }]))
    await settle()
    expect(upserted).not.toContain(atLcb.vin)
    expect(cloud.get(atLcb.vin)).toEqual(atLcb)
  })

  it('VIN ที่ถูกลบในคลาวด์ (tombstone) → นำเข้าใหม่ได้เหมือนเดิม', async () => {
    const gone: Row = { vin: 'LGXCE4CB4TG041393', site: 'site-7-nyb', updatedAt: 500, deletedAt: 600, cells: { Vin: 'LGXCE4CB4TG041393' } }
    const { cloud, upserted, useTracking, settle } = await setup([gone])
    useTracking.getState().commitImport(parsed([{ vin: gone.vin, cells: { Vin: gone.vin, 'Car Status': 'Pre Gate-in', 'Location yard': 'NYB2 Phase 2' } }]))
    await settle()
    expect(upserted).toContain(gone.vin)
    expect(cloud.get(gone.vin)?.deletedAt).toBeFalsy()
    expect(cloud.get(gone.vin)?.cells['Car Status']).toBe('Pre Gate-in')
  })

  it('ชิปเมนต์หลายยาร์ด (commitPreGateInCandidates) ก็ไม่ทับแถวที่มีในคลาวด์', async () => {
    const { cloud, upserted, useTracking, settle } = await setup([atLcb])
    useTracking.getState().commitPreGateInCandidates([{ vin: atLcb.vin, cells: { Vin: atLcb.vin } }], ['site-7-nyb', 'site-1-3d-lcb'])
    await settle()
    expect(upserted).not.toContain(atLcb.vin)
    expect(cloud.get(atLcb.vin)).toEqual(atLcb)
  })
})
