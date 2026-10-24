import { describe, expect, it } from 'vitest'
import {
  chargeMs, dailySummary, evCellText, evChargeId, fmtDuration, openChargeOf, parsePct, hoursOf, type EvCharge,
  monthSummary, shiftMonth, monthRange, fmtMonth, monthKey, fmtDayKey,
} from '../src/lib/evCharging'
import { defaultColumns, EV_CHARGING_KEY } from '../src/lib/trackingColumns'

/** งานชาร์จแบต EV: สรุปเวลาชาร์จต่อคัน · วันละกี่คัน · ยอดเดือน · ช่องสรุปในชีต · ช่องกรอก % */

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
function ev(vin: string, before: number, after = 0, beforePct: number | null = 18, afterPct: number | null = null): EvCharge {
  return {
    id: evChargeId(vin, before), vin, model: 'DOLPHIN', color: 'GREY', from: '38RAI', remark: '',
    vinPhoto: 'v', beforePhoto: 'b', beforePct, beforeAt: before, beforeBy: 'A',
    afterPhoto: after ? 'a' : '', afterPct, afterAt: after, afterBy: after ? 'B' : '', updatedAt: after || before,
  }
}

describe('เวลาชาร์จต่อคัน', () => {
  it('รอบที่จบแล้ว = เวลาบันทึกหลัง − เวลาบันทึกก่อน', () => {
    const c = ev('LC0CE4CC4SG029237', at(1, 8, 15), at(1, 12, 0), 18, 62)
    expect(chargeMs(c)).toBe(3.75 * 3_600_000)
    expect(fmtDuration(chargeMs(c))).toBe('3:45 ชม.')
    expect(hoursOf(chargeMs(c))).toBe(3.75)
  })
  it('รอบที่ยังชาร์จอยู่นับถึงตอนนี้', () => {
    const c = ev('V1', at(1, 8))
    expect(chargeMs(c, at(1, 9, 30))).toBe(1.5 * 3_600_000)
  })
})

describe('สรุปรายวัน — วันละกี่คัน คันละกี่ชั่วโมง', () => {
  it('นับคันที่เสร็จตามวันที่บันทึกหลังชาร์จ · เฉลี่ยเฉพาะคันที่เสร็จ', () => {
    const list = [
      ev('V1', at(1, 8), at(1, 12), 18, 62),       // 4 ชม. เสร็จวันที่ 1
      ev('V2', at(1, 9), at(1, 11), 19, 66),       // 2 ชม. เสร็จวันที่ 1
      ev('V3', at(1, 22), at(2, 2), 10, 80),       // ข้ามคืน: เริ่มวันที่ 1 เสร็จวันที่ 2
      ev('V4', at(2, 8)),                          // ยังชาร์จอยู่
    ]
    const days = dailySummary(list)
    expect(days.map((d) => d.day)).toEqual(['2026-10-02', '2026-10-01'])
    const d1 = days.find((d) => d.day === '2026-10-01')!
    expect(d1).toMatchObject({ started: 3, finished: 2 })
    expect(d1.avgMs).toBe(3 * 3_600_000)
    const d2 = days.find((d) => d.day === '2026-10-02')!
    expect(d2).toMatchObject({ started: 1, finished: 1, totalMs: 4 * 3_600_000 })
  })
})

describe('ยอดเดือน — ดูย้อนหลังได้ทีละเดือน', () => {
  const sep = (d: number, h: number) => new Date(2026, 8, d, h).getTime()
  const list = [
    ev('A', sep(10, 8), sep(10, 12), 18, 62),          // ก.ย. 4 ชม.
    ev('B', sep(30, 22), at(1, 2), 10, 80),            // เริ่ม 30 ก.ย. เสร็จ 1 ต.ค. → ยอด ต.ค.
    ev('C', at(5, 8), at(5, 10), 20, 70),              // ต.ค. 2 ชม.
    ev('D', at(6, 9)),                                 // ต.ค. ยังชาร์จอยู่
  ]
  it('นับคันที่เสร็จตามเดือนที่บันทึกหลังชาร์จ · เฉลี่ยต่อคัน · เวลารวม', () => {
    const oct = monthSummary(list, '2026-10')
    expect(oct).toMatchObject({ finished: 2, started: 2, totalMs: 6 * 3_600_000, avgMs: 3 * 3_600_000 })
    expect(oct.days.map((d) => d.day)).toEqual(['2026-10-06', '2026-10-05', '2026-10-01'])
    const sepSum = monthSummary(list, '2026-09')
    expect(sepSum).toMatchObject({ finished: 1, started: 2, totalMs: 4 * 3_600_000 })
    expect(monthSummary(list, '2026-08')).toMatchObject({ finished: 0, started: 0, avgMs: 0, days: [] })
  })
  it('เลื่อนเดือนข้ามปี · ช่วงเวลาของเดือน · ชื่อเดือน', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2025-12', 1)).toBe('2026-01')
    const [a, b] = monthRange('2026-10')
    expect(new Date(a)).toEqual(new Date(2026, 9, 1))
    expect(new Date(b)).toEqual(new Date(2026, 10, 1))
    expect(fmtMonth('2026-10')).toBe('ต.ค. 2026')
    expect(monthKey(at(24, 11))).toBe('2026-10')
    expect(fmtDayKey('2026-10-01')).toBe('01/10/26')
  })
})

describe('รอบที่ค้าง / ช่อง EV Charging ในชีต', () => {
  it('ยิงคันเดิมระหว่างชาร์จ → เจอรอบที่ยังไม่จบ (ไม่ใช่รอบเก่าที่จบแล้ว)', () => {
    const old = ev('V1', at(1, 8), at(1, 12), 18, 62)
    const cur = ev('V1', at(3, 8))
    expect(openChargeOf([old, cur, ev('V2', at(3, 9))], 'V1')?.id).toBe(cur.id)
    expect(openChargeOf([old], 'V1')).toBeUndefined()
  })
  it('ข้อความในช่อง: กำลังชาร์จ / ก่อน → หลัง · เวลา · วันที่', () => {
    expect(evCellText(ev('V1', at(1, 9, 5)))).toBe('กำลังชาร์จ 18% · 01/10/26 09:05')
    expect(evCellText(ev('V1', at(1, 8), at(1, 11, 30), 18, 62))).toBe('18% → 62% · 3:30 ชม. · 01/10/26')
  })
  it('คอลัมน์ EV Charging อยู่ในตารางรถ เปิดไว้ตั้งแต่แรก และแก้มือไม่ได้', () => {
    const col = defaultColumns().find((c) => c.key === EV_CHARGING_KEY)
    expect(col).toBeTruthy()
    expect(col!.visible).toBe(true)
    expect(col!.editable).toBe(false)
  })
  it('ช่องกรอก %: 0–100 เท่านั้น', () => {
    expect(parsePct('18')).toBe(18)
    expect(parsePct(' 62% ')).toBe(62)
    expect(parsePct('101')).toBeNull()
    expect(parsePct('')).toBeNull()
    expect(parsePct('abc')).toBeNull()
  })
})
