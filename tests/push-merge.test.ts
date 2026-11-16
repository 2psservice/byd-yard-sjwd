import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeWithCloud } from '../src/lib/rowMerge'
import type { TrackRow } from '../src/lib/excelTracking'

/**
 * 14 พ.ย. 20:29: เครื่องที่ข้อมูลเก่า 33 ชม. ยิง Gate-out …039603 ก่อนซิงก์เสร็จ — การส่งเขียนทั้งแถว
 * เลข Grouping / Dealer / DN Printed (ใส่ 12:49–13:24) หายพร้อมประวัติ → DN 7 คัน จอ Gate-out ขึ้น 6
 * กติกา: ก่อนส่งรวมกับฉบับคลาวด์ — ของที่คนอื่นเขียนต้องอยู่ · การแก้ของเครื่องนี้ต้องขึ้น
 */
const VIN = 'LGXCE4CB1TG039603'
const keyOf = (f: string) => (f === 'Grouping' ? 'Grouping  Number' : f)
const H = (at: number, field: string, from: string, to: string, by: string) => ({ at, field, from, to, by })

const base = H(100, 'Location', 'C0211', 'A1502', 'รัชนีกร')
const cloudRow: TrackRow = {
  vin: VIN, site: 'site-5-3d-thungkrat', updatedAt: 3000,
  cells: { Vin: VIN, 'Car Status': 'In Yard', 'Grouping  Number': 'SJWD261113-015', 'Dealer Location': 'Jinlong', 'DN Printed': 'SJWD261113-015 · 14/11/26 13:24' },
  history: [base, H(1000, 'Grouping', '', 'SJWD261113-015', 'Aim'), H(1001, 'Dealer Location', '', 'Jinlong', 'Aim'), H(2000, 'DN Printed', '', 'SJWD261113-015 · 14/11/26 13:24', 'Kwanchai')],
}
// เครื่องเก่า: ยังไม่เห็นเลข แล้วยิง Gate-out
const staleEdited: TrackRow = {
  vin: VIN, site: 'site-5-3d-thungkrat', updatedAt: 5000,
  cells: { Vin: VIN, 'Car Status': 'Pre Gate-out', 'Dealer Location': '', 'Gate Out time stamp': '14/11/2026 20:29' },
  history: [base, H(5000, 'Car Status', 'In Yard', 'Pre Gate-out', 'นัฐกานต์'), H(5000, 'Gate Out time stamp', '', '14/11/2026 20:29', 'นัฐกานต์')],
}

describe('mergeWithCloud', () => {
  it('เคส 039603: เลข Grouping / Dealer / DN Printed ของคนอื่นยังอยู่ · Gate-out ของเครื่องนี้ขึ้น', () => {
    const m = mergeWithCloud(staleEdited, cloudRow, keyOf)
    expect(m.cells['Grouping  Number']).toBe('SJWD261113-015')
    expect(m.cells['Dealer Location']).toBe('Jinlong')
    expect(m.cells['DN Printed']).toBe('SJWD261113-015 · 14/11/26 13:24')
    expect(m.cells['Car Status']).toBe('Pre Gate-out')
    expect(m.cells['Gate Out time stamp']).toBe('14/11/2026 20:29')
    expect(m.history!.map((e) => e.at)).toEqual([100, 1000, 1001, 2000, 5000, 5000])
    expect(m.updatedAt).toBe(5000)
  })
  it('ช่องเดียวกันแก้ทั้งสองฝั่ง → บรรทัดใหม่กว่าชนะ', () => {
    const local: TrackRow = { ...staleEdited, cells: { ...staleEdited.cells, 'Dealer Location': 'NYB2' }, history: [...staleEdited.history!, H(4000, 'Dealer Location', '', 'NYB2', 'me')] }
    expect(mergeWithCloud(local, cloudRow, keyOf).cells['Dealer Location']).toBe('NYB2') // 4000 > 1001
    const older: TrackRow = { ...local, history: [base, H(500, 'Dealer Location', '', 'NYB2', 'me')] }
    expect(mergeWithCloud(older, cloudRow, keyOf).cells['Dealer Location']).toBe('Jinlong') // 1001 > 500
  })
  it('คลาวด์ลบช่องไปแล้ว (บรรทัดใหม่กว่า) → ช่องหายด้วย', () => {
    const cloud: TrackRow = { ...cloudRow, cells: { Vin: VIN }, history: [base, H(1500, 'Grouping', 'X', '', 'admin')] }
    const local: TrackRow = { ...staleEdited, cells: { ...staleEdited.cells, 'Grouping  Number': 'X' }, history: [base, H(900, 'Grouping', '', 'X', 'a')] }
    expect(mergeWithCloud(local, cloud, keyOf).cells['Grouping  Number']).toBeUndefined()
  })
  it('คลาวด์ไม่มีอะไรใหม่ / ไม่มีแถว / ถูกลบ → แถวเดิม', () => {
    const same: TrackRow = { ...cloudRow, history: [base] }
    expect(mergeWithCloud(staleEdited, same, keyOf)).toBe(staleEdited)
    expect(mergeWithCloud(staleEdited, undefined, keyOf)).toBe(staleEdited)
    expect(mergeWithCloud(staleEdited, { ...cloudRow, deletedAt: 1 }, keyOf)).toBe(staleEdited)
  })
  it('ฉบับรวมใหม่กว่าคลาวด์เสมอ (เครื่องอื่นจะรับ) · ประวัติไม่เกินที่เก็บ', () => {
    const m = mergeWithCloud({ ...staleEdited, updatedAt: 10 }, cloudRow, keyOf, 3)
    expect(m.updatedAt).toBe(3001)
    expect(m.history).toHaveLength(3)
  })
})

describe('pushRows รวมกับคลาวด์ก่อนส่ง', () => {
  afterEach(() => { vi.doUnmock('../src/lib/db'); vi.doUnmock('../src/lib/supabase'); vi.resetModules() })

  async function setup(failFetch = false) {
    vi.resetModules(); localStorage.clear()
    const cloud = new Map<string, TrackRow>([[VIN, JSON.parse(JSON.stringify(cloudRow))]])
    vi.doMock('../src/lib/supabase', () => ({
      isConfigured: () => true,
      supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
    }))
    vi.doMock('../src/lib/db', async (orig) => ({
      ...(await orig<object>()), isConfigured: () => true,
      upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), bulkUpsert: async () => {}, deleteTrackingRows: async () => {}, upsertStationChecks: async () => {},
      upsertTrackingRows: async (rows: TrackRow[]) => { for (const r of rows) cloud.set(r.vin, JSON.parse(JSON.stringify(r))) },
      fetchTrackingRowsByVins: async (vins: string[]) => {
        if (failFetch) throw new Error('network down')
        return vins.map((v) => cloud.get(v)).filter((r): r is TrackRow => !!r).map((r) => JSON.parse(JSON.stringify(r)))
      },
    }))
    const { useYard } = await import('../src/store/useYard')
    useYard.setState({ currentUser: 'นัฐกานต์', currentSite: 'site-5-3d-thungkrat', sites: [{ id: 'site-5-3d-thungkrat', name: '3D THUNGKRAT' }] as any })
    const { useTracking } = await import('../src/store/useTracking')
    // เครื่องเก่า: ยังไม่เห็นเลข Grouping
    const stale: TrackRow = { vin: VIN, site: 'site-5-3d-thungkrat', updatedAt: 50, cells: { Vin: VIN, 'Car Status': 'In Yard' }, history: [base] }
    useTracking.setState({ loaded: true, rows: { [VIN]: stale } })
    return { cloud, useTracking, settle: () => new Promise((r) => setTimeout(r, 30)) }
  }

  it('เครื่องเก่ายิง Gate-out → คลาวด์ยังมีเลข Grouping / DN Printed + ประวัติ · เครื่องได้ฉบับรวม', async () => {
    const { cloud, useTracking, settle } = await setup()
    useTracking.getState().updateCell(VIN, 'Car Status', 'Pre Gate-out', 'scan')
    await settle()
    const c = cloud.get(VIN)!
    expect(c.cells['Car Status']).toBe('Pre Gate-out')
    expect(c.cells['Grouping  Number']).toBe('SJWD261113-015')
    expect(c.cells['DN Printed']).toBe('SJWD261113-015 · 14/11/26 13:24')
    expect(c.history!.some((e) => e.by === 'Aim')).toBe(true)
    expect(c.history!.some((e) => e.to === 'Pre Gate-out')).toBe(true)
    expect(useTracking.getState().rows[VIN].cells['Grouping  Number']).toBe('SJWD261113-015')
  })

  it('ดึงคลาวด์ไม่ได้ → ส่งแบบเดิม (ไม่ขวางงาน)', async () => {
    const { cloud, useTracking, settle } = await setup(true)
    useTracking.getState().updateCell(VIN, 'Car Status', 'Pre Gate-out', 'scan')
    await settle()
    expect(cloud.get(VIN)!.cells['Car Status']).toBe('Pre Gate-out')
  })
})
