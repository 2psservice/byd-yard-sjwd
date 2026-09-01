// Bilingual master lists for the gate-in damage capture. Field staff record in
// Thai (with the English shown alongside); the stored record keeps BOTH so the
// admin Unit page shows English + Thai and the report shows English only.
//
// The lists themselves are ADMIN-EDITABLE (Import → Master Defect List), so
// everything here reads the live store rather than the shipped constants — a
// part renamed in the morning resolves the new way that afternoon. The index is
// rebuilt only when the list object actually changes.
import { liveParts, liveDefects, type MasterEntry } from '../store/useMasterDefect'

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

/** Index cache keyed on the list array itself — a new array means a real edit. */
function indexer() {
  let src: MasterEntry[] | null = null
  let idx = new Map<string, MasterEntry>()
  return (list: MasterEntry[]) => {
    if (list !== src) { src = list; idx = buildIndex(list) }
    return idx
  }
}
const partIndex = indexer()
const defectIndex = indexer()

/** Resolve free text (Thai OR English) against the master list → both languages.
 *  Unknown text (a custom entry) comes back with en = th = the raw text. */
function resolve(idx: Map<string, MasterEntry>, text: string): { en: string; th: string } {
  const t = (text ?? '').trim()
  const hit = idx.get(norm(t))
  return hit ? { en: hit.en, th: hit.th } : { en: t, th: t }
}
export const resolvePart = (text: string) => resolve(partIndex(liveParts()), text)
export const resolveDefect = (text: string) => resolve(defectIndex(liveDefects()), text)
