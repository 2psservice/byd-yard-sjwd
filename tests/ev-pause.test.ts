import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chargeMs, dailySummary, evCellText, evChargeId, isPaused, openPause, pausedMs, pauseCharge, resumeCharge, type EvCharge,
} from '../src/lib/evCharging'

/** EV Charging: ปุ่มหยุดพัก / เริ่มชาร์จต่อ — ช่วงพักไม่นับเป็นเวลาชาร์จ · ตารางที่ยังไม่มีคอลัมน์ pauses ไม่ทำให้รอบหาย */

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
const HOUR = 3_600_000
function ev(vin: string, before: number, after = 0): EvCharge {
  return {
    id: evChargeId(vin, before), vin, model: 'M6', color: 'BLACK', from: 'C0', remark: '',
    vinPhoto: 'v', beforePhoto: 'b', beforePct: 20, beforeAt: before, beforeBy: 'A',
    afterPhoto: after ? 'a' : '', afterPct: after ? 80 : null, afterAt: after, afterBy: after ? 'B' : '', updatedAt: after || before,
  }
}

describe('หยุดพัก / เริ่มชาร์จต่อ', () => {
  it('ระหว่างพัก เวลาชาร์จไม่เดิน · ชาร์จต่อแล้วเดินต่อจากเดิม', () => {
    let c = ev('V1', at(25, 8))
    expect(chargeMs(c, at(25, 10))).toBe(2 * HOUR)
    c = pauseCharge(c, 'สมชาย', at(25, 10))
    expect(isPaused(c)).toBe(true)
    expect(openPause(c)).toMatchObject({ at: at(25, 10), by: 'สมชาย' })
    expect(chargeMs(c, at(25, 11, 30))).toBe(2 * HOUR) // frozen while paused
    expect(pausedMs(c, at(25, 11, 30))).toBe(1.5 * HOUR)
    c = resumeCharge(c, 'สมหญิง', at(25, 11, 30))
    expect(isPaused(c)).toBe(false)
    expect(c.pauses).toEqual([{ at: at(25, 10), by: 'สมชาย', until: at(25, 11, 30), untilBy: 'สมหญิง' }])
    expect(chargeMs(c, at(25, 12, 30))).toBe(3 * HOUR)
  })

  it('กดซ้ำไม่สร้างช่วงซ้อน · รอบที่จบแล้วกดหยุดพักไม่ได้ · ชาร์จต่อตอนไม่ได้พักไม่เปลี่ยน', () => {
    const c = pauseCharge(ev('V1', at(25, 8)), 'A', at(25, 9))
    expect(pauseCharge(c, 'B', at(25, 9, 30))).toBe(c)
    expect(resumeCharge(ev('V2', at(25, 8)), 'A', at(25, 9)).pauses).toBeUndefined()
    const done = ev('V3', at(25, 8), at(25, 12))
    expect(pauseCharge(done, 'A', at(25, 13))).toBe(done)
  })

  it('บันทึกหลังชาร์จระหว่างพัก: ปิดช่วงพัก ณ เวลาจบ — เวลาชาร์จหยุดที่ตอนเริ่มพัก', () => {
    const paused = pauseCharge(ev('V1', at(25, 8)), 'A', at(25, 11))
    const finished = { ...resumeCharge(paused, 'B', at(25, 14)), afterAt: at(25, 14), afterPct: 90 }
    expect(chargeMs(finished)).toBe(3 * HOUR)
    expect(pausedMs(finished)).toBe(3 * HOUR)
  })

  it('หลายช่วงพัก · สรุปรายวันใช้เวลาหลังหักพัก · ช่องในชีตบอกว่าหยุดพัก', () => {
    let c = ev('V1', at(25, 8))
    c = resumeCharge(pauseCharge(c, 'A', at(25, 9)), 'A', at(25, 10))
    c = resumeCharge(pauseCharge(c, 'A', at(25, 12)), 'A', at(25, 12, 30))
    const done = { ...c, afterAt: at(25, 14), afterPct: 80 }
    expect(chargeMs(done)).toBe(4.5 * HOUR)
    expect(dailySummary([done])[0]).toMatchObject({ finished: 1, totalMs: 4.5 * HOUR })
    expect(evCellText(pauseCharge(ev('V2', at(25, 8)), 'A', at(25, 9)))).toBe('หยุดพัก 20% · 25/10/26 08:00')
    expect(evCellText(ev('V3', at(25, 8)))).toBe('กำลังชาร์จ 20% · 25/10/26 08:00')
  })

  it('รอบเก่าที่ไม่มีช่วงพักคิดเวลาเหมือนเดิม', () => {
    expect(chargeMs(ev('V1', at(25, 8), at(25, 11, 45)))).toBe(3.75 * HOUR)
  })
})

// ── cloud: ตารางที่ยังไม่ได้เพิ่มคอลัมน์ pauses ──────────────────────────────────

type Row = Record<string, unknown>
async function setupDb(hasPausesColumn: boolean) {
  vi.resetModules(); localStorage.clear()
  const sent: Row[] = []
  const table = new Map<string, Row>()
  const missing = { code: 'PGRST204', message: "Could not find the 'pauses' column of 'ev_charges' in the schema cache" }
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: {
      channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {},
      from: () => ({
        upsert: async (row: Row) => {
          sent.push(row)
          if ('pauses' in row && !hasPausesColumn) return { error: missing }
          table.set(String(row.id), { ...table.get(String(row.id)), ...row })
          return { error: null }
        },
      }),
    },
  }))
  const db = await import('../src/lib/db')
  return { db, sent, table }
}

describe('บันทึกขึ้นคลาวด์', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('../src/lib/supabase') })

  it('รอบที่ไม่เคยพักไม่ส่งช่อง pauses (เขียนได้แม้ยังไม่รัน SQL)', async () => {
    const { db, sent } = await setupDb(false)
    expect(await db.upsertEvCharge(ev('V1', at(25, 8)))).toBe('ok')
    expect('pauses' in sent[0]).toBe(false)
  })

  it('ยังไม่มีคอลัมน์ pauses: ส่งช่องอื่นขึ้นไปก่อน แล้วบอกว่าเวลาพักยังไม่ขึ้น', async () => {
    const { db, sent, table } = await setupDb(false)
    const c = pauseCharge(ev('V1', at(25, 8)), 'A', at(25, 9))
    expect(await db.upsertEvCharge(c)).toBe('no-pauses')
    expect(sent).toHaveLength(2)
    expect('pauses' in sent[1]).toBe(false)
    expect(table.get(c.id)).toMatchObject({ vin: 'V1', before_pct: 20 })
  })

  it('มีคอลัมน์แล้ว: ช่วงพักขึ้นครบ', async () => {
    const { db, table } = await setupDb(true)
    const c = pauseCharge(ev('V1', at(25, 8)), 'A', at(25, 9))
    expect(await db.upsertEvCharge(c)).toBe('ok')
    expect(table.get(c.id)?.pauses).toEqual([{ at: at(25, 9), by: 'A' }])
  })

  it('store: เวลาพักยังไม่ขึ้น → เก็บรอบไว้ในเครื่อง · ดึงจากคลาวด์ (ไม่มีช่วงพัก) แล้วไม่ทับของในเครื่อง', async () => {
    const { db } = await setupDb(false)
    const { useEvCharging } = await import('../src/store/useEvCharging')
    const c = pauseCharge(ev('V1', at(25, 8)), 'A', at(25, 9))
    expect(await useEvCharging.getState().save(c)).toBe(true)
    expect(useEvCharging.getState().pausesMissing).toBe(true)
    expect(useEvCharging.getState().pending[c.id]).toBeTruthy()
    const { pauses: _p, ...cloudCopy } = c
    vi.spyOn(db, 'fetchEvCharges').mockResolvedValue([{ ...cloudCopy, pauses: [] }])
    await useEvCharging.getState().load(null, 0)
    expect(isPaused(useEvCharging.getState().charges[c.id])).toBe(true)
  })
})
