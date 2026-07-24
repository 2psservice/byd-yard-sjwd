// One place to render a damage's Part / Defect in either language, covering both
// the new bilingual master-list capture (area = English part, areaTh = Thai;
// item = English defect, itemTh = Thai) and legacy zone-id / type-id damages.
import { zoneLabel } from '../components/CarDiagramMultiView'
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

/** Defect label. English from `item` (or legacy type id). Thai from `itemTh`
 *  (or legacy `note`). Empty string when nothing is recorded. */
export function defectLabel(d: Pick<Damage, 'item' | 'itemTh' | 'type' | 'note'>, lang: 'en' | 'th'): string {
  if (lang === 'th') return d.itemTh || LEGACY_TYPES[d.type]?.th || d.note || ''
  return d.item || LEGACY_TYPES[d.type]?.en || (d.type && d.type !== '—' ? d.type : '') || ''
}
