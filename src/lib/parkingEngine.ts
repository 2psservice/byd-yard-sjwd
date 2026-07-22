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

/**
 * Rank every legal slot for a unit, best first.
 *
 * Fill order is COLUMN-major (lane-by-lane): the yard is striped into vertical
 * lanes (the grid's ช่อง / `slot`, 1…cols) and each lane is filled depth-first
 * down its rows (แถว / `row`, rowFrom…rowTo) before the next lane is opened. So
 * lane 1 fills solid top-to-bottom, then lane 2, then lane 3 … up to the last
 * lane (e.g. 50). Depth is capped per model by the Row-window (rowFrom/rowTo)
 * set on the Parking Rules page — leave it at 7–8 for the SS block.
 *
 *  - hard rules: allowedBlocks, rowFrom/rowTo (lane depth), exclusiveRow
 *  - mixed models are allowed in a lane; a mild bonus keeps a lane single-model
 *    when that doesn't fight the left-to-right lane order.
 */
export function candidates(
  unit: Unit,
  blocks: Block[],
  policies: ParkingPolicy[],
  units: Unit[],
  _groupModelsInRow: boolean,
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
    // Scan lanes left → right; within each lane take the shallowest free (and
    // admissible) depth, then stop — one proposal per lane so cycling the
    // alternatives walks lane 1, lane 2, lane 3 … in order.
    for (let slot = 1; slot <= b.cols; slot++) {
      for (let row = rFrom; row <= rTo; row++) {
        const ri = occ.get(`${b.id}#${row}`)
        if (ri?.filled.has(slot)) continue // this depth in the lane is taken

        const occupants = ri?.occupants ?? []
        const models = ri?.models ?? new Set<string>()
        const isEmpty = occupants.length === 0
        const onlyThis = !isEmpty && models.size === 1 && models.has(unit.model)

        // ---- hard constraints (row-level) ----
        if (!isEmpty) {
          if (policy.exclusiveRow && !onlyThis) continue // I demand exclusivity
          if ([...models].some((m) => m !== unit.model && exclusiveOf(m))) continue // row claimed by another exclusive model
        }

        // lane order dominates (slot × 10), then depth (row); a same-model lane
        // gets +5 — never enough to jump ahead of a lower-numbered lane.
        let score = 1000 - (bi * 1000 + slot * 10 + row)
        if (onlyThis) score += 5
        const reason = isEmpty
          ? `เลนว่าง · ${b.id} ช่อง ${slot}`
          : onlyThis
            ? `ต่อเลนรุ่นเดียวกัน · ${b.id} ช่อง ${slot}`
            : `จอดคละรุ่น · ${b.id} ช่อง ${slot}`

        out.push({ block: b.id, row, slot, score, reason })
        break // next lane
      }
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
