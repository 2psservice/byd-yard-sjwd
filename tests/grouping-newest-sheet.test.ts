import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseGroupingWorkbook, pickSiteSheet, sheetNameDay } from '../src/lib/groupingImport'

/**
 * ไฟล์ Grouping ที่มีหลาย sheet ของยาร์ดเดียวกัน (07/11 "FIS Ready to Grouping for delivery 8 Nov 2026 Special")
 *  - sheet เก่า "NYB 2 29.10.26" (Date 26 October 2026) อยู่ก่อน sheet ใหม่ "NYB2 08.11.26" (Date 08 November 2026)
 *  - เดิมอ่าน sheet แรกที่ชื่อตรงยาร์ด → ได้แผน 26 ต.ค. กลับมา · ต้องได้ sheet ที่วันที่แผนใหม่สุด
 */

const HEAD = ['No', 'VIN No.', 'Model name', 'Model', 'Color', 'Delivery Location', 'Groupping  Number', 'Grouping (Unit)', 'Location', 'Lane load', 'วันที่ในการเข้ารับ', 'หมายเหตุ']
const plan = (title: string, vins: string[], group: (i: number) => string) =>
  [[title], HEAD, ...vins.map((v, i) => [i + 1, v, 'M6', 'M6', 'WHITE', 'สหกรณ์ มิตรแท้แท็กซี่ จำกัด', group(i), 1, '', '', '', ''])]
const OLD = ['LC0CE4CB9T0116763', 'LC0CE4CBXT0117534']
const NEW = ['LC0CE4CBXT0117520', 'LC0CE4CB3T0116760', 'LC0CE4CB2T0119357']
const book = (sheets: [string, unknown[][]][]) => {
  const wb = XLSX.utils.book_new()
  for (const [n, aoa] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n)
  const buf: ArrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return { name: 'FIS Ready to Grouping for delivery 8 Nov 2026 Special.xlsx', arrayBuffer: async () => buf } as unknown as File
}
const file = () => book([
  ['Sheet3 ', [['No.', 'Vin', 'Group No'], [1, NEW[0], 'SJWD261103-057']]], // raw master dump: never a yard sheet
  ['NYB 2 29.10.26', plan('NYB Phase 2 - Grouping to Dealer ( 2 Units / 2 Group) Date 26 October 2026', OLD, (i) => `SJWD261027-10${i}`)],
  ['NYB2 08.11.26', plan('NYB2 - Grouping to Dealer ( 3 Units / 3 Groups) Date 08 November 2026', NEW, (i) => `SJWD261103-05${7 + i}`)],
])

describe('ไฟล์ที่มีหลาย sheet ของยาร์ดเดียวกัน', () => {
  it('อ่าน sheet ที่วันที่แผนใหม่สุด ไม่ใช่ sheet แรก · บอก sheet อื่นของยาร์ดพร้อมวันที่', async () => {
    const res = await parseGroupingWorkbook(file(), 'NYB2 Phase 2')
    expect(res.sheetName).toBe('NYB2 08.11.26')
    expect(res.title).toContain('08 November 2026')
    expect(res.rows.map((r) => r.grouping)).toEqual(['SJWD261103-057', 'SJWD261103-058', 'SJWD261103-059'])
    expect(res.siblings).toEqual([{ sheet: 'NYB 2 29.10.26', day: '2026-10-26' }])
  })

  it('เลือก sheet เก่าเองได้ (ปุ่ม "อ่าน sheet อื่นแทน") · แล้ว sheet ใหม่กลายเป็นตัวเลือก', async () => {
    const res = await parseGroupingWorkbook(file(), 'NYB2 Phase 2', 'NYB 2 29.10.26')
    expect(res.rows.map((r) => r.vin)).toEqual(OLD)
    expect(res.siblings).toEqual([{ sheet: 'NYB2 08.11.26', day: '2026-11-08' }])
  })

  it('ไฟล์ที่มี sheet ของยาร์ดเดียว อ่านเหมือนเดิม ไม่มีตัวเลือกอื่น', async () => {
    const res = await parseGroupingWorkbook(book([['NYB 06.11.26', plan('NYB2 - Grouping to Dealer ( 2 Units / 2 Groups) Date 6 November 2026', OLD, (i) => `G${i}`)]]), 'NYB2 Phase 2')
    expect(res.sheetName).toBe('NYB 06.11.26')
    expect(res.siblings).toEqual([])
  })

  it('วันที่: หัว sheet ก่อน แล้วชื่อ sheet · ไม่มีวันที่ = อันดับท้าย · เท่ากัน = ตามลำดับในไฟล์', () => {
    expect(sheetNameDay('NYB2 08.11.26')).toBe('2026-11-08')
    expect(sheetNameDay('RY 6-11-2026')).toBe('2026-11-06')
    expect(sheetNameDay('NYB2 Phase2')).toBe('')
    expect(pickSiteSheet([{ sheet: 'NYB', title: 'no date' }, { sheet: 'NYB 01.11.26', title: '' }])?.sheet).toBe('NYB 01.11.26')
    expect(pickSiteSheet([{ sheet: 'NYB a', title: 'x Date 3 Nov 2026' }, { sheet: 'NYB b', title: 'y Date 3 November 2026' }])?.sheet).toBe('NYB a')
    expect(pickSiteSheet([{ sheet: 'NYB 30.12.26', title: 'Date 2 January 2027' }, { sheet: 'NYB 31.12.26', title: '' }])?.sheet).toBe('NYB 30.12.26')
  })
})
