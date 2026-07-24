// Row types matching the Supabase SQL schema exactly
// (snake_case columns ↔ camelCase domain types in types.ts)

export interface DbUnit {
  vin: string
  site_id: string | null
  model: string | null
  model_name: string | null
  variant: string | null
  color: string | null
  color_hex: string | null
  trailer: number | null
  lot: string | null
  category: string | null
  weight_kg: number | null
  status: string
  gate_in_at: string | null
  gate_in_by: string | null
  inspected: boolean
  block: string | null
  row: number | null
  slot: number | null
  plan_mode: string | null
  assigned_at: string | null
  driver: string | null
  driving_started_at: string | null
  parked_at: string | null
  last_pos: object | null
  trip_count: number
  imported_at: string
  updated_at: string
}

export interface DbDamage {
  id: string
  vin: string
  area: string | null
  type: string | null
  severity: string | null
  note: string | null
  remark?: string | null         // free-text remark (optional column; only written when set, degrades gracefully if absent)
  area_th?: string | null        // Thai part name (optional column; only written when set)
  item_th?: string | null        // Thai defect name (optional column; only written when set)
  photo_url: string | null       // base64 dataURL (Phase 3 → Storage URL) — first photo, back-compat
  photo_urls: string[] | null    // all photos (base64 dataURL, compressed)
  recorded_at: string | null
  recorded_by: string | null
  source: string | null
  station: string | null
  item: string | null
  category_ng: string | null
  category_repair: string | null
  incharge: string | null
  status_repair: string | null
  repair_date: string | null
  repaired_by: string | null
  repair_history: object | null
}

export interface DbTrailer {
  no: number
  site_id: string
  plate: string | null
  arrived: boolean
  arrived_at: string | null
  driver: string | null
}

/** Shape returned by: SELECT *, damages(*) FROM units */
export interface DbUnitWithDamages extends DbUnit {
  damages: DbDamage[]
}
