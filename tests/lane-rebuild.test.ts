import { describe, expect, it } from 'vitest'
import { planLaneUpdates, recordableDrafts, type LaneDraft } from '../src/lib/laneRebuild'
import { car } from './helpers/world'

const codeOf = (b: string, slot: number, row: number) => `${b}${String(slot).padStart(2, '0')}${String(row).padStart(2, '0')}`
const locOf = (u: any) => (u?.block && u.slot && u.row ? codeOf(u.block, u.slot, u.row) : '')

function plan(seq: string[], inc: any[], units: any[]) {
  const by = new Map(units.map((u) => [u.vin, u]))
  return planLaneUpdates({
    seq, inc, blockId: 'Q', slot: 37,
    unitOf: (v) => by.get(v), rowOf: () => undefined, codeOf, locOf,
  })
}

describe('planLaneUpdates', () => {
  it('คันที่ยิงถูกย้ายจริง → มีทั้งคำสั่งวางและ draft ประวัติ (จาก → ถึง)', () => {
    const { updates, drafts } = plan(['A'], [], [car('A', 'Q', 35, 1)])
    expect(updates).toEqual([expect.objectContaining({ vin: 'A', block: 'Q', slot: 37, row: 1 })])
    expect(updates[0].from).toBeUndefined() // คันที่ยิงไม่มี compare-and-set
    expect(drafts).toEqual([{ vin: 'A', from: 'Q3501', to: 'Q3701' }])
  })

  it('คันที่อยู่ตำแหน่งนั้นอยู่แล้ว → ไม่เขียน ไม่มีประวัติ "X → X"', () => {
    const { updates, drafts } = plan(['A'], [], [car('A', 'Q', 37, 1)])
    expect(updates).toEqual([])
    expect(drafts).toEqual([])
  })

  it('คันที่ถูกเลื่อน (incumbent) ใช้ compare-and-set และมีประวัติของตัวเอง; คันที่ไม่ขยับไม่มี', () => {
    const inc1 = car('I1', 'Q', 37, 1)  // ถูกเลื่อน 1 → 2
    const inc2 = car('I2', 'Q', 37, 3)  // 3 → 3 (ไม่ขยับ: seq=1 คัน, inc index 1 → row 3)
    const { updates, drafts } = plan(['A'], [inc1, inc2], [car('A', 'Q', 35, 1), inc1, inc2])
    expect(updates.map((u) => [u.vin, u.row])).toEqual([['A', 1], ['I1', 2]])
    expect(updates[1].from).toEqual({ block: 'Q', row: 1, slot: 37 })
    expect(drafts).toEqual([{ vin: 'A', from: 'Q3501', to: 'Q3701' }, { vin: 'I1', from: 'Q3701', to: 'Q3702' }])
  })

  it('ยิงหลายคัน: คันที่ 2 ใน seq ได้ row 2, รถที่ยังไม่มีตำแหน่งมี from เป็นค่าว่าง', () => {
    const { updates, drafts } = plan(['A', 'B'], [], [car('A', 'Q', 37, 1), { ...car('B', 'Q', 1, 1), block: undefined, slot: undefined, row: undefined }])
    expect(updates.map((u) => [u.vin, u.row])).toEqual([['B', 2]])
    expect(drafts).toEqual([{ vin: 'B', from: '', to: 'Q3702' }])
  })
})

describe('recordableDrafts', () => {
  const drafts: LaneDraft[] = [{ vin: 'A', from: 'x', to: 'y' }, { vin: 'B', from: 'x', to: 'y' }, { vin: 'C', from: 'x', to: 'y' }, { vin: 'D', from: 'x', to: 'y' }]
  it('เก็บเฉพาะ ok/queued — ตัด lost และคันที่ไม่มีผล', () => {
    const out = recordableDrafts(drafts, [{ vin: 'A', status: 'ok' }, { vin: 'B', status: 'queued' }, { vin: 'C', status: 'lost' }])
    expect(out.map((d) => d.vin)).toEqual(['A', 'B'])
  })
})
