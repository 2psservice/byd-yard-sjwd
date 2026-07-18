import type { UnitStatus } from '../types'

export function timeAgo(ts: number | undefined, lang: 'th' | 'en' = 'th'): string {
  if (!ts) return '—'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return lang === 'th' ? 'เมื่อสักครู่' : 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return lang === 'th' ? `${m} นาทีก่อน` : `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return lang === 'th' ? `${h} ชม.ก่อน` : `${h}h ago`
  const d = Math.floor(h / 24)
  return lang === 'th' ? `${d} วันก่อน` : `${d}d ago`
}

export function clock(ts: number | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function timeOnly(ts: number | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const STATUS_META: Record<
  UnitStatus,
  { th: string; en: string; color: string; bg: string }
> = {
  EXPECTED: { th: 'รอเข้า Yard', en: 'Pre Gate-in', color: '#eab308', bg: 'rgba(234,179,8,0.14)' },
  GATE_IN: { th: 'เข้าลานแล้ว', en: 'Gate-In', color: '#06b6d4', bg: 'rgba(6,182,212,0.14)' },
  ASSIGNED: { th: 'กำลังนำจอด', en: 'Assigned', color: '#3b82f6', bg: 'rgba(59,130,246,0.14)' },
  PARKED: { th: 'จอดแล้ว', en: 'Parked', color: '#22c55e', bg: 'rgba(34,197,94,0.14)' },
  LOADED: { th: 'ขึ้นรถส่ง', en: 'Loaded', color: '#a855f7', bg: 'rgba(168,85,247,0.14)' },
  DEPARTED: { th: 'ออกจากลาน', en: 'Departed', color: '#64748b', bg: 'rgba(100,116,139,0.14)' },
}

export const CATEGORY_META: Record<string, { th: string; en: string; color: string; bg: string }> = {
  EXPORT: { th: 'ส่งออก', en: 'Export', color: '#2563eb', bg: '#dbeafe' },
  DOMESTIC: { th: 'ในประเทศ', en: 'Domestic', color: '#0d9488', bg: '#ccfbf1' },
  IMPORT: { th: 'นำเข้า', en: 'Import', color: '#c2680b', bg: '#ffedd5' },
}

/** Terminal state, RoRo-TOS style (Yard / Loaded / Departed). */
export function tState(status: UnitStatus): { key: string; th: string; en: string; color: string; bg: string } {
  if (status === 'LOADED') return { key: 'Loaded', th: 'ขึ้นรถส่ง', en: 'Loaded', color: '#2563eb', bg: '#dbeafe' }
  if (status === 'DEPARTED') return { key: 'Departed', th: 'ออกแล้ว', en: 'Departed', color: '#64748b', bg: '#e2e8f0' }
  if (status === 'EXPECTED') return { key: 'Pre-Yard', th: 'รอเข้า Yard', en: 'Pre Gate-in', color: '#94a3b8', bg: '#eef1f6' }
  return { key: 'Yard', th: 'ในลาน', en: 'Yard', color: '#a16207', bg: '#fef9c3' }
}

// Yard address, column-first: block + COLUMN(slot) + row-in-column. A lane block
// stores the LaneNo column in `slot` and the 1..8 stack position in `row`, so the
// column is the primary identifier and comes first (e.g. RR3805 = block RR,
// column 38, car 5). Padded, dotless — the compact code used in detail/plan cards.
export function pos(u: { block?: string; row?: number; slot?: number }): string {
  if (!u.block) return '—'
  return `${u.block}${String(u.slot).padStart(2, '0')}${String(u.row).padStart(2, '0')}`
}

const normBlockTag = (s?: string) => (s ?? '').trim().toUpperCase()

/** Unit ↔ drawn-block matcher. A unit's block tag can be the block's internal
 *  id (auto A–Z from the layout editor) or its display name — the Update
 *  Location import tags cars by the block NAME (e.g. "NN"). */
export function unitInBlock(u: { block?: string }, b: { id: string; name: string }): boolean {
  const t = normBlockTag(u.block)
  return !!t && (t === normBlockTag(b.id) || t === normBlockTag(b.name))
}

/** Short display tag for a block — its name when it's a short code (AA/NN), else its id. */
export function blockTag(b: { id: string; name: string }): string {
  const n = normBlockTag(b.name)
  return /^[A-Z0-9]{1,4}$/.test(n) ? n : b.id
}

export function pct(a: number, b: number): number {
  if (!b) return 0
  return Math.round((a / b) * 100)
}

/** downscale + compress an image File to a small dataURL for storage */
export function fileToDataUrl(file: File, max = 720, quality = 0.6): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const reader = new FileReader()
    reader.onload = () => {
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.round(img.width * scale)
        c.height = Math.round(img.height * scale)
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/jpeg', quality))
      }
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
