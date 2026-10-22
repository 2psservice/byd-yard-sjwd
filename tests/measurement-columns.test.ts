import { describe, expect, it } from 'vitest'
import { defaultColumns, reconcileColumns, MEASUREMENT_KEYS } from '../src/lib/trackingColumns'

/** ค่าที่วัดตอน PDI / PM (%SOC · Mileage · Voltage 12V · Tire Pressure) เป็นคอลัมน์ในหน้า Units / Units Mylist */

describe('คอลัมน์ค่าที่วัด', () => {
  it('เป็นคอลัมน์มาตรฐาน เปิดให้เห็นเป็นค่าเริ่มต้น ชื่อหัวคอลัมน์ = ชื่อช่อง (ประวัติแก้ไขลงชื่อตามหัวคอลัมน์)', () => {
    const cols = defaultColumns()
    for (const k of MEASUREMENT_KEYS) {
      const c = cols.find((x) => x.key === k)
      expect(c, k).toBeTruthy()
      expect(c!.visible).toBe(true)
      expect(c!.label).toBe(k)
      expect(c!.editable).toBe(true)
    }
  })

  it('เครื่องที่เคยบันทึกค่าคอลัมน์ไว้ (ไม่มีคอลัมน์ใหม่) ได้คอลัมน์ใหม่เปิดอยู่ ต่อท้าย PIC (PDI) · ลำดับ/การซ่อนของเดิมคงอยู่', () => {
    const saved = defaultColumns()
      .filter((c) => !(MEASUREMENT_KEYS as readonly string[]).includes(c.key))
      .map((c) => (c.key === 'Model' ? { ...c, visible: false } : c))
      .reverse() // ผู้ใช้จัดลำดับเอง
    const out = reconcileColumns(saved)
    for (const k of MEASUREMENT_KEYS) expect(out.find((c) => c.key === k)?.visible, k).toBe(true)
    expect(out.find((c) => c.key === 'Model')?.visible).toBe(false)
    expect(out.map((c) => c.key).slice(0, 3)).toEqual(saved.map((c) => c.key).slice(0, 3))
    const keys = out.map((c) => c.key)
    expect(keys.length).toBe(new Set(keys).size)
  })

  it('ค่าเริ่มต้น: เรียง % SOC → Mileage → Voltage → Tire Pressure ต่อจาก PIC (PDI)', () => {
    const keys = defaultColumns().map((c) => c.key)
    const i = keys.indexOf('PIC (PDI)')
    expect(keys.slice(i + 1, i + 5)).toEqual(['% SOC', 'Mileage', 'Voltage of 12V', 'Tire Pressure'])
  })

  it('คอลัมน์ที่ผู้ใช้เพิ่มเองชื่อเดียวกัน (เช่น % SOC ที่นำเข้าจากไฟล์) ไม่ซ้ำ และคงค่าที่ผู้ใช้ตั้งไว้', () => {
    const saved = [
      ...defaultColumns().filter((c) => !(MEASUREMENT_KEYS as readonly string[]).includes(c.key)),
      { key: '% SOC', label: '% SOC', group: 'status' as const, type: 'text' as const, width: 133, visible: false, editable: true, custom: true },
    ]
    const out = reconcileColumns(saved)
    const socs = out.filter((c) => c.key === '% SOC')
    expect(socs.length).toBe(1)
    expect(socs[0].visible).toBe(false)
    expect(socs[0].width).toBe(133)
  })
})
