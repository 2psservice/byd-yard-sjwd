import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 18 พ.ย.: คิว "PDI · PDI SEALION 7" (60 RAI) และ "PM · PM" (3D RINCHA) ถูกทุกเครื่องเขียนซ้ำทุก ~15 วิ
 * รถที่ Gate-in แล้วสแกนสถานี "วันเดียวกัน" (…273760 Gate In 19/9 17:01 → PDI 17:03) สลับ done ↔ ไม่ done ไม่จบ:
 * กฎ "ติ๊กจาก Gate-in" ถอดติ๊ก (ไม่มี checkedAt + doneAt วันเดียวกับ Gate-in) → รอบถัดไปปิดใหม่จากบรรทัดสแกนสถานี
 * ทุกเครื่องผลักคิวทั้งก้อนซ้ำไปมา → Save ของหน้างานหมดเวลา ("บันทึกคิวขึ้น cloud ไม่สำเร็จ") มือถือหนักจนแท็บรีโหลด
 * กติกา: รถที่สถานีสแกนจริงไม่ใช่ติ๊กจาก Gate-in — ติ๊กคงอยู่ และไม่ส่งคิวซ้ำ
 */
const at = (h: number, m = 0, d = 19, mo = 8) => new Date(2026, mo, d, h, m).getTime()

async function setup() {
  vi.resetModules(); localStorage.clear()
  const pushes: string[] = []
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    fetchTrackingRows: async () => [], countTrackingRows: async () => 0,
    upsertOpsQueue: async (q: any) => { pushes.push(q.id) },
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [{ id: 'S1', name: '60 RAI', createdAt: 0 }], currentSite: 'S1' } as any)
  return { useTracking, ops, pushes }
}
const VIN = 'LGXCF4CD9T2273760'
const gateIn = { 'Gate In': '19/09/2026', 'Gate In Time': String(at(17, 1)) }
const row = (cells: Record<string, string>, history: object[]) =>
  ({ vin: VIN, site: 'S1', updatedAt: 0, history, cells: { Vin: VIN, 'Car Status': 'In Yard', ...gateIn, ...cells } })
const queue = (item: object) => ({ id: 'Q', name: 'PDI · PDI SEALION 7', createdAt: at(9, 0, 17), site: 'S1', type: 'PDI', items: [{ vin: VIN, addedAt: at(9, 0, 17), ...item }] })
const itemOf = (ops: any) => ops.useOps.getState().queues[0].items[0]

describe('Gate-in กับสแกนสถานีวันเดียวกัน — คิวไม่สลับไปมา', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-18T11:50:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('สแกน PDI 2 นาทีหลัง Gate-in → ติ๊กคงอยู่ทุกรอบ ไม่ส่งคิวซ้ำ', async () => {
    const { useTracking, ops, pushes } = await setup()
    const scan = { at: at(17, 3), by: 'จ๋า', field: 'PDI', from: '', to: '19/09/2026', src: 'scan' }
    useTracking.setState({ loaded: true, rows: { [VIN]: row({ PDI: '19/09/2026' }, [scan]) } } as any)
    ops.useOps.setState({ queues: [queue({ done: true, doneAt: at(17, 3), doneBy: 'จ๋า', stamped: true })] } as any)
    for (let n = 0; n < 3; n++) {
      ops.reconcileGateOuts()
      expect(itemOf(ops)).toMatchObject({ done: true, doneAt: at(17, 3), doneBy: 'จ๋า' })
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(pushes).toEqual([])
  })

  it('ยังไม่ติ๊กแต่มีบรรทัดสแกน → ปิดครั้งเดียวแล้วนิ่ง', async () => {
    const { useTracking, ops, pushes } = await setup()
    const scan = { at: at(17, 3), by: 'จ๋า', field: 'PDI', from: '', to: '19/09/2026', src: 'scan' }
    useTracking.setState({ loaded: true, rows: { [VIN]: row({ PDI: '19/09/2026' }, [scan]) } } as any)
    ops.useOps.setState({ queues: [queue({ done: false })] } as any)
    for (let n = 0; n < 3; n++) ops.reconcileGateOuts()
    expect(itemOf(ops)).toMatchObject({ done: true, doneAt: at(17, 3) })
    await vi.advanceTimersByTimeAsync(5000)
    expect(new Set(pushes).size).toBeLessThanOrEqual(1)
    const before = pushes.length
    ops.reconcileGateOuts()
    await vi.advanceTimersByTimeAsync(5000)
    expect(pushes.length).toBe(before)
  })

  it('ติ๊กจาก Gate-in จริง (ไม่มีบรรทัดสแกนสถานี) → ยังถูกถอดเหมือนเดิม', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { [VIN]: row({ PDI: '19/09/2026' }, []) } } as any)
    ops.useOps.setState({ queues: [queue({ done: true, doneAt: at(17, 2), doneBy: 'จ๋า', stamped: true })] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops)).toMatchObject({ done: false })
    ops.reconcileGateOuts()
    expect(itemOf(ops)).toMatchObject({ done: false })
  })
})
