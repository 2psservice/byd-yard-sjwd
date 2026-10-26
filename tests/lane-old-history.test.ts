import { describe, expect, it } from 'vitest'
import { planLaneUpdates, laneEntryKind } from '../src/lib/laneRebuild'
import type { Unit } from '../src/types'

/**
 * ยิงตามแถว: รถที่ไม่ได้ยิงถูกดันไปต่อท้าย — แสดงแยกเป็น "ประวัติเก่า" (23 ต.ค. V05: …210472 ไม่ได้อยู่ในแถว
 * แต่ถูกดันเป็นคันที่ 7 และขึ้นในรายการเหมือนคันที่ยิงยืนยัน)
 */
const u = (vin: string, block: string, slot: number, row: number) => ({ vin, block, slot, row, status: 'PARKED', damages: [] } as unknown as Unit)
const code = (b: string, s: number, r: number) => `${b}${String(s).padStart(2, '0')}${String(r).padStart(2, '0')}`

describe('planLaneUpdates: จดว่าคันไหนถูกดัน', () => {
  it('คันที่ยิงไม่มีป้าย pushed · คันที่ไม่ได้ยิงที่ถูกเลื่อนมีป้าย pushed', () => {
    const units = [u('A', 'V', 5, 1), u('B', 'V', 5, 2), u('X', 'V', 4, 1)]
    const { drafts } = planLaneUpdates({
      seq: ['X'], inc: [units[0], units[1]], blockId: 'V', slot: 5,
      unitOf: (v) => units.find((x) => x.vin === v), rowOf: () => undefined,
      codeOf: code, locOf: (x) => (x ? code(x.block!, x.slot!, x.row!) : ''),
    })
    expect(drafts.find((d) => d.vin === 'X')).toEqual({ vin: 'X', from: 'V0401', to: 'V0501' })
    expect(drafts.find((d) => d.vin === 'A')).toMatchObject({ to: 'V0502', pushed: true })
    expect(drafts.find((d) => d.vin === 'B')).toMatchObject({ to: 'V0503', pushed: true })
  })
})

describe('laneEntryKind', () => {
  it('ยิงเองลงช่องนี้ → ยิงยืนยัน', () => {
    expect(laneEntryKind({ to: 'V0504' }, 'V0504')).toBe('confirmed')
  })
  it('ถูกดันมาช่องนี้ → ประวัติเก่า', () => {
    expect(laneEntryKind({ to: 'V0506', pushed: true }, 'V0506')).toBe('old')
  })
  it('ข้อมูลก่อนมีป้าย: ช่องตอนนี้ไม่ตรงบรรทัดล่าสุด (…210472 ประวัติ V0506 อยู่คันที่ 7) → ประวัติเก่า', () => {
    expect(laneEntryKind({ to: 'V0506' }, 'V0507')).toBe('old')
  })
  it('ไม่มีบรรทัดตำแหน่งเลย → ประวัติเก่า', () => {
    expect(laneEntryKind(undefined, 'V0501')).toBe('old')
  })
})
