/**
 * EV Charging → Excel ในรูปแบบไฟล์ "Plan ชาร์จแบต" ที่หน้างานส่ง BYD (3 ชีต เหมือนไฟล์ต้นแบบ):
 *   1. UPDATE-%SOC <ยาร์ด>-<รุ่น> — Plan / Actual รายวัน · TTL · Diff (เป็นสูตร Excel)
 *   2. Plan <จำนวน>              — รายชื่อรถตามแผน: Location · วันที่ชาร์จ · % ก่อน/หลัง · หมายเหตุ
 *   3. รูปชาร์จแบต               — รูปเลขวิน + รูปหน้าปัด ก่อน/หลัง · %SOC / เวลา · ผลต่าง
 * แผน = รถรุ่นที่เลือกในยาร์ดนี้ (+ รถรุ่นนั้นที่ชาร์จในช่วงแต่ออกจากลานไปแล้ว) · วันละ N คันนับจากวันเริ่มแผน
 * Actual = รถที่ชาร์จเสร็จ นับคันละครั้ง (รอบแรกที่เสร็จในช่วง) ตามวันที่เริ่มชาร์จ
 */
import { fmtEvTime, isCharging, type EvCharge } from './evCharging'
import { addDays, dateKey } from './dayKey'
import { byYardLocation } from './groupingImport'
import { photoImageId, colLetter, downloadBlob } from './defectReport'

export interface EvPlanCar {
  vin: string
  model: string
  /** ชื่อรุ่นย่อยจากช่อง Model name ("EXTENDED") — บรรทัดที่สองของช่อง Model ในชีตแรก */
  variant: string
  color: string
  /** "N-A34" (prefix ยาร์ด + block + ช่อง) — ว่างเมื่อรถไม่ได้จอดในผังแล้ว */
  location: string
  from: string
}

export interface EvPlanModel {
  model: string
  variant: string
  qty: number
  plan: number[]
  actual: number[]
}

export interface EvPlan {
  /** วันที่ของแต่ละคอลัมน์ (yyyy-mm-dd) ติดกันทุกวัน */
  days: string[]
  models: EvPlanModel[]
}

/** ชื่อรุ่นย่อย: "BYD M6 EXTENDED" กับรุ่น "M6 (7-SEATS)" → "EXTENDED" · ว่างเมื่อไม่ได้บอกอะไรเพิ่ม */
export function modelVariant(model: string, modelName: string): string {
  const m = model.trim().toUpperCase()
  let n = modelName.replace(/^BYD\s+/i, '').trim().toUpperCase()
  if (!n || n === m) return ''
  const head = m.split(/\s+/)[0]
  if (m && n.startsWith(m)) n = n.slice(m.length)
  else if (head && n.startsWith(head + ' ')) n = n.slice(head.length)
  return n.trim()
}

/** รอบชาร์จที่เสร็จรอบแรกของแต่ละคัน (ในรายการที่ส่งมา) */
function firstFinished(charges: EvCharge[]): Map<string, EvCharge> {
  const out = new Map<string, EvCharge>()
  for (const c of [...charges].sort((a, b) => a.beforeAt - b.beforeAt)) {
    if (!isCharging(c) && !out.has(c.vin)) out.set(c.vin, c)
  }
  return out
}

/**
 * รายชื่อรถตามแผน: รถในลาน (rows) รุ่นที่เลือก + รถรุ่นนั้นที่มีรอบชาร์จในช่วงแต่ไม่อยู่ในลานแล้ว
 * เรียงตาม Location แบบที่คนขับเดินในลาน (รถที่ไม่มีตำแหน่งอยู่ท้าย)
 */
export function evPlanCars(
  models: string[],
  rows: { vin: string; model: string; modelName: string; color: string; from: string }[],
  charges: EvCharge[],
  locOf: (vin: string) => string,
): EvPlanCar[] {
  const want = new Set(models)
  const byVin = new Map<string, EvPlanCar>()
  for (const r of rows) {
    if (!want.has(r.model) || byVin.has(r.vin)) continue
    byVin.set(r.vin, { vin: r.vin, model: r.model, variant: modelVariant(r.model, r.modelName), color: r.color, location: locOf(r.vin), from: r.from })
  }
  for (const c of charges) {
    if (!want.has(c.model) || byVin.has(c.vin)) continue
    byVin.set(c.vin, { vin: c.vin, model: c.model, variant: '', color: c.color, location: locOf(c.vin), from: c.from })
  }
  return [...byVin.values()].sort((a, b) => byYardLocation(a.location, b.location) || a.vin.localeCompare(b.vin))
}

/** ตาราง Plan / Actual รายวันต่อรุ่น — คอลัมน์วันเริ่มที่วันเริ่มแผน (หรือวันที่ชาร์จจริงวันแรกถ้าก่อนกว่า)
 *  ไปจนถึงวันสุดท้ายของแผนหรือวันสุดท้ายที่ชาร์จจริง แล้วแต่อันไหนหลังกว่า */
export function buildEvPlan(cars: EvPlanCar[], charges: EvCharge[], perDay: number, start: string): EvPlan {
  const rate = Math.max(1, Math.floor(perDay) || 1)
  const order: string[] = []
  const carsOf = new Map<string, EvPlanCar[]>()
  for (const c of cars) {
    if (!carsOf.has(c.model)) { carsOf.set(c.model, []); order.push(c.model) }
    carsOf.get(c.model)!.push(c)
  }
  const modelOfVin = new Map(cars.map((c) => [c.vin, c.model]))
  const done = [...firstFinished(charges).values()].filter((c) => modelOfVin.has(c.vin))
  const doneDays = done.map((c) => dateKey(new Date(c.beforeAt))).sort()

  const longest = Math.max(0, ...order.map((m) => Math.ceil(carsOf.get(m)!.length / rate)))
  let first = start
  let last = longest ? addDays(start, longest - 1) : start
  if (doneDays.length) {
    if (doneDays[0] < first) first = doneDays[0]
    if (doneDays[doneDays.length - 1] > last) last = doneDays[doneDays.length - 1]
  }
  const days: string[] = []
  for (let d = first; d <= last && days.length < 400; d = addDays(d, 1)) days.push(d)
  const at = new Map(days.map((d, i) => [d, i]))

  const models = order.map((model): EvPlanModel => {
    const list = carsOf.get(model)!
    const plan = days.map(() => 0)
    let left = list.length
    for (let i = at.get(start) ?? 0; i < days.length && left > 0; i++) { plan[i] = Math.min(rate, left); left -= plan[i] }
    const actual = days.map(() => 0)
    for (const c of done) {
      if (modelOfVin.get(c.vin) !== model) continue
      const i = at.get(dateKey(new Date(c.beforeAt)))
      if (i != null) actual[i]++
    }
    // ชื่อรุ่นย่อยที่พบมากที่สุดในรุ่นนี้
    const count = new Map<string, number>()
    for (const c of list) if (c.variant) count.set(c.variant, (count.get(c.variant) ?? 0) + 1)
    const variant = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    return { model, variant, qty: list.length, plan, actual }
  })
  return { days, models }
}

/** "M6 (7-SEATS)" → "M6" — ชื่อสั้นสำหรับชื่อชีต / หัวเรื่อง */
export const modelShort = (model: string) => (model.trim().split(/[\s(]+/)[0] || model).toUpperCase()

// ── สไตล์ตามไฟล์ต้นแบบ (สีจากธีม Office ของไฟล์ แปลงเป็นค่าสีตรง) ──────────────────────
const fill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
const PINK = 'FFF2DCDB'     // accent2 · 80%
const LILAC = 'FFE5E0EC'    // accent4 · 80%
const PEACH = 'FFFDE9D9'    // accent6 · 80%
const NAVY = 'FF1F497D'     // dark 2
const GREY5 = 'FFF2F2F2'    // white · darker 5%
const GREY15 = 'FFD9D9D9'   // white · darker 15%
const MONTH = 'FFEBDAFA'
const WHITE = 'FFFFFFFF'
const YELLOW = 'FFFFFF00'
const BLUE_HEAD = 'FFDDEBF7'
const GREEN_HEAD = 'FFE2EFDA'
const CYAN = 'FF00B0F0'
const RED = 'FFFF0000'
const THIN = { style: 'thin' as const }
const HAIR = { style: 'hair' as const }
const box = { top: THIN, left: THIN, bottom: THIN, right: THIN }
const CENTER = { horizontal: 'center', vertical: 'middle' } as const
const BROW = 'Browallia New'
const TAHOMA = 'Tahoma'
const NUM = '#,##0'
/** ความกว้างคอลัมน์ของไฟล์ต้นแบบเป็นหน่วยของ Tahoma 11 (ฟอนต์ตั้งต้นของไฟล์ ตัวเลขกว้าง 8px)
 *  แต่ exceljs ตั้งต้นที่ Calibri 11 (7px) — แปลงให้กว้างเท่าของจริง */
const tw = (w: number) => Math.round((w * 8) / 7 * 100) / 100
const colPx = (w: number) => w * 8 + 5

/** exceljs เขียน Date เป็น UTC — วันที่ล้วนต้องเป็นเที่ยงคืน UTC ของวันนั้น ไม่งั้น Excel แสดงเลื่อนวัน */
const dayCell = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }

function put(cell: any, value: unknown, s: { font?: object; fill?: string; border?: object; align?: object; numFmt?: string }): void {
  if (value !== undefined) cell.value = value
  if (s.font) cell.font = s.font
  if (s.fill) cell.fill = fill(s.fill)
  if (s.border) cell.border = s.border
  if (s.align) cell.alignment = s.align
  if (s.numFmt) cell.numFmt = s.numFmt
}

/** ขนาดรูปจริง — ไว้ย่อให้พอดีกรอบโดยไม่บิดสัดส่วน (null = โหลดรูปไม่ได้ ใช้กรอบเต็ม) */
function imageSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null)
    const img = new Image()
    const t = setTimeout(() => resolve(null), 8000)
    img.onload = () => { clearTimeout(t); resolve(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null) }
    img.onerror = () => { clearTimeout(t); resolve(null) }
    img.src = src
  })
}

export interface EvPlanExport {
  siteName: string
  siteCode: string
  perDay: number
  start: string
  cars: EvPlanCar[]
  /** รอบชาร์จในช่วงที่เลือก (รุ่นที่อยู่ในแผน) */
  charges: EvCharge[]
}

export function evPlanFilename(x: Pick<EvPlanExport, 'siteName' | 'cars'>): string {
  const models = [...new Set(x.cars.map((c) => modelShort(c.model)))].join('+') || 'EV'
  return `Plan ชาร์จแบต ${models} - ${x.cars.length} คัน - ${x.siteName.replace(/\s+/g, '')}.xlsx`
}

export async function buildEvPlanWorkbook(x: EvPlanExport): Promise<any> {
  const XJS: any = await import('exceljs')
  const ExcelJS = XJS.default ?? XJS
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SJWD Yard Control'
  const plan = buildEvPlan(x.cars, x.charges, x.perDay, x.start)
  const shorts = [...new Set(plan.models.map((m) => modelShort(m.model)))].join(', ') || 'EV'
  const sheetSafe = (s: string) => s.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31)

  // ── ชีต 1: Plan and Actual ────────────────────────────────────────────────
  const ws = wb.addWorksheet(sheetSafe(`UPDATE-%SOC ${(x.siteCode || x.siteName).toUpperCase()}-${shorts.replace(/, /g, '+')}`), {
    views: [{ zoomScale: 85, zoomScaleNormal: 85 }],
  })
  const nDays = plan.days.length
  const D0 = 6                                // F = วันแรก
  const DL = D0 + nDays - 1
  const TTL = DL + 1, DIFF = DL + 2
  const L = colLetter
  ws.columns = [10.2, 8.8, 6.9, 6, 8.2, ...plan.days.map(() => 4), 5.6, 4].map((w) => ({ width: tw(w) }))
  ws.getColumn(2).hidden = true // ต้นแบบซ่อนคอลัมน์ B และ Type ไว้
  ws.getColumn(4).hidden = true

  ws.getRow(2).height = 18
  put(ws.getCell('A2'), `Plan and Actual  monitor %soc BYD Model ${shorts}`, { font: { name: BROW, size: 12, bold: true }, align: { horizontal: 'left' } })
  for (let c = 1; c <= 5; c++) ws.getRow(2).getCell(c).fill = fill(PINK)

  const head = { name: BROW, size: 10, bold: true }
  ws.getRow(3).height = 18
  ws.getRow(4).height = 17.4
  ;(['Model', '', "Q'ty", 'Type', 'Plan&Actual'] as const).forEach((t, i) => {
    ws.mergeCells(3, i + 1, 4, i + 1)
    put(ws.getCell(3, i + 1), t, { font: head, fill: LILAC, border: box, align: i === 4 ? { ...CENTER, wrapText: true } : CENTER, numFmt: i === 2 ? NUM : undefined })
  })
  // เดือน (merge ตามจำนวนวันในเดือนนั้น) + เลขวัน
  for (let i = 0; i < nDays; ) {
    const ym = plan.days[i].slice(0, 7)
    let j = i
    while (j + 1 < nDays && plan.days[j + 1].slice(0, 7) === ym) j++
    if (j > i) ws.mergeCells(3, D0 + i, 3, D0 + j)
    put(ws.getCell(3, D0 + i), dayCell(`${ym}-01`), { font: { name: BROW, size: 12, bold: true }, fill: MONTH, border: box, align: CENTER, numFmt: '[$-409]mmm-yy;@' })
    i = j + 1
  }
  plan.days.forEach((d, i) => put(ws.getCell(4, D0 + i), Number(d.slice(8, 10)), { font: { name: BROW, size: 12 }, fill: WHITE, border: box, align: CENTER }))
  ;([[TTL, 'TTL'], [DIFF, 'Diff']] as const).forEach(([c, t]) => {
    ws.mergeCells(3, c, 4, c)
    put(ws.getCell(3, c), t, { font: { name: BROW, size: 12, bold: true }, fill: GREY5, border: box, align: CENTER })
  })

  const planRows: number[] = []
  plan.models.forEach((m, k) => {
    const pr = 5 + k * 2, ar = pr + 1
    planRows.push(pr)
    ws.getRow(pr).height = 15.6
    ws.getRow(ar).height = 15.6
    const body = { name: BROW, size: 10 }
    put(ws.getCell(pr, 1), m.model, { font: body, fill: PEACH, border: { top: THIN, left: THIN, right: THIN }, align: CENTER })
    put(ws.getCell(ar, 1), m.variant, { font: body, fill: PEACH, border: { bottom: THIN, left: THIN, right: THIN }, align: CENTER })
    for (const c of [2, 3, 4]) ws.mergeCells(pr, c, ar, c)
    put(ws.getCell(pr, 2), '', { font: body, fill: PEACH, border: box, align: CENTER })
    put(ws.getCell(pr, 3), m.qty, { font: body, fill: PEACH, border: box, align: { ...CENTER, wrapText: true }, numFmt: NUM })
    put(ws.getCell(pr, 4), '', { font: body, fill: GREY5, border: box, align: CENTER, numFmt: NUM })
    const planB = { top: THIN, left: THIN, right: THIN, bottom: HAIR }
    const actB = { top: HAIR, left: THIN, right: THIN, bottom: THIN }
    const planF = { name: BROW, size: 12, color: { argb: 'FF000000' } }
    const actF = { name: BROW, size: 12, color: { argb: CYAN } }
    put(ws.getCell(pr, 5), 'Plan', { font: body, fill: WHITE, border: planB, align: CENTER })
    put(ws.getCell(ar, 5), 'Actual', { font: { ...body, color: { argb: CYAN } }, fill: WHITE, border: actB, align: CENTER })
    for (let i = 0; i < nDays; i++) {
      put(ws.getCell(pr, D0 + i), m.plan[i] || null, { font: planF, fill: WHITE, border: planB, align: CENTER, numFmt: NUM })
      put(ws.getCell(ar, D0 + i), m.actual[i] || null, { font: actF, fill: WHITE, border: actB, align: CENTER, numFmt: NUM })
    }
    const planT = m.plan.reduce((s, n) => s + n, 0), actT = m.actual.reduce((s, n) => s + n, 0)
    const span = (r: number) => `${L(D0)}${r}:${L(DL)}${r}`
    put(ws.getCell(pr, TTL), { formula: `SUM(${span(pr)})`, result: planT }, { font: planF, border: planB, align: CENTER, numFmt: NUM })
    put(ws.getCell(pr, DIFF), { formula: `+C${pr}-${L(TTL)}${pr}`, result: m.qty - planT }, { font: planF, border: planB, align: CENTER, numFmt: NUM })
    put(ws.getCell(ar, TTL), { formula: `SUM(${span(ar)})`, result: actT }, { font: actF, border: actB, align: CENTER, numFmt: NUM })
    put(ws.getCell(ar, DIFF), { formula: `+${L(TTL)}${pr}-${L(TTL)}${ar}`, result: planT - actT }, { font: actF, border: actB, align: CENTER, numFmt: NUM })
  })

  // Total: Plan TTL / Actual TTL / Difference
  const t0 = 5 + plan.models.length * 2, t1 = t0 + 1, t2 = t0 + 2
  ws.mergeCells(t0, 1, t2, 3)
  put(ws.getCell(t0, 1), 'Total', { font: { name: BROW, size: 10, bold: true, color: { argb: WHITE } }, fill: NAVY, border: box, align: CENTER })
  const totals = [
    { r: t0, label: 'Plan TTL', bg: PINK, color: 'FF000000', f: (c: string) => `SUM(${planRows.map((p) => `${c}${p}`).join(',')})` },
    { r: t1, label: 'Actual TTL', bg: LILAC, color: 'FF000000', f: (c: string) => planRows.length === 1 ? `+${c}${planRows[0] + 1}` : `SUM(${planRows.map((p) => `${c}${p + 1}`).join(',')})` },
    { r: t2, label: 'Difference', bg: GREY15, color: RED, f: (c: string) => `+${c}${t1}-${c}${t0}` },
  ]
  // ค่าที่คำนวณไว้ให้ (result) — โปรแกรมดูไฟล์บนมือถือที่ไม่คำนวณสูตรก็ยังเห็นตัวเลข
  const colValue = (r: number, c: number): number => {
    const v = ws.getCell(r, c).value
    return typeof v === 'number' ? v : v && typeof v === 'object' && 'result' in v ? Number((v as any).result) || 0 : 0
  }
  for (const t of totals) {
    ws.getRow(t.r).height = 15
    ws.mergeCells(t.r, 4, t.r, 5)
    put(ws.getCell(t.r, 4), t.label, { font: { name: BROW, size: 10, bold: true, color: { argb: t.color } }, fill: t.bg, border: box, align: CENTER })
    for (let c = D0; c <= DIFF; c++) {
      const sumOf = (rows: number[]) => rows.reduce((s, r) => s + colValue(r, c), 0)
      const result = t.r === t0 ? sumOf(planRows) : t.r === t1 ? sumOf(planRows.map((p) => p + 1)) : sumOf(planRows.map((p) => p + 1)) - sumOf(planRows)
      put(ws.getCell(t.r, c), { formula: t.f(L(c)), result }, { font: { name: BROW, size: 12, color: { argb: t.color } }, fill: t.bg, border: box, align: CENTER, numFmt: NUM })
    }
  }

  // ── ชีต 2: Plan <จำนวน> ──────────────────────────────────────────────────
  const latest = new Map<string, EvCharge>()
  for (const c of [...x.charges].sort((a, b) => a.beforeAt - b.beforeAt)) {
    const prev = latest.get(c.vin)
    if (!prev || !isCharging(c) || isCharging(prev)) latest.set(c.vin, c) // รอบที่เสร็จล่าสุดชนะรอบที่ยังชาร์จอยู่
  }
  const ps = wb.addWorksheet(sheetSafe(`Plan ${x.cars.length}`), { views: [{ state: 'frozen', ySplit: 2 }] })
  ps.columns = [6, 22, 14, 12, 14, 12, 11, 11, 24].map((w) => ({ width: tw(w), style: { font: { name: TAHOMA, size: 10 } } }))
  ps.mergeCells('A1:I1')
  ps.getRow(1).height = 22.05
  put(ps.getCell('A1'), `Plan monitor %soc BYD Model ${shorts} จำนวน ${x.cars.length}`, { font: { name: TAHOMA, size: 12, bold: true }, align: CENTER })
  const ph = ps.addRow(['No', 'Vin', 'Model', 'Color', 'Location', 'Date', 'ก่อนชาร์จ', 'หลังชาร์จ', 'หมายเหตุ'])
  ph.height = 18
  ph.eachCell((cell: any) => put(cell, undefined, { font: { name: TAHOMA, size: 10, bold: true }, fill: YELLOW, border: box, align: CENTER }))
  x.cars.forEach((car, i) => {
    const c = latest.get(car.vin)
    const from = c?.from || car.from
    const row = ps.addRow([
      i + 1, car.vin, car.model, car.color, car.location,
      c ? dayCell(dateKey(new Date(c.beforeAt))) : null,
      c?.beforePct != null ? c.beforePct / 100 : null,
      c && !isCharging(c) && c.afterPct != null ? c.afterPct / 100 : null,
      c?.remark || (from ? `Move from ${from}` : ''),
    ])
    row.height = 16.05
    for (let k = 1; k <= 9; k++) put(row.getCell(k), undefined, { font: { name: TAHOMA, size: 10 }, border: box, align: k === 9 ? { horizontal: 'left', vertical: 'middle' } : CENTER })
    row.getCell(6).numFmt = 'dd/mm/yyyy'
    row.getCell(7).numFmt = '0%'
    row.getCell(8).numFmt = '0%'
  })
  ps.autoFilter = 'A2:I2'

  // ── ชีต 3: รูปชาร์จแบต ───────────────────────────────────────────────────
  const ss = wb.addWorksheet('รูปชาร์จแบต', {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  const SW = [5, 22, 10, 12, 22, 22, 13, 22, 22, 13, 10]
  ss.columns = SW.map((w) => ({ width: tw(w), style: { font: { name: TAHOMA, size: 11 } } }))
  ss.mergeCells('A1:K1')
  ss.getRow(1).height = 25.95
  put(ss.getCell('A1'), `รูปก่อน-หลังชาร์จแบต BYD ${shorts} – Yard ${x.siteName}`, { font: { name: TAHOMA, size: 14, bold: true }, align: { ...CENTER, wrapText: true } })
  const h2 = ['No', 'VIN', 'Location', 'Date', 'ก่อนชาร์จ', '', '', 'หลังชาร์จ', '', '', 'ผลต่าง']
  const h3 = ['', '', '', '', 'รูป VIN', 'รูปหน้าปัด', '%SOC / เวลา', 'รูป VIN', 'รูปหน้าปัด', '%SOC / เวลา', '%SOC']
  ss.getRow(2).values = h2
  ss.getRow(3).values = h3
  for (const c of ['A', 'B', 'C', 'D']) ss.mergeCells(`${c}2:${c}3`)
  ss.mergeCells('E2:G2')
  ss.mergeCells('H2:J2')
  for (const r of [2, 3]) for (let c = 1; c <= 11; c++) {
    put(ss.getCell(r, c), undefined, { font: { name: TAHOMA, size: 10, bold: true }, fill: c >= 5 && c <= 7 ? BLUE_HEAD : c >= 8 && c <= 10 ? GREEN_HEAD : YELLOW, border: box, align: { ...CENTER, wrapText: true } })
  }
  const locOf = new Map(x.cars.map((c) => [c.vin, c.location]))
  const cache = new Map<string, Promise<number | null>>()
  const places: { src: string; col: number; row: number }[] = []
  const shots = [...x.charges].sort((a, b) => a.beforeAt - b.beforeAt)
  const socText = (pct: number | null, at: number) => `${pct ?? '—'}%\n${fmtEvTime(at)} น.`
  shots.forEach((c, i) => {
    const done = !isCharging(c)
    const diff = done && c.beforePct != null && c.afterPct != null
      ? { formula: `(${c.afterPct}-${c.beforePct})/100`, result: (c.afterPct - c.beforePct) / 100 } : null
    const row = ss.addRow([
      i + 1, c.vin, locOf.get(c.vin) ?? '', dayCell(dateKey(new Date(c.beforeAt))),
      null, null, socText(c.beforePct, c.beforeAt),
      null, null, done ? socText(c.afterPct, c.afterAt) : 'กำลังชาร์จ',
      diff,
    ])
    row.height = 220.05
    for (let k = 1; k <= 11; k++) put(row.getCell(k), undefined, { font: { name: TAHOMA, size: 11, bold: k === 7 || k === 10 || k === 11 }, border: box, align: { ...CENTER, wrapText: true } })
    row.getCell(4).numFmt = 'dd/mm/yyyy'
    row.getCell(11).numFmt = '+0%'
    // รูป VIN หลังชาร์จ: สถานีถ่ายรูปเลขวินครั้งเดียวตอนเริ่ม ช่องนี้จึงว่าง
    ;([[c.vinPhoto, 4], [c.beforePhoto, 5], [c.afterPhoto, 8]] as const).forEach(([src, col]) => {
      if (src) places.push({ src, col, row: row.number - 1 })
    })
  })
  // กรอบรูปเท่าไฟล์ต้นแบบ 157×280 px · ย่อตามสัดส่วนจริง · วางกลางช่อง
  const BOX_W = 157, BOX_H = 280
  const rowPx = 220.05 * 96 / 72
  const loaded = await Promise.all(places.map((pl) => photoImageId(wb, pl.src, cache)
    .then(async (id) => (id == null ? null : { ...pl, id, size: await imageSize(pl.src) }))))
  for (const pl of loaded) {
    if (!pl) continue
    const { id, size } = pl
    const k = size ? Math.min(BOX_W / size.w, BOX_H / size.h) : 1
    const w = Math.round((size?.w ?? BOX_W) * k), h = Math.round((size?.h ?? BOX_H) * k)
    const cw = colPx(SW[pl.col])
    ss.addImage(id, {
      tl: { col: pl.col + Math.max(0, (cw - w) / 2) / cw, row: pl.row + Math.max(0, (rowPx - h) / 2) / rowPx },
      ext: { width: w, height: h },
      editAs: 'oneCell',
    })
  }
  return wb
}

export async function exportEvPlanExcel(x: EvPlanExport, filename = evPlanFilename(x)): Promise<void> {
  const wb = await buildEvPlanWorkbook(x)
  const buf = await wb.xlsx.writeBuffer()
  downloadBlob(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename)
}
