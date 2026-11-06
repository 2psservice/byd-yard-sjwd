import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupColumns, backupFileName, tallyYard, yardCsv, yardUnitList } from '../src/lib/unitBackup'
import { trackRowsCsvText } from '../src/lib/excelTracking'
import { defaultColumns, LOCATION_KEY } from '../src/lib/trackingColumns'

/**
 * สำรองข้อมูลหน้า Unit ทุกยาร์ดเข้าอีเมลทุกเที่ยงคืน
 *  - ไฟล์ของแต่ละยาร์ด = ไฟล์ที่ปุ่ม CSV หน้า Unit ออกให้ที่ยาร์ดนั้น (ไม่กรอง)
 *  - รถของยาร์ดตามกติกาเดียวกับหน้า Unit · Final Status / Vin Of Status ตามแผลจริง · Location จากช่องจอดในยาร์ดนั้น
 */

const S1 = 'site-60rai', S2 = 'site-3d'
const sites = [{ id: S1, name: '60 RAI', code: '60RAI', createdAt: 0 }, { id: S2, name: '3D RINCHA', code: '3D RINCHA', createdAt: 0 }]
const row = (vin: string, site: string | undefined, cells: Record<string, string> = {}) => ({ vin, site, cells: { Vin: vin, 'Car Status': 'In Yard', PDI: '05/11/2026', ...cells } })
const rows = [
  row('LVIN000000000001', S1),
  row('LVIN000000000002', S1, { 'Final Status': 'OK-Accept', Remark: '=1+1, "x"' }),
  row('LVIN000000000003', S2),
  row('LVIN000000000004', undefined, { 'Location yard': '60 RAI' }), // legacy, not tagged yet
  row('LVIN000000000005', undefined, { 'Car Status': 'Pre Gate-in', 'Candidate Sites': `${S1},${S2}` }), // shared shuttle
]
const units = {
  LVIN000000000001: { block: 'AA', row: 3, slot: 12, damages: [{ id: 'd1', area: 'Rear Bumper', type: 'dent', item: 'Dent', severity: 'minor' as const, at: 0, by: 'qc', statusRepair: 'Waiting Repair' as const }] },
  LVIN000000000002: { block: 'WCL', row: 1, slot: 4, damages: [] },
}

describe('รถของยาร์ด · สถานะตามแผล · Location', () => {
  it('ได้รถของยาร์ดนี้ + แถวเก่าที่ระบุยาร์ดนี้ + รถรอเข้าแบบแชร์ · ไม่ปนรถยาร์ดอื่น', () => {
    expect(yardUnitList(sites[0], sites, rows, units).map((r) => r.vin)).toEqual(['LVIN000000000001', 'LVIN000000000002', 'LVIN000000000004', 'LVIN000000000005'])
    expect(yardUnitList(sites[1], sites, rows, {}).map((r) => r.vin)).toEqual(['LVIN000000000003', 'LVIN000000000005'])
  })

  it('แผลค้าง → Waiting Repair / NG เหมือนบนจอ · Location = บล็อก+ช่อง+คันที่ · ไม่มีที่จอด = ว่าง', () => {
    const [a, b, , legacy] = yardUnitList(sites[0], sites, rows, units)
    expect(a.cells).toMatchObject({ 'Final Status': 'Waiting Repair', 'Vin Of Status': 'NG', [LOCATION_KEY]: 'A1203' })
    expect(b.cells).toMatchObject({ 'Final Status': 'OK-Accept', [LOCATION_KEY]: 'WCL0401' })
    expect(legacy.cells[LOCATION_KEY]).toBe('')
  })
})

describe('ไฟล์ CSV', () => {
  it('ไม่มีมุมมองบนคลาวด์ → คอลัมน์มาตรฐานที่เปิดอยู่ · มี → ตามมุมมองนั้น (ลำดับ + ที่ซ่อน)', () => {
    expect(backupColumns(undefined).map((c) => c.key)).toEqual(defaultColumns().filter((c) => c.visible).map((c) => c.key))
    const saved = defaultColumns().map((c) => ({ ...c, visible: ['Vin', LOCATION_KEY, 'Final Status'].includes(c.key) }))
    saved.unshift(saved.splice(saved.findIndex((c) => c.key === 'Final Status'), 1)[0])
    expect(backupColumns(saved).map((c) => c.label)).toEqual(['Final Status', 'Vin', 'Location'])
  })

  it('เหมือนไฟล์จากปุ่ม CSV หน้า Unit: BOM · หัวคอลัมน์ตามชื่อ · กันสูตร Excel · ใส่ "" เมื่อมี , หรือ "', () => {
    const cols = backupColumns(defaultColumns().map((c) => ({ ...c, visible: ['Vin', LOCATION_KEY, 'Remark'].includes(c.key) })))
    const list = yardUnitList(sites[0], sites, rows, units)
    const csv = yardCsv(cols, list)
    expect(csv).toBe(trackRowsCsvText(cols, list))
    const lines = csv.split('\n')
    expect(lines[0]).toBe('﻿Vin,Location,Remark')
    expect(lines[1]).toBe('LVIN000000000001,A1203,')
    expect(lines[2]).toBe(`LVIN000000000002,WCL0401,"'=1+1, ""x"""`)
  })

  it('นับต่อยาร์ด: ในลาน · Pre Gate-in · อื่น ๆ · ชื่อไฟล์อ่านง่าย', () => {
    expect(tallyYard(yardUnitList(sites[0], sites, rows, units))).toEqual({ total: 4, inYard: 3, preGateIn: 1, other: 0 })
    expect(backupFileName(sites[1], '2026-11-07')).toBe('SJWD_3D_RINCHA_2026-11-07.csv')
    expect(backupFileName({ id: 'x', name: ' ลาน/ใหม่ #2 ', createdAt: 0 }, '2026-11-07')).toBe('SJWD_ลาน_ใหม่_2_2026-11-07.csv')
  })
})

describe('สคริปต์ที่ GitHub รันตอนเที่ยงคืน', () => {
  it('ไม่ดึงตัวเชื่อมคลาวด์ / store / React ของแอปเข้ามา (Node บน GitHub ไม่มี WebSocket ให้ตัวเชื่อม realtime)', () => {
    // the same esbuild command the workflow runs (as a separate process: esbuild cannot run inside jsdom)
    const dir = mkdtempSync(join(tmpdir(), 'unit-backup-'))
    execFileSync(join('node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'), ['scripts/daily-unit-csv.ts', '--bundle', '--platform=node', '--format=esm', '--target=node20',
      `--outfile=${join(dir, 'run.mjs')}`, `--metafile=${join(dir, 'meta.json')}`, '--log-level=error'])
    const inputs = Object.keys(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).inputs)
    expect(inputs).toContain('src/lib/unitBackup.ts')
    expect(inputs.filter((f) => /supabase|lib\/db\.ts|src\/store\/|src\/components\/|node_modules\/react/.test(f))).toEqual([])
  })
})
