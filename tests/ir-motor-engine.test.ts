import { describe, expect, it } from 'vitest'
import { buildIrHtml, buildIrPaperHtml, engineNo, frontMotorNo, rearMotorNo, IRP_NUMBER_BOXES, type MeasureText } from '../src/lib/dnir'
import type { TrackRow } from '../src/lib/excelTracking'

/**
 * กระดาษ IR (ใบส่งมอบรถยนต์): เลข Front Motor · Rear Motor · Engine ลงช่องของตัวเอง
 *  - เดิมพิมพ์เป็นข้อความเดียวเริ่มที่ช่อง Front Motor: รถ DM-i เลขเครื่องยนต์ไปอยู่ช่อง Front Motor
 *    เลขมอเตอร์ล้นข้ามช่อง Rear Motor ไปช่อง Engine
 *  - รถที่เข้ามาด้วยไฟล์อื่น (หัวคอลัมน์ "Motor no." / "Engine No") ไม่ขึ้นเลขเลย
 */

const row = (cells: Record<string, string>): TrackRow => ({ vin: 'LGXC74C42SG016616', cells: { Vin: 'LGXC74C42SG016616', ...cells } })
/** the irpf field printed at x (left:Xpt) → [font size, text] */
const at = (html: string, x: number) => {
  const m = new RegExp(`class="irpf" style="left:${x}pt;top:[\\d.]+pt;font-size:([\\d.]+)pt">([^<]*)<`).exec(html)
  return m ? { size: Number(m[1]), text: m[2] } : null
}
const [FRONT, REAR, ENGINE] = IRP_NUMBER_BOXES

describe('กระดาษ IR · เลขมอเตอร์ / เลขเครื่องยนต์', () => {
  it('DM-i: มอเตอร์อยู่ช่อง Front Motor · เครื่องยนต์อยู่ช่อง Engine · Rear Motor ว่าง', () => {
    const html = buildIrPaperHtml([row({ 'Front Motor no.': 'TZ220XYE 3G4157160', 'Engine No.': 'BYD472QA 425006618' })], '3D RINCHA')
    expect(at(html, FRONT.x)?.text).toBe('TZ220XYE 3G4157160')
    expect(at(html, ENGINE.x)?.text).toBe('BYD472QA 425006618')
    expect(at(html, REAR.x)).toBeNull()
    // the two numbers are no longer glued together into one string
    expect(html).not.toContain('425006618 TZ220XYE')
  })

  it('AWD: มอเตอร์หน้าและหลังแยกช่อง · EV ไม่มีเลขเครื่องยนต์ ช่อง Engine ว่าง', () => {
    const html = buildIrPaperHtml([row({ 'Front Motor no.': 'TZ200XSQ 1A2B3C4D', 'Rear Motor no.': 'TZ180XYF 9Z8Y7X6W' })])
    expect(at(html, FRONT.x)?.text).toBe('TZ200XSQ 1A2B3C4D')
    expect(at(html, REAR.x)?.text).toBe('TZ180XYF 9Z8Y7X6W')
    expect(at(html, ENGINE.x)).toBeNull()
  })

  it('หัวคอลัมน์จากไฟล์อื่นก็อ่านได้: "Motor no." (ไฟล์ย้ายยาร์ด) · "Engine No" · "Motor Number"', () => {
    const transfer = row({ 'Motor no.': 'TZ220XYE 3G4150001', 'Engine No.': 'BYD472QA 425000001' })
    expect(frontMotorNo(transfer)).toBe('TZ220XYE 3G4150001')
    const vinList = row({ 'Engine No': 'BYD472QA 425000002', 'Motor Number': 'TZ220XYE 3G4150002' })
    expect(engineNo(vinList)).toBe('BYD472QA 425000002')
    expect(frontMotorNo(vinList)).toBe('TZ220XYE 3G4150002')
    expect(rearMotorNo(row({ 'Rear Motor No': 'TZ180XYF 1' }))).toBe('TZ180XYF 1')
    // a column that only mentions the motor is not a motor number
    expect(frontMotorNo(row({ 'Motor Type': 'PMSM' }))).toBe('')
  })

  it('ค่าขึ้นต้นด้วย "-" ตัดออก · "-" อย่างเดียวถือว่าว่าง', () => {
    expect(frontMotorNo(row({ 'Front Motor no.': '- TZ200XSQ 1' }))).toBe('TZ200XSQ 1')
    expect(engineNo(row({ 'Engine No.': '-' }))).toBe('')
  })

  it('เลขยาวเกินช่อง ตัวเล็กลงให้พอดีช่อง ไม่ล้นไปช่องข้าง ๆ', () => {
    const perChar = 4.6 // 12pt TH Sarabun New, capitals + digits, roughly
    const measure: MeasureText = (s) => s.length * perChar
    const html = buildIrPaperHtml([row({ 'Front Motor no.': 'TZ220XYE 3G4157160', 'Rear Motor no.': 'TZ180XYF 3G4150000', 'Engine No.': 'BYD472QA 425006618' })], '', undefined, measure)
    for (const b of IRP_NUMBER_BOXES) {
      const f = at(html, b.x)!
      const width = (f.text.length * perChar * f.size) / 12
      expect(width <= b.max || f.size === 7).toBe(true)
    }
    expect(at(html, ENGINE.x)!.size).toBe(12) // fits as is
  })

  it('IR ฟอร์ม AMS (ช่องเดียว) ยังพิมพ์เครื่องยนต์ + มอเตอร์ เหมือนเดิม และอ่านหัวคอลัมน์แบบอื่นได้', () => {
    expect(buildIrHtml([row({ 'Engine No.': 'BYD472QA 425006618', 'Front Motor no.': 'TZ220XYE 3G4157160' })])).toContain('>BYD472QA 425006618 TZ220XYE 3G4157160<')
    expect(buildIrHtml([row({ 'Motor no.': 'TZ220XYE 3G4150001' })])).toContain('>TZ220XYE 3G4150001<')
  })
})
