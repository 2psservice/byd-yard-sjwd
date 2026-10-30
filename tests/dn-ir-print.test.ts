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

describe('IR: Delivery From = Site งานที่พิมพ์', () => {
  it('ช่อง Location yard ของรถเป็นยาร์ดอื่น (Rayone yard) → พิมพ์ชื่อ Site ที่กำลังพิมพ์', () => {
    const r = row('LGXCE4CB4TG041586', { 'Location yard': 'Rayone yard' })
    for (const html of [buildIrHtml([r], 'NYB2 Phase 2'), buildIrPaperHtml([r], 'NYB2 Phase 2')]) {
      expect(html).toContain('>NYB2 Phase 2<')
      expect(html).not.toContain('Rayone yard')
    }
  })
  it('ไม่ได้เลือก Site → ใช้ช่อง Location yard ของรถตามเดิม', () => {
    const r = row('LGXCE4CB4TG041586', { 'Location yard': 'Rayone yard' })
    expect(buildIrPaperHtml([r], '')).toContain('>Rayone yard<')
  })
})

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
  it('8 แถวปกติยังอยู่ใบเดียว', () => {
    const normal = Array.from({ length: 8 }, (_, i) => row(`N${i}`, { 'Dealer Location': 'Jinlong Motors Co., Ltd.' }))
    expect(buildDnHtml(normal, () => 'G1', undefined, mono).match(/class="dn-sheet"/g)).toHaveLength(1)
  })
})

describe('DN: 1 Grouping = 1 แผ่น (28/10 North Star 8 คัน ชื่อดีลเลอร์ยาว 3 บรรทัด แยกเป็น 2 แผ่น)', () => {
  const sheetsOf = (html: string) => html.split('class="dn-sheet"').slice(1)
  it('8 คันที่ปลายทางยาว 3 บรรทัด: อยู่แผ่นเดียว · ช่องยาวใช้ตัวเล็กลง แถวสูงเท่าแถวปกติ', () => {
    const tall = Array.from({ length: 8 }, (_, i) => row(`T${i}`, { 'Dealer Location': 'North Star Automotive Lamphun Co., Ltd. (Lamphun)' }))
    const html = buildDnHtml(tall, () => 'SJWD261028-021', undefined, mono)
    const sheets = sheetsOf(html)
    expect(sheets).toHaveLength(1)
    expect((sheets[0].match(/>T\d</g) ?? []).length).toBe(8)
    expect(sheets[0]).toContain('>8<')
    // every destination cell drops to a smaller face that still holds all 3 lines
    expect(sheets[0].match(/font-size:(?:11|10|9)pt;line-height:[\d.]+pt">North Star Automotive Lamphun/g)).toHaveLength(8)
    const lines = hLines(html)
    // header top + 8 row tops + table bottom, every row the standard 43.945pt
    expect(lines).toHaveLength(10)
    for (let i = 1; i < lines.length - 1; i++) expect(lines[i + 1] - lines[i]).toBeCloseTo(43.945, 1)
  })

  it('ปนกัน (ปลายทางสั้น + ยาว) 8 คัน: แผ่นเดียว · ช่องสั้นยังเป็นตัวปกติ', () => {
    const mixed = Array.from({ length: 8 }, (_, i) => row(`M${i}`, {
      'Dealer Location': i < 5 ? 'North Star Automotive Lamphun Co., Ltd. (Lamphun)' : 'Hi-Class Auto Co., Ltd.',
    }))
    const html = buildDnHtml(mixed, () => 'SJWD261028-020', undefined, mono)
    expect(sheetsOf(html)).toHaveLength(1)
    expect(html.match(/line-height:[\d.]+pt">North Star/g)).toHaveLength(5)
    expect(html).not.toMatch(/line-height:[\d.]+pt">Hi-Class/)
  })

  it('กลุ่มที่ไม่ล้นหน้า: ตัวปกติ 12pt แถวยาวลงตามเดิม (ไม่ย่อโดยไม่จำเป็น)', () => {
    const html = buildDnHtml([row('A1', { 'Dealer Location': 'North Star Automotive Lamphun Co., Ltd. (Lamphun)' })], () => 'G', undefined, mono)
    expect(html).not.toMatch(/font-size:(?:11|10|9)pt;line-height/)
    const lines = hLines(html)
    expect(lines[2] - lines[1]).toBeCloseTo(43.945 + 15.61, 1)
  })

  it('เกิน 8 คัน: ยังต่อแผ่นที่ 2 เลขลำดับต่อกัน (ข้อจำกัดของหน้ากระดาษ)', () => {
    const nine = Array.from({ length: 9 }, (_, i) => row(`K${i}`, { 'Dealer Location': 'Hi-Class Auto Co., Ltd.' }))
    const sheets = sheetsOf(buildDnHtml(nine, () => 'G9', undefined, mono))
    expect(sheets).toHaveLength(2)
    expect((sheets[0].match(/>K\d</g) ?? []).length).toBe(8)
    expect(sheets[1]).toContain('>9<')
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
