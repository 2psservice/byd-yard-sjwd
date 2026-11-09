import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PM นับเฉพาะที่หน้างานบันทึก (admin 07/11)
 *  - วันที่ PM ที่มาจากไฟล์ ไม่ปิดงานในคิว PM แล้ว (รถยังรอทำ จนกว่าหน้างานจะสแกน)
 *  - หน้างานสแกนที่สถานี (เครื่องที่ไม่มีคิวนั้น) → ปิดงานด้วยเวลาและชื่อคนสแกน
 *  - รายการที่ระบบเคยปิดจากไฟล์ตั้งแต่ 07/11 เปิดกลับเป็นรอทำ · ก่อนหน้านั้นคงเดิม
 *  - PDI / FINAL ใช้กติกาเดียวกันตั้งแต่ 09/11 (ปิดก่อน 09/11 คงเดิม)
 */

const DAY = new Date(2026, 10, 7).getTime()
const at = (h: number, m = 0, d = 7) => new Date(2026, 10, d, h, m).getTime()

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    upsertVisits: async () => {}, insertVisitsIfAbsent: async (vs: any[]) => new Set(vs.map((v) => v.id)), upsertTrackingRows: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {},
    fetchTrackingRows: async () => [], countTrackingRows: async () => 0, upsertOpsQueue: async () => {},
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  const ops = await import('../src/store/useOps')
  useYard.setState({ sites: [{ id: 'S1', name: '3D LCB', createdAt: 0 }], currentSite: 'S1' } as any)
  return { useTracking, ops }
}
const row = (vin: string, cells: Record<string, string>, history: object[] = []) =>
  ({ vin, site: 'S1', updatedAt: 0, history, cells: { Vin: vin, 'Car Status': 'In Yard', ...cells } })
const item = (vin: string, o: object = {}) => ({ vin, addedAt: at(8, 0, 1), done: false, ...o })
const q = (type: string, items: object[]) => ({ id: type, name: `${type} · PMคงค้าง`, createdAt: at(8, 0, 1), site: 'S1', type, items })
const itemOf = (ops: any, qid: string, vin: string) => ops.useOps.getState().queues.find((x: any) => x.id === qid).items.find((i: any) => i.vin === vin)

describe('คิว PM ปิดจากการบันทึกของหน้างานเท่านั้น', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-07T13:00:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('วันที่ PM จากไฟล์ (ไม่มีการสแกน) ไม่ปิดงาน · รถยังรอทำ', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { V: row('V', { PM1: '26-Sep-26', PM2: '07/11/2026' }) } } as any)
    ops.useOps.setState({ queues: [q('PM', [item('V')])] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'PM', 'V')).toMatchObject({ done: false })
  })

  it('หน้างานสแกนที่สถานี (บันทึกในประวัติรถ) → ปิดงานด้วยเวลาที่สแกนและชื่อคนสแกน', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { V: row('V', { PM1: '07/11/2026' }, [{ at: at(10, 20), by: 'รัชนีกร', field: 'PM1', from: '', to: '07/11/2026', src: 'scan' }]) } } as any)
    ops.useOps.setState({ queues: [q('PM', [item('V')])] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'PM', 'V')).toMatchObject({ done: true, doneAt: at(10, 20), doneBy: 'รัชนีกร' })
  })

  it('รายการที่ระบบเคยปิดจากไฟล์ตั้งแต่ 07/11 เปิดกลับเป็นรอทำ · ปิดก่อน 07/11 คงเดิม', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: {
      NEW: row('NEW', { PM2: '07/11/2026' }),
      OLD: row('OLD', { PM1: '20/10/2026' }),
    } } as any)
    ops.useOps.setState({ queues: [{ ...q('PM', [
      item('NEW', { done: true, doneAt: DAY, doneBy: 'ไฟล์ Co-Inspection', stamped: true }),
      item('OLD', { done: true, doneAt: at(0, 0, -11), doneBy: 'ไฟล์ Co-Inspection', stamped: true, addedAt: at(8, 0, -15) }),
    ]), createdAt: at(8, 0, -15) }] } as any)
    ops.reconcileGateOuts()
    const n = itemOf(ops, 'PM', 'NEW'), o = itemOf(ops, 'PM', 'OLD')
    expect(n).toMatchObject({ done: false })
    expect(n.manualUndoneAt).toBeGreaterThan(0)
    expect(o).toMatchObject({ done: true, doneBy: 'ไฟล์ Co-Inspection' })
    // and it stays open on the next pass (no flip-flop)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'PM', 'NEW')).toMatchObject({ done: false })
  })

  it('PDI / FINAL (09/11): วันที่จากไฟล์ไม่ปิดงาน · สแกนที่สถานีปิดพร้อมเวลาและชื่อ (ช่อง RE PDI ก็นับ)', async () => {
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: {
      F1: row('F1', { PDI: '07/11/2026' }),
      F2: row('F2', { 'Final check date': '07/11/2026' }),
      S1: row('S1', { PDI: '20/10/2026', 'RE PDI  Date #1': '07/11/2026' }, [{ at: at(9, 40), by: 'สมชาย', field: 'RE PDI  Date #1', from: '', to: '07/11/2026', src: 'scan' }]),
      S2: row('S2', { 'Final check date': '07/11/2026' }, [{ at: at(11, 5), by: 'รัชนีกร', field: 'Final check date', from: '07/11/2026', to: '07/11/2026', src: 'scan' }]),
    } } as any)
    ops.useOps.setState({ queues: [q('PDI', [item('F1'), item('S1')]), q('FINAL', [item('F2'), item('S2')])] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'PDI', 'F1')).toMatchObject({ done: false })
    expect(itemOf(ops, 'FINAL', 'F2')).toMatchObject({ done: false })
    expect(itemOf(ops, 'PDI', 'S1')).toMatchObject({ done: true, doneAt: at(9, 40), doneBy: 'สมชาย' })
    expect(itemOf(ops, 'FINAL', 'S2')).toMatchObject({ done: true, doneAt: at(11, 5), doneBy: 'รัชนีกร' })
  })

  it('PDI / FINAL ที่ระบบปิดจากไฟล์ตั้งแต่ 09/11 เปิดกลับ · ปิดก่อน 09/11 คงเดิม', async () => {
    vi.setSystemTime(new Date('2026-11-09T13:00:00+07:00'))
    const { useTracking, ops } = await setup()
    useTracking.setState({ loaded: true, rows: { N: row('N', { PDI: '09/11/2026' }), O: row('O', { 'Final check date': '08/11/2026' }) } } as any)
    const fileDone = (vin: string, d: number) => item(vin, { done: true, doneAt: new Date(2026, 10, d).getTime(), doneBy: 'ไฟล์ Co-Inspection', stamped: true })
    ops.useOps.setState({ queues: [q('PDI', [fileDone('N', 9)]), q('FINAL', [fileDone('O', 8)])] } as any)
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'PDI', 'N')).toMatchObject({ done: false })
    expect(itemOf(ops, 'PDI', 'N').manualUndoneAt).toBeGreaterThan(0)
    expect(itemOf(ops, 'FINAL', 'O')).toMatchObject({ done: true, doneBy: 'ไฟล์ Co-Inspection' })
    ops.reconcileGateOuts()
    expect(itemOf(ops, 'PDI', 'N')).toMatchObject({ done: false })
  })
})
