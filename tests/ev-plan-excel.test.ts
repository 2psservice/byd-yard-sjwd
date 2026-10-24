import { afterEach, describe, expect, it, vi } from 'vitest'
import { evChargeId, type EvCharge } from '../src/lib/evCharging'
import { buildEvPlan, buildEvPlanWorkbook, evPlanCars, evPlanFilename, modelVariant, type EvPlanCar } from '../src/lib/evExcel'

/** Export Excel ของ EV Charging ตามไฟล์ "Plan ชาร์จแบต M6 - 69 คัน - 60Rai" ที่หน้างานส่ง BYD (3 ชีต) */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min).getTime()

function ev(vin: string, before: number, after = 0, beforePct: number | null = 12, afterPct: number | null = null, photos = ''): EvCharge {
  return {
    id: evChargeId(vin, before), vin, model: 'M6 (7-SEATS)', color: 'WHITE', from: 'C0', remark: '',
    vinPhoto: photos, beforePhoto: photos, beforePct, beforeAt: before, beforeBy: 'A',
    afterPhoto: after ? photos : '', afterPct, afterAt: after, afterBy: after ? 'B' : '', updatedAt: after || before,
  }
}

/** 69 คันเหมือนไฟล์ต้นแบบ · 3 คันแรกชาร์จวันที่ 23/10 */
function fixture() {
  const vin = (i: number) => `LC0CE4CB${String(i).padStart(9, '0')}`
  const rows = Array.from({ length: 69 }, (_, i) => ({ vin: vin(i), model: 'M6 (7-SEATS)', modelName: 'BYD M6 EXTENDED', color: i % 2 ? 'GREY' : 'BLACK', from: 'C0' }))
  const loc = new Map(rows.map((r, i) => [r.vin, `6-A${34 + Math.floor(i / 5)}`]))
  const charges = [
    ev(vin(30), at(10, 23, 8, 57), at(10, 23, 17, 4), 12, 79, PNG),
    ev(vin(31), at(10, 23, 8, 50), at(10, 23, 17, 5), 10, 75, PNG),
    ev(vin(32), at(10, 23, 9, 4), at(10, 23, 17, 7), 10, 74, PNG),
  ]
  const cars = evPlanCars(['M6 (7-SEATS)'], rows, charges, (v) => loc.get(v) ?? '')
  return { rows, charges, cars }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('แผนชาร์จแบต: Plan / Actual รายวัน', () => {
  it('ชื่อรุ่นย่อยจาก Model name', () => {
    expect(modelVariant('M6 (7-SEATS)', 'BYD M6 EXTENDED')).toBe('EXTENDED')
    expect(modelVariant('DOLPHIN', 'BYD DOLPHIN')).toBe('')
    expect(modelVariant('ATTO 3', 'ATTO 3 EXTENDED RANGE')).toBe('EXTENDED RANGE')
  })

  it('69 คัน วันละ 4 คัน เริ่ม 23/10 → 18 วัน (17×4 + 1) · Actual 3 คันวันแรก', () => {
    const { charges, cars } = fixture()
    expect(cars).toHaveLength(69)
    const plan = buildEvPlan(cars, charges, 4, '2026-10-23')
    expect(plan.days[0]).toBe('2026-10-23')
    expect(plan.days.at(-1)).toBe('2026-11-09')
    expect(plan.days).toHaveLength(18)
    const [m] = plan.models
    expect(m).toMatchObject({ model: 'M6 (7-SEATS)', variant: 'EXTENDED', qty: 69 })
    expect(m.plan.slice(0, 17).every((n) => n === 4)).toBe(true)
    expect(m.plan[17]).toBe(1)
    expect(m.actual[0]).toBe(3)
    expect(m.actual.slice(1).every((n) => n === 0)).toBe(true)
  })

  it('รถชาร์จสองรอบนับ Actual ครั้งเดียว · รถที่ออกจากลานแล้วแต่ชาร์จในช่วงยังอยู่ในแผน · ชาร์จก่อนวันเริ่มแผนขยายคอลัมน์', () => {
    const rows = [{ vin: 'A', model: 'M6', modelName: '', color: '', from: '' }]
    const charges = [ev('A', at(10, 20, 8), at(10, 20, 12), 10, 80), ev('A', at(10, 22, 8), at(10, 22, 12), 50, 80), ev('GONE', at(10, 21, 9), at(10, 21, 15), 20, 70)]
    charges[2].model = 'M6'; charges[0].model = 'M6'; charges[1].model = 'M6'
    const cars = evPlanCars(['M6'], rows, charges, () => '')
    expect(cars.map((c) => c.vin).sort()).toEqual(['A', 'GONE'])
    const plan = buildEvPlan(cars, charges, 4, '2026-10-22')
    expect(plan.days[0]).toBe('2026-10-20')
    expect(plan.models[0].actual).toEqual([1, 1, 0])
    expect(plan.models[0].plan).toEqual([0, 0, 2])
  })
})

describe('ไฟล์ Excel 3 ชีตตามต้นแบบ', () => {
  it('ชื่อชีต · หัวตาราง · merge · สูตร · สี · รูปฝัง', async () => {
    // jsdom ไม่โหลดรูป — จำลองขนาดรูปถ่ายแนวตั้ง 9:16
    vi.stubGlobal('Image', class { naturalWidth = 900; naturalHeight = 1600; onload: any; onerror: any; set src(_: string) { setTimeout(() => this.onload?.()) } })
    const { charges, cars } = fixture()
    const x = { siteName: '60 Rai', siteCode: '60 RAI', perDay: 4, start: '2026-10-23', cars, charges }
    expect(evPlanFilename(x)).toBe('Plan ชาร์จแบต M6 - 69 คัน - 60Rai.xlsx')
    const wb = await buildEvPlanWorkbook(x)
    const XJS: any = await import('exceljs')
    const ExcelJS = XJS.default ?? XJS
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(await wb.xlsx.writeBuffer())
    expect(back.worksheets.map((w: any) => w.name)).toEqual(['UPDATE-%SOC 60 RAI-M6', 'Plan 69', 'รูปชาร์จแบต'])

    const [s1, s2, s3] = back.worksheets
    expect(s1.getCell('A2').value).toBe('Plan and Actual  monitor %soc BYD Model M6')
    expect(['A3', 'C3', 'D3', 'E3'].map((a) => s1.getCell(a).value)).toEqual(['Model', "Q'ty", 'Type', 'Plan&Actual'])
    expect(s1.getCell('F3').numFmt).toBe('[$-409]mmm-yy;@')
    expect(s1.getCell('F4').value).toBe(23)
    expect(s1.getCell('O4').value).toBe(1)
    expect(['X3', 'Y3'].map((a) => s1.getCell(a).value)).toEqual(['TTL', 'Diff'])
    const merges: string[] = s1.model.merges
    for (const m of ['A3:A4', 'F3:N3', 'O3:W3', 'X3:X4', 'Y3:Y4', 'B5:B6', 'C5:C6', 'D5:D6', 'A7:C9', 'D7:E7', 'D8:E8', 'D9:E9']) expect(merges).toContain(m)
    expect(['A5', 'A6', 'C5', 'E5', 'E6'].map((a) => s1.getCell(a).value)).toEqual(['M6 (7-SEATS)', 'EXTENDED', 69, 'Plan', 'Actual'])
    expect(s1.getCell('F5').value).toBe(4)
    expect(s1.getCell('W5').value).toBe(1)
    expect(s1.getCell('F6').value).toBe(3)
    expect(s1.getCell('X5').value).toMatchObject({ formula: 'SUM(F5:W5)', result: 69 })
    expect(s1.getCell('Y5').value).toMatchObject({ formula: '+C5-X5' }) // exceljs ไม่เขียน result 0 (ไฟล์ต้นแบบก็ไม่มี)
    expect(s1.getCell('X6').value).toMatchObject({ formula: 'SUM(F6:W6)', result: 3 })
    expect(s1.getCell('Y6').value).toMatchObject({ formula: '+X5-X6', result: 66 })
    expect(s1.getCell('F7').value).toMatchObject({ formula: 'SUM(F5)', result: 4 })
    expect(s1.getCell('F8').value).toMatchObject({ formula: '+F6', result: 3 })
    expect(s1.getCell('F9').value).toMatchObject({ formula: '+F8-F7', result: -1 })
    expect(s1.getCell('X9').value).toMatchObject({ result: -66 })
    expect(s1.getCell('A7').fill.fgColor.argb).toBe('FF1F497D')
    expect(s1.getCell('F7').fill.fgColor.argb).toBe('FFF2DCDB')
    expect(s1.getCell('F8').fill.fgColor.argb).toBe('FFE5E0EC')
    expect(s1.getCell('F9').font.color.argb).toBe('FFFF0000')
    expect(s1.getCell('F6').font.color.argb).toBe('FF00B0F0')
    expect(s1.getCell('A5').font.name).toBe('Browallia New')

    expect(s2.getCell('A1').value).toBe('Plan monitor %soc BYD Model M6 จำนวน 69')
    expect(s2.getRow(2).values.slice(1)).toEqual(['No', 'Vin', 'Model', 'Color', 'Location', 'Date', 'ก่อนชาร์จ', 'หลังชาร์จ', 'หมายเหตุ'])
    expect(s2.getCell('A2').fill.fgColor.argb).toBe('FFFFFF00')
    expect(s2.rowCount).toBe(71)
    expect(s2.getCell('E3').value).toBe('6-A34')
    expect(s2.getCell('I3').value).toBe('Move from C0')
    const charged = s2.getColumn(2).values.indexOf(charges[0].vin)
    expect(s2.getCell(charged, 7).value).toBe(0.12)
    expect(s2.getCell(charged, 7).numFmt).toBe('0%')
    expect(s2.getCell(charged, 8).value).toBe(0.79)
    expect(s2.getCell(charged, 6).numFmt).toBe('dd/mm/yyyy')

    expect(s3.getCell('A1').value).toBe('รูปก่อน-หลังชาร์จแบต BYD M6 – Yard 60 Rai')
    expect(s3.getRow(3).values.slice(5)).toEqual(['รูป VIN', 'รูปหน้าปัด', '%SOC / เวลา', 'รูป VIN', 'รูปหน้าปัด', '%SOC / เวลา', '%SOC'])
    for (const m of ['A1:K1', 'E2:G2', 'H2:J2', 'A2:A3', 'D2:D3']) expect(s3.model.merges).toContain(m)
    expect(s3.getCell('E2').fill.fgColor.argb).toBe('FFDDEBF7')
    expect(s3.getCell('H2').fill.fgColor.argb).toBe('FFE2EFDA')
    expect(s3.rowCount).toBe(6)
    // เรียงตามเวลาเริ่มชาร์จ: 08:50 · 08:57 · 09:04
    expect(s3.getCell('G4').value).toBe('10%\n08:50 น.')
    expect(s3.getCell('J5').value).toBe('79%\n17:04 น.')
    expect(s3.getCell('K5').value).toMatchObject({ formula: '(79-12)/100' })
    expect(s3.getCell('K5').numFmt).toBe('+0%')
    expect(s3.getCell('D4').numFmt).toBe('dd/mm/yyyy')
    expect(s3.getRow(4).height).toBeCloseTo(220.05)
    const imgs = s3.getImages()
    expect(imgs).toHaveLength(9) // รูป VIN + หน้าปัดก่อน + หน้าปัดหลัง ต่อคัน
    expect(new Set(imgs.map((im: any) => Math.floor(im.range.tl.nativeCol)))).toEqual(new Set([4, 5, 8]))
    expect(imgs[0].range.ext).toMatchObject({ width: 157, height: 279 })
  })
})
