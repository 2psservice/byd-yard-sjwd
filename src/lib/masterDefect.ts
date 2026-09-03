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

// A "/"-joined th or en cell already lists several synonyms of the same entry
// ("สีแตก / สีร้าว / สีกะเทาะ"); index every one of them on its own, not just
// the cell as a whole, so a synonym typed alone still resolves.
function buildIndex(list: MasterEntry[]): Map<string, MasterEntry> {
  const idx = new Map<string, MasterEntry>()
  const addAll = (cell: string | undefined, e: MasterEntry) => {
    for (const part of (cell ?? '').split('/')) {
      const key = norm(part)
      if (key && !idx.has(key)) idx.set(key, e)
    }
  }
  for (const e of list) { addAll(e.th, e); addAll(e.en, e) }
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

// Free text typed outside the bilingual picker (legacy imports, Co-Inspection
// files, admin free-typed forms) sometimes glues a bare side letter straight
// onto the Thai name with no picker markup ("กันชนหน้าR", "กันชนหลัง L") — the
// master list has no per-side bumper entries, so the letter has to be split
// off and reattached to the resolved English name rather than looked up.
function splitSide(raw: string): { base: string; side?: 'LH' | 'RH' } {
  const m = raw.match(/^(.+?)\s*([RL])$/)
  if (m && /[ก-๙]/.test(m[1])) return { base: m[1].trim(), side: m[2] === 'R' ? 'RH' : 'LH' }
  return { base: raw }
}

/** Best-effort match for a term the exact index missed: the longest indexed
 *  synonym contained in (or containing) the free text, so a known root word
 *  ("รอยขีด" inside "รอยขีดข่วน") still resolves instead of falling through
 *  untranslated. Length-gated on both sides so a short, generic key can't
 *  spuriously match unrelated text. */
function fuzzyMatch(idx: Map<string, MasterEntry>, key: string): MasterEntry | null {
  if (key.length < 4) return null
  let best: MasterEntry | null = null, bestLen = 0
  for (const [k, e] of idx) {
    if (k.length < 4 || k.length <= bestLen) continue
    if (key.includes(k) || k.includes(key)) { best = e; bestLen = k.length }
  }
  return best
}

function resolveOne(idx: Map<string, MasterEntry>, text: string): { en: string; th: string } | null {
  const key = norm(text)
  if (!key) return null
  const hit = idx.get(key) ?? fuzzyMatch(idx, key)
  return hit ? { en: hit.en, th: hit.th } : null
}

/** Resolve free text (Thai OR English) against the master list → both languages.
 *  Handles the messy shapes real (often imported) records carry: several
 *  defects joined with "+" ("สีกระเทาะ+รอยจิก" → each resolved on its own and
 *  rejoined), and a side letter glued onto a Thai name (see splitSide above).
 *  A segment the list has no match for at all — exact, synonym, or fuzzy —
 *  passes through verbatim (en = th = that segment) rather than being
 *  guessed at, so an export still reads mostly English with just the
 *  genuinely-unlisted term left in Thai as a visible flag to add to the list. */
function resolve(idx: Map<string, MasterEntry>, text: string): { en: string; th: string } {
  const whole = (text ?? '').trim()
  if (!whole) return { en: '', th: '' }
  const segments = whole.split('+').map((s) => s.trim()).filter(Boolean)
  const parts = (segments.length ? segments : [whole]).map((seg) => {
    const { base, side } = splitSide(seg)
    const hit = resolveOne(idx, base)
    const en = hit ? hit.en : base
    const th = hit ? hit.th : base
    return { en: side ? `${en} ${side}` : en, th: side ? `${th} ${side}` : th }
  })
  return { en: parts.map((p) => p.en).join(' + '), th: parts.map((p) => p.th).join(' + ') }
}
export const resolvePart = (text: string) => resolve(partIndex(liveParts()), text)
export const resolveDefect = (text: string) => resolve(defectIndex(liveDefects()), text)
