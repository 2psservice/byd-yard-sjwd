/**
 * Car Status lifecycle — shared by the Units grid and the Dashboard so both read
 * the same status off an imported tracking row.
 *   Pre Gate-in → Gate-in → In Yard → (Moving / PDI) → Ready → Gate-out
 */
export const CAR_STATUS_META: Record<string, { color: string; bg: string }> = {
  'Pre Gate-in':  { color: '#5b4a00', bg: '#facc15' }, // เหลือง
  'Gate-in':      { color: '#fff',    bg: '#0ea5e9' }, // ฟ้า
  'In Yard':      { color: '#fff',    bg: '#15803d' }, // เขียวเข้ม
  'Moving':       { color: '#fff',    bg: '#2563eb' }, // น้ำเงิน
  'PDI':          { color: '#fff',    bg: '#f97316' }, // ส้ม
  'Ready':        { color: '#fff',    bg: '#22c55e' }, // เขียวสดใส
  'Preload':      { color: '#fff',    bg: '#0d9488' }, // เขียวอมฟ้า — จอด preload รอรถมารับ
  'Pre Gate-out': { color: '#fff',    bg: '#f59e0b' }, // ส้มอำพัน — สแกนออกแล้ว รอ flush 9:30
  'Gate-out':     { color: '#fff',    bg: '#94a3b8' }, // เทา
  'Total loss':   { color: '#fff',    bg: '#991b1b' }, // แดงเข้ม — รถ write-off (total loss)
}

export const CAR_STATUS_ORDER = ['Pre Gate-in', 'Gate-in', 'In Yard', 'Moving', 'PDI', 'Ready', 'Preload', 'Pre Gate-out', 'Gate-out', 'Total loss'] as const
/** statuses that count as physically in the yard.
 *  Total loss = a written-off car that is STILL physically parked in the yard
 *  (not sellable, but present) → counts as in-yard, never treated as gated-out. */
export const IN_YARD_STATUSES = new Set(['Gate-in', 'In Yard', 'Moving', 'PDI', 'Ready', 'Total loss'])
/** statuses that count as parked in a block */
export const PARKED_STATUSES = new Set(['In Yard', 'PDI', 'Ready', 'Total loss'])

/**
 * Does a "Gate Out time stamp" cell mean the car ACTUALLY gated out?
 * Only when the value is just a date / timestamp. A value carrying words — e.g.
 * "แผนรับวันที่ 10/07/2026" (a pickup PLAN) — means the car is still in the yard,
 * NOT gated out. Detected by stripping every date/time token (digits, separators,
 * month names, the Thai time marker "น"); if descriptive letters survive it's a
 * plan/note → treat as still-in-yard, not a gate-out.
 *   "09/07/2026"                → true  (bare date → gated out)
 *   "แผนรับวันที่ 10/07/2026"   → false (has plan text → still In Yard)
 */
export function isGateOutStamp(v: string | undefined | null): boolean {
  const s = (v ?? '').trim()
  if (!s) return false
  const leftover = s
    .replace(/\d+/g, ' ')
    .replace(/[/\-.:,]/g, ' ')
    .replace(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm)/gi, ' ')
    .replace(/น/g, ' ') // "น" — Thai time marker (นาฬิกา)
    .replace(/\s+/g, '')
  // must actually be a date/serial — a bare "-" (no digits) is NOT a gate-out
  return leftover === '' && /\d/.test(s)
}

/** Parse a "DD/MM/YYYY" (day-first, Thai convention) date out of a string →
 *  Date at local midnight, or null. */
function parseDMY(s: string): Date | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return null
  const day = +m[1], mon = +m[2], year = +m[3]
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null
  const d = new Date(year, mon - 1, day)
  return isNaN(d.getTime()) ? null : d
}

/**
 * A pickup PLAN in "Gate Out time stamp" ("แผนรับวันที่ 10/07/2026") schedules the
 * car for collection. Once that planned date has passed by MORE than `graceDays`
 * (default 2) it is treated as an actual gate-out — the car was collected around
 * the plan date. (Today 13th, plan 10th → 3 days late → gated out; plan 11th → 2
 * days, still in yard; a future/today plan stays in yard.) A bare date is NOT a
 * plan — that's a real gate-out handled by isGateOutStamp, so it's excluded here.
 */
export function isLapsedPlan(v: string | undefined | null, now: Date = new Date(), graceDays = 2): boolean {
  const s = (v ?? '').trim()
  if (!s || isGateOutStamp(s)) return false // empty, or a bare gate-out date (not a plan)
  const plan = parseDMY(s)
  if (!plan) return false
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const plan0 = new Date(plan.getFullYear(), plan.getMonth(), plan.getDate()).getTime()
  return (today0 - plan0) / 86400000 > graceDays
}

/** Daily flush hour for Pre Gate-out → Gate-out (09:30 local). */
export const GATE_OUT_FLUSH_H = 9
export const GATE_OUT_FLUSH_M = 30

/** epoch(ms) a Pre-Gate-out car was scanned out — from the "Gate Out Time" cell,
 *  else parsed from the "dd/mm/yyyy hh:mm" display stamp. 0 if unknown. */
function gateOutScanMs(c: Record<string, string>): number {
  const t = parseInt(c['Gate Out Time'] || '', 10)
  if (Number.isFinite(t) && t > 0) return t
  const m = (c['Gate Out time stamp'] || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (!m) return 0
  const d = new Date(+m[3], +m[2] - 1, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0)
  return isNaN(d.getTime()) ? 0 : d.getTime()
}

/**
 * A Pre-Gate-out car (ops-scan gate-out) is finalised as a real Gate-out at the
 * first 09:30 AFTER it was scanned out — the daily "flush". Before that flush it
 * is still on-site; confirming Preload in the meantime keeps it (as 'Preload').
 */
export function pastGateOutFlush(c: Record<string, string>, now: number = Date.now()): boolean {
  const t = gateOutScanMs(c)
  if (!t) return false
  const d = new Date(t)
  const flush = new Date(d.getFullYear(), d.getMonth(), d.getDate(), GATE_OUT_FLUSH_H, GATE_OUT_FLUSH_M, 0, 0)
  if (flush.getTime() <= t) flush.setDate(flush.getDate() + 1) // scanned after 09:30 → next day's flush
  return now >= flush.getTime()
}

/**
 * Derive a Car Status from imported sheet fields when not set explicitly. An
 * admin can override it; the importer stamps 'Pre Gate-in' on new vehicles.
 */
export function deriveCarStatus(c: Record<string, string>): string {
  // Total loss (write-off) is a definitive terminal fact about the vehicle —
  // it wins over the lifecycle status so a written-off car is always visible.
  if (/total\s*loss/i.test(c['Vin Of Status'] || '')) return 'Total loss'
  // a pickup plan whose date lapsed > 2 days ago ⇒ the car was collected → Gate-out,
  // overriding the stale "In Yard" the importer stamped before the plan date passed
  if (isLapsedPlan(c['Gate Out time stamp'])) return 'Gate-out'
  const explicit = (c['Car Status'] || '').trim()
  // Pre Gate-out: ops-scan gate-out parks the car in preload until the daily 09:30
  // flush, when it becomes a real Gate-out (unless it was confirmed Preload first).
  if (explicit === 'Pre Gate-out') return pastGateOutFlush(c) ? 'Gate-out' : 'Pre Gate-out'
  if (explicit) return explicit
  // gate-out signal — the Tracking Status sheet uses "Gate Out time stamp",
  // the Vin List Inventory uses "Gate Out Date"; either real date = gated out
  if (isGateOutStamp(c['Gate Out time stamp']) || isGateOutStamp(c['Gate Out Date'])) return 'Gate-out'
  if ((c['Grouping  Number'] || '').trim()) return 'Ready'
  const gateIn = (c['Gate In (Rayong yard)'] || '').trim()
  if (!gateIn || gateIn === '—') return 'Pre Gate-in'
  const storage = (c['storage Yard'] || '').trim()
  const loc = c['Location yard'] || ''
  if (storage || /yard/i.test(loc)) return 'In Yard'
  return 'Gate-in'
}

/** true if the row should count as "damaged / needs review" */
export function isDamaged(c: Record<string, string>): boolean {
  const st = (c['Status'] || '').toLowerCase()
  const fs = (c['Final Status'] || '').toLowerCase()
  return st.includes('ng') || fs.includes('repair')
}

/** true if the car is still WAITING for repair — Final Status = "Waiting Repair".
 *  Distinct from isDamaged (any NG / already-repaired): this counts only the cars
 *  that still need work, which is what the dashboard "Damage" KPI reports. Matched
 *  loosely (case / spacing tolerant) but excludes "OK-Repaired" (no "wait"). */
export function isWaitingRepair(c: Record<string, string>): boolean {
  const fs = (c['Final Status'] || '').toLowerCase()
  return fs.includes('wait') && fs.includes('repair')
}

/** Solid TOS-style badge colours for Final Status — shared by the Units grid
 *  badge and the Yard Plan "Final Status" view mode so both agree on colour. */
export function finalColor(v: string): { color: string; bg: string } | null {
  const s = v.toLowerCase()
  if (s.startsWith('ok')) return { color: '#fff', bg: '#16a34a' }       // OK-Accept / OK-Repaired
  if (s.includes('repair')) return { color: '#fff', bg: '#dc2626' }     // Waiting Repair
  if (s.includes('wait')) return { color: '#5b4a00', bg: '#facc15' }    // Waiting
  return null
}

/** Solid badge colours for the "Vin Of Status" column (FIS lifecycle). */
export function vinOfStatusColor(v: string): { color: string; bg: string } | null {
  const s = v.toLowerCase()
  if (/total\s*loss/.test(s)) return { color: '#fff', bg: '#991b1b' }   // write-off — แดงเข้ม
  if (s.includes('deliver')) return { color: '#fff', bg: '#16a34a' }    // FIS for delivery — เขียว
  if (s.includes('wait') || s.includes('alloc')) return { color: '#5b4a00', bg: '#facc15' } // FIS Waiting Allocation — เหลือง
  if (s.includes('fis')) return { color: '#fff', bg: '#0ea5e9' }        // สถานะ FIS อื่น ๆ — ฟ้า
  return null
}

/** Solid badge colours for the "Status Tax" column — matches the YardOps tax chip
 *  (green = paid, red = not paid, yellow = waiting). */
export function taxStatusColor(v: string): { color: string; bg: string } | null {
  const s = v.toLowerCase()
  if (/yes|already|paid|ชำระแล้ว|เสียแล้ว/.test(s)) return { color: '#fff', bg: '#16a34a' } // จ่ายแล้ว — เขียว
  if (/^no|ยังไม่|not/.test(s)) return { color: '#fff', bg: '#dc2626' }  // ยังไม่จ่าย — แดง
  if (s.includes('wait') || s.includes('รอ')) return { color: '#5b4a00', bg: '#facc15' } // รอ — เหลือง
  return null
}
