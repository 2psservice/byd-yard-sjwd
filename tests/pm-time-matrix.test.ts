import { describe, expect, it } from 'vitest'
import { buildList, buildTimeMatrix, type ReportCtx } from '../src/lib/opsReport'

/**
 * ตาราง PM รายเบรก (P1–P5): รถที่สถานีบันทึกแต่รายการคิวถูกปิดจากวันที่ในชีต (ไม่มี checkedAt)
 * ต้องลงเบรกตามเวลาที่สถานีเขียนวันที่ — 26/10 ทำ PM 35 คัน แต่ P4 ขึ้นแค่ 8 (เฉพาะคันที่มีเวลา)
 */

const at = (h: number, m = 0, d = 26) => new Date(2026, 9, d, h, m).getTime()
const midnight = at(0)
const row = (vin: string, history: object[] = [], pm1 = '26/10/2026') => ({
  vin, site: 'S1', updatedAt: 0, history,
  cells: { Vin: vin, Model: 'ATTO 2', 'Model name': 'BYD ATTO 2 (PREMIUM)', Color: 'WHITE', PM1: pm1 },
})
const scan = (field: string, h: number, m = 0, d = 26) => ({ at: at(h, m, d), by: 'สมชาย', field, from: '', to: `${d}/10/2026`, src: 'scan' })

function ctx(): ReportCtx {
  const items = [
    // saved at the station through the queue → checkedAt
    { vin: 'A', addedAt: 1, done: true, doneAt: at(15, 24), checkedAt: at(15, 24), result: 'OK', stage: 'checked' },
    // scanned at the station with no queue item on that device → sheet stamp; closed later from the sheet date
    { vin: 'B', addedAt: 1, done: true, doneAt: midnight, doneBy: 'ไฟล์ Co-Inspection', stamped: true },
    { vin: 'C', addedAt: 1, done: true, doneAt: midnight, doneBy: 'ไฟล์ Co-Inspection', stamped: true },
    // date only from an import (no history) — no time to place it by
    { vin: 'D', addedAt: 1, done: true, doneAt: midnight, stamped: true },
    // office cell edit (no src) and a scan from another day — neither is today's field work
    { vin: 'E', addedAt: 1, done: true, doneAt: midnight, stamped: true },
  ]
  return {
    rows: [
      row('A'),
      row('B', [scan('PM1', 9, 15)]),
      row('C', [scan('% SOC', 13, 0), scan('PM1', 13, 2)]),
      row('D'),
      row('E', [{ at: at(11), by: 'office', field: 'PM1', from: '', to: '26/10/2026' }, scan('PM1', 16, 0, 25)]),
    ] as any,
    units: [],
    queues: [{ id: 'Q', name: 'PM 468U 18 OCT', createdAt: at(8, 0, 18), type: 'PM', items }] as any,
    day: '2026-10-26',
    siteLabel: '3D LCB',
  }
}

describe('ตาราง PM: รถที่ไม่มี checkedAt ลงเบรกตามเวลาที่สถานีเขียนวันที่ PM', () => {
  it('P1–P5 นับครบจากเวลาที่สถานีบันทึก · รถที่ไม่มีเวลาเลย (นำเข้าไฟล์ / แก้มือ) อยู่ในยอดรวมแต่ไม่ลงเบรก', () => {
    const m = buildTimeMatrix(ctx(), 'pmtime')
    expect(m.total).toBe(5)
    expect(m.ok).toEqual([1, 0, 1, 1, 0]) // B 09:15 → P1 · C 13:02 → P3 · A 15:24 → P4
    const atto = m.models.find((x) => x.name === 'ATTO 2')!
    expect(atto.p).toEqual([1, 0, 1, 1, 0])
    expect(atto.total).toBe(5)
  })

  it('ตาราง PM (รายชื่อ) แสดงเวลาที่สถานีบันทึก · ไม่มีเวลาแสดงแค่วันที่', () => {
    const dates = Object.fromEntries(buildList(ctx(), 'pm').map((r) => [r.vin, r.date]))
    expect(dates).toEqual({ A: '26/10/2026 15:24', B: '26/10/2026 09:15', C: '26/10/2026 13:02', D: '26/10/2026', E: '26/10/2026' })
  })
})
