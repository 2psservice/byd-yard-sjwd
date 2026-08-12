/**
 * Master-workbook sheets (Tracking Status + the three Defect sheets), shared
 * by the Report page's master export and the Daily Stock export. Every value
 * was measured 1:1 from the real master file so the output matches its fonts,
 * sizes, widths, heights and colours exactly — and can be re-imported.
 */
import type { TrackRow } from './excelTracking'
import type { Unit } from '../types'
import { agingPmDays } from './trackingColumns'
import { YARD_SHEET, FACTORY_SHEET, WHALE_SHEET, buildDefectSheet, type DefectExportRow } from './defectReport'

/** light blue header band used on the Vin Of Status → Stock of Status block */
const LIGHT_BLUE = { theme: 3, tint: 0.8999908444471572 }
/** light orange fill carried by every "Match Tax/Shuttle" data cell */
const LIGHT_ORANGE = { theme: 9, tint: 0.7999816888943144 }

interface TCol {
  h: string          // exact master header (incl. trailing spaces — trimmed for the cell lookup)
  w: number          // master column width
  hFill?: object     // header fill (absent = plain white like the master)
  dFill?: object     // per-column data fill
  left?: boolean     // left-aligned data (default is centred)
  hPlain?: boolean   // header NOT bold (the Motor/Engine/Model/Color/battery/company/Status block)
  noBorder?: boolean // the Move/PM/หมายเหตุ block carries no gridline borders
}

/** "Tracking Status" — all 66 master columns, in master order. */
const TRACKING_COLS: TCol[] = [
  { h: 'No', w: 7.13 },
  { h: 'Match Tax/Shuttle', w: 20.25, dFill: LIGHT_ORANGE },
  { h: 'Vin', w: 19.63 },
  { h: 'Model name', w: 22.25 },
  { h: 'Front Motor no.', w: 22.75, hPlain: true },
  { h: 'Rear Motor no.', w: 22.75, hPlain: true },
  { h: 'Engine No.', w: 18.13, hPlain: true },
  { h: 'Model Code', w: 17, hPlain: true },
  { h: 'Model', w: 12.75, hPlain: true },
  { h: 'Color', w: 11.75, hPlain: true },
  { h: 'battery', w: 26.25, hPlain: true },
  { h: 'company', w: 14.5, hPlain: true },
  { h: 'Status', w: 14.13, hPlain: true },
  { h: 'PDI', w: 11.75 },
  { h: 'RE PDI  Date #1', w: 11.88 },
  { h: 'RE PDI  Date #2', w: 12.13 },
  { h: 'RE PDI  Date #3', w: 11.88 },
  { h: 'RE PDI  Date #4', w: 11.88 },
  { h: 'RE PDI  Date #5', w: 11.88 },
  { h: 'RE PDI  Date #6', w: 18.13 },
  { h: 'RE PDI  Date #7', w: 11.88 },
  { h: 'RE PDI  Date #8', w: 11.88 },
  { h: 'OK date ', w: 12.25 },
  { h: 'PIC (PDI)', w: 12.25, hFill: { argb: 'FFFFC000' } },
  { h: 'Vin Of Status', w: 16.75, hFill: LIGHT_BLUE },
  { h: 'Gate In (Rayong yard)', w: 15.5, hFill: LIGHT_BLUE },
  { h: 'Final check date', w: 15.75, hFill: LIGHT_BLUE },
  { h: 'Final Status', w: 12.13, hFill: LIGHT_BLUE },
  { h: 'Location yard', w: 16.88, hFill: LIGHT_BLUE },
  { h: 'Status Tax', w: 20.25, hFill: LIGHT_BLUE },
  { h: 'Stock of Status ', w: 21.75, hFill: LIGHT_BLUE },
  { h: 'Gate Out time stamp', w: 22.75 },
  { h: 'Grouping  Number', w: 20.13 },
  { h: 'Allocation Date', w: 18.38 },
  { h: 'Dealer Code', w: 15.38 },
  { h: 'Dealer Location', w: 57.75, left: true },
  { h: 'Remark', w: 63.75 },
  { h: 'Tailer Company', w: 13.5 },
  { h: 'storage Yard', w: 10.25 },
  { h: 'Move from  1', w: 16.25, noBorder: true },
  { h: 'Transfer 1', w: 14.63, noBorder: true },
  { h: 'Move from  2', w: 16.25, noBorder: true },
  { h: 'Transfer 2', w: 14.63, noBorder: true },
  { h: 'Move from  3', w: 16.25, noBorder: true },
  { h: 'Transfer 3', w: 14.63, noBorder: true },
  { h: 'Move from  4', w: 16.25, noBorder: true },
  { h: 'Transfer 4', w: 14.63, noBorder: true },
  { h: 'Factory-Installed', w: 28.75, noBorder: true },
  { h: 'Accessories', w: 28.75, noBorder: true },
  { h: 'Aging PM', w: 11.75, noBorder: true },
  { h: 'PM1', w: 8.75, noBorder: true },
  { h: 'PM2', w: 8.75, noBorder: true },
  { h: 'PM3', w: 8.75, noBorder: true },
  { h: 'PM4', w: 8.75, noBorder: true },
  { h: 'PM5', w: 8.75, noBorder: true },
  { h: 'PM6', w: 9.75, noBorder: true },
  { h: 'PM7', w: 9.75, noBorder: true },
  { h: 'PM8', w: 9.63, noBorder: true },
  { h: 'PM9', w: 8.75, noBorder: true },
  { h: 'PM10', w: 8.75, noBorder: true },
  { h: 'PM11', w: 8.75, noBorder: true },
  { h: 'PM12', w: 8.75, noBorder: true },
  { h: 'PM13', w: 8.75, noBorder: true },
  { h: 'PM14', w: 8.75, noBorder: true },
  { h: 'PM15', w: 8.75, noBorder: true },
  { h: 'หมายเหตุ', w: 17.75, noBorder: true },
]

/** Split every damage into its defect sheet: factory / whale keep their import
 *  source; everything else (imported yard defects + in-app walk-around / PDI /
 *  mechanic / manual finds) is a yard-found defect → Defect-Yard. */
export function splitDefects(units: Unit[]) {
  const yard: DefectExportRow[] = []
  const factory: DefectExportRow[] = []
  const whale: DefectExportRow[] = []
  for (const u of units) {
    for (const dmg of u.damages) {
      const bucket = dmg.source === 'factoryDefect' ? factory : dmg.source === 'whaleDefect' ? whale : yard
      bucket.push({ unit: u, dmg })
    }
  }
  const byVinDate = (a: DefectExportRow, b: DefectExportRow) =>
    a.unit.vin.localeCompare(b.unit.vin) || a.dmg.at - b.dmg.at
  return { yard: yard.sort(byVinDate), factory: factory.sort(byVinDate), whale: whale.sort(byVinDate) }
}

/** Append the 4 master sheets (Tracking Status + Defect-Yard / -Factory /
 *  -Whale 28 rai) to an exceljs workbook. */
export function appendMasterSheets(wb: any, rows: TrackRow[], units: Unit[]) {
  const thinBorder = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
  const fill = (color: object) => ({ type: 'pattern', pattern: 'solid', fgColor: color })

  // ── "Tracking Status" — Tahoma 10, header 25.9 / rows 18.6, borders up to
  //    "storage Yard", coloured header blocks, tab green
  const ws = wb.addWorksheet('Tracking Status', {
    views: [{ state: 'frozen', ySplit: 1, zoomScale: 70, zoomScaleNormal: 70 }],
    properties: { tabColor: { argb: 'FF92D050' }, defaultRowHeight: 18.6, defaultColWidth: 8.75 },
  })
  ws.columns = TRACKING_COLS.map((c) => ({
    width: c.w,
    style: {
      font: { name: 'Tahoma', size: 10 },
      alignment: c.left ? { horizontal: 'left' } : { horizontal: 'center', vertical: 'middle' },
      ...(c.noBorder ? {} : { border: thinBorder }),
    },
  }))
  const hr = ws.addRow(TRACKING_COLS.map((c) => c.h))
  hr.height = 25.9
  hr.eachCell({ includeEmpty: true }, (cell: any, col: number) => {
    const spec = TRACKING_COLS[col - 1]
    cell.font = { name: 'Tahoma', size: 10, bold: !spec?.hPlain }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    if (spec?.hFill) cell.fill = fill(spec.hFill)
    if (spec && !spec.noBorder) cell.border = thinBorder
  })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TRACKING_COLS.length } }
  rows.forEach((r, i) => {
    const row = ws.addRow(TRACKING_COLS.map((c) => {
      const key = c.h.trim()
      return key === 'No' ? i + 1 : key === 'Vin' ? r.vin
        : key === 'Aging PM' ? agingPmDays(r.cells)
        : (r.cells[key] ?? '')
    }))
    row.height = 18.6
    TRACKING_COLS.forEach((c, ci) => { if (c.dFill) row.getCell(ci + 1).fill = fill(c.dFill) })
  })

  // ── defect sheets — Yard (Tahoma 11 / 21), Factory + Whale (Tahoma 8 / 13.5)
  const defectSplit = splitDefects(units)
  const trackByVin = new Map(rows.map((r) => [r.vin, r.cells]))
  buildDefectSheet(wb, YARD_SHEET, defectSplit.yard, trackByVin)
  buildDefectSheet(wb, FACTORY_SHEET, defectSplit.factory, trackByVin)
  buildDefectSheet(wb, WHALE_SHEET, defectSplit.whale, trackByVin)
}
