import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildVehicleLabelHtml, labelModel } from '../src/lib/vehicleLabel'
import { parseVinListInventory } from '../src/lib/excelTracking'

/** Vin label แถว Vehicle Model: ชื่อรุ่นเต็ม — ไฟล์ VIN LIST MASTER อ่าน Sub-Model · ไฟล์ Co อ่าน Model name */

describe('Vin label · Vehicle Model', () => {
  it('ไฟล์ VIN LIST MASTER: อ่านคอลัมน์ Sub-Model (สะกดแบบไหนก็ได้) · เติม BYD นำหน้าถ้าไม่มี', () => {
    expect(labelModel({ Model: 'ATTO 1', 'Sub-Model': 'ATTO 1 PREMIUM' })).toBe('BYD ATTO 1 PREMIUM')
    expect(labelModel({ Model: 'ATTO 1', 'Sub Model': 'BYD ATTO 1 PREMIUM' })).toBe('BYD ATTO 1 PREMIUM')
    expect(labelModel({ Model: 'ATTO 1', SubModel: 'ATTO 1 DYNAMIC' })).toBe('BYD ATTO 1 DYNAMIC')
  })

  it('ไฟล์ Co: อ่านคอลัมน์ Model name · Sub-Model ว่างก็ใช้ Model name', () => {
    expect(labelModel({ Model: 'ATTO 2', 'Model name': 'BYD ATTO 2 (PREMIUM)' })).toBe('BYD ATTO 2 (PREMIUM)')
    expect(labelModel({ Model: 'ATTO 2', 'Sub-Model': ' ', 'Model name': 'BYD ATTO 2 (PREMIUM)' })).toBe('BYD ATTO 2 (PREMIUM)')
  })

  it('มีแค่ Model ยังพิมพ์ได้ · ไม่มีอะไรเลยเป็น —', () => {
    expect(labelModel({ Model: 'ATTO 1' })).toBe('BYD ATTO 1')
    expect(labelModel({})).toBe('—')
  })

  it('นำเข้าไฟล์ VIN LIST MASTER ที่มีคอลัมน์ Sub-Model แล้วพิมพ์ป้าย ได้ชื่อรุ่นเต็ม', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['No', 'Vin No.', 'Model', 'Sub-Model', 'Color', 'Gate In Date'],
      [1, 'LGXCE4CC4T2283087', 'ATTO 1', 'ATTO 1 PREMIUM', 'BLACK', '24-Oct-26'],
    ]), 'NYB2')
    const { rows } = parseVinListInventory(XLSX, wb)
    expect(rows).toHaveLength(1)
    const html = buildVehicleLabelHtml(rows)
    expect(html).toContain('<span class="lb">Vehicle Model :</span><span class="vl">BYD ATTO 1 PREMIUM</span>')
    expect(html).toContain('<span class="vl">LGXCE4CC4T2283087</span>')
  })
})
