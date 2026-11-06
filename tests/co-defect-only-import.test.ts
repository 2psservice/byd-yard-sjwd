import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { parseTrackingWorkbook } from '../src/lib/excelTracking'

/**
 * นำเข้าไฟล์ Co ที่มีแค่ชีต Defect-Yard (เหตุ 05/11 08:58 ที่ 3D RINCHA)
 *  - เดิมชีต Defect-Yard ถูกอ่านเป็นข้อมูลรถด้วย → แถวรถรับช่องของแผลสุดท้าย + รถรอเข้า 102 คันถูกยกเป็น In Yard
 *  - เดิมขั้นลง Defect เขียนข้อมูลรถเปล่า (EXPECTED ไม่มีล็อต/Gate-in) ทับรถที่เครื่องยังไม่ได้โหลด
 */

const HEAD = ['No', 'Vin', 'Model', 'Stock of Status ', 'Category NG', 'Category (Repair)', 'Incharge', 'Date', 'Position', 'Defect', 'Status Repair', 'Repair Date']
const book = (sheets: Record<string, unknown[][]>) => {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  const buf: ArrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return { name: 'Defect_198 SEALION6.xlsx', arrayBuffer: async () => buf } as unknown as File
}
const defectRows = [
  HEAD,
  [1, 'LGXC74C49SG016595', 'SEALION 6', 'Soi 5', 'HEAVY NG', 'Re polishing', 'BYD', '24/10/2026', 'All Car', 'Polishing Stain', 'Repaired', '01/10/2026'],
  [2, 'LGXC74C49SG016595', 'SEALION 6', 'Soi 5', 'NG', 'Part', 'BYD', '24/10/2026', 'Front Windshield', 'Bubble', 'Accept', '02/11/2026'],
  [3, 'LGXC74C40SG012094', 'SEALION 6', 'EX-warehouse', 'NG', 'Re Dent', 'SJWD', '24/10/2026', 'Front Door LH', 'Dent', 'Waiting Repair', ''],
]

describe('ไฟล์ Co ที่มีแค่ชีต Defect-Yard', () => {
  it('อ่านเป็น Defect อย่างเดียว · ไม่มีแถวข้อมูลรถ (ไม่แตะสถานะ/ช่องของรถ)', async () => {
    const res = await parseTrackingWorkbook(book({ 'Defect-Yard': defectRows }))
    expect(res.rows).toHaveLength(0)
    expect(res.gateOutRows).toHaveLength(0)
    expect(res.defects).toHaveLength(3)
    expect(new Set(res.defects.map((d) => d.vin)).size).toBe(2)
  })

  it('ไฟล์ Co ปกติ (มีชีต Tracking Status + Defect-Yard) ยังอ่านข้อมูลรถจากชีต Tracking ตามเดิม', async () => {
    const res = await parseTrackingWorkbook(book({
      'Defect-Yard': defectRows,
      'Tracking Status': [['No', 'Vin', 'Model', 'Car Status'], [1, 'LGXC74C49SG016595', 'SEALION 6', 'In Yard']],
    }))
    expect(res.rows.map((r) => r.vin)).toEqual(['LGXC74C49SG016595'])
    expect(res.rows[0].cells['Position']).toBeUndefined()
    expect(res.defects).toHaveLength(3)
  })

  it('ไฟล์ย้ายยาร์ดที่ชีตชื่ออื่นแต่มีคอลัมน์ Vin ยังอ่านเป็นข้อมูลรถได้เหมือนเดิม', async () => {
    const res = await parseTrackingWorkbook(book({ Sheet1: [['No', 'Vin', 'Model name', 'Motor no.'], [1, 'LGXCE4CB0TG025160', 'BYD ATTO 3', 'M1']] }))
    expect(res.rows.map((r) => r.vin)).toEqual(['LGXCE4CB0TG025160'])
  })
})

describe('ขั้นลง Defect: รถที่เครื่องยังไม่ได้โหลด', () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock('../src/lib/db') })

  const setup = async (fetchUnitsByVins: (vins: string[]) => Promise<unknown[]>) => {
    vi.resetModules(); localStorage.clear()
    const written: { units: any[]; damages: any[] } = { units: [], damages: [] }
    vi.doMock('../src/lib/db', async (orig) => ({
      ...(await orig<object>()), isConfigured: () => true,
      fetchUnitsByVins,
      deleteDamages: async () => {},
      upsertUnitsKeepPlacement: async (us: any[]) => { written.units.push(...us) },
      upsertDamages: async (ds: any[]) => { written.damages.push(...ds) },
    }))
    const { useYard } = await import('../src/store/useYard')
    useYard.setState({ units: {}, currentSite: 'site-1-3d-rincha', sites: [{ id: 'site-1-3d-rincha', name: '3D RINCHA', code: '3D RINCHA', createdAt: 0 }] as any })
    const tracking = { LGXC74C40SG012094: { vin: 'LGXC74C40SG012094', site: 'site-1-3d-rincha', cells: { Vin: 'LGXC74C40SG012094', 'Car Status': 'Pre Gate-in' } } } as any
    const defects = [{ vin: 'LGXC74C40SG012094', position: 'Front Door LH', defect: 'Dent', source: 'yard', statusRepair: 'Waiting Repair' }] as any
    return { useYard, written, tracking, defects }
  }

  it('ดึงข้อมูลรถของยาร์ดนี้จากคลาวด์ก่อน แล้วเติม Defect ลงคันเดิม · สถานะ/ล็อต/Gate-in เดิมไม่ถูกทับ', async () => {
    const cloudCar = { vin: 'LGXC74C40SG012094', model: 'sealion6', modelName: 'BYD SEALION 6', color: 'WHITE', trailer: 0, status: 'PARKED', block: 'G', row: 4, slot: 7,
      lot: '(SOI 5 · 10-21 · SELF DRIVE · 248)', gateInAt: 1793842789462, gateInBy: 'วิไลภรณ์', site: 'site-1-3d-rincha', damages: [], importedAt: 1 }
    const { useYard, written, tracking, defects } = await setup(async () => [cloudCar])
    const res = await useYard.getState().importDefects(defects, tracking)
    expect(res).toMatchObject({ units: 0, unreachable: 0 })
    expect(written.units).toHaveLength(1)
    expect(written.units[0]).toMatchObject({ status: 'PARKED', lot: cloudCar.lot, gateInAt: cloudCar.gateInAt, gateInBy: 'วิไลภรณ์' })
    expect(written.damages).toHaveLength(1)
    expect(useYard.getState().units.LGXC74C40SG012094).toMatchObject({ status: 'PARKED', block: 'G', slot: 7 })
  })

  it('อ่านคลาวด์ไม่ได้ → ไม่เขียนอะไรของคันนั้นเลย และนับไว้ให้นำเข้าซ้ำ', async () => {
    const { useYard, written, tracking, defects } = await setup(async () => { throw new Error('offline') })
    const res = await useYard.getState().importDefects(defects, tracking)
    expect(res).toMatchObject({ unreachable: 1, damages: 0 })
    expect(written.units).toHaveLength(0)
    expect(written.damages).toHaveLength(0)
  })

  it('รถที่ไม่มีข้อมูลในยาร์ดนี้จริง ๆ ยังลงทะเบียนใหม่ได้ตามเดิม (รอเข้า = EXPECTED)', async () => {
    const { useYard, written, tracking, defects } = await setup(async () => [])
    const res = await useYard.getState().importDefects(defects, tracking)
    expect(res).toMatchObject({ units: 1, unreachable: 0, damages: 1 })
    expect(written.units[0]).toMatchObject({ vin: 'LGXC74C40SG012094', status: 'EXPECTED' })
  })
})
