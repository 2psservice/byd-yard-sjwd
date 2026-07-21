/**
 * Shared "หา รถ / ใบหารถ" logic — used by both the Units Mylist tab and the
 * Yard Plan find-car panel so the two stay in lock-step.
 *
 * Search accepts a free-text blob (paste from Excel / email / typed) mixing
 * full VINs and short tokens (last-5 digits, etc.):
 *   • token ≥ 11 chars → exact VIN match
 *   • shorter token     → suffix/substring match (typing "154237" finds the
 *                         car whose VIN ends in it)
 * Results are de-duplicated, so a full VIN plus its own suffix count once.
 */
import type { TrackRow } from './excelTracking'
import type { FindListRow } from './groupingPrint'
import { siteGroupingConfig, yardLocFull } from './groupingImport'

export interface MatchResult {
  found: TrackRow[]
  notFound: string[]
  asked: number
}

// Thai (Kedmanee) keyboard → the Latin key at the same physical position, so a
// VIN typed while the keyboard was still on Thai ("ควๅ…") is recovered to
// "LGX…". Letters + the number-row keys; '/' and '-' (Thai keys 2 and 3) are
// handled separately since they're also plain ASCII separators.
const TH_TO_EN: Record<string, string> = {
  'ๆ': 'Q', 'ไ': 'W', 'ำ': 'E', 'พ': 'R', 'ะ': 'T', 'ั': 'Y', 'ี': 'U', 'ร': 'I', 'น': 'O', 'ย': 'P',
  'ฟ': 'A', 'ห': 'S', 'ก': 'D', 'ด': 'F', 'เ': 'G', '้': 'H', '่': 'J', 'า': 'K', 'ส': 'L',
  'ผ': 'Z', 'ป': 'X', 'แ': 'C', 'อ': 'V', 'ิ': 'B', 'ื': 'N', 'ท': 'M',
  'ๅ': '1', 'ภ': '4', 'ถ': '5', 'ุ': '6', 'ึ': '7', 'ค': '8', 'ต': '9', 'จ': '0',
}
// only fold these ASCII chars to digits when the text actually contains Thai —
// otherwise a hyphen / slash separator in normal input would be corrupted
const TH_AMBIG: Record<string, string> = { '/': '2', '-': '3' }
const hasThai = (s: string) => /[฀-๿]/.test(s)

/** Convert a Thai-keyboard-typed string to what the same keystrokes are in the
 *  Latin layout. Leaves ordinary Latin/ digits untouched. */
export function thaiKbToLatin(s: string): string {
  if (!hasThai(s)) return s
  let out = ''
  for (const ch of s) out += TH_TO_EN[ch] ?? TH_AMBIG[ch] ?? ch
  return out
}

export function matchVins(text: string, allRows: TrackRow[]): MatchResult {
  // accept VINs typed on a Thai keyboard too: tokenize the raw text AND its
  // Thai→Latin transliteration, then match the union (Latin input is unchanged
  // by the transliteration, so normal searches behave exactly as before).
  const latin = thaiKbToLatin(text)
  const grab = (t: string) => t.toUpperCase().match(/[A-Z0-9]{3,20}/g) ?? []
  const tokens = latin === text ? grab(text) : [...grab(text), ...grab(latin)]
  const uniq = [...new Set(tokens)]
  const byVin = new Map(allRows.map((r) => [r.vin, r]))
  const found: TrackRow[] = []
  const notFound: string[] = []
  const seen = new Set<string>()
  for (const tok of uniq) {
    let hits: TrackRow[]
    if (tok.length >= 11) { const r = byVin.get(tok); hits = r ? [r] : [] }
    else hits = allRows.filter((r) => r.vin.endsWith(tok) || r.vin.includes(tok))
    if (!hits.length) { notFound.push(tok); continue }
    for (const r of hits) if (!seen.has(r.vin)) { seen.add(r.vin); found.push(r) }
  }
  return { found, notFound, asked: uniq.length }
}

/** unit placement needed to resolve a yard-location code */
export interface UnitLite { block?: string; row?: number; slot?: number; modelName?: string; color?: string }

/** Build ใบหารถ rows: yard-location code (with cell fallbacks) + display fields. */
export function toFindListRows(
  found: TrackRow[],
  unitByVin: (vin: string) => UnitLite | undefined,
  siteName: string,
): FindListRow[] {
  const prefix = siteGroupingConfig(siteName).prefix
  return found.map((r) => {
    const u = unitByVin(r.vin)
    // real placement code only (prefix-block+row+slot, same as the Location
    // column) — no cell fallback (storage Yard / Location yard aren't a position)
    const loc = yardLocFull(u ? { block: u.block, row: u.row, slot: u.slot } : null, prefix)
    return {
      vin: r.vin,
      model: r.cells['Model'] || u?.modelName || r.cells['Model name'] || '',
      color: r.cells['Color'] || u?.color || '',
      location: loc,
      remark: r.cells['หมายเหตุ'] || r.cells['Remark'] || '',
    }
  })
}
