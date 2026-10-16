/**
 * PM Plan — which day of a month a car falls due for PM.
 *
 * The cycle is counted from `base` (see pmCountFrom in trackingColumns.ts: the latest PM when the
 * car has had one, otherwise its PDI date, otherwise Gate In): the first PM is one interval after
 * `base`, then every interval after. Kept free of React so the plan grid and its tests share it.
 */
const DAY_MS = 86_400_000

/** The days (1…31) of `month` (1-12) on which a car counted from `base` (ms) falls due, in order. */
export function pmDueDays(base: number, interval: number, year: number, month: number): number[] {
  const daysInMonth = new Date(year, month, 0).getDate()
  const monthStart = new Date(year, month - 1, 1).getTime()
  const monthEnd = new Date(year, month - 1, daysInMonth, 23, 59, 59, 999).getTime()
  const step = interval * DAY_MS
  const out: number[] = []
  const n = Math.max(1, Math.ceil((monthStart - base) / step))
  for (let due = base + n * step; due <= monthEnd; due += step) {
    if (due < monthStart) continue
    out.push(new Date(due).getDate())
  }
  return out
}
