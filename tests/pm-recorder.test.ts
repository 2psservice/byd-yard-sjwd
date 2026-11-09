import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildList, FILE_CLOSED_BY, type ReportCtx } from '../src/lib/opsReport'

/**
 * หน้า PM: วันที่ + เวลาทุกครั้งที่สแกนที่สถานี และคอลัมน์ผู้บันทึก (07/11 3D LCB)
 *  - รถที่ไฟล์นำเข้าลงวันที่ PM ไว้ก่อน (ระบบปิดคิวให้จากวันที่ในไฟล์ ไม่มีเวลา) แล้ววันนี้มาสแกนที่สถานี
 *    เดิมสถานีเห็นว่าช่อง PM มีวันที่วันนี้อยู่แล้ว เลยไม่บันทึกอะไร → ไม่มีเวลา ไม่มีชื่อ
 *  - ตอนนี้การสแกนลงประวัติรถพร้อมเวลาและคนสแกนเสมอ · รายชื่อมีคอลัมน์ผู้บันทึก
 */

const at = (h: number, m = 0, d = 7) => new Date(2026, 10, d, h, m).getTime()
const midnight = at(0)
const row = (vin: string, cells: Record<string, string>, history: object[] = []) => ({
  vin, site: 'S1', updatedAt: 0, history,
  cells: { Vin: vin, Model: 'M6', 'Model name': 'M6 EXTENDED (6-SEATS)', Color: 'GREY', ...cells },
})
const scan = (field: string, h: number, m: number, by: string, to = '07/11/2026') => ({ at: at(h, m), by, field, from: to, to, src: 'scan' })

function ctx(): ReportCtx {
  return {
    rows: [
      row('A', { PM1: '07/11/2026' }),
      row('B', { PM1: '26-Sep-26', PM2: '07/11/2026' }, [scan('PM2', 10, 20, 'รัชนีกร')]), // file date first, scanned later
      row('D', { PM1: '26-Sep-26', PM2: '07/11/2026' }),                                   // file date, never scanned
      row('E', { PM1: '07/11/2026' }),                                                     // office tick on the queue page
      row('F', { PM1: '10/10/2026', PM2: '07/11/2026' }, [{ at: at(9, 40), by: 'สมชาย', field: 'PM2', from: '', to: '07/11/2026', src: 'scan' }]),
      row('G', { PM1: '07/11/2026' }),                                                     // file date, no queue item today
    ] as any,
    units: [],
    queues: [{ id: 'Q', name: 'PM · PMคงค้าง', createdAt: at(8, 0, 1), type: 'PM', items: [
      { vin: 'A', addedAt: 1, done: true, doneAt: at(9, 5), checkedAt: at(9, 5), checkedBy: 'รัชนีกร', result: 'OK', stage: 'checked' },
      { vin: 'B', addedAt: 1, done: true, doneAt: midnight, doneBy: 'ไฟล์ Co-Inspection', stamped: true },
      { vin: 'D', addedAt: 1, done: true, doneAt: midnight, doneBy: 'ไฟล์ Co-Inspection', stamped: true },
      { vin: 'E', addedAt: 1, done: true, doneAt: at(11, 0), doneBy: 'admin', stamped: true },
      // closed on an earlier day; scanned at the station again today with no open item
      { vin: 'F', addedAt: 1, done: true, doneAt: at(9, 0, 2), checkedAt: at(9, 0, 2), checkedBy: 'สมชาย', stamped: true },
    ] }] as any,
    day: '2026-11-07',
    siteLabel: '3D LCB',
  }
}

describe('รายชื่อ PM: วันที่ + เวลา และผู้บันทึก', () => {
  it('สแกนที่สถานี = วันที่และเวลาที่สแกน + ชื่อคนสแกน · ปิดจากไฟล์อย่างเดียว ไม่นับเป็นงาน PM', () => {
    const got = Object.fromEntries(buildList(ctx(), 'pm').map((r) => [r.vin, [r.date, r.period, r.by]]))
    expect(got).toEqual({
      A: ['07/11/2026 09:05', 'P1', 'รัชนีกร'],
      B: ['07/11/2026 10:20', 'P2', 'รัชนีกร'],
      E: ['07/11/2026 11:00', 'P2', 'admin'], // ticked done in the queue by admin at 11:00
      F: ['07/11/2026 09:40', 'P1', 'สมชาย'],
    })
  })

  it('PDI ยังแสดงคันที่ปิดจากไฟล์ พร้อมป้าย "จากไฟล์ · ไม่ได้สแกน" (กติกาใหม่ใช้กับ PM เท่านั้น)', () => {
    const c = ctx()
    c.queues = [{ ...c.queues[0], name: 'PDI 7 NOV', type: 'PDI' }] as any
    c.rows = c.rows.map((r: any) => (r.vin === 'D' ? { ...r, cells: { ...r.cells, PDI: '07/11/2026' } } : r)) as any
    expect(buildList(c, 'pdi').find((r) => r.vin === 'D')?.by).toBe(FILE_CLOSED_BY)
  })

  it('เรียงเวลาล่าสุดอยู่บนสุด · คันที่ไม่มีเวลาอยู่ท้าย', () => {
    const list = buildList(ctx(), 'pm')
    expect(list.map((r) => r.vin)).toEqual(['E', 'B', 'F', 'A'])
    expect(list.map((r) => r.no)).toEqual([4, 3, 2, 1]) // newest on top carries the total, the bottom row is 1
  })

  it('รถที่สแกนวันนี้แต่คิวปิดไปตั้งแต่วันก่อน ยังขึ้นในรายชื่อพร้อมชื่อคิว · วันที่ PM จากไฟล์ที่ไม่มีใครสแกนและไม่มีคิววันนี้ ไม่นับ', () => {
    const list = buildList(ctx(), 'pm')
    expect(list.find((r) => r.vin === 'F')?.lot).toBe('PM · PMคงค้าง')
    expect(list.some((r) => r.vin === 'G')).toBe(false)
  })
})

describe('สถานีบันทึก: ช่องมีวันที่วันนี้อยู่แล้ว (ไฟล์ลงไว้ก่อน) ก็ยังจดการสแกนพร้อมเวลาและคนสแกน', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-07T10:20:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  async function setup(cells: Record<string, string>) {
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
    useYard.setState({ currentUser: 'รัชนีกร', currentSite: 'S1', sites: [{ id: 'S1', name: '3D LCB', createdAt: 0 }] } as any)
    useTracking.setState({ loaded: true, rows: { V: { vin: 'V', site: 'S1', updatedAt: 0, history: [], cells: { Vin: 'V', ...cells } } } } as any)
    return { useTracking, ops }
  }

  it('PM: ช่องล่าสุดเป็นวันนี้ (รูปแบบไฟล์ 7-Nov-26) → ไม่เปลืองช่องใหม่ แต่จดการสแกน 10:20 โดยรัชนีกร', async () => {
    const { useTracking, ops } = await setup({ PM1: '26-Sep-26', PM2: '7-Nov-26' })
    expect(ops.stampStationDate('V', 'PM')).toBe(false)
    const r = useTracking.getState().rows.V
    expect(r.cells.PM3 ?? '').toBe('')
    expect(r.history!.at(-1)).toMatchObject({ field: 'PM2', from: '7-Nov-26', to: '7-Nov-26', by: 'รัชนีกร', src: 'scan', at: Date.now() })
  })

  it('PM วันใหม่: ลงช่องถัดไปเหมือนเดิม · FINAL ที่มีวันที่วันนี้แล้ว ก็จดการสแกน', async () => {
    const a = await setup({ PM1: '10/10/2026' })
    expect(a.ops.stampStationDate('V', 'PM')).toBe(true)
    expect(a.useTracking.getState().rows.V.cells.PM2).toBe('07/11/2026')
    const b = await setup({ 'Final check date': '07/11/2026' })
    b.ops.stampStationDate('V', 'FINAL')
    expect(b.useTracking.getState().rows.V.history!.at(-1)).toMatchObject({ field: 'Final check date', src: 'scan', by: 'รัชนีกร' })
  })

  it('ย้อนบันทึกงานเก่า (repair) ไม่นับเป็นการสแกนใหม่', async () => {
    const { useTracking, ops } = await setup({ PM1: '07/11/2026' })
    ops.stampStationDate('V', 'PM', Date.now())
    expect(useTracking.getState().rows.V.history ?? []).toHaveLength(0)
  })
})
