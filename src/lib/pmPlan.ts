/**
 * PM Plan — which day of a month a car falls due for PM.
 *
 * The cycle is counted from `base` (see pmCountFrom in trackingColumns.ts: the latest PM when the
 * car has had one, otherwise its PDI date, otherwise Gate In): the first PM is one interval after
 * `base`, then every interval after. The plan lists each car ONCE per month, on its first due day —
 * a 30-day cycle can fit twice in a 31-day month, but the second round is not planned (the car's
 * cycle restarts from the PM actually done), so the plan's total equals the number of cars.
 * Kept free of React so the plan grid and its tests share it.
 */
const DAY_MS = 86_400_000

/** The day (1…31) of `month` (1-12) on which a car counted from `base` (ms) first falls due, or null
 *  when its next due date is not in that month. */
export function pmDueDay(base: number, interval: number, year: number, month: number): number | null {
  const daysInMonth = new Date(year, month, 0).getDate()
  const monthStart = new Date(year, month - 1, 1).getTime()
  const monthEnd = new Date(year, month - 1, daysInMonth, 23, 59, 59, 999).getTime()
  const step = interval * DAY_MS
  const n = Math.max(1, Math.ceil((monthStart - base) / step))
  const due = base + n * step
  return due >= monthStart && due <= monthEnd ? new Date(due).getDate() : null
}
