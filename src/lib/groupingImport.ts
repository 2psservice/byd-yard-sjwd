/**
 * "Grouping to Dealer" import — reads the FIS grouping workbook and pulls the
 * sheet for the active site (NYB2 → the "NYB" sheet, Rayong → "RY", …). Each
 * sheet lists the VINs planned for delivery with their Grouping Number + dealer;
 * the app stamps those grouping numbers onto the yard's tracking rows and fills
 * in each car's yard Location + Lane load for the printable grouping / find-car
 * sheets.
 */

export interface GroupingParseRow {
  vin: string
  modelName: string       // full "BYD ATTO 2 PREMIUM GREY"
  model: string           // short "ATTO 2"
  color: string
  deliveryLocation: string // dealer
  grouping: string        // "ATL260706-001"
  receiveDate: string     // วันที่ในการเข้ารับ (as shown), optional
}

export interface GroupingParseResult {
  sheetName: string
  title: string           // sheet title row, e.g. "NYB2 - Grouping to Dealer ( 17 Units / 5 Group) Date 06 July 2026"
  headerDate: string      // date pulled from the title, else ''
  rows: GroupingParseRow[]
}

/** Per-site config: which workbook sheet to read + the yard-location prefix
 *  ("N-V41"). Prefix defaults to the site's first letter (NYB→N, Rayong→R). */
export function siteGroupingConfig(siteName: string): { sheetKeys: string[]; prefix: string } {
  const n = (siteName || '').toLowerCase()
  const firstLetter = (siteName || 'X').trim().charAt(0).toUpperCase() || 'X'
  if (n.includes('nyb')) return { sheetKeys: ['nyb'], prefix: 'N' }
  if (n.includes('rayong')) return { sheetKeys: ['ry', 'rayong'], prefix: 'R' }
  // the Auto Tran yards are told apart by their RAI number — both start with "A",
  // so a first-letter prefix would render 20 Rai and 38 Rai identically ("A-…")
  if (n.includes('38')) return { sheetKeys: ['38'], prefix: '38' }
  if (n.includes('20')) return { sheetKeys: ['20'], prefix: '20' }
  return { sheetKeys: [n.replace(/[^a-z0-9]/g, '').slice(0, 3)].filter(Boolean), prefix: firstLetter }
}

/** Block code inside a yard location: a single or doubled letter collapses to one
 *  letter (block "OO" → "O", "A" → "A") to match the grouping sheet, while a real
 *  multi-letter block name is kept whole ("WCL" → "WCL", not "W"). */
export function blockCode(block: string): string {
  const b = block.trim().toUpperCase()
  return /^([A-Z])\1?$/.test(b) ? b.charAt(0) : b
}

/** Yard location code for a placed unit: site prefix + block code + zero-padded
 *  column — e.g. "20-A28", "20-B05", "20-WCL28", "N-O15". Empty when unplaced. */
export function yardLocCode(u: { block?: string; slot?: number } | undefined | null, prefix: string): string {
  if (!u || !u.block || !u.slot) return ''
  return `${prefix}-${blockCode(u.block)}${String(u.slot).padStart(2, '0')}`
}

/** Sort key for a yard location code ("20-A28" → ["A", 28], "N-O15" → ["O", 15]).
 *  The yard prefix is ALPHANUMERIC ("N-", "R-", "20-", "38-"), so it must be stripped
 *  with [A-Za-z0-9]+ — a letters-only strip leaves "20-A28" untouched and every key
 *  collapses to ["", 20], which silently turns the sort into a no-op. */
export function locSortKey(loc: string): [string, number] {
  const m = (loc || '').replace(/^[A-Za-z0-9]+-/, '').match(/^([A-Za-z]*)(\d*)/)
  return [(m?.[1] ?? '').toUpperCase(), m?.[2] ? +m[2] : 0]
}

/** Comparator ordering cars the way a driver walks the yard: block A→B→C→…→WCL,
 *  then column ascending. Cars with no location ('' / '—') sink to the bottom. */
export function byYardLocation(a: string, b: string): number {
  const ea = !a || a === '—'
  const eb = !b || b === '—'
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1
  const [la, na] = locSortKey(a), [lb, nb] = locSortKey(b)
  return la < lb ? -1 : la > lb ? 1 : na - nb
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/[\s._\-#]/g, '')
const isVin = (s: string) => /^[A-Z0-9]{11,20}$/.test(s)

/** Find the workbook sheet whose (normalised) name matches one of the site keys.
 *  Skips the raw master "Sheet3"-style dumps by requiring a key hit. */
function pickSheet(sheetNames: string[], keys: string[]): string | null {
  for (const key of keys) {
    const hit = sheetNames.find((nm) => norm(nm).includes(key))
    if (hit) return hit
  }
  return null
}

export async function parseGroupingWorkbook(file: File, siteName: string): Promise<GroupingParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })

  const { sheetKeys } = siteGroupingConfig(siteName)
  const sheetName = pickSheet(wb.SheetNames, sheetKeys)
  if (!sheetName) {
    throw new Error(`ไม่พบ sheet สำหรับ site "${siteName}" (มองหา: ${sheetKeys.join(', ')}) — sheet ในไฟล์: ${wb.SheetNames.join(', ')}`)
  }

  const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: false })

  // title row (first non-empty cell) + the date embedded in it
  const title = String(aoa.find((r) => String(r?.[0] ?? '').trim())?.[0] ?? '').trim()
  const headerDate = (title.match(/date\s+(.+)$/i)?.[1] ?? '').trim()

  // header row: has a Vin column AND a Grouping-number column
  let headerAt = -1
  let headers: string[] = []
  for (let r = 0; r < Math.min(6, aoa.length); r++) {
    const hs = (aoa[r] as any[]).map((h) => String(h ?? '').trim())
    const has = (...names: string[]) => hs.some((h) => names.includes(norm(h)))
    if (has('vin', 'vinno') && has('groupingnumber', 'grouppingnumber', 'grouping')) { headerAt = r; headers = hs; break }
  }
  if (headerAt < 0) throw new Error(`sheet "${sheetName}" ไม่มีคอลัมน์ Vin + Grouping Number`)

  const idx = (...names: string[]) => headers.findIndex((h) => names.includes(norm(h)))
  const vinI = idx('vin', 'vinno')
  const modelNameI = idx('modelname')
  const modelI = idx('model')
  const colorI = idx('color')
  const deliveryI = idx('deliverylocation', 'delivery')
  const groupI = idx('grouppingnumber', 'groupingnumber', 'grouping')
  const dateI = idx('วันที่ในการเข้ารับ', 'วันที่รับ', 'date')

  const rows: GroupingParseRow[] = []
  for (let r = headerAt + 1; r < aoa.length; r++) {
    const row = aoa[r] as any[]
    const vin = String(row[vinI] ?? '').trim().toUpperCase()
    if (!isVin(vin)) continue
    const grouping = String(row[groupI] ?? '').trim()
    if (!grouping) continue
    rows.push({
      vin,
      modelName: modelNameI >= 0 ? String(row[modelNameI] ?? '').trim() : '',
      model: modelI >= 0 ? String(row[modelI] ?? '').trim() : '',
      color: colorI >= 0 ? String(row[colorI] ?? '').trim() : '',
      deliveryLocation: deliveryI >= 0 ? String(row[deliveryI] ?? '').trim() : '',
      grouping,
      receiveDate: dateI >= 0 ? String(row[dateI] ?? '').trim() : '',
    })
  }
  if (!rows.length) throw new Error(`sheet "${sheetName}" ไม่พบแถวข้อมูล VIN`)
  return { sheetName, title, headerDate, rows }
}
