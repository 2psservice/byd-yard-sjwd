import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World, car } from './helpers/world'

/**
 * importUnits (นำเข้าไฟล์ + ตัวซ่อมรุ่น/สีใน App.tsx ที่วนทุก 60 วิบนทุกเครื่อง) ห้ามเขียนสถานะ/ยาร์ดจากสำเนาในเครื่องทับคลาวด์
 * เคสจริง 10 ต.ค. 12:42: รถ NYB2 1,066 คันถูกเขียนในวินาทีเดียว รถที่ออกไปแล้วกลับเป็น EXPECTED
 */
describe('importUnits ส่งแค่ข้อมูลรถจากไฟล์ให้รถที่มีอยู่แล้ว', () => {
  let world: World
  beforeEach(() => { vi.useFakeTimers(); world = new World() })
  afterEach(() => { vi.useRealTimers() })

  it('สำเนาในเครื่องค้าง (EXPECTED) ไม่ทับสถานะคลาวด์ (DEPARTED) แต่รุ่น/สียังอัปเดต', async () => {
    world.seedCloud(car('V1', 'B', 13, 1, { status: 'DEPARTED', block: undefined, row: undefined, slot: undefined, color: 'White' }))
    const d = await world.createDevice('phone')
    d.yard.setState({ currentSite: 'S1', units: { V1: car('V1', 'B', 13, 1, { status: 'EXPECTED', block: undefined, row: undefined, slot: undefined, color: 'White' }) } })
    d.yard.getState().importUnits([{ vin: 'V1', model: 'SEAL 5', color: 'Red' }])
    await world.advance(10)
    const c = world.cloud.get('V1')!
    expect(c.status).toBe('DEPARTED')
    expect(c.color).toBe('Red')
  })

  it('รถจอดอยู่ในคลาวด์ + สำเนาเครื่องเก่าไม่มีช่อง → ตำแหน่งและสถานะในคลาวด์คงเดิม', async () => {
    world.seedCloud(car('V2', 'B', 13, 1, { status: 'PARKED' }))
    const d = await world.createDevice('phone')
    d.yard.setState({ currentSite: 'S1', units: { V2: car('V2', 'B', 13, 1, { status: 'EXPECTED', block: undefined, row: undefined, slot: undefined }) } })
    d.yard.getState().importUnits([{ vin: 'V2', model: 'ATTO 1', color: 'Blue' }])
    await world.advance(10)
    const c = world.cloud.get('V2')!
    expect(c.status).toBe('PARKED')
    expect([c.block, c.slot, c.row]).toEqual(['B', 13, 1])
    expect(c.site).toBe('S1')
  })

  it('รถใหม่ (ไม่มีในเครื่อง) ยังถูกสร้างเป็น EXPECTED ที่ยาร์ดปัจจุบัน', async () => {
    const d = await world.createDevice('admin')
    d.yard.setState({ currentSite: 'S1', units: {} })
    d.yard.getState().importUnits([{ vin: 'V3', model: 'ATTO 1', color: 'Green' }])
    await world.advance(10)
    const c = world.cloud.get('V3')!
    expect(c.status).toBe('EXPECTED')
    expect(c.site).toBe('S1')
  })

  it('รถที่มีในเครื่องแต่ยังไม่มียาร์ด → ได้ยาร์ดปัจจุบัน (ทางเดิมที่ส่งทั้งแถว)', async () => {
    world.seedCloud(car('V4', 'B', 1, 1, { status: 'EXPECTED', site: undefined, block: undefined, row: undefined, slot: undefined }))
    const d = await world.createDevice('admin')
    d.yard.setState({ currentSite: 'S1', units: { V4: car('V4', 'B', 1, 1, { status: 'EXPECTED', site: undefined, block: undefined, row: undefined, slot: undefined }) } })
    d.yard.getState().importUnits([{ vin: 'V4', model: 'ATTO 1', color: 'Green' }])
    await world.advance(10)
    expect(world.cloud.get('V4')!.site).toBe('S1')
  })
})

/** db.patchUnitsCatalog: UPDATE (ไม่ upsert) ลงตารางของโหมดปัจจุบัน — หลังสลับโหมด units ถูกปิดการแก้ */
describe('patchUnitsCatalog', () => {
  async function load(mode: 'units' | 'yard_units') {
    const calls: { table: string; op: string; fields?: unknown; vins?: string[]; site?: string }[] = []
    vi.resetModules()
    vi.doUnmock('../src/lib/db') // ชุดก่อนหน้า (World) จำลอง db ไว้ — ต้องใช้ตัวจริง
    vi.doMock('../src/lib/supabase', () => ({
      isConfigured: () => true,
      supabase: {
        from: (table: string) => ({
          update: (fields: unknown) => {
            const c: (typeof calls)[number] = { table, op: 'update', fields }
            calls.push(c)
            const b: any = {
              in: (_k: string, v: string[]) => { c.vins = v; return b },
              eq: (k: string, v: string) => { if (k === 'site_id') c.site = v; return b },
              then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
            }
            return b
          },
          upsert: () => { calls.push({ table, op: 'upsert' }); return Promise.resolve({ error: null }) },
        }),
      },
    }))
    const db = await import('../src/lib/db')
    db.setUnitsMode(mode)
    db.setUnitsSite('S1')
    return { db, calls }
  }

  it('โหมดเดิม: update ตาราง units · คันที่ค่าเหมือนกันรวมเป็นคำสั่งเดียว · ไม่มี upsert', async () => {
    const { db, calls } = await load('units')
    await db.patchUnitsCatalog([
      { vin: 'A', site: 'S1', fields: { model: 'ATTO1', model_name: 'ATTO 1', color: 'Blue' } },
      { vin: 'B', site: 'S1', fields: { model: 'ATTO1', model_name: 'ATTO 1', color: 'Blue' } },
      { vin: 'C', site: 'S1', fields: { model: 'ATTO1', model_name: 'ATTO 1', color: 'Red' } },
    ])
    expect(calls.every((c) => c.op === 'update' && c.table === 'units')).toBe(true)
    expect(calls.map((c) => c.vins)).toEqual([['A', 'B'], ['C']])
    expect(calls[0].site).toBeUndefined()
  })

  it('โหมด yard_units: update yard_units เฉพาะแถวของยาร์ดนั้น', async () => {
    const { db, calls } = await load('yard_units')
    await db.patchUnitsCatalog([{ vin: 'A', site: 'S2', fields: { model: 'X', model_name: 'X' } }])
    expect(calls).toEqual([{ table: 'yard_units', op: 'update', fields: { model: 'X', model_name: 'X' }, vins: ['A'], site: 'S2' }])
  })
})
