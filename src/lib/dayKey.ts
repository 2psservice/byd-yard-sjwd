/**
 * Which calendar day did a tracking row gate in / gate out on?
 *
 * Shared by the Gate In/Out board and the daily stock report so both attribute
 * an event to the same day — the report reconstructs history from these keys,
 * so a second copy of the parsing rules would silently disagree with the board.
 */
import { isGateOutStamp, isLapsedPlan } from './carStatus'
import type { TrackRow } from './excelTracking'

export const MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * Best-effort date parse covering the 3 formats actually seen in this data:
 * plain ISO, this app's own dd/mm/yyyy[ HH:MM] stamp (written by the Ops Scan
 * station), and Excel's short-date display e.g. "20-May-26" (raw:false renders
 * each cell using the source file's own number format). Never guesses a
 * genuinely ambiguous format — returns null rather than risk attributing an
 * event to the wrong day.
 */
export function parseLooseDate(s: string | undefined): Date | null {
  const t = (s ?? '').trim()
  if (!t) return null
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3])
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/)
  if (m) {
    const mon = MONTH_ABBR[m[2].toLowerCase()]
    if (mon !== undefined) return new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon, +m[1])
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return new Date(+m[3], +m[2] - 1, +m[1])
  return null
}

/** Local calendar day as "YYYY-MM-DD" — comparable with < and >. */
export const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const todayKey = () => dateKey(new Date())

export const fmtDateTh = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Shift a day key by N days (negative = earlier). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + n))
}

/** Gate-in day: prefer the exact epoch the Ops Scan station stamps at the
 *  moment of gate-in (immune to later edits); fall back to the imported date. */
export function gateInDateKey(r: TrackRow): string | null {
  const ms = parseInt(r.cells['Gate In Time'] ?? '')
  if (!isNaN(ms) && ms > 0) return dateKey(new Date(ms))
  const d = parseLooseDate(r.cells['Gate In (Rayong yard)'])
  return d ? dateKey(d) : null
}

/** dd/mm/yyyy found ANYWHERE in a string (parseLooseDate is start-anchored, so
 *  it can't read the date out of a plan text like "แผนรับวันที่ 10/07/2026"). */
function embeddedDMY(s: string | undefined): Date | null {
  const m = (s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return null
  const d = new Date(+m[3], +m[2] - 1, +m[1])
  return isNaN(d.getTime()) ? null : d
}

/** Gate-out day, or null if the car has not actually left.
 *  Reads every gate-out signal deriveCarStatus accepts, so the daily-stock
 *  ledger and the dashboard agree on who is still in the yard:
 *  - a bare date in "Gate Out time stamp" (ops scan / tracking sheet)
 *  - a bare date in "Gate Out Date" (Vin List Inventory — sold cars)
 *  - a pickup PLAN whose date lapsed past the grace period → left ~plan day */
export function gateOutDateKey(r: TrackRow): string | null {
  const stamp = r.cells['Gate Out time stamp']
  if (isGateOutStamp(stamp)) {
    const d = parseLooseDate(stamp)
    if (d) return dateKey(d)
  }
  const dateCol = r.cells['Gate Out Date']
  if (isGateOutStamp(dateCol)) {
    const d = parseLooseDate(dateCol)
    if (d) return dateKey(d)
  }
  if (isLapsedPlan(stamp)) {
    const d = embeddedDMY(stamp)
    if (d) return dateKey(d)
  }
  return null
}
