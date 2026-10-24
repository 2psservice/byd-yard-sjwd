/**
 * EV Charging → Excel ในรูปแบบไฟล์ที่หน้างานใช้อยู่:
 *   No · From · Vin Number · Model Name · Color Name · Photo (Export Label / Before / After) · Date · Remark
 * ต่อท้ายด้วยช่องของงานชาร์จ: % ก่อน/หลัง · เวลาเริ่ม/เสร็จ · เวลาชาร์จ · ผู้บันทึก
 * + ชีตสรุปรายวัน (วันละกี่คัน · คันละกี่ชั่วโมง) · รูปฝังในเซลล์เหมือนรายงาน Defect
 */
import { chargeMs, dailySummary, type EvCharge } from './evCharging'
import { photoImageId, colLetter, downloadBlob } from './defectReport'

const HEAD_FIXED = ['No', 'From', 'Vin Number', 'Model Name', 'Color Name']
const PHOTO_HEADS = ['Export Label', 'Before', 'After']
const HEAD_TAIL = ['Date', 'Remark', 'Before %', 'After %', 'Start', 'Finish', 'Charge Time (h:mm)', 'Start By', 'Finish By']
const WIDTHS = [7, 10, 24, 14, 13, 30, 30, 30, 13, 24, 10, 10, 15, 15, 13, 14, 14]
const PHOTO_COL0 = HEAD_FIXED.length            // 0-based column of Export Label
const BLUE = 'FFDDEBF7'                          // body rows (template's light blue)
const IMG_W = 210
const IMG_H = 158
const THIN = { style: 'thin' as const }
const border = { top: THIN, left: THIN, bottom: THIN, right: THIN }
const DAY_MS = 86_400_000

/** exceljs writes Date as UTC — pin the LOCAL wall-clock so the cell shows the time the yard saw */
function localCell(ts: number): Date {
  const d = new Date(ts)
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()))
}

export async function exportEvChargingExcel(list: EvCharge[], filename: string): Promise<void> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const cache = new Map<string, Promise<number | null>>()
  const rows = [...list].sort((a, b) => a.beforeAt - b.beforeAt)

  const ws = wb.addWorksheet('EV Charging', {
    views: [{ state: 'frozen', ySplit: 2, zoomScale: 80, zoomScaleNormal: 80 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  ws.columns = WIDTHS.map((width) => ({ width }))
  const nCols = WIDTHS.length
  const lastPhoto = PHOTO_COL0 + PHOTO_HEADS.length // 1-based index of the band's last column

  const h1 = ws.addRow([...HEAD_FIXED, 'Photo', '', '', ...HEAD_TAIL]); h1.height = 22
  const h2 = ws.addRow([...HEAD_FIXED.map(() => ''), ...PHOTO_HEADS, ...HEAD_TAIL.map(() => '')]); h2.height = 22
  for (let c = 1; c <= nCols; c++) if (c <= PHOTO_COL0 || c > lastPhoto) ws.mergeCells(`${colLetter(c)}1:${colLetter(c)}2`)
  ws.mergeCells(`${colLetter(PHOTO_COL0 + 1)}1:${colLetter(lastPhoto)}1`)
  for (const row of [h1, h2]) row.eachCell({ includeEmpty: true }, (cell: any) => {
    cell.font = { name: 'Arial', size: 11, bold: true }
    cell.border = border
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })

  const places: { id: Promise<number | null>; col: number; row: number }[] = []
  rows.forEach((c, i) => {
    const ms = c.afterAt ? chargeMs(c) : 0
    const row = ws.addRow([
      i + 1, c.from, c.vin, c.model, c.color,
      '', '', '',
      c.beforeAt ? localCell(c.beforeAt) : '',
      c.remark,
      c.beforePct ?? '', c.afterPct ?? '',
      c.beforeAt ? localCell(c.beforeAt) : '',
      c.afterAt ? localCell(c.afterAt) : 'กำลังชาร์จ',
      ms ? ms / DAY_MS : '',
      c.beforeBy, c.afterBy,
    ])
    row.height = 129
    row.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.font = { name: 'Arial', size: 11 }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } }
      cell.border = border
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    })
    row.getCell(9).numFmt = 'dd/mm/yy'
    row.getCell(13).numFmt = 'dd/mm/yy hh:mm'
    row.getCell(14).numFmt = 'dd/mm/yy hh:mm'
    row.getCell(15).numFmt = '[h]:mm'
    ;[c.vinPhoto, c.beforePhoto, c.afterPhoto].forEach((src, pi) => {
      if (src) places.push({ id: photoImageId(wb, src, cache), col: PHOTO_COL0 + pi, row: row.number - 1 })
    })
  })
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: nCols } }
  for (const pl of places) {
    const id = await pl.id
    if (id == null) continue
    ws.addImage(id, { tl: { col: pl.col + 0.04, row: pl.row + 0.04 }, ext: { width: IMG_W, height: IMG_H }, editAs: 'oneCell' })
  }

  // สรุปรายวัน: วันละกี่คัน + คันละกี่ชั่วโมง (นับรถที่ชาร์จเสร็จในวันนั้น)
  const sum = wb.addWorksheet('Daily Summary', { views: [{ state: 'frozen', ySplit: 1 }] })
  sum.columns = [16, 14, 14, 18, 18].map((width) => ({ width }))
  const sh = sum.addRow(['Date', 'Started', 'Finished', 'Avg / Car (h:mm)', 'Total (h:mm)'])
  sh.eachCell((cell: any) => {
    cell.font = { name: 'Arial', size: 11, bold: true }
    cell.border = border
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
  })
  for (const d of dailySummary(rows).reverse()) {
    const [y, m, dd] = d.day.split('-').map(Number)
    const r = sum.addRow([new Date(Date.UTC(y, m - 1, dd)), d.started, d.finished, d.finished ? d.avgMs / DAY_MS : '', d.totalMs ? d.totalMs / DAY_MS : ''])
    r.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.font = { name: 'Arial', size: 11 }
      cell.border = border
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
    })
    r.getCell(1).numFmt = 'dd/mm/yy'
    r.getCell(4).numFmt = '[h]:mm'
    r.getCell(5).numFmt = '[h]:mm'
  }

  const buf = await wb.xlsx.writeBuffer()
  downloadBlob(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename)
}
