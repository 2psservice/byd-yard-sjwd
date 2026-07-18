import type { Block, ParkingPolicy, SlotCandidate, Unit, UnitStatus } from '../types'

// A slot is considered occupied (or reserved) for these statuses.
const OCCUPYING: UnitStatus[] = ['ASSIGNED', 'PARKED', 'LOADED']

export const defaultPolicy = (model: string): ParkingPolicy => ({
  model,
  enabled: true,
  allowedBlocks: 'ALL',
  exclusiveRow: false,
})

export function getPolicy(model: string, policies: ParkingPolicy[]): ParkingPolicy {
  return policies.find((p) => p.model === model) ?? defaultPolicy(model)
}

interface RowInfo {
  occupants: Unit[]
  filled: Set<number>
  models: Set<string>
}

/** Map "<block>#<row>" -> occupancy info, considering only occupying statuses. */
export function buildOccupancy(units: Unit[]): Map<string, RowInfo> {
  const rows = new Map<string, RowInfo>()
  for (const u of units) {
    if (!u.block || !u.row || !u.slot) continue
    if (!OCCUPYING.includes(u.status)) continue
    const k = `${u.block}#${u.row}`
    let ri = rows.get(k)
    if (!ri) {
      ri = { occupants: [], filled: new Set(), models: new Set() }
      rows.set(k, ri)
    }
    ri.occupants.push(u)
    ri.filled.add(u.slot)
    ri.models.add(u.model)
  }
  return rows
}

function firstFreeSlot(filled: Set<number>, cols: number): number | null {
  for (let s = 1; s <= cols; s++) if (!filled.has(s)) return s
  return null
}

/**
 * Rank every legal slot for a unit, best first.
 *  - hard rules: allowedBlocks, rowFrom/rowTo, exclusiveRow (mine + others')
 *  - soft preference: keep one model per row, finish partial rows, compact fill
 */
export function candidates(
  unit: Unit,
  blocks: Block[],
  policies: ParkingPolicy[],
  units: Unit[],
  groupModelsInRow: boolean,
): SlotCandidate[] {
  const policy = getPolicy(unit.model, policies)
  if (!policy.enabled) return []

  const occ = buildOccupancy(units.filter((u) => u.vin !== unit.vin))
  const allowed =
    policy.allowedBlocks === 'ALL'
      ? blocks
      : blocks.filter((b) => (policy.allowedBlocks as string[]).includes(b.id))

  const exclusiveOf = (m: string) => getPolicy(m, policies).exclusiveRow
  const out: SlotCandidate[] = []

  allowed.forEach((b, bi) => {
    const rFrom = Math.max(1, policy.rowFrom ?? 1)
    const rTo = Math.min(b.rows, policy.rowTo ?? b.rows)
    for (let row = rFrom; row <= rTo; row++) {
      const ri = occ.get(`${b.id}#${row}`)
      const slot = firstFreeSlot(ri?.filled ?? new Set(), b.cols)
      if (slot == null) continue // row full

      const occupants = ri?.occupants ?? []
      const models = ri?.models ?? new Set<string>()
      const isEmpty = occupants.length === 0
      const onlyThis = !isEmpty && models.size === 1 && models.has(unit.model)
      const hasOther = [...models].some((m) => m !== unit.model)

      // ---- hard constraints ----
      if (!isEmpty) {
        if (policy.exclusiveRow && !onlyThis) continue // I demand exclusivity
        if ([...models].some((m) => m !== unit.model && exclusiveOf(m))) continue // row claimed by another exclusive model
      }

      // ---- score ----
      let score: number
      let reason: string
      if (onlyThis) {
        score = 1000 + occupants.length * 5 // finish same-model rows
        reason = `ต่อแถวรุ่นเดียวกัน · ${b.id} แถว ${row}`
      } else if (isEmpty) {
        score = 600
        reason = `เปิดแถวว่าง · ${b.id} แถว ${row}`
      } else {
        score = groupModelsInRow ? 120 : 240 // mixing — last resort when grouping on
        reason = `แทรกแถวที่มีรุ่นอื่น · ${b.id} แถว ${row}`
      }
      if (hasOther && groupModelsInRow && !policy.exclusiveRow) score -= 0 // already low
      score -= bi * 0.5 + row * 0.2 + slot * 0.05 // compact deterministic fill

      out.push({ block: b.id, row, slot, score, reason })
    }
  })

  out.sort((a, b) => b.score - a.score)
  return out
}

export function autoAssign(
  unit: Unit,
  blocks: Block[],
  policies: ParkingPolicy[],
  units: Unit[],
  groupModelsInRow: boolean,
): SlotCandidate | null {
  return candidates(unit, blocks, policies, units, groupModelsInRow)[0] ?? null
}

/** Distinct (block,row) options for the Semi-plan picker, best first, with free count. */
export function rowOptions(
  unit: Unit,
  blocks: Block[],
  policies: ParkingPolicy[],
  units: Unit[],
  groupModelsInRow: boolean,
): { block: string; row: number; free: number; slot: number; reason: string }[] {
  const cs = candidates(unit, blocks, policies, units, groupModelsInRow)
  const occ = buildOccupancy(units.filter((u) => u.vin !== unit.vin))
  const seen = new Set<string>()
  const res: { block: string; row: number; free: number; slot: number; reason: string }[] = []
  for (const c of cs) {
    const key = `${c.block}#${c.row}`
    if (seen.has(key)) continue
    seen.add(key)
    const block = blocks.find((b) => b.id === c.block)!
    const filled = occ.get(key)?.filled.size ?? 0
    res.push({ block: c.block, row: c.row, slot: c.slot, free: block.cols - filled, reason: c.reason })
  }
  return res
}
