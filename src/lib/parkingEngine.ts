import type { Block, ParkingPolicy, SlotCandidate, Unit, UnitStatus } from '../types'
import { blockKeyOfTag, blockTag } from './format'

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

/** Map "<blockKey>#<row>" -> occupancy info, considering only occupying
 *  statuses. Keys use the canonical block key (collapsed name) so a unit
 *  tagged "Q" and one tagged "QQ" count into the same lane. */
export function buildOccupancy(units: Unit[]): Map<string, RowInfo> {
  const rows = new Map<string, RowInfo>()
  for (const u of units) {
    if (!u.block || !u.row || !u.slot) continue
    if (!OCCUPYING.includes(u.status)) continue
    const k = `${blockKeyOfTag(u.block)}#${u.row}`
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

interface LaneInfo {
  rows: Set<number> // occupied depths (แถว) in this lane
  models: Set<string> // distinct models parked in this lane
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
 *  - `groupModelsInRow` = keep one model per LANE (ช่อง): when ON, a lane that
 *    already holds a different model is skipped (open the next lane instead);
 *    when OFF, models may be mixed within a lane and it fills purely by lane
 *    order. Either way a mild bonus keeps a lane single-model when it can.
 */
export function candidates(
  unit: Unit,
  blocks: Block[],
  policies: ParkingPolicy[],
  units: Unit[],
  groupModelsInRow: boolean,
  laneDepth = 7,
): SlotCandidate[] {
  const policy = getPolicy(unit.model, policies)
  if (!policy.enabled) return []

  const others = units.filter(
    (u) => u.vin !== unit.vin && u.block && u.row && u.slot && OCCUPYING.includes(u.status),
  )
  // lane view (`${block}#${slot}` → depths + models) drives column-major fill;
  // row view (`${block}#${row}` → models) drives the row-level exclusiveRow rule.
  const lanes = new Map<string, LaneInfo>()
  const rowModels = new Map<string, Set<string>>()
  for (const u of others) {
    // canonical key: tags written as the id, the name or a collapsed letter all
    // land on the same lane — an id-keyed scan used to miss name-tagged cars
    // and propose their occupied cells
    const bk = blockKeyOfTag(u.block)
    const lk = `${bk}#${u.slot}`
    let li = lanes.get(lk)
    if (!li) { li = { rows: new Set(), models: new Set() }; lanes.set(lk, li) }
    li.rows.add(u.row!)
    li.models.add(u.model)
    const rk = `${bk}#${u.row}`
    let rm = rowModels.get(rk)
    if (!rm) { rm = new Set(); rowModels.set(rk, rm) }
    rm.add(u.model)
  }

  const allowed =
    policy.allowedBlocks === 'ALL'
      ? blocks
      // match by the block's NAME; legacy policies that stored internal ids
      // keep working until they are next edited
      : blocks.filter((b) => (policy.allowedBlocks as string[]).some((a) => a === blockTag(b) || a === b.id))

  const exclusiveOf = (m: string) => getPolicy(m, policies).exclusiveRow
  const out: SlotCandidate[] = []

  allowed.forEach((b, bi) => {
    const bk = blockTag(b) // the block's NAME — what gets stamped on the car
    const rFrom = Math.max(1, policy.rowFrom ?? 1)
    // depth cap = per-model Row-window (advanced override) or the global lane
    // depth (default 7). Once a lane is full to this depth the loop finds no
    // free row and the scan advances to the next lane — including empty lanes.
    const rTo = Math.min(b.rows, policy.rowTo ?? laneDepth)
    // Scan lanes left → right; within each lane take the shallowest free (and
    // admissible) depth, then stop — one proposal per lane so cycling the
    // alternatives walks lane 1, lane 2, lane 3 … in order.
    for (let slot = 1; slot <= b.cols; slot++) {
      const lane = lanes.get(`${bk}#${slot}`)
      const laneModels = lane?.models ?? new Set<string>()
      const laneEmpty = !lane || lane.rows.size === 0
      const laneOnlyThis = !laneEmpty && laneModels.size === 1 && laneModels.has(unit.model)
      const laneHasOther = [...laneModels].some((m) => m !== unit.model)

      // one model per lane: this lane belongs to another model → open the next
      if (groupModelsInRow && laneHasOther) continue
      // a lane already claimed by an exclusive-row model is off-limits to others
      if (laneHasOther && [...laneModels].some((m) => m !== unit.model && exclusiveOf(m)) && !laneOnlyThis) continue

      for (let row = rFrom; row <= rTo; row++) {
        if (lane?.rows.has(row)) continue // this depth in the lane is taken

        // ---- row-level exclusiveRow (แถว reserved for a single model) ----
        const rowMs = rowModels.get(`${bk}#${row}`) ?? new Set<string>()
        const rowEmpty = rowMs.size === 0
        const rowOnlyThis = !rowEmpty && rowMs.size === 1 && rowMs.has(unit.model)
        if (!rowEmpty) {
          if (policy.exclusiveRow && !rowOnlyThis) continue // I demand an exclusive row
          if ([...rowMs].some((m) => m !== unit.model && exclusiveOf(m))) continue // row claimed by another exclusive model
        }

        // lane order dominates (slot × 10), then depth (row); a same-model lane
        // gets +5 — never enough to jump ahead of a lower-numbered lane.
        let score = 1000 - (bi * 1000 + slot * 10 + row)
        if (laneOnlyThis) score += 5
        const reason = laneEmpty
          ? `เลนว่าง · ${bk} ช่อง ${slot}`
          : laneOnlyThis
            ? `ต่อเลนรุ่นเดียวกัน · ${bk} ช่อง ${slot}`
            : `จอดคละรุ่น · ${bk} ช่อง ${slot}`

        out.push({ block: bk, row, slot, score, reason })
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
  laneDepth = 7,
): SlotCandidate | null {
  return candidates(unit, blocks, policies, units, groupModelsInRow, laneDepth)[0] ?? null
}

/** First free slot in ONE SPECIFIC block by name — ignores per-model policy
 *  (allowedBlocks / exclusiveRow / groupModelsInRow) entirely, unlike
 *  `candidates`. Used for the universal Gate-in staging block ("WCL"), which
 *  accepts every model on its way to a real slot via Re-location, so a
 *  model's normal parking policy must not gate whether it can land there.
 *  Column-major fill (lane 1 top-to-bottom, then lane 2…), same order as
 *  `candidates`. Returns null if the block doesn't exist or is full. */
export function nextFreeSlotInBlock(
  blockName: string, blocks: Block[], units: Unit[],
): { block: string; row: number; slot: number } | null {
  const b = blocks.find((x) => blockTag(x) === blockName)
  if (!b) return null
  const occ = buildOccupancy(units)
  const bk = blockKeyOfTag(blockName)
  for (let slot = 1; slot <= b.cols; slot++) {
    for (let row = 1; row <= b.rows; row++) {
      if (!occ.get(`${bk}#${row}`)?.filled.has(slot)) return { block: blockTag(b), row, slot }
    }
  }
  return null
}

/** Distinct (block,row) options for the Semi-plan picker, best first, with free count. */
export function rowOptions(
  unit: Unit,
  blocks: Block[],
  policies: ParkingPolicy[],
  units: Unit[],
  groupModelsInRow: boolean,
  laneDepth = 7,
): { block: string; row: number; free: number; slot: number; reason: string }[] {
  const cs = candidates(unit, blocks, policies, units, groupModelsInRow, laneDepth)
  const occ = buildOccupancy(units.filter((u) => u.vin !== unit.vin))
  const seen = new Set<string>()
  const res: { block: string; row: number; free: number; slot: number; reason: string }[] = []
  for (const c of cs) {
    const key = `${c.block}#${c.row}`
    if (seen.has(key)) continue
    seen.add(key)
    const block = blocks.find((b) => blockTag(b) === c.block)!
    const filled = occ.get(key)?.filled.size ?? 0
    res.push({ block: c.block, row: c.row, slot: c.slot, free: block.cols - filled, reason: c.reason })
  }
  return res
}
