// One place to render a damage's Part / Defect in either language, covering both
// the new bilingual master-list capture (area = English part, areaTh = Thai;
// item = English defect, itemTh = Thai) and legacy zone-id / type-id damages.
import { zoneLabel } from '../components/CarDiagramMultiView'
import { resolvePart, resolveDefect } from './masterDefect'
import type { Damage } from '../types'

// the 5 legacy defect ids used before the master Defect list
const LEGACY_TYPES: Record<string, { en: string; th: string }> = {
  scratch: { en: 'Scratch', th: 'รอยขีดข่วน' },
  dent:    { en: 'Dent', th: 'บุบ' },
  chip:    { en: 'Paint chip', th: 'สีกระเทาะ' },
  crack:   { en: 'Crack', th: 'แตก/ร้าว' },
  missing: { en: 'Missing part', th: 'ชิ้นส่วนหาย' },
}

/** Part / position label. English: new damages store English in `area`, legacy
 *  store a zone id (zoneLabel translates it). Thai: prefer the stored `areaTh`. */
export function partLabel(d: Pick<Damage, 'area' | 'areaTh'>, lang: 'en' | 'th'): string {
  if (lang === 'th') return d.areaTh || zoneLabel(d.area, 'th')
  return zoneLabel(d.area, 'en')
}

/** Defect label. English from `item` (or legacy type id). Thai from `itemTh`,
 *  else the English defect name — NOT `note`: imported defects never carry a
 *  Thai translation and their `note` holds From/Stock/Remark metadata, so the
 *  old fallback rendered a yard code ("NYB2") where the defect ("Rust") belongs.
 *  `note` stays as the last resort for legacy in-app damages that only have it. */
export function defectLabel(d: Pick<Damage, 'item' | 'itemTh' | 'type' | 'note'>, lang: 'en' | 'th'): string {
  const en = d.item || LEGACY_TYPES[d.type]?.en || (d.type && d.type !== '—' ? d.type : '') || ''
  if (lang === 'th') return d.itemTh || LEGACY_TYPES[d.type]?.th || en || d.note || ''
  return en
}

/** Both languages for a damage's Part / Defect, filling in the missing side from
 *  the master Defect list (the same wording the +ADD DEFECT dropdowns offer), so
 *  imported rows that stored only one language still show EN with TH underneath.
 *  `th === en` means no translation is known — callers should then show one line. */
export function partBilingual(d: Pick<Damage, 'area' | 'areaTh'>): { en: string; th: string } {
  const m = resolvePart(d.area || d.areaTh || '')
  const known = m.en !== m.th // the master list matched and has both languages
  return {
    en: known ? m.en : partLabel(d, 'en'),
    th: d.areaTh || (known ? m.th : partLabel(d, 'th')),
  }
}

export function defectBilingual(d: Pick<Damage, 'item' | 'itemTh' | 'type' | 'note'>): { en: string; th: string } {
  const m = resolveDefect(d.item || d.itemTh || d.type || '')
  const known = m.en !== m.th
  return {
    en: known ? m.en : defectLabel(d, 'en'),
    th: d.itemTh || (known ? m.th : defectLabel(d, 'th')),
  }
}
