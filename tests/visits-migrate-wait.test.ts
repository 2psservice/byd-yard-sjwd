import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 31 ต.ค. 08:05: ตัวแปลงย้อนหลัง (__trips → visits) เริ่มทันทีที่แถวรถโหลดเสร็จ ก่อนแถวรอบโหลดเสร็จ
 * → เห็นว่าไม่มีสักแถว สร้างใหม่ ~1,400 แถว ส่งขึ้น/ดึงกลับช่วง "Loading 99%" (ก่อน #655 = เขียนทับคลาวด์)
 * กติกา: รอสำเนาในเครื่อง + คลาวด์รอบแรกครบก่อน แล้วสร้างเฉพาะรอบที่คลาวด์ยังไม่มีจริง
 */
const VIN = 'LGXCE4CB5T4338905'
const row = (rounds: number) => ({
  vin: VIN, site: 'site-7-nyb', history: [],
  cells: { Vin: VIN, __trips: JSON.stringify(Array.from({ length: rounds }, (_, i) => ({ round: i + 1, yard: 'NYB2 Phase 2', closedAt: 1000 + i, cells: {} }))) },
}) as any
const visit = (round: number) => ({ id: `${VIN}#${round}`, vin: VIN, round, site: 'site-7-nyb', cells: { PDI: '01-Aug-26' }, history: [], closedAt: 1, gateOutAt: 1, updatedAt: 1000 })

async function setup(cloudRows: any[]) {
  vi.resetModules(); localStorage.clear()
  const inserted: string[] = []
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
    upsertVisits: async () => true,
    insertVisitsIfAbsent: async (vs: any[]) => { const s = new Set<string>(); for (const v of vs) { inserted.push(v.id); s.add(v.id) } return s },
    fetchVisits: async () => cloudRows.map((v) => ({ ...v })),
    fetchVisitIds: async () => cloudRows.map((v) => v.id),
  }))
  const { useVisits } = await import('../src/store/useVisits')
  return { useVisits, inserted }
}

describe('ตัวแปลงย้อนหลังรอแถวรอบโหลดครบ', () => {
  afterEach(() => { vi.doUnmock('../src/lib/db'); vi.doUnmock('../src/lib/idb'); vi.doUnmock('../src/lib/supabase'); vi.resetModules() })

  it('แถวรอบยังไม่โหลด → ไม่สร้างอะไร ไม่ส่งอะไร', async () => {
    const { useVisits, inserted } = await setup([visit(1), visit(2)])
    expect(useVisits.getState().migrateFromTrips([row(2)], [])).toBe(0)
    await new Promise((r) => setTimeout(r, 20))
    expect(inserted).toEqual([])
    expect(useVisits.getState().visits).toEqual({})
  })

  it('โหลดครบแล้ว และคลาวด์มีทุกรอบ → ไม่สร้างซ้ำ', async () => {
    const { useVisits, inserted } = await setup([visit(1), visit(2)])
    await useVisits.getState().load()
    expect(useVisits.getState().cloudReady).toBe(true)
    expect(useVisits.getState().migrateFromTrips([row(2)], [])).toBe(0)
    expect(inserted).toEqual([])
  })

  it('โหลดครบแล้ว → สร้างเฉพาะรอบที่ขาดจริง', async () => {
    const { useVisits, inserted } = await setup([visit(1)])
    await useVisits.getState().load()
    expect(useVisits.getState().migrateFromTrips([row(2)], [])).toBe(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(inserted).toEqual([`${VIN}#2`])
  })
})
