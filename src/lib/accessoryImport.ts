/**
 * "Update Accessory" import — reads TWO different Vin-list workbook shapes:
 *
 *  1) A transfer manifest with columns Installed Accessories / Uninstalled
 *     Accessories / CBU-Installed, each a "+"-joined list of item names.
 *     Every name found in "Uninstalled Accessories" becomes a Control Stock
 *     Sheet NG for that VIN — Uninstalled always wins even if the SAME name
 *     also appears in CBU-Installed (a factory-installed item this yard's
 *     inspection found missing IS missing, whatever the CBU manifest says).
 *
 *  2) A Yard-to-Yard transfer sheet with a single free-text "Remark" column
 *     instead: "มี…มากับตัวรถ" ("has … with the car") reads as present: OK,
 *     nothing to write. A BARE item name — or anything named after
 *     "ไม่ใส่"/"ไม่ได้ใส่" ("did not include …") — reads as missing: NG.
 *     Segments are still "+"-joined, and wording varies a lot ("สมุดคู่มือ"
 *     vs "สมุดคู่มือการใช้งานภาษาไทย" vs "คู่มือ" …), so this column is
 *     matched by KEYWORD rather than an exact name lookup.
 *
 * Either column set may be present; a file can even carry both (their NG
 * findings simply union together — see parseAccessoryWorkbook). A name found
 * present some other way still needs no record: the Control Stock Sheet has
 * no "OK" tick to write, only NG defects (same as ticking every item OK by
 * hand and saving — see StockAccessoryCheck.tsx).
 *
 * "กระดาษปูพื้น" / "กระดาษคราฟท์…" (floor protective paper) is not part of
 * today's Control Stock Sheet and is deliberately ignored, by request.
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
  /** distinct accessory names this VIN is missing (mapped ones only) — the
   *  union of every sheet row this VIN appears on (see parseAccessoryWorkbook) */
  ngNames: string[]
}

export interface AccessoryParseResult {
  rows: AccessoryParseRow[]
  /** distinct VINs in the file (one row per VIN — see parseAccessoryWorkbook) */
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

// ── free-text "Remark" column (Yard-to-Yard transfer sheet) ────────────────
// Order matters: a more specific/container word must win over a substring it
// happens to also contain. "กระเป๋าใส่คู่มือ" / "ซองใส่คู่มือ" (the POUCH that
// holds the manual) also contain "คู่มือ", so pouch is checked before manual
// or every pouch mention would misread as the manual itself. Likewise
// "กระดาษคราฟท์…พรม…" (paper protecting the carpet) is about the paper, not
// the carpet, so floor-paper is checked before carpet. Every alias below is
// one already recognized by ACCESSORY_ALIASES, so resolveAccessoryItem needs
// no changes to serve either column format.
const REMARK_ITEM_TARGETS: { kw: string[]; alias: string | null }[] = [
  { kw: ['กระเป๋า', 'ซอง'], alias: 'กระเป๋าใส่คู่มือ' },
  { kw: ['กระดาษ'], alias: null }, // floor paper — deliberately skipped, see file header
  { kw: ['กรอบป้ายทะเบียน', 'ป้ายทะเบียน', 'ป้าย'], alias: 'กรอบป้ายทะเบียน' },
  { kw: ['คู่มือ'], alias: 'สมุดคู่มือ' },
  { kw: ['รับประกัน', 'วารันตี', 'warranty'], alias: 'สมุดรับประกัน' },
  { kw: ['ฟิล์ม', 'ฟีล์ม'], alias: 'ฟิล์มหน้าจอ' },
  { kw: ['พรม'], alias: 'พรม' },
  { kw: ['ผ้ายาง'], alias: 'ผ้ายาง' },
]
function matchRemarkTarget(text: string): { alias: string | null } | null {
  for (const t of REMARK_ITEM_TARGETS) if (t.kw.some((k) => text.includes(k))) return t
  return null
}

/** One "+"-joined segment of a Remark cell → the item(s) it names and
 *  whether it means present (OK) or missing (NG). */
function parseRemarkClause(clauseRaw: string): { ok: boolean; raw: string }[] {
  const clause = clauseRaw.trim()
  if (!clause) return []
  // "ไม่ใส่ A B C" / "ไม่ได้ใส่ A B C" — every space-separated name after it is NG
  const neg = clause.match(/^ไม่(?:ได้)?ใส่\s*(.+)$/)
  if (neg) return neg[1].split(/\s+/).filter(Boolean).map((raw) => ({ ok: false, raw }))
  // "มี…(มากับตัวรถ)?" — present; the "มากับตัวรถ" tail is optional ("มีสมุดคู่มือ" alone counts too)
  if (clause.startsWith('มี')) {
    const inner = clause.replace(/^มี/, '').replace(/มากับตัวรถ$/, '').trim()
    return [{ ok: true, raw: inner || clause }]
  }
  return [{ ok: false, raw: clause }] // bare name → missing
}

/** Free-text Remark cell → alias names (ready for resolveAccessoryItem) this
 *  row's Uninstalled-equivalent list carries, plus anything unrecognized. */
function parseRemarkCell(remark: string): { ngNames: string[]; unmapped: string[] } {
  const cell = (remark || '').trim()
  if (!cell || cell === '-' || cell === 'ตัดออก') return { ngNames: [], unmapped: [] }
  const ngNames = new Set<string>()
  const unmapped: string[] = []
  for (const clauseRaw of cell.split('+')) {
    for (const { ok, raw } of parseRemarkClause(clauseRaw)) {
      if (!raw) continue
      const hit = matchRemarkTarget(raw)
      if (!hit) { unmapped.push(raw); continue }
      if (!hit.alias) continue // recognized but deliberately skipped (floor paper)
      if (!ok) ngNames.add(hit.alias)
    }
  }
  return { ngNames: [...ngNames], unmapped }
}

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
  const colRemark = header.findIndex((h) => norm(h) === 'remark')
  if (colUninst < 0 && colInst < 0 && colCbu < 0 && colRemark < 0) {
    throw new Error('ไม่พบคอลัมน์ Installed / Uninstalled Accessories / CBU-Installed หรือ Remark')
  }

  const knownNames = new Set(Object.keys(ACCESSORY_ALIASES))
  const unmapped = new Set<string>()
  // a transfer-history sheet can list the SAME VIN on several rows (one per
  // move) — union every row's findings into ONE row per VIN, or a car moved
  // twice would queue its same missing item twice and land two NGs from one
  // import (the confirm step's own-import dedupe only sees the CURRENT
  // damages, not sibling rows still queued in this same file)
  const byVin = new Map<string, Set<string>>()
  let skippedNoVin = 0
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i]
    const vin = String(r[colVin] ?? '').trim().toUpperCase()
    if (!vin) { skippedNoVin++; continue }
    const inst = colInst >= 0 ? splitNames(String(r[colInst] ?? '')) : []
    const uninst = colUninst >= 0 ? splitNames(String(r[colUninst] ?? '')) : []
    const cbu = colCbu >= 0 ? splitNames(String(r[colCbu] ?? '')) : []
    for (const n of new Set([...inst, ...uninst, ...cbu])) if (!knownNames.has(n)) unmapped.add(n)
    const ngNames = byVin.get(vin) ?? new Set<string>()
    for (const n of uninst) if (knownNames.has(n)) ngNames.add(n)
    if (colRemark >= 0) {
      const parsed = parseRemarkCell(String(r[colRemark] ?? ''))
      for (const n of parsed.ngNames) ngNames.add(n)
      for (const n of parsed.unmapped) unmapped.add(n)
    }
    byVin.set(vin, ngNames)
  }
  const rows: AccessoryParseRow[] = [...byVin.entries()].map(([vin, ngNames]) => ({ vin, ngNames: [...ngNames] }))
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
