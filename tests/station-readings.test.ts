import { describe, expect, it } from 'vitest'
import { stationReadingsHist, PDI_DATE_KEYS, PM_DATE_KEYS } from '../src/lib/carHistory'
import { defaultColumns } from '../src/lib/trackingColumns'

/**
 * 25/11 LC0CE4CB9T4403786: PDI 31-Aug-26 (from the file) and PM1 26/10 (saved at the station 17:08).
 * The car popup's PDI tab listed the PM save's readings as if PDI had been recorded at 17:08.
 * Each station tab now lists only the readings saved together with that station's date stamp.
 */
const T = new Date('2026-10-26T17:08:00+07:00').getTime()
const cols = defaultColumns()
const row = (history: any[], cells: Record<string, string> = {}) => ({
  vin: 'V', updatedAt: T, history,
  cells: { Vin: 'V', PDI: '31-Aug-26', PM1: '26/10/2026', '% SOC': '24', Mileage: '18', ...cells },
}) as any
const PM_SAVE = [
  { at: T, by: 'วิไลภรณ์', field: 'PM1', from: '', to: '26/10/2026' },
  { at: T + 20_000, by: 'วิไลภรณ์', field: '% SOC', from: '', to: '24' },
  { at: T + 20_000, by: 'วิไลภรณ์', field: 'Mileage', from: '', to: '18' },
]

describe('ค่าที่วัดได้แยกตามสถานี', () => {
  it('ค่าที่ PM บันทึก ขึ้นเฉพาะแท็บ PM · แท็บ PDI (วันที่จากไฟล์) ไม่มีค่าของ PM', () => {
    const r = row(PM_SAVE)
    expect(stationReadingsHist(r, cols, '% SOC', PM_DATE_KEYS)).toEqual([{ value: '24', at: T + 20_000, by: 'วิไลภรณ์' }])
    expect(stationReadingsHist(r, cols, 'Mileage', PM_DATE_KEYS).map((v) => v.value)).toEqual(['18'])
    expect(stationReadingsHist(r, cols, '% SOC', PDI_DATE_KEYS)).toEqual([])
  })

  it('PDI ที่บันทึกที่หน้างาน ได้ค่าของตัวเอง · ค่าที่มาจากไฟล์ (ไม่มีเวลา) ยังแสดงเป็น "จากไฟล์นำเข้า"', () => {
    const P = T - 50 * 86400_000
    const r = row([
      { at: P, by: 'gate', field: 'PDI', from: '', to: '31-Aug-26' },
      { at: P + 60_000, by: 'gate', field: '% SOC', from: '', to: '80' },
      ...PM_SAVE,
    ], { '% SOC': '55' }) // a later file wrote 55 with no log line
    expect(stationReadingsHist(r, cols, '% SOC', PDI_DATE_KEYS)).toEqual([
      { value: '80', at: P + 60_000, by: 'gate' }, { value: '55' },
    ])
    expect(stationReadingsHist(r, cols, '% SOC', PM_DATE_KEYS).map((v) => v.value)).toEqual(['24', '55'])
  })
})
