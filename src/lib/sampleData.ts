import type { Block, Damage, ParkingPolicy, Trailer, Unit, VehicleModel } from '../types'
import { autoAssign } from './parkingEngine'

// ---- BYD line-up (color = yard-grid hue) ----
export const MODELS: VehicleModel[] = [
  { id: 'ATTO3', name: 'BYD ATTO 3', segment: 'SUV', color: '#22d3ee', lengthM: 4.46 },
  { id: 'ATTO2', name: 'BYD ATTO 2', segment: 'SUV', color: '#2dd4bf', lengthM: 4.31 },
  { id: 'ATTO1', name: 'BYD ATTO 1', segment: 'Hatchback', color: '#5eead4', lengthM: 4.10 },
  { id: 'DOLPHIN', name: 'BYD DOLPHIN', segment: 'Hatchback', color: '#34d399', lengthM: 4.29 },
  { id: 'SEAL5', name: 'BYD SEAL 5', segment: 'Sedan', color: '#818cf8', lengthM: 4.98 },
  { id: 'SEAL6', name: 'BYD SEAL 6', segment: 'Sedan', color: '#6366f1', lengthM: 4.84 },
  { id: 'SEAL', name: 'BYD SEAL', segment: 'Sedan', color: '#a5b4fc', lengthM: 4.80 },
  { id: 'SEALION5', name: 'BYD SEALION 5', segment: 'SUV', color: '#f9a8d4', lengthM: 4.78 },
  { id: 'SEALION6', name: 'BYD SEALION 6', segment: 'SUV', color: '#f472b6', lengthM: 4.78 },
  { id: 'SEALION7', name: 'BYD SEALION 7', segment: 'SUV', color: '#fb923c', lengthM: 4.83 },
  { id: 'M6', name: 'BYD M6', segment: 'MPV', color: '#60a5fa', lengthM: 4.71 },
  { id: 'HAN', name: 'BYD HAN', segment: 'Sedan', color: '#facc15', lengthM: 4.99 },
  { id: 'TANG', name: 'BYD TANG', segment: 'SUV', color: '#a78bfa', lengthM: 4.97 },
  { id: 'D9', name: 'DENZA D9', segment: 'MPV', color: '#e879f9', lengthM: 5.25 },
]

export function modelById(id: string): VehicleModel | undefined {
  return MODELS.find((m) => m.id === id)
}

export const COLOR_HEX: Record<string, string> = {
  white: '#eef1f4', silver: '#c2c8ce', grey: '#828a93', gray: '#828a93',
  black: '#23282f', blue: '#2f6fed', red: '#d23a3a', green: '#2f9e6f',
  ขาว: '#eef1f4', เงิน: '#c2c8ce', เทา: '#828a93', ดำ: '#23282f', น้ำเงิน: '#2f6fed', แดง: '#d23a3a',
}
export const paintHex = (name: string): string => COLOR_HEX[(name || '').toLowerCase().trim()] ?? '#9aa6b2'

/** match an imported free-text model name to a known model (grid colour /
 *  segment / footprint). An UNKNOWN model keeps its real name with a neutral hue
 *  — it must never be silently relabelled as another model (e.g. Denza D9 was
 *  wrongly collapsing to "BYD ATTO 3" because that was the blind fallback). */
export function matchModel(name: string): VehicleModel {
  const raw = (name || '').trim()
  const n = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  // prefer the longest / most specific id or name match so "SEALION5" beats "SEAL"
  const found = MODELS
    .filter((m) => n.includes(m.id) || n.includes(m.name.toUpperCase().replace(/[^A-Z0-9]/g, '')))
    .sort((a, b) => b.id.length - a.id.length)[0]
  if (found) return found
  const by = (id: string) => MODELS.find((m) => m.id === id)!
  // keyword fallbacks — most specific first
  if (/D9/.test(n)) return by('D9')                                   // DENZA D9
  if (n.includes('ATTO') && /2/.test(n)) return by('ATTO2')
  if (n.includes('ATTO')) return by('ATTO3')
  if (n.includes('DOLPHIN')) return by('DOLPHIN')
  if (n.includes('SEALION') && /7/.test(n)) return by('SEALION7')
  if (n.includes('SEALION') && /6/.test(n)) return by('SEALION6')
  if (n.includes('SEALION')) return by('SEALION5')
  if (n.includes('SEAL') && /6/.test(n)) return by('SEAL6')
  if (n.includes('SEAL') && /5/.test(n)) return by('SEAL5')
  if (n.includes('SEAL')) return by('SEAL')
  if (n.includes('HAN')) return by('HAN')
  if (n.includes('TANG')) return by('TANG')
  if (n.includes('M6')) return by('M6')
  // unknown → preserve the real name, neutral hue (never mislabel as ATTO 3)
  return { id: 'OTHER', name: raw || '—', segment: 'Other', color: '#94a3b8', lengthM: 4.6 }
}

// ---- Yard layout (zone tags like RoRo TOS) ----
export const BLOCKS: Block[] = [
  { id: 'A', name: 'Block A', rows: 12, cols: 22, zone: 'B' },
  { id: 'B', name: 'Block B', rows: 12, cols: 22, zone: 'B' },
  { id: 'C', name: 'Block C', rows: 10, cols: 20, zone: 'G' },
  { id: 'D', name: 'Block D', rows: 10, cols: 20, zone: 'G' },
  { id: 'E', name: 'Block E', rows: 14, cols: 24, zone: 'Y' },
  { id: 'F', name: 'Block F', rows: 14, cols: 24, zone: 'Y' },
  { id: 'G', name: 'Block G', rows: 8, cols: 18, zone: 'R' },
  { id: 'H', name: 'Block H', rows: 8, cols: 18, zone: 'R' },
]

export const ZONE_COLOR: Record<Block['zone'], string> = {
  Y: '#eab308',
  B: '#3b82f6',
  R: '#ef4444',
  G: '#22c55e',
}

/** หางเทรลเลอร์ 1 หาง บรรทุกรถได้สูงสุด 8 คัน */
export const TRAILER_CAPACITY = 8

// ---- Default policies (encodes the user's two examples) ----
export const DEFAULT_POLICIES: ParkingPolicy[] = [
  { model: 'ATTO3', enabled: true, allowedBlocks: ['A'], rowFrom: 1, rowTo: 10, exclusiveRow: false },
  { model: 'DOLPHIN', enabled: true, allowedBlocks: 'ALL', exclusiveRow: true },
  { model: 'SEAL', enabled: true, allowedBlocks: ['B', 'C'], exclusiveRow: false },
  { model: 'SEALION6', enabled: true, allowedBlocks: 'ALL', exclusiveRow: false },
  { model: 'SEALION7', enabled: true, allowedBlocks: ['E', 'F'], exclusiveRow: true },
  { model: 'M6', enabled: true, allowedBlocks: 'ALL', exclusiveRow: false },
  { model: 'HAN', enabled: true, allowedBlocks: ['D'], exclusiveRow: false },
  { model: 'TANG', enabled: true, allowedBlocks: ['G', 'H'], exclusiveRow: false },
]

// ---- Paint colors ----
const COLORS: { name: string; hex: string; w: number }[] = [
  { name: 'White', hex: '#eef1f4', w: 32 },
  { name: 'Silver', hex: '#c2c8ce', w: 20 },
  { name: 'Grey', hex: '#828a93', w: 14 },
  { name: 'Black', hex: '#23282f', w: 14 },
  { name: 'Blue', hex: '#2f6fed', w: 9 },
  { name: 'Red', hex: '#d23a3a', w: 7 },
  { name: 'Green', hex: '#2f9e6f', w: 4 },
]

const MODEL_WEIGHTS: Record<string, number> = {
  ATTO3: 26, DOLPHIN: 22, SEAL: 14, SEALION6: 10, SEALION7: 9, M6: 9, HAN: 6, TANG: 4,
}

const STAFF = ['สมชาย ป.', 'วิรัช ก.', 'ธนพล ส.', 'อนุชา ม.', 'Pranee T.']
const DRIVERS = ['ก้องภพ', 'ณัฐวุฒิ', 'สุริยา', 'จิรายุ', 'พีรพล', 'อรรถพล', 'ชัยวัฒน์']

const DAMAGE_AREAS = ['fl-bumper', 'fr-door', 'rl-door', 'rr-bumper', 'bonnet', 'roof', 'fl-wheel']
const DAMAGE_TYPES = ['scratch', 'dent', 'chip', 'crack']

function weighted<T extends { w: number }>(arr: T[], rng: () => number): T {
  const total = arr.reduce((s, a) => s + a.w, 0)
  let r = rng() * total
  for (const a of arr) {
    r -= a.w
    if (r <= 0) return a
  }
  return arr[arr.length - 1]
}

function weightedKey(map: Record<string, number>, rng: () => number): string {
  const entries = Object.entries(map)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [k, w] of entries) {
    r -= w
    if (r <= 0) return k
  }
  return entries[0][0]
}

function vinFor(model: string, serial: number, rng: () => number): string {
  const code = model.slice(0, 2).toUpperCase()
  const rand = (n: number) =>
    Array.from({ length: n }, () => 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'[Math.floor(rng() * 33)]).join('')
  return `LGX${code}${rand(3)}B${rand(2)}TG${String(serial).padStart(6, '0')}`
}

export interface SampleResult {
  units: Record<string, Unit>
  trailers: Trailer[]
}

/** Build a realistic, rule-consistent populated yard. */
export function generateSample(): SampleResult {
  const rng = Math.random
  const NOW = Date.now()
  const TRAILER_COUNT = 20
  const ARRIVED_UP_TO = 13 // 13 of 20 trailers already arrived

  const trailers: Trailer[] = []
  const units: Record<string, Unit> = {}
  const placed: Unit[] = [] // accumulator the engine plans against
  let serial = 24000

  for (let t = 1; t <= TRAILER_COUNT; t++) {
    const arrived = t <= ARRIVED_UP_TO
    const arrivedAt = arrived ? NOW - (ARRIVED_UP_TO - t) * 26 * 60 * 1000 - 40 * 60 * 1000 : undefined
    trailers.push({
      no: t,
      plate: `70-${String(1000 + Math.floor(rng() * 8999))}`,
      arrived,
      arrivedAt,
      driver: arrived ? DRIVERS[Math.floor(rng() * DRIVERS.length)] : undefined,
    })

    const count = 6 + Math.floor(rng() * (TRAILER_CAPACITY - 5)) // 6–8 cars, never over capacity
    for (let i = 0; i < count; i++) {
      const modelId = weightedKey(MODEL_WEIGHTS, rng)
      const m = modelById(modelId)!
      const paint = weighted(COLORS, rng)
      const vin = vinFor(modelId, serial++, rng)
      const catRoll = rng()
      const u: Unit = {
        vin,
        model: modelId,
        modelName: m.name,
        variant: modelId === 'ATTO3' ? '480KM-EXT' : undefined,
        color: paint.name,
        colorHex: paint.hex,
        trailer: t,
        category: catRoll < 0.62 ? 'EXPORT' : catRoll < 0.92 ? 'DOMESTIC' : 'IMPORT',
        lot: `${new Date(arrivedAt ?? NOW).getMonth() + 1}-${new Date(arrivedAt ?? NOW).getDate()}-${200 + (serial % 90)}`,
        status: 'EXPECTED',
        damages: [],
        importedAt: NOW - 3 * 60 * 60 * 1000,
      }

      if (arrived) {
        // gate-in
        const gIn = (arrivedAt ?? NOW) + Math.floor(rng() * 20 * 60 * 1000)
        u.status = 'GATE_IN'
        u.gateInAt = gIn
        u.gateInBy = STAFF[Math.floor(rng() * STAFF.length)]
        u.inspected = true
        // damages (~7%)
        if (rng() < 0.07) {
          const d: Damage = {
            id: `dmg-${vin}`,
            area: DAMAGE_AREAS[Math.floor(rng() * DAMAGE_AREAS.length)],
            type: DAMAGE_TYPES[Math.floor(rng() * DAMAGE_TYPES.length)],
            severity: rng() < 0.3 ? 'major' : 'minor',
            note: 'พบระหว่าง walk-around',
            at: gIn,
            by: u.gateInBy!,
          }
          u.damages.push(d)
        }
        // assign + park most of them
        const roll = rng()
        if (roll < 0.86) {
          const a = autoAssign(u, BLOCKS, DEFAULT_POLICIES, placed, true)
          if (a) {
            u.block = a.block
            u.row = a.row
            u.slot = a.slot
            u.planMode = 'AUTO'
            u.assignedAt = gIn + 4 * 60 * 1000
            u.driver = DRIVERS[Math.floor(rng() * DRIVERS.length)]
            u.drivingStartedAt = u.assignedAt
            u.parkedAt = u.assignedAt + (2 + Math.floor(rng() * 6)) * 60 * 1000
            u.status = 'PARKED'
            placed.push(u)
          }
        } else if (roll < 0.94) {
          // assigned, en-route (reserved slot)
          const a = autoAssign(u, BLOCKS, DEFAULT_POLICIES, placed, true)
          if (a) {
            u.block = a.block
            u.row = a.row
            u.slot = a.slot
            u.planMode = 'AUTO'
            u.assignedAt = NOW - Math.floor(rng() * 8 * 60 * 1000)
            u.driver = DRIVERS[Math.floor(rng() * DRIVERS.length)]
            u.drivingStartedAt = u.assignedAt
            u.status = 'ASSIGNED'
            placed.push(u)
          }
        }
        // else stays GATE_IN (waiting to be driven)
      }

      units[vin] = u
    }
  }

  return { units, trailers }
}
