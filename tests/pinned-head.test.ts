import { describe, expect, it } from 'vitest'
import { headShift } from '../src/lib/pinnedHead'

// ใบ Grouping: หัวตารางเลื่อนลงมาต่อใต้แถบพิมพ์ที่ค้างอยู่ — ไม่ขึ้นเหนือที่เดิม และไม่ลงเลยแถวสุดท้าย
describe('headShift', () => {
  it('stays put while the table is still below the bar', () => {
    expect(headShift(300, 302, 4000, 37, 38)).toBe(0)
    expect(headShift(300, 300, 4000, 37, 38)).toBe(0)
  })
  it('follows the bar once the table slides under it', () => {
    // bar bottom at 104, table top scrolled to -2800 → the header moves down 2904px
    expect(headShift(104, -2800, 4000, 37, 38)).toBe(2904)
  })
  it('never moves past the last row (does not float over the total row)', () => {
    expect(headShift(104, -5000, 4000, 37, 38)).toBe(4000 - 37 - 38)
  })
  it('a table shorter than its own header + footer never moves', () => {
    expect(headShift(104, -50, 60, 37, 38)).toBe(0)
  })
})
