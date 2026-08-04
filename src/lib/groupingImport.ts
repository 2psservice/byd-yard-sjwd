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
  /** Unit count the sheet's own title claims (0 when the title has none) —
   *  compared against rows.length so a short read is never silent. */
  titleUnits: number
  /** VIN-looking rows skipped, by reason. */
  skipped: { noGrouping: number }
  /** VIN row counts for every sheet in the workbook — names a sheet holding
   *  data we did not read (a plan split across continuation sheets). */
  sheetVinCounts: { sheet: string; vins: number }[]
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

/** Yard lane code for a placed unit: block name + zero-padded column —
 *  e.g. "A28", "T12", "WCL28". The code reads from the block NAME (a doubled
 *  drawn id "TT" collapses to "T"), no yard prefix. Empty when unplaced. */
export function yardLocCode(u: { block?: string; slot?: number } | undefined | null): string {
  if (!u || !u.block || !u.slot) return ''
  return `${blockCode(u.block)}${String(u.slot).padStart(2, '0')}`
}

/** Full yard location: block name + 2-digit column (ช่อง) + 2-digit order —
 *  e.g. "T1201" = block T, column 12, 1st car down that column. Matches how
 *  the yard extends its lane codes (T12 → T1201, T1202, …). Empty when
 *  unplaced. Used by the Unit List "Location" column. */
export function yardLocFull(u: { block?: string; row?: number; slot?: number } | undefined | null): string {
  if (!u || !u.block || !u.row || !u.slot) return ''
  return `${blockCode(u.block)}${String(u.slot).padStart(2, '0')}${String(u.row).padStart(2, '0')}`
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

/** @param sheetOverride read this sheet instead of the one matched by site —
 *  used to pull in a plan continued on a second sheet. */
export async function parseGroupingWorkbook(file: File, siteName: string, sheetOverride?: string): Promise<GroupingParseResult> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })

  const { sheetKeys } = siteGroupingConfig(siteName)
  const sheetName = sheetOverride && wb.SheetNames.includes(sheetOverride)
    ? sheetOverride
    : pickSheet(wb.SheetNames, sheetKeys)
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
  let skipNoGrouping = 0
  // The Grouping Number is written once per group and the rest of that group's
  // rows are left blank (a merged cell). Reading each row on its own therefore
  // kept only the first car of every group — carry the last number down instead,
  // which is what the merged cell means. Only rows before the FIRST number have
  // no group to inherit and are genuinely un-assignable.
  let lastGrouping = ''
  for (let r = headerAt + 1; r < aoa.length; r++) {
    const row = aoa[r] as any[]
    const cellGroup = String(row[groupI] ?? '').trim()
    if (cellGroup) lastGrouping = cellGroup
    const vin = String(row[vinI] ?? '').trim().toUpperCase()
    if (!isVin(vin)) continue
    const grouping = cellGroup || lastGrouping
    if (!grouping) { skipNoGrouping++; continue }
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

  // "( 124 Units / 25 Groups)" — the sheet's own claim, to check the read against
  const titleUnits = +(title.match(/\(\s*(\d+)\s*units?/i)?.[1] ?? 0)
  // how many VINs each sheet holds, so a plan continued on another sheet is named
  const sheetVinCounts = wb.SheetNames.map((nm) => {
    const a = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[nm], { header: 1, defval: '', raw: false, blankrows: false })
    let vins = 0
    for (const rw of a) for (const c of rw as any[]) if (isVin(String(c ?? '').trim().toUpperCase())) { vins++; break }
    return { sheet: nm, vins }
  })
  return { sheetName, title, headerDate, rows, titleUnits, skipped: { noGrouping: skipNoGrouping }, sheetVinCounts }
}
