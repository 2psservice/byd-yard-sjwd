import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { isVinHeader, parseImportWorkbook } from '../src/lib/excelTracking'

/** อัปโหลด Vin List Inventory: คอลัมน์เลขรถชื่อ "Vin no." ต้องอ่านได้เหมือน "Vin" */

const fileOf = (sheets: Record<string, unknown[][]>): File => {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  const buf: ArrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return { name: 'vin-list.xlsx', arrayBuffer: async () => buf } as unknown as File
}
const V1 = 'LGXCE4CC4T2283087'
const V2 = 'LC0CE4CB8TG037026'

describe('Vin no. column', () => {
  it('recognises every spelling of the VIN header', () => {
    for (const h of ['Vin', 'VIN', 'Vin no.', 'Vin No.', 'VIN NO', 'Vin Number', 'vin#']) expect(isVinHeader(h)).toBe(true)
    for (const h of ['Vin Of Status', 'Model', '', 'Location']) expect(isVinHeader(h)).toBe(false)
  })

  it('a sheet not named after a yard, with "Vin no.", imports instead of failing with "ไม่พบคอลัมน์ Vin"', async () => {
    const res = await parseImportWorkbook(fileOf({ Sheet1: [
      ['No', 'Vin no.', 'Model', 'Color', 'Gate In Date'],
      [1, V1, 'ATTO 1', 'WHITE', '02-Nov-26'],
      [2, V2, 'DOLPHIN', 'WHITE', '02-Nov-26'],
    ] }), [{ name: 'NYB2 Phase 2' }])
    expect(res.rows.map((r) => r.vin)).toEqual([V1, V2])
    expect(res.rows[0].cells['Vin']).toBe(V1)
    expect(res.rows[0].cells['Model']).toBe('ATTO 1')
    // one VIN column, not a stray "Vin no." beside it
    expect(res.headers).toContain('Vin')
    expect(res.headers).not.toContain('Vin no.')
  })

  it('a title row above the header is fine', async () => {
    const res = await parseImportWorkbook(fileOf({ Inventory: [
      ['VIN LIST INVENTORY 02 November 2026'],
      ['No', 'Vin no.', 'Model'],
      [1, V1, 'ATTO 1'],
    ] }), [])
    expect(res.rows.map((r) => r.vin)).toEqual([V1])
  })

  it('a sheet named after a yard reads "Vin no." as that yard\'s Pre Gate-in list', async () => {
    const res = await parseImportWorkbook(fileOf({ 'NYB2 Phase 2': [
      ['No', 'Vin no.', 'Model', 'Color', 'Gate In Date'],
      [1, V1, 'ATTO 1', 'WHITE', '02-Nov-26'],
    ] }), [{ name: 'NYB2 Phase 2' }])
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].cells['Vin']).toBe(V1)
    expect(res.rows[0].cells['Car Status']).toBe('Pre Gate-in')
    expect(res.rows[0].cells['Location yard']).toBe('NYB2 Phase 2')
  })

  it('a plain "Vin" sheet still imports exactly as before', async () => {
    const res = await parseImportWorkbook(fileOf({ Sheet1: [
      ['Vin', 'Model', 'Vin no.'],
      [V1, 'ATTO 1', 'old-ref'],
    ] }), [])
    expect(res.rows.map((r) => r.vin)).toEqual([V1])
    // "Vin" wins when both exist; the other column stays as it was
    expect(res.rows[0].cells['Vin no.']).toBe('old-ref')
  })
})
