import { describe, expect, it } from 'vitest'
import { evChargeId, type EvCharge } from '../src/lib/evCharging'
import { buildEvPlan, buildEvPlanWorkbook, evChargesInRange, evListedCars, evPlanCars, evPlanFilename } from '../src/lib/evExcel'

/** Export Excel ของ EV Charging: เลือกช่วงวันที่แล้วไฟล์มีแค่ช่วงนั้น */

const at = (m: number, d: number, h: number) => new Date(2026, m - 1, d, h).getTime()
function ev(vin: string, before: number, after = 0, beforePct = 20, afterPct: number | null = null): EvCharge {
  return {
    id: evChargeId(vin, before), vin, model: 'M6', color: 'WHITE', from: '', remark: '',
    vinPhoto: '', beforePhoto: '', beforePct, beforeAt: before, beforeBy: 'A',
    afterPhoto: '', afterPct, afterAt: after, afterBy: after ? 'B' : '', updatedAt: after || before,
  }
}
// 10 M6 in the yard; rounds on 27/10 (still charging), 29/10 (still charging), 01/11 (done) and 02/11 (one done, one charging)
const rows = Array.from({ length: 10 }, (_, i) => ({ vin: `V${i}`, model: 'M6', modelName: '', color: 'WHITE', from: '' }))
const charges = [
  ev('V0', at(10, 27, 9)),
  ev('V1', at(10, 29, 9)),
  ev('V2', at(11, 1, 9), at(11, 1, 15), 20, 80),
  ev('V3', at(11, 2, 10), at(11, 2, 15), 16, 29),
  ev('V4', at(11, 2, 11)),
]
const range = { from: '2026-11-01', to: '2026-11-02' }
const cars = evPlanCars(['M6'], rows, charges, () => '')

describe('EV Excel · ช่วงวันที่ที่เลือก', () => {
  it('keeps only rounds STARTED in the range — older cars still on the charger stay out', () => {
    expect(evChargesInRange(charges, range).map((c) => c.vin)).toEqual(['V2', 'V3', 'V4'])
    expect(evChargesInRange(charges).length).toBe(5)
  })

  it('Plan / Actual has exactly the picked days; the plan still counts from its own start', () => {
    const inRange = evChargesInRange(charges, range)
    const plan = buildEvPlan(cars, inRange, 4, '2026-10-31', range)
    expect(plan.days).toEqual(['2026-11-01', '2026-11-02'])
    // 31/10 planned 4 (outside the range) → 01/11 and 02/11 get 4 + 2
    expect(plan.models[0].plan).toEqual([4, 2])
    expect(plan.models[0].actual).toEqual([1, 1])
    expect(plan.models[0].qty).toBe(10)
  })

  it('the car list holds the cars charged in the range; the file name says the range', () => {
    const x = { siteName: 'NYB2 Phase 2', cars, charges, range }
    expect(evListedCars(x).map((c) => c.vin)).toEqual(['V2', 'V3', 'V4'])
    expect(evPlanFilename(x)).toBe('Plan ชาร์จแบต M6 - 3 คัน - NYB2Phase2 - 01-11-26 ถึง 02-11-26.xlsx')
    expect(evPlanFilename({ ...x, range: { from: '2026-11-02', to: '2026-11-02' } })).toBe('Plan ชาร์จแบต M6 - 2 คัน - NYB2Phase2 - 02-11-26.xlsx')
  })

  it('every sheet of the workbook stays inside the range', async () => {
    const wb = await buildEvPlanWorkbook({ siteName: 'NYB2 Phase 2', siteCode: 'NYB2', perDay: 4, start: '2026-11-01', cars, charges, range })
    const XJS: any = await import('exceljs')
    const ExcelJS = XJS.default ?? XJS
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(await wb.xlsx.writeBuffer())
    const [s1, s2, s3] = back.worksheets
    // sheet 1: two day columns (F, G), then TTL / Diff
    expect([s1.getCell('F4').value, s1.getCell('G4').value, s1.getCell('H3').value, s1.getCell('I3').value]).toEqual([1, 2, 'TTL', 'Diff'])
    expect(s2.name).toBe('Plan 3')
    expect(s2.getCell('A1').value).toBe('Plan monitor %soc BYD Model M6 จำนวน 3')
    expect(s2.rowCount).toBe(5)
    expect([3, 4, 5].map((r) => s2.getCell(r, 2).value)).toEqual(['V2', 'V3', 'V4'])
    expect(s3.rowCount).toBe(3 + 3)
    expect([4, 5, 6].map((r) => s3.getCell(r, 2).value)).toEqual(['V2', 'V3', 'V4'])
  })

  it('without a range the export is exactly as before', () => {
    const plan = buildEvPlan(cars, charges, 4, '2026-10-31')
    expect(plan.days[0]).toBe('2026-10-31')
    expect(evListedCars({ cars, charges }).length).toBe(cars.length)
  })
})
