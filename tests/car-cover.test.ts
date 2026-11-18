import { describe, expect, it } from 'vitest'
import { CAR_COVER_KEY, COVERED, UNCOVERED, carCoverColor } from '../src/lib/carCover'
import { defaultColumns, reconcileColumns } from '../src/lib/trackingColumns'
import { TRIP_SCOPED_KEYS } from '../src/lib/tripHistory'

/** 18/11: Gate-in ต้องติ๊กรถคลุมผ้า (คลุม = เขียว · ไม่คลุม = แดง) · หน้า Unit มีคอลัมน์ รถคลุมผ้า */
describe('รถคลุมผ้า', () => {
  it('คลุม = เขียว · ไม่คลุม = แดง · ค่าอื่นไม่มีสี', () => {
    expect(carCoverColor(COVERED)?.color).toBe('#15803d')
    expect(carCoverColor(UNCOVERED)?.color).toBe('#b91c1c')
    expect(carCoverColor('')).toBeNull()
  })

  it('คอลัมน์ "รถคลุมผ้า" เปิดให้เห็นเป็นค่าเริ่มต้น เลือกค่า คลุม / ไม่คลุม ได้ อยู่ถัดจาก Gate In', () => {
    const cols = defaultColumns()
    const i = cols.findIndex((c) => c.key === CAR_COVER_KEY)
    expect(cols[i]).toMatchObject({ label: 'รถคลุมผ้า', visible: true, type: 'select', options: [COVERED, UNCOVERED] })
    expect(cols[i - 1].key).toBe('Gate In (Rayong yard)')
  })

  it('ผู้ใช้ที่บันทึกมุมมองคอลัมน์ไว้ก่อน ก็เห็นคอลัมน์ใหม่ ต่อจาก Gate In', () => {
    const saved = defaultColumns().filter((c) => c.key !== CAR_COVER_KEY).reverse()
    const out = reconcileColumns(saved)
    const i = out.findIndex((c) => c.key === CAR_COVER_KEY)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(out[i].visible).toBe(true)
  })

  it('เป็นข้อมูลของการมาถึงรอบนี้ — ปิดรอบแล้วไม่ค้างไปรอบหน้า', () => {
    expect(TRIP_SCOPED_KEYS).toContain(CAR_COVER_KEY)
  })
})
