// ============================================================
//  Domain types — BYD Yard Control
// ============================================================

export type Lang = 'th' | 'en'

export type UserRole = 'admin' | 'driver' | 'walkAround' | 'pmPdiFinal' | 'mechanic'

export interface AppUser {
  id: string
  name: string
  role: UserRole
  active: boolean
  username: string
  password: string
}

export type View =
  | 'dashboard'
  | 'import'
  | 'trailers' // legacy id — kept so a device with a persisted 'trailers' view still lands on Report
  | 'report'
  | 'gatein'
  | 'driver'
  | 'yard'
  | 'units'
  | 'rules'
  | 'yardops'
  | 'tracking'
  | 'operation'
  | 'pm'
  | 'damages'
  | 'grouping'
  | 'settings'

/** Lifecycle of a vehicle from factory to parked (to loaded/departed). */
export type UnitStatus =
  | 'EXPECTED' // imported / on trailer, not yet arrived
  | 'GATE_IN' // walk-around scanned & confirmed in yard, not parked
  | 'ASSIGNED' // driver scanned, slot assigned, en-route
  | 'PARKED' // parked confirmed
  | 'LOADED' // loaded for outbound
  | 'DEPARTED'

export interface VehicleModel {
  id: string // 'ATTO3'
  name: string // 'BYD ATTO 3'
  segment: string // SUV / Sedan / Hatch / MPV
  color: string // hex used on yard grid + legend
  lengthM: number // footprint length (m) — informational
}

export interface DamageType {
  id: string
  th: string
  en: string
}

export type DamageCategoryNG = 'NG' | 'HEAVY NG'
export type DamageCategoryRepair = 'Re Dent' | 'Re paint' | 'Part'
export type DamageIncharge = 'SJWD' | 'BYD'
export type DamageStatusRepair = 'Waiting Repair' | 'Accept' | 'Acc byd' | 'OK Accept' | 'OK Repaired' | 'Repaired'
/** Which step recorded the damage (undefined = legacy gate-in walk-around). */
export type DamageSource = 'walkaround' | 'pdi' | 'mechanic' | 'update' | 'yardDefect' | 'factoryDefect' | 'whaleDefect' | 'manual'

export interface Damage {
  id: string
  area: string // body zone id (e.g. 'fl-door') OR English part name (master-list capture)
  areaTh?: string // Thai part name (master-list capture) — admin shows EN + this below
  type: string // damage type id
  severity: 'minor' | 'major'
  note?: string
  remark?: string // free-text remark (e.g. "Move From Main yard")
  photo?: string // dataURL (compressed) — first photo, kept for back-compat with single-photo displays
  photos?: string[] // all photos (dataURL, compressed); photo === photos[0] when present
  at: number
  by: string
  source?: DamageSource // where it was found (gate-in walk-around, PDI, …)
  station?: string      // human-readable station/queue name (e.g. "Gate-in", or a custom Operation queue name like "Wash for sale")
  item?: string         // English defect / checklist item (master-list capture, Final Check NG)
  itemTh?: string       // Thai defect (master-list capture) — admin shows EN + this below
  categoryNG?: DamageCategoryNG | string
  categoryRepair?: DamageCategoryRepair
  incharge?: DamageIncharge
  statusRepair?: DamageStatusRepair
  repairDate?: number
  repairedBy?: string // who marked it repaired
  repairHistory?: DamageStatusEvent[] // audit trail of Status Repair changes
}

/** One Status Repair change (who changed it, from what, to what, and when). */
export interface DamageStatusEvent {
  status: string
  from?: string // previous status (undefined on the first recorded change)
  at: number
  by: string
}

export interface Unit {
  vin: string
  model: string // VehicleModel.id
  modelName: string
  variant?: string
  color: string // color name (TH/EN free text)
  colorHex?: string
  trailer: number // grouping number (หาง)
  lot?: string
  category?: 'EXPORT' | 'DOMESTIC' | 'IMPORT' // outbound channel (drives the category badge)
  weightKg?: number

  status: UnitStatus

  // gate-in / walk-around
  gateInAt?: number
  gateInBy?: string
  inspected?: boolean
  damages: Damage[]

  // parking assignment
  block?: string
  row?: number
  slot?: number
  planMode?: 'AUTO' | 'SEMI'
  assignedAt?: number
  driver?: string
  drivingStartedAt?: number
  parkedAt?: number

  // gps
  lastPos?: GpsPoint   // latest known position (last point of most-recent trip)
  tripCount?: number   // how many times this car has been driven

  site?: string        // the work site / yard this vehicle belongs to (Site.id)

  importedAt: number
}

export interface Trailer {
  no: number
  plate?: string
  arrived: boolean
  arrivedAt?: number
  driver?: string
}

/** A work site / yard the operator is stationed at (chosen after login). */
export interface Site {
  id: string
  name: string
  code?: string
  createdAt: number
  custom?: boolean // created by an admin (vs. seeded defaults)
}

// ── GPS tracking ───────────────────────────────────────────────────────────
/** One recorded GPS fix while a car is being driven. */
export interface GpsPoint {
  lat: number
  lng: number
  t: number        // epoch ms
  speed?: number   // km/h
  heading?: number // degrees (0=N)
  acc?: number     // accuracy radius in metres
}

/** One driving session (a driver moving one car from A → B). */
export interface Trip {
  id: string
  vin: string
  driver: string
  startedAt: number
  endedAt?: number
  from?: string      // origin label, e.g. 'Gate'
  to?: string        // destination slot label, e.g. 'A5.13'
  path: GpsPoint[]
  distanceM?: number // total path distance (m)
  sim?: boolean      // recorded from the simulator (no real GPS)
}

export interface Block {
  id: string // 'A'
  name: string
  rows: number
  cols: number // slots per row
  zone: 'Y' | 'B' | 'R' | 'G' // zone tag like RoRo TOS
  // free-layout editor (optional — laid out automatically when absent)
  x?: number        // top-left position on the board (board units)
  y?: number
  w?: number        // box size on the board (board units)
  h?: number
  rot?: number      // rotation in degrees (0–360, to match the real plan)
  color?: string    // custom fill (overrides zone colour)
  kind?: 'park' | 'area' // 'area' = a labelled zone (PDI / lane) with no slot grid
  transposed?: boolean   // swap the slot-grid axes (rows on top, slots on the left)
  shape?: { x: number; y: number }[] // free polygon outline, normalised 0..1 in the box (omit = rectangle)
}

/** Per-model parking rule. Drives the Auto / Semi plan engine. */
export interface ParkingPolicy {
  model: string // VehicleModel.id
  enabled: boolean
  allowedBlocks: string[] | 'ALL'
  rowFrom?: number // optional row window within a block
  rowTo?: number
  exclusiveRow: boolean // a row may not mix this model with others
}

export interface Settings {
  lang: Lang
  planMode: 'AUTO' | 'SEMI' // global default
  currentUser: string // walk-around / admin operator
  currentDriver: string
  groupModelsInRow: boolean // engine preference: keep one model per row when possible
}

export interface DamageInput {
  area: string
  areaTh?: string
  type: string
  severity: 'minor' | 'major'
  note?: string
  remark?: string
  photo?: string
  photos?: string[]
  source?: DamageSource
  station?: string
  item?: string
  itemTh?: string
  categoryNG?: DamageCategoryNG | string | string
  statusRepair?: DamageStatusRepair
}

/** A single candidate slot the engine proposes. */
export interface SlotCandidate {
  block: string
  row: number
  slot: number
  score: number
  reason: string // human-readable why (TH)
}
