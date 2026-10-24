import { describe, expect, it } from 'vitest'
import { buildDnHtml, buildIrPaperHtml, buildIrHtml, wrapLines, type MeasureText } from '../src/lib/dnir'
import { printedAt, printedValue } from '../src/lib/printMarks'
import type { TrackRow } from '../src/lib/excelTracking'

/** ใบ IR / DN: ปลายทางที่หน้า Grouping แสดงต้องขึ้นบนกระดาษ · ช่อง Destination ยาวต้องขยายแถวลง ไม่ตกขอบ */

const row = (vin: string, cells: Record<string, string> = {}): TrackRow =>
  ({ vin, cells: { Vin: vin, 'Model name': 'D9', Color: 'WHITE', 'Location yard': '60 RAI', ...cells } })
// fixed-width "font": 4.2pt per character, about TH Sarabun New 12pt's Latin average
const mono: MeasureText = (s) => s.length * 4.2

/** top (pt) of every horizontal table line on the first DN sheet */
const hLines = (html: string) => [...html.matchAll(/class="dnl" style="left:10\.00pt;top:([\d.]+)pt;width:574\.28pt/g)].map((m) => Number(m[1]))

describe('ปลายทางบนใบ IR / DN', () => {
  it('ช่อง Dealer Location ของรถว่าง → ใช้ปลายทางที่หน้า Grouping แสดง (กระดาษ IR, IR, DN)', () => {
    const r = row('LC0DF4CD1T0256227')
    const dest = () => 'CAC Premium Co.,Ltd. (Chonburi)'
    expect(buildIrPaperHtml([r], '60 RAI')).not.toContain('CAC Premium')
    expect(buildIrPaperHtml([r], '60 RAI', dest)).toContain('CAC Premium Co.,Ltd. (Chonburi)')
    expect(buildIrHtml([r], '60 RAI', dest)).toContain('CAC Premium Co.,Ltd. (Chonburi)')
    expect(buildDnHtml([r], () => 'SJWD26104-001', dest, mono)).toContain('CAC Premium Co.,Ltd. (Chonburi)')
  })
  it('หน้านั้นไม่รู้ปลายทาง → ใช้ช่อง Dealer Location ของรถเหมือนเดิม', () => {
    const r = row('V1', { 'Dealer Location': 'Jinlong Motors Co., Ltd. (Chaengwattana)' })
    expect(buildIrPaperHtml([r], '60 RAI', () => '')).toContain('Jinlong Motors Co., Ltd. (Chaengwattana)')
    expect(buildIrPaperHtml([r], '60 RAI')).toContain('Jinlong Motors Co., Ltd. (Chaengwattana)')
  })
  it('ได้แถวที่พิมพ์มาด้วย — หน้า Units ใช้ช่องของแถวนั้นก่อน แล้วค่อยแผน Grouping', () => {
    const r = row('V1', { 'Dealer Location': 'From Cell' })
    const html = buildIrPaperHtml([r], '60 RAI', (_vin, rr) => rr.cells['Dealer Location'] || 'From Plan')
    expect(html).toContain('From Cell')
    expect(html).not.toContain('From Plan')
  })
})

describe('DN: ช่อง Destination ยาว ขยายแถวลง', () => {
  it('ตัดบรรทัดที่ช่องว่างแบบเดียวกับเครื่องพิมพ์', () => {
    expect(wrapLines('Jinlong Motors Co., Ltd. (Chaengwattana)', 97.5, mono)).toBe(2)
    expect(wrapLines('Embassy Automotive Uttaradit Co., Ltd. (Uttaradit)', 97.5, mono)).toBe(3)
    expect(wrapLines('', 97.5, mono)).toBe(1)
  })
  it('ปลายทาง 2 บรรทัด = แถวสูงเท่าเดิม · 3 บรรทัด = สูงขึ้น 1 บรรทัด และเส้นตารางตามลงไป', () => {
    const two = row('A1', { 'Dealer Location': 'Jinlong Motors Co., Ltd. (Chaengwattana)' })
    const three = row('A2', { 'Dealer Location': 'Embassy Automotive Uttaradit Co., Ltd. (Uttaradit)' })
    const lines = hLines(buildDnHtml([two, three], () => 'G1', undefined, mono))
    // header top, row1 top, row2 top, table bottom
    expect(lines).toHaveLength(4)
    const h1 = lines[2] - lines[1], h2 = lines[3] - lines[2]
    expect(h1).toBeCloseTo(43.945, 1)
    expect(h2).toBeCloseTo(43.945 + 15.61, 1)
  })
  it('8 แถวปกติยังอยู่ใบเดียว · ถ้าแถวสูงขึ้นจนเกินหน้า ขึ้นใบใหม่ เลขลำดับต่อกัน', () => {
    const normal = Array.from({ length: 8 }, (_, i) => row(`N${i}`, { 'Dealer Location': 'Jinlong Motors Co., Ltd.' }))
    expect(buildDnHtml(normal, () => 'G1', undefined, mono).match(/class="dn-sheet"/g)).toHaveLength(1)
    const tall = Array.from({ length: 8 }, (_, i) => row(`T${i}`, { 'Dealer Location': 'Embassy Automotive Uttaradit Co., Ltd. (Uttaradit)' }))
    const html = buildDnHtml(tall, () => 'G2', undefined, mono)
    const sheets = html.split('class="dn-sheet"').slice(1)
    expect(sheets.length).toBe(2)
    // 8 × 43.945 = 351.56pt of table per sheet → 5 rows of 59.555pt fit, the rest continue with Seq 6…
    expect((sheets[0].match(/>T\d</g) ?? []).length).toBe(5)
    expect(sheets[1]).toContain('>6<')
  })
})

describe('เครื่องหมาย "พิมพ์แล้ว"', () => {
  it('นับเฉพาะ Grouping ที่พิมพ์ไว้ — ย้ายไปรอบอื่นแล้วต้องพิมพ์ใหม่', () => {
    const at = new Date(2026, 9, 24, 13, 56).getTime()
    const cells = { 'DN Printed': printedValue('SJWD26104-006', at) }
    expect(cells['DN Printed']).toBe('SJWD26104-006 · 24/10/26 13:56')
    expect(printedAt(cells, 'dn', 'SJWD26104-006')).toBe('24/10/26 13:56')
    expect(printedAt(cells, 'dn', 'SJWD26104-007')).toBeNull()
    expect(printedAt(cells, 'ir', 'SJWD26104-006')).toBeNull()
    expect(printedAt({ 'IR Printed': printedValue('', at) }, 'ir', '')).toBe('24/10/26 13:56')
  })
})
