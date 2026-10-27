import { describe, expect, it } from 'vitest'
import { printRowFor, type GroupPrintRow } from '../src/lib/groupingPrint'
import { buildIrHtml, buildDnHtml } from '../src/lib/dnir'
import { GATE_OUT_ORIGIN_SITE_KEY, GATE_OUT_ORIGIN_AT_KEY } from '../src/lib/carStatus'
import { TRIPS_CELL } from '../src/lib/tripHistory'
import type { TrackRow } from '../src/lib/excelTracking'
import type { Site } from '../src/types'

/**
 * Grouping · พิมพ์ DN / IR: ทุกคันในใบ Grouping ต้องพิมพ์ได้ — 27/10 3D LCB ติ๊ก 6 คันที่ Location ไม่พบ
 * ปุ่มพิมพ์เป็นสีเทา · ไม่ติ๊กก็ออกแค่คันเดียวที่มีแถวในยาร์ดนี้
 */

const sites = [{ id: 'S3D', name: '3D LCB' }, { id: 'S60', name: '60 Rai' }] as Site[]
const sheet = (vin: string, over: Partial<GroupPrintRow> = {}): GroupPrintRow => ({
  no: 1, vin, modelName: '', model: 'ATTO 2', color: 'GREY', deliveryLocation: 'CG Automotive Co., Ltd. (Praditmanutham)',
  grouping: 'SJWD261027-011', groupUnit: 2, yardLocation: '', laneLoad: 'O2', receiveDate: '', remark: '', ...over,
})

describe('Grouping: DN / IR พิมพ์ได้ทุกคันในใบ', () => {
  it('แถวของยาร์ดนี้มาก่อน', () => {
    const own: TrackRow = { vin: 'V1', site: 'S3D', cells: { Vin: 'V1', 'Engine No.': 'E-OWN' } }
    const other: TrackRow = { vin: 'V1', site: 'S60', cells: { Vin: 'V1', 'Engine No.': 'E-OTHER' } }
    expect(printRowFor(sheet('V1'), own, other, 'S3D', sites)).toBe(own)
  })

  it('รถที่ยาร์ดนี้ยิงออกไปแล้ว แถวย้ายไปยาร์ดถัดไป: พิมพ์ข้อมูลรอบที่อยู่ยาร์ดนี้ ชื่อยาร์ดเป็นยาร์ดนี้', () => {
    const left = new Date(2026, 9, 27, 9, 0).getTime()
    const trip = { round: 1, gateIn: '', gateOut: '', yard: '3D LCB', lot: '', grouping: 'SJWD261027-011', closedAt: left,
      cells: { 'Gate Out Time': String(left), 'Grouping  Number': 'SJWD261027-011' } }
    const moved: TrackRow = { vin: 'V2', site: 'S60', cells: {
      Vin: 'V2', 'Model name': 'BYD ATTO 2 (DYNAMIC)', 'Engine No.': 'E-2', Color: 'GREY', 'Location yard': '60 Rai',
      [GATE_OUT_ORIGIN_SITE_KEY]: 'S3D', [GATE_OUT_ORIGIN_AT_KEY]: String(left), [TRIPS_CELL]: JSON.stringify([trip]),
    } }
    const row = printRowFor(sheet('V2'), undefined, moved, 'S3D', sites)
    expect(row.cells['Location yard']).toBe('3D LCB')
    expect(row.cells['Engine No.']).toBe('E-2')
    const ir = buildIrHtml([row], '3D LCB', () => 'CG Automotive Co., Ltd. (Praditmanutham)')
    expect(ir).toContain('>V2<')
    expect(ir).toContain('>3D LCB<')
    expect(ir).toContain('E-2')
  })

  it('แถวอยู่ยาร์ดอื่น ไม่เคยออกจากยาร์ดนี้: พิมพ์จากแถวนั้นแบบอ่านอย่างเดียว', () => {
    const other: TrackRow = { vin: 'V3', site: 'S60', cells: { Vin: 'V3', 'Engine No.': 'E-3', Color: 'WHITE' } }
    const row = printRowFor(sheet('V3'), undefined, other, 'S3D', sites)
    expect(row).toBe(other)
  })

  it('ไม่มีแถวที่ไหนเลย: พิมพ์จาก Model / Color / ปลายทาง / Grouping ในแผน', () => {
    const row = printRowFor(sheet('V4'), undefined, undefined, 'S3D', sites)
    expect(row.cells).toMatchObject({ Model: 'ATTO 2', 'Model name': 'ATTO 2', Color: 'GREY', 'Grouping  Number': 'SJWD261027-011' })
    const dn = buildDnHtml([row], () => 'SJWD261027-011', undefined, (s) => s.length * 5)
    expect(dn).toContain('Grouping : SJWD261027-011')
    expect(dn).toContain('CG Automotive')
    expect(dn).toContain('ATTO 2')
  })
})
