/**
 * PM work-queue upload — reads a "Plan PM (site) <date> - จำนวน N คัน" style
 * workbook (No · Vin · Model name · Model · Color · Gate In (Rayong yard) ·
 * Location · Remark) and pulls out the VIN list to seed a new PM queue with.
 * Everything else about a car (model, color, location, …) is read live off
 * the tracking sheet elsewhere in the app by VIN — this import only needs
 * the VINs themselves, in the order the sheet lists them.
 */

export interface PmQueueParseRow {
  no: number
  vin: string
  modelName: string
  model: string
  color: string
  gateIn: string
  location: string
  remark: string
}

export interface PmQueueParseResult {
  rows: PmQueueParseRow[]
  /** rows that carried some data but no valid VIN — a hole in the sheet, not a car. */
  skipped: number
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/[\s._\-#()]/g, '')
// real VINs never contain I, O or Q (ISO 3779) — rejects placeholder codes
const isVin = (s: string) => /^[A-Z0-9]{11,20}$/.test(s) && !/[IOQ]/.test(s)

export async function parsePmQueueWorkbook(file: File): Promise<PmQueueParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('ไฟล์นี้ไม่มี sheet')
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: false })

  // header row: the first row (within the first few) carrying a Vin column —
  // row 1 is often a merged title ("Plan PM (NYB) 2 SEP 2026 - จำนวน 186 คัน")
  let headerAt = -1
  let headers: string[] = []
  for (let r = 0; r < Math.min(6, aoa.length); r++) {
    const hs = (aoa[r] as unknown[]).map((h) => String(h ?? '').trim())
    if (hs.some((h) => norm(h) === 'vin' || norm(h) === 'vinno')) { headerAt = r; headers = hs; break }
  }
  if (headerAt < 0) throw new Error('ไม่พบคอลัมน์ Vin ในไฟล์ — ต้องมีหัวตาราง No / Vin / Model / Color / Gate In / Location / Remark')

  const idx = (...names: string[]) => headers.findIndex((h) => names.includes(norm(h)))
  const noI = idx('no')
  const vinI = idx('vin', 'vinno')
  const modelNameI = idx('modelname')
  const modelI = idx('model')
  const colorI = idx('color')
  const gateInI = idx('gateinrayongyard', 'gatein')
  const locI = idx('location')
  const remarkI = idx('remark', 'remarks', 'หมายเหตุ')

  const rows: PmQueueParseRow[] = []
  let skipped = 0
  for (let r = headerAt + 1; r < aoa.length; r++) {
    const row = aoa[r] as unknown[]
    if (!row.some((c) => String(c ?? '').trim())) continue // fully blank row — not a hole, just spacing
    const vin = String(row[vinI] ?? '').trim().toUpperCase()
    if (!isVin(vin)) { skipped++; continue }
    rows.push({
      no: noI >= 0 ? parseInt(String(row[noI] ?? ''), 10) || rows.length + 1 : rows.length + 1,
      vin,
      modelName: modelNameI >= 0 ? String(row[modelNameI] ?? '').trim() : '',
      model: modelI >= 0 ? String(row[modelI] ?? '').trim() : '',
      color: colorI >= 0 ? String(row[colorI] ?? '').trim() : '',
      gateIn: gateInI >= 0 ? String(row[gateInI] ?? '').trim() : '',
      location: locI >= 0 ? String(row[locI] ?? '').trim() : '',
      remark: remarkI >= 0 ? String(row[remarkI] ?? '').trim() : '',
    })
  }
  if (!rows.length) throw new Error('ไม่พบแถวข้อมูล VIN ที่ถูกต้องในไฟล์')
  return { rows, skipped }
}

/** Queue name = the uploaded file's own name, extension stripped. */
export function pmQueueNameFromFile(fileName: string): string {
  return fileName.replace(/\.(xlsx|xls)$/i, '').trim() || 'PM'
}
