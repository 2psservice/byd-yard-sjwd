/**
 * "Update Accessory" import — a Vin-list transfer workbook (columns: VIN,
 * Installed Accessories, Uninstalled Accessories, CBU-Installed — each a
 * "+"-joined list of item names) that records what shipped with the car.
 *
 * Every name found in a car's "Uninstalled Accessories" column becomes a
 * Control Stock Sheet NG for that VIN — Uninstalled always wins even if the
 * SAME name also appears in CBU-Installed (a factory-installed item this
 * yard's inspection found missing IS missing, whatever the CBU manifest
 * says). A name that never appears in Uninstalled needs no record: the
 * Control Stock Sheet has no "OK" tick to write, only NG defects (same as
 * ticking every item OK by hand and saving — see StockAccessoryCheck.tsx).
 *
 * "กระดาษปูพื้น" (floor protective paper) is not part of today's Control
 * Stock Sheet and is deliberately ignored, by request.
 */
import { FINAL_CHECK_TABS } from './finalCheckList'

/** Excel accessory name → the Control Stock Sheet item it represents. Every
 *  value must match an item's `th` EXACTLY as printed in finalCheckList.ts,
 *  so an NG written here reads identically to one ticked by hand at
 *  PDI / FINAL CHECK / Walk Around Check. */
const ACCESSORY_ALIASES: Record<string, string> = {
  'สมุดคู่มือ': "คู่มือการใช้รถ ฉบับภาษาไทย / Owner's Manual (Thai Version)",
  'สมุดรับประกัน': 'สมุดรับประกัน / Warranty Book',
  'กระเป๋าใส่คู่มือ': 'ซองใส่คู่มือและสมุดรับประกัน', // ของชิ้นเดียวกัน คนละชื่อเรียก
  'ฟิล์มหน้าจอ': 'ฟิล์มกันรอยหน้าจอ infotainment',
  'พรม': 'พรม ประจำรถ / Floor Carpet',
  'ผ้ายาง': 'ผ้ายาง ประจำรถ / Floor Mat',
  'กรอบป้ายทะเบียน': 'กรอบป้ายทะเบียน / license plate frame',
}
/** Names the file carries that this checklist deliberately does not track. */
const IGNORED_NAMES = new Set(['กระดาษปูพื้น', '-', ''])

export interface AccessoryParseRow {
  vin: string
  /** distinct accessory names this row's Uninstalled column lists (mapped ones only) */
  ngNames: string[]
}

export interface AccessoryParseResult {
  rows: AccessoryParseRow[]
  totalRows: number
  skippedNoVin: number
  /** accessory names the file mentions that this checklist has no item for
   *  (besides the known "กระดาษปูพื้น") — surfaced so a renamed/new accessory
   *  is never silently dropped. */
  unmapped: string[]
}

function splitNames(cell: string): string[] {
  return (cell || '').split('+').map((s) => s.trim()).filter((s) => s && !IGNORED_NAMES.has(s))
}

const norm = (s: string) => String(s ?? '').trim().toLowerCase()

export async function parseAccessoryWorkbook(file: File): Promise<AccessoryParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false })
  if (!raw.length) throw new Error('ไฟล์ว่างเปล่า')

  // header row — scan the first few rows in case a title row sits above it
  let headerIdx = -1
  for (let i = 0; i < Math.min(5, raw.length); i++) {
    if (raw[i].some((c) => norm(c) === 'vin')) { headerIdx = i; break }
  }
  if (headerIdx < 0) throw new Error('ไม่พบคอลัมน์ VIN ในไฟล์')
  const header = raw[headerIdx].map((h) => String(h ?? ''))
  const colVin = header.findIndex((h) => norm(h) === 'vin')
  const colInst = header.findIndex((h) => /^installed\s*accessories$/i.test(h.trim()))
  const colUninst = header.findIndex((h) => /^uninstalled\s*accessories$/i.test(h.trim()))
  const colCbu = header.findIndex((h) => /^cbu[-\s]*install(ed)?$/i.test(h.trim()))
  if (colUninst < 0 && colInst < 0 && colCbu < 0) {
    throw new Error('ไม่พบคอลัมน์ Installed / Uninstalled Accessories / CBU-Installed')
  }

  const knownNames = new Set(Object.keys(ACCESSORY_ALIASES))
  const unmapped = new Set<string>()
  const rows: AccessoryParseRow[] = []
  let skippedNoVin = 0
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i]
    const vin = String(r[colVin] ?? '').trim().toUpperCase()
    if (!vin) { skippedNoVin++; continue }
    const inst = colInst >= 0 ? splitNames(String(r[colInst] ?? '')) : []
    const uninst = colUninst >= 0 ? splitNames(String(r[colUninst] ?? '')) : []
    const cbu = colCbu >= 0 ? splitNames(String(r[colCbu] ?? '')) : []
    for (const n of new Set([...inst, ...uninst, ...cbu])) if (!knownNames.has(n)) unmapped.add(n)
    rows.push({ vin, ngNames: [...new Set(uninst.filter((n) => knownNames.has(n)))] })
  }
  return { rows, totalRows: rows.length, skippedNoVin, unmapped: [...unmapped] }
}

/** Resolve an accessory name to the exact Control Stock Sheet item it maps to
 *  — the label (Damage.area/areaTh) and the group title (folded into
 *  Damage.item as "Control Stock Sheet · <group title>", same as a hand-ticked
 *  NG) that isStockSheetEntry / the PDI-defect sheet already key off. */
export function resolveAccessoryItem(name: string): { label: string; groupTitle: string } | null {
  const label = ACCESSORY_ALIASES[name]
  if (!label) return null
  const stock = FINAL_CHECK_TABS.find((t) => t.key === 'stock')
  for (const g of stock?.groups ?? []) {
    if (g.items.some((it) => (it.th ?? it.en) === label)) return { label, groupTitle: g.title }
  }
  return null
}

export const STOCK_TAB_LABEL = FINAL_CHECK_TABS.find((t) => t.key === 'stock')?.label ?? 'Control Stock Sheet'
