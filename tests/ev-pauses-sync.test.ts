import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * EV หยุดพัก ข้ามเครื่อง (28 ต.ค.: รถที่หยุดพักขึ้นว่ากำลังชาร์จบนมือถืออีกเครื่อง เวลานับไป 25 ชม.)
 * ตาราง ev_charges ที่ยังไม่มีคอลัมน์ pauses ส่งการหยุดพักไปเครื่องอื่นไม่ได้ — ทุกเครื่องต้องรู้และเตือน
 * ไม่ใช่แค่เครื่องที่กดหยุดพัก
 */

const row = (withPauses: boolean) => ({
  id: 'V1#1', site_id: 'S1', vin: 'V1', model: 'M6', before_pct: 30, before_at: '2026-10-27T03:00:00Z', after_at: null,
  updated_at: '2026-10-27T05:00:00Z', ...(withPauses ? { pauses: [{ at: Date.parse('2026-10-27T05:00:00Z'), by: 'A' }] } : {}),
})

function fakeSupabase(rows: () => object[]) {
  const q: any = {
    select: () => q, eq: () => q, gte: () => q, is: () => q, order: () => q,
    range: async () => ({ data: rows(), error: null }),
  }
  return { isConfigured: () => true, supabase: { from: () => q, channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} } }
}

describe('EV: ตารางไม่มีคอลัมน์ pauses → ทุกเครื่องเตือน', () => {
  afterEach(() => { vi.doUnmock('../src/lib/supabase'); vi.resetModules() })

  it('ดึงรอบชาร์จแล้วแถวไม่มีช่อง pauses → pausesMissing · เพิ่มคอลัมน์แล้ว → หายเอง และเห็นการหยุดพักของเครื่องอื่น', async () => {
    vi.resetModules(); localStorage.clear()
    let withPauses = false
    vi.doMock('../src/lib/supabase', () => fakeSupabase(() => [row(withPauses)]))
    const { useEvCharging } = await import('../src/store/useEvCharging')
    const { openPause } = await import('../src/lib/evCharging')
    await useEvCharging.getState().load('S1', 0)
    expect(useEvCharging.getState().pausesMissing).toBe(true)
    expect(openPause(useEvCharging.getState().charges['V1#1'])).toBeUndefined()

    withPauses = true // admin ran supabase-ev-charging.sql
    await useEvCharging.getState().load('S1', 0)
    expect(useEvCharging.getState().pausesMissing).toBe(false)
    expect(openPause(useEvCharging.getState().charges['V1#1'])?.by).toBe('A')
  })
})
