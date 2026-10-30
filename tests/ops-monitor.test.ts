import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** มอนิเตอร์หน้างาน (หน้า Operation): สถานะงานจากสิ่งที่หน้างานกดบันทึก · ค้างเกิน 4 ชม. · พนักงานวันนี้ */

const H = 3_600_000
const at = (h: number, m = 0) => new Date(2026, 9, 30, h, m).getTime()
const DAY = at(0)
const NOW = at(15)

async function load() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({ ...(await orig<object>()), isConfigured: () => true, upsertQueue: async () => {}, saveQueue: async () => {} }))
  return import('../src/lib/opsMonitor')
}

const q = (id: string, type: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  ({ id, name: `${type} · Lot 1`, createdAt: at(7), site: 'S1', type, items: items.map((i) => ({ addedAt: at(7), done: false, ...i })), ...extra }) as any

describe('มอนิเตอร์หน้างาน', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('สถานะตามขั้นที่หน้างานกด', async () => {
    const m = await load()
    expect(m.jobStatus({ vin: 'A', addedAt: 1, done: false } as any)).toBe('queued')
    expect(m.jobStatus({ vin: 'A', addedAt: 1, done: false, drivingBy: 'สมชาย', drivingAt: at(14) } as any)).toBe('driving-in')
    expect(m.jobStatus({ vin: 'A', addedAt: 1, done: false, stage: 'at-station', deliveredBy: 'สมชาย', deliveredAt: at(14) } as any)).toBe('at-station')
    expect(m.jobStatus({ vin: 'A', addedAt: 1, done: false, stage: 'checked', result: 'OK' } as any)).toBe('checked')
    expect(m.jobStatus({ vin: 'A', addedAt: 1, done: false, stage: 'checked', drivingBy: 'สมชาย', drivingAt: at(14) } as any)).toBe('driving-back')
    expect(m.jobStatus({ vin: 'A', addedAt: 1, done: true, returnedAt: at(14) } as any)).toBe('done')
    // ขับค้างเกิน 4 ชม. = ลืมกด ไม่นับว่ากำลังขับ (กติกาเดิมของ drivingNow)
    expect(m.jobStatus({ vin: 'A', addedAt: 1, done: false, drivingBy: 'สมชาย', drivingAt: at(10) } as any)).toBe('queued')
  })

  it('ค้างเกิน 4 ชม. เฉพาะงานที่อยู่ระหว่างขั้นตอน · รถที่รอย้ายตามแผนไม่นับค้าง', async () => {
    const m = await load()
    expect(m.isStuck('at-station', NOW - 4 * H - 60_000, NOW)).toBe(true)
    expect(m.isStuck('at-station', NOW - 4 * H + 60_000, NOW)).toBe(false)
    expect(m.isStuck('checked', NOW - 5 * H, NOW)).toBe(true)
    expect(m.isStuck('queued', NOW - 8 * H, NOW)).toBe(false)
    expect(m.isStuck('done', NOW - 8 * H, NOW)).toBe(false)
  })

  it('รายการงาน: กำลังทำ (ค้างนานสุดก่อน) · รอย้าย · เสร็จวันนี้ · ไม่เอาที่เสร็จเมื่อวาน หรือคิวที่ปิดไปแล้ว', async () => {
    const m = await load()
    const queues = [
      q('PM1', 'PM', [
        { vin: 'Q1' },
        { vin: 'AT', stage: 'at-station', deliveredBy: 'สมชาย', deliveredAt: at(10), fromSlot: 'A02.3' },
        { vin: 'CK', stage: 'checked', result: 'NG', checkedBy: 'นิด', checkedAt: at(14) },
        { vin: 'DN', done: true, doneAt: at(13), returnedBy: 'สมชาย', returnedAt: at(13) },
        { vin: 'OLD', done: true, doneAt: at(13) - 24 * H, returnedAt: at(13) - 24 * H },
      ]),
      q('PDI1', 'PDI', [{ vin: 'DR', drivingBy: 'แดง', drivingAt: at(14, 30) }]),
      q('X', 'PDI', [{ vin: 'CLOSED_OPEN' }, { vin: 'CLOSED_DONE', done: true, doneAt: at(9), returnedAt: at(9) }]),
    ]
    const jobs = m.monitorJobs(queues, { X: { at: at(9) } }, DAY, NOW)
    expect(jobs.map((j) => `${j.item.vin}:${j.status}`)).toEqual([
      'AT:at-station', 'CK:checked', 'DR:driving-in', 'Q1:queued', 'DN:done', 'CLOSED_DONE:done',
    ])
    const at10 = jobs[0]
    expect(at10).toMatchObject({ stuck: true, by: 'สมชาย', since: at(10), type: 'PM' })
    expect(jobs.find((j) => j.item.vin === 'CK')).toMatchObject({ stuck: false, by: 'นิด' })
  })

  it('พนักงาน: คนที่กำลังขับขึ้นก่อน · งานวันนี้จากชื่อที่แต่ละขั้นบันทึก · ติ๊กจากหน้าแอดมินไม่นับ', async () => {
    const m = await load()
    const queues = [
      q('PM1', 'PM', [
        { vin: 'V1', stage: 'checked', result: 'OK', deliveredBy: 'สมชาย', deliveredAt: at(9), fromSlot: 'A02.3', checkedBy: 'นิด', checkedAt: at(10) },
        { vin: 'V2', done: true, doneBy: 'admin', doneAt: at(11) },
        { vin: 'V3', done: true, deliveredBy: 'สมชาย', deliveredAt: at(8) - 24 * H, returnedBy: 'สมชาย', returnedAt: at(12) },
      ]),
      q('PDI1', 'PDI', [{ vin: 'V4', drivingBy: 'แดง', drivingAt: at(14, 50) }]),
    ]
    const jobs = m.monitorJobs(queues, {}, DAY, NOW)
    const cards = m.staffCards(queues, jobs, DAY)
    expect(cards.map((c) => c.name)).toEqual(['แดง', 'สมชาย', 'นิด'])
    expect(cards[0].driving?.item.vin).toBe('V4')
    expect(cards[1].events.map((e) => e.text)).toEqual(['จอดกลับหลัง PM', 'ส่งเข้า PM จาก A02.3'])
    expect(cards[2].events.map((e) => e.text)).toEqual(['ตรวจ PM OK'])
    expect(cards.some((c) => c.name === 'admin')).toBe(false)
  })

  it('เวลาที่ผ่านไป', async () => {
    const m = await load()
    expect(m.fmtElapsed(12 * 60_000)).toBe('12 นาที')
    expect(m.fmtElapsed(65 * 60_000)).toBe('1:05 ชม.')
  })
})
