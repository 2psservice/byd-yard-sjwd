import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 29 ต.ค. 21:15 / 30 ต.ค. 09:24: iPhone ที่สำเนาแถวรอบในเครื่องว่าง เปิดแอป → ตัวแปลงย้อนหลังสร้างแถวรอบ ~1,400 แถว
 * จาก __trips ใหม่หมด แล้ว upsert ทับแถวในคลาวด์ — แถวของรถที่ __trips ถูกนำเข้าทับ 27 ต.ค. เสียข้อมูล (PDI, ผู้รับ Gate-in ฯลฯ)
 * กติกา: แถวรอบที่เครื่องสร้าง เพิ่มได้เฉพาะ id ที่คลาวด์ยังไม่มี · ที่มีแล้ว เครื่องรับฉบับคลาวด์ · การแก้ของแอดมินยังเขียนทับได้
 */
type V = { id: string; vin: string; round: number; site?: string; cells: Record<string, string>; history: any[]; closedAt: number; gateOutAt: number; updatedAt: number }
const visit = (id: string, cells: Record<string, string>, updatedAt: number): V =>
  ({ id, vin: id.split('#')[0], round: Number(id.split('#')[1]), site: 'site-7-nyb', cells, history: [], closedAt: 1, gateOutAt: 1, updatedAt })
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

async function setup(cloudRows: V[], opts: { failInsert?: boolean } = {}) {
  vi.resetModules(); localStorage.clear()
  const cloud = new Map(cloudRows.map((v) => [v.id, clone(v)]))
  const upserted: string[] = []
  const state = { failInsert: !!opts.failInsert }
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/idb', async (orig) => ({
    ...(await orig<object>()),
    idbGetAllVisits: async () => [], idbPutVisits: async () => {}, idbDeleteVisits: async () => {},
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async (vs: V[]) => { for (const v of vs) { upserted.push(v.id); cloud.set(v.id, clone(v)) } return true },
    insertVisitsIfAbsent: async (vs: V[]) => {
      if (state.failInsert) return null
      const ins = new Set<string>()
      for (const v of vs) if (!cloud.has(v.id)) { cloud.set(v.id, clone(v)); ins.add(v.id) }
      return ins
    },
    fetchVisits: async (o: { ids?: string[] } = {}) =>
      [...cloud.values()].filter((v) => !o.ids || o.ids.includes(v.id)).map(clone),
    fetchVisitIds: async () => [...cloud.keys()],
  }))
  const { useVisits } = await import('../src/store/useVisits')
  const settle = () => new Promise((r) => setTimeout(r, 20))
  return { cloud, upserted, useVisits, settle, state }
}

const real = visit('LGXCE4CB5T4338905#1', { PDI: '01-Aug-26', 'Gate In Inspector': 'อัญชลี', 'Gate Out time stamp': '01/10/2026 14:18' }, 1000)
const rebuilt = visit('LGXCE4CB5T4338905#1', { 'Gate Out time stamp': '2026-10-01' }, 5000)

describe('แถวรอบที่เครื่องสร้าง ไม่เขียนทับแถวที่มีในคลาวด์', () => {
  afterEach(() => { vi.doUnmock('../src/lib/db'); vi.doUnmock('../src/lib/idb'); vi.doUnmock('../src/lib/supabase'); vi.resetModules() })

  it('สำเนาในเครื่องว่าง แล้วสร้างแถวที่คลาวด์มีแล้ว → คลาวด์ไม่เปลี่ยน · เครื่องรับฉบับคลาวด์', async () => {
    const { cloud, upserted, useVisits, settle } = await setup([real])
    useVisits.getState().add([clone(rebuilt)])
    await settle()
    expect(upserted).toEqual([])
    expect(cloud.get(real.id)).toEqual(real)
    expect(useVisits.getState().visits[real.id]).toEqual(real)
  })

  it('แถวรอบใหม่จริง → เพิ่มเข้าคลาวด์', async () => {
    const { cloud, useVisits, settle } = await setup([])
    useVisits.getState().add([clone(rebuilt)])
    await settle()
    expect(cloud.get(rebuilt.id)?.cells).toEqual(rebuilt.cells)
  })

  it('ส่งไม่สำเร็จตอนสร้าง → ลองใหม่ตอนโหลดก็ยังไม่ทับ (เครื่องอื่นสร้างไปก่อนแล้ว)', async () => {
    const { cloud, upserted, useVisits, settle, state } = await setup([], { failInsert: true })
    useVisits.getState().add([clone(rebuilt)])
    await settle()
    expect(cloud.has(rebuilt.id)).toBe(false)
    cloud.set(real.id, clone(real)); state.failInsert = false
    await useVisits.getState().load()
    await settle()
    expect(upserted).toEqual([])
    expect(cloud.get(real.id)).toEqual(real)
  })

  it('แอดมินแก้แถวรอบ (bulkUpdate) → ยังเขียนทับคลาวด์ได้', async () => {
    const { cloud, upserted, useVisits, settle } = await setup([real])
    await useVisits.getState().load()
    useVisits.getState().bulkUpdate([real.id], 'Dealer Location', 'NYB2')
    await settle()
    expect(upserted).toEqual([real.id])
    expect(cloud.get(real.id)?.cells['Dealer Location']).toBe('NYB2')
    expect(cloud.get(real.id)?.cells.PDI).toBe('01-Aug-26')
  })
})
