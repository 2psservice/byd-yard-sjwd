/** A cell by its header whatever the spelling — "Sub-Model", "Sub Model", "SubModel" all read the same. */
export const cellByHeader = (cells: Record<string, string>, header: string): string => {
  const want = header.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const [k, v] of Object.entries(cells)) if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === want && (v ?? '').trim()) return v.trim()
  return ''
}

/**
 * The car's full model with its trim, e.g. "BYD ATTO 1 PREMIUM" / "BYD DOLPHIN (490KM-EXT)", not the bare
 * "ATTO 1": the VIN LIST MASTER file carries it in "Sub-Model", the Co file in "Model name"; a car known
 * only by "Model" still prints that. The brand leads like the rest of the yard's paperwork.
 * Used by the Vehicle Label sticker and the IR (both print styles). '—' when nothing is known.
 */
export function labelModel(cells: Record<string, string>): string {
  const v = (cellByHeader(cells, 'Sub-Model') || cells['Model name'] || cells['Model'] || '').trim()
  if (!v) return '—'
  return /^byd\b/i.test(v) ? v : `BYD ${v}`
}
