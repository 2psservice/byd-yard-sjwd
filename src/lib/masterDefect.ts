// Bilingual master lists for the gate-in damage capture. Field staff record in
// Thai (with the English shown alongside); the stored record keeps BOTH so the
// admin Unit page shows English + Thai and the report shows English only.
import { MASTER_PARTS, MASTER_DEFECTS, type MasterEntry } from './masterDefectData'

export { MASTER_PARTS, MASTER_DEFECTS }
export type { MasterEntry }

const norm = (s: string) => (s ?? '').trim().toLowerCase()

function buildIndex(list: MasterEntry[]): Map<string, MasterEntry> {
  const idx = new Map<string, MasterEntry>()
  for (const e of list) {
    if (e.th) idx.set(norm(e.th), e)
    if (e.en && !idx.has(norm(e.en))) idx.set(norm(e.en), e)
  }
  return idx
}
const PART_IDX = buildIndex(MASTER_PARTS)
const DEFECT_IDX = buildIndex(MASTER_DEFECTS)

/** Resolve free text (Thai OR English) against the master list → both languages.
 *  Unknown text (a custom entry) comes back with en = th = the raw text. */
function resolve(idx: Map<string, MasterEntry>, text: string): { en: string; th: string } {
  const t = (text ?? '').trim()
  const hit = idx.get(norm(t))
  return hit ? { en: hit.en, th: hit.th } : { en: t, th: t }
}
export const resolvePart = (text: string) => resolve(PART_IDX, text)
export const resolveDefect = (text: string) => resolve(DEFECT_IDX, text)
