/**
 * Supabase CRUD layer
 * All functions are no-ops when Supabase is not configured (offline mode).
 * Call patterns: fire-and-forget for mutations, await for initial data load.
 */
import { supabase, isConfigured } from './supabase'
import type { AppUser, Block, Damage, Site, Trailer, Unit } from '../types'
import type { DbDamage, DbTrailer, DbUnit, DbUnitWithDamages } from './database.types'
import type { TrackRow } from './excelTracking'
import type { WorkQueue } from '../store/useOps'

export { isConfigured } from './supabase'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Retry a single Supabase write a few times with backoff before giving up —
 * yard wifi/cellular is flaky, and a one-shot fire-and-forget write (the
 * pattern used for gate-in / walk-around actions) previously dropped silently
 * on a transient network blip, leaving the change stuck on that one device.
 * Throws the last error after all attempts fail (caller decides how to surface it).
 */
async function withRetry<T>(fn: () => PromiseLike<{ error: unknown } & T>, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    const res = await fn()
    if (!res.error) return res
    last = res.error
    if (i < attempts - 1) await sleep(500 * (i + 1))
  }
  throw last
}

/**
 * Upsert many rows in parallel chunks, retrying failed chunks up to 2× — a big
 * defect import (16k+ rows) must not silently drop a chunk on a transient error.
 */
async function bulkUpsert(table: string, rows: any[], chunkSize: number, onConflict: string, concurrency = 5): Promise<void> {
  if (!rows.length) return
  const chunks: any[][] = []
  for (let i = 0; i < rows.length; i += chunkSize) chunks.push(rows.slice(i, i + chunkSize))
  const runChunk = async (c: any[], attempt = 0): Promise<void> => {
    const { error } = await supabase.from(table).upsert(c, { onConflict })
    if (error) {
      if (attempt < 2) { await sleep(400 * (attempt + 1)); return runChunk(c, attempt + 1) }
      console.error(`[db] bulkUpsert ${table} gave up after retries`, error)
    }
  }
  for (let i = 0; i < chunks.length; i += concurrency) {
    await Promise.all(chunks.slice(i, i + concurrency).map((c) => runChunk(c)))
  }
}

// ── domain → row ─────────────────────────────────────────────────────────

function unitToRow(u: Unit): Omit<DbUnit, 'updated_at'> {
  return {
    vin:               u.vin,
    site_id:           u.site ?? null,
    model:             u.model,
    model_name:        u.modelName,
    variant:           u.variant ?? null,
    color:             u.color,
    color_hex:         u.colorHex ?? null,
    trailer:           u.trailer,
    lot:               u.lot ?? null,
    category:          u.category ?? null,
    weight_kg:         u.weightKg ?? null,
    status:            u.status,
    gate_in_at:        u.gateInAt        ? new Date(u.gateInAt).toISOString()        : null,
    gate_in_by:        u.gateInBy        ?? null,
    inspected:         u.inspected       ?? false,
    block:             u.block           ?? null,
    row:               u.row             ?? null,
    slot:              u.slot            ?? null,
    plan_mode:         u.planMode        ?? null,
    assigned_at:       u.assignedAt      ? new Date(u.assignedAt).toISOString()      : null,
    driver:            u.driver          ?? null,
    driving_started_at: u.drivingStartedAt ? new Date(u.drivingStartedAt).toISOString() : null,
    parked_at:         u.parkedAt        ? new Date(u.parkedAt).toISOString()        : null,
    last_pos:          (u.lastPos as object) ?? null,
    trip_count:        u.tripCount       ?? 0,
    imported_at:       new Date(u.importedAt).toISOString(),
  }
}

function damageToRow(vin: string, d: Damage): DbDamage {
  return {
    id:             d.id,
    vin,
    area:           d.area,
    type:           d.type,
    severity:       d.severity,
    note:           d.note           ?? null,
    // only include the remark key when set — keeps bulk imports off a column
    // that may not be migrated yet (insertDamage retries without it on error).
    ...(d.remark ? { remark: d.remark } : {}),
    photo_url:      d.photo          ?? d.photos?.[0] ?? null,
    photo_urls:     d.photos?.length  ? d.photos : null,
    recorded_at:    new Date(d.at).toISOString(),
    recorded_by:    d.by,
    source:         d.source         ?? null,
    station:        d.station        ?? null,
    item:           d.item           ?? null,
    category_ng:    d.categoryNG     ?? null,
    category_repair: d.categoryRepair ?? null,
    incharge:       d.incharge       ?? null,
    status_repair:  d.statusRepair   ?? null,
    repair_date:    d.repairDate     ? new Date(d.repairDate).toISOString() : null,
    repaired_by:    d.repairedBy     ?? null,
    repair_history: d.repairHistory  ?? null,
  }
}

// ── row → domain ─────────────────────────────────────────────────────────

export function rowToDamage(r: DbDamage): Damage {
  return {
    id:             r.id,
    area:           r.area           ?? '',
    type:           r.type           ?? '',
    severity:       (r.severity      as Damage['severity']) ?? 'minor',
    note:           r.note           ?? undefined,
    remark:         r.remark         ?? undefined,
    photo:          r.photo_url      ?? r.photo_urls?.[0] ?? undefined,
    photos:         r.photo_urls     ?? undefined,
    at:             r.recorded_at    ? new Date(r.recorded_at).getTime() : 0,
    by:             r.recorded_by    ?? '',
    source:         r.source         as Damage['source'],
    station:        r.station        ?? undefined,
    item:           r.item           ?? undefined,
    categoryNG:     r.category_ng    as Damage['categoryNG']    ?? undefined,
    categoryRepair: r.category_repair as Damage['categoryRepair'] ?? undefined,
    incharge:       r.incharge       as Damage['incharge']      ?? undefined,
    statusRepair:   r.status_repair  as Damage['statusRepair']  ?? undefined,
    repairDate:     r.repair_date    ? new Date(r.repair_date).getTime() : undefined,
    repairedBy:     r.repaired_by    ?? undefined,
    repairHistory:  (r.repair_history as Damage['repairHistory']) ?? undefined,
  }
}

/** Convert a units row to the domain type. Damages are passed in separately so
 *  realtime payloads (which carry no joined damages) can reuse this. */
export function parseUnitRow(r: DbUnit, damages: Damage[] = []): Unit {
  return {
    vin:              r.vin,
    site:             r.site_id           ?? undefined,
    model:            r.model             ?? '',
    modelName:        r.model_name        ?? '',
    variant:          r.variant           ?? undefined,
    color:            r.color             ?? '—',
    colorHex:         r.color_hex         ?? undefined,
    trailer:          r.trailer           ?? 0,
    lot:              r.lot               ?? undefined,
    category:         (r.category         as Unit['category']) ?? undefined,
    weightKg:         r.weight_kg         ?? undefined,
    status:           r.status            as Unit['status'],
    gateInAt:         r.gate_in_at        ? new Date(r.gate_in_at).getTime()        : undefined,
    gateInBy:         r.gate_in_by        ?? undefined,
    inspected:        r.inspected,
    block:            r.block             ?? undefined,
    row:              r.row               ?? undefined,
    slot:             r.slot              ?? undefined,
    planMode:         (r.plan_mode        as Unit['planMode']) ?? undefined,
    assignedAt:       r.assigned_at       ? new Date(r.assigned_at).getTime()       : undefined,
    driver:           r.driver            ?? undefined,
    drivingStartedAt: r.driving_started_at ? new Date(r.driving_started_at).getTime() : undefined,
    parkedAt:         r.parked_at         ? new Date(r.parked_at).getTime()         : undefined,
    lastPos:          r.last_pos          as Unit['lastPos'] ?? undefined,
    tripCount:        r.trip_count,
    importedAt:       new Date(r.imported_at).getTime(),
    damages,
  }
}

function rowToUnit(r: DbUnitWithDamages): Unit {
  return parseUnitRow(r, (r.damages ?? []).map(rowToDamage))
}

// ── unit operations ───────────────────────────────────────────────────────

/** โหลดรถทุกคัน (+ ความเสียหาย) จาก Supabase; กรองตาม site หากระบุ.
 *  Paginated — PostgREST caps a single request at 1,000 rows, so a >1,000-unit
 *  yard silently lost the tail (units past the cap never loaded → their damages
 *  "vanished" after refresh even though they were safely in the cloud). */
export async function fetchAllUnits(siteId?: string | null): Promise<Unit[]> {
  if (!isConfigured()) return []
  const PAGE = 500
  let head = supabase.from('units').select('vin', { count: 'exact', head: true })
  if (siteId) head = (head as any).eq('site_id', siteId)
  const { count, error: cErr } = await head
  if (cErr) { console.error('[db] fetchAllUnits count', cErr); return [] }
  const total = count ?? 0
  if (!total) return []
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(total / PAGE) }, async (_, p) => {
      let q = supabase.from('units').select('*, damages(*)')
      if (siteId) q = (q as any).eq('site_id', siteId)
      const { data, error } = await (q as any).order('vin').range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) { console.error('[db] fetchAllUnits page', p, error); return [] as DbUnitWithDamages[] }
      return (data ?? []) as DbUnitWithDamages[]
    }),
  )
  return pages.flat().map(rowToUnit)
}

/** บันทึกหรืออัปเดตรถ 1 คัน (ไม่รวม damages) — retries on transient failure, throws if it never lands */
export async function upsertUnit(u: Unit): Promise<void> {
  if (!isConfigured()) return
  try {
    await withRetry(() => supabase.from('units').upsert(unitToRow(u), { onConflict: 'vin' }))
  } catch (error) {
    console.error('[db] upsertUnit', u.vin, error)
    throw error
  }
}

/** บันทึกหรืออัปเดตรถหลายคันพร้อมกัน (batch) */
export async function upsertUnits(units: Unit[]): Promise<void> {
  if (!isConfigured() || !units.length) return
  await bulkUpsert('units', units.map(unitToRow), 200, 'vin')
}

/** ลบรถ (cascade → ลบ damages + trips อัตโนมัติ) */
export async function deleteUnit(vin: string): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('units').delete().eq('vin', vin)
  if (error) console.error('[db] deleteUnit', vin, error)
}

/** Delete ALL units (damages + trips cascade via FK). Used by "clear data". */
export async function deleteAllUnits(): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('units').delete().neq('vin', '')
  if (error) console.error('[db] deleteAllUnits', error)
}

// ── damage operations ─────────────────────────────────────────────────────

/** Detect PostgREST "column does not exist" (schema not yet migrated). */
function isMissingColumn(e: unknown, col: string): boolean {
  const s = JSON.stringify(e ?? '')
  return s.includes(col) && (s.includes('PGRST204') || s.includes('42703') || s.includes('schema cache') || s.includes('does not exist'))
}

export async function insertDamage(vin: string, d: Damage): Promise<void> {
  if (!isConfigured()) return
  const row = damageToRow(vin, d)
  try {
    await withRetry(() => supabase.from('damages').insert(row))
  } catch (error) {
    // remark column may not be migrated yet — retry without it so the damage
    // still saves (the remark stays on this device until the column exists).
    if (isMissingColumn(error, 'remark')) {
      const { remark, ...rest } = row
      const { error: e2 } = await supabase.from('damages').insert(rest)
      if (!e2) return
    }
    console.error('[db] insertDamage', vin, error)
    throw error
  }
}

export async function patchDamage(
  id: string,
  patch: Partial<Damage>,
): Promise<void> {
  if (!isConfigured()) return
  const row: Partial<DbDamage> = {}
  // Check KEY PRESENCE ('in'), not value !== undefined: a caller clearing an
  // optional field (e.g. the Damages-tab edit form emptying Cat NG) passes
  // `{ categoryNG: undefined }` on purpose — `patch.categoryNG !== undefined`
  // can't tell that apart from the key being absent entirely, so it silently
  // skipped the clear and the field never reached the cloud (only the local
  // store updated, so other devices kept the stale value forever).
  if ('note'           in patch) row.note           = patch.note ?? null
  if ('photo'          in patch) row.photo_url      = patch.photo ?? null
  if ('photos'         in patch) row.photo_urls     = patch.photos?.length ? patch.photos : null
  if ('categoryNG'     in patch) row.category_ng    = patch.categoryNG ?? null
  if ('categoryRepair' in patch) row.category_repair = patch.categoryRepair ?? null
  if ('incharge'       in patch) row.incharge       = patch.incharge ?? null
  if ('statusRepair'   in patch) row.status_repair  = patch.statusRepair ?? null
  if ('repairDate'     in patch) row.repair_date    = patch.repairDate ? new Date(patch.repairDate).toISOString() : null
  if ('repairedBy'     in patch) row.repaired_by    = patch.repairedBy ?? null
  if ('repairHistory'  in patch) row.repair_history = patch.repairHistory ?? null
  if ('severity'       in patch) row.severity       = patch.severity
  if ('area'           in patch) row.area           = patch.area
  if ('type'           in patch) row.type           = patch.type
  if ('item'           in patch) row.item           = patch.item ?? null
  if ('source'         in patch) row.source         = patch.source ?? null
  if ('station'        in patch) row.station        = patch.station ?? null
  const { error } = await supabase.from('damages').update(row).eq('id', id)
  if (error) console.error('[db] patchDamage', id, error)
}

export async function deleteDamage(id: string): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('damages').delete().eq('id', id)
  if (error) console.error('[db] deleteDamage', id, error)
}

export async function deleteDamages(ids: string[]): Promise<void> {
  if (!isConfigured() || !ids.length) return
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await supabase.from('damages').delete().in('id', ids.slice(i, i + CHUNK))
    if (error) console.error('[db] deleteDamages chunk', i, error)
  }
}

// ── trailer operations ────────────────────────────────────────────────────

export async function fetchTrailers(siteId: string): Promise<Trailer[]> {
  if (!isConfigured()) return []
  const { data, error } = await supabase
    .from('trailers')
    .select('*')
    .eq('site_id', siteId)
  if (error) { console.error('[db] fetchTrailers', error); return [] }
  return ((data ?? []) as DbTrailer[]).map((r) => ({
    no:        r.no,
    plate:     r.plate     ?? undefined,
    arrived:   r.arrived,
    arrivedAt: r.arrived_at ? new Date(r.arrived_at).getTime() : undefined,
    driver:    r.driver    ?? undefined,
  }))
}

export async function upsertTrailer(siteId: string, t: Trailer): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase
    .from('trailers')
    .upsert(
      {
        no:         t.no,
        site_id:    siteId,
        plate:      t.plate     ?? null,
        arrived:    t.arrived,
        arrived_at: t.arrivedAt ? new Date(t.arrivedAt).toISOString() : null,
        driver:     t.driver    ?? null,
      },
      { onConflict: 'no,site_id' },
    )
  if (error) console.error('[db] upsertTrailer', t.no, error)
}

/** Delete ALL trailers (every site). Used by "clear data". */
export async function deleteAllTrailers(): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('trailers').delete().gte('no', 0)
  if (error) console.error('[db] deleteAllTrailers', error)
}

// ── sites (FK parent of units / trailers — MUST exist before they sync) ─────

export async function fetchSites(): Promise<Site[]> {
  if (!isConfigured()) return []
  const { data, error } = await supabase.from('sites').select('id, name, code, custom, created_at')
  if (error) { console.error('[db] fetchSites', error); return [] }
  return ((data ?? []) as { id: string; name: string; code: string | null; custom: boolean | null; created_at: string | null }[])
    .map((r) => ({ id: r.id, name: r.name, code: r.code ?? undefined, custom: r.custom ?? false, createdAt: r.created_at ? new Date(r.created_at).getTime() : 0 }))
}

export async function upsertSites(sites: Site[]): Promise<void> {
  if (!isConfigured() || !sites.length) return
  const payload = sites.map((s) => ({ id: s.id, name: s.name, code: s.code ?? null, custom: s.custom ?? false }))
  const { error } = await supabase.from('sites').upsert(payload, { onConflict: 'id' })
  if (error) console.error('[db] upsertSites', error)
}

export async function deleteSite(id: string): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('sites').delete().eq('id', id)
  if (error) console.error('[db] deleteSite', error)
}

// ── app users (login accounts) — synced so a field role created on the
// admin's computer can actually log in from their own phone; without this,
// each device kept its own isolated user list and a new account only ever
// "existed" on whichever browser created it. ────────────────────────────────

export async function fetchAppUsers(): Promise<AppUser[]> {
  if (!isConfigured()) return []
  const { data, error } = await supabase.from('app_users').select('id, name, role, username, password, active')
  if (error) { console.error('[db] fetchAppUsers', error); return [] }
  return ((data ?? []) as { id: string; name: string; role: string; username: string; password: string; active: boolean | null }[])
    .map((r) => ({ id: r.id, name: r.name, role: r.role as AppUser['role'], username: r.username, password: r.password, active: r.active ?? true }))
}

/** Retries then THROWS — a lost login account is an operational blocker, so
 *  callers surface the failure (toast) instead of us swallowing it here. */
export async function upsertAppUser(u: AppUser): Promise<void> {
  if (!isConfigured()) return
  await withRetry(() => supabase.from('app_users').upsert(
    { id: u.id, name: u.name, role: u.role, username: u.username, password: u.password, active: u.active },
    { onConflict: 'id' },
  ))
}

export async function deleteAppUser(id: string): Promise<void> {
  if (!isConfigured()) return
  await withRetry(() => supabase.from('app_users').delete().eq('id', id))
}

// ── shared app config (key/value jsonb) — e.g. the default Unit-List view ────
/** Read a shared config blob by id. null when unset, table missing, or offline. */
export async function fetchAppConfig<T = unknown>(id: string): Promise<T | null> {
  if (!isConfigured()) return null
  const { data, error } = await supabase.from('app_config').select('value').eq('id', id).maybeSingle()
  if (error) { if (error.code !== '42P01') console.error('[db] fetchAppConfig', error); return null } // 42P01 = table not migrated
  return (data?.value ?? null) as T | null
}
/** Upsert a shared config blob (admin action). Throws so the caller can toast. */
export async function saveAppConfig(id: string, value: unknown): Promise<void> {
  if (!isConfigured()) throw new Error('cloud not configured')
  const { error } = await supabase.from('app_config').upsert({ id, value, updated_at: new Date().toISOString() }, { onConflict: 'id' })
  if (error) throw error
}

// ── yard-plan blocks (layout sync across devices) ───────────────────────────

function blockToRow(siteId: string, b: Block) {
  return {
    id: b.id, site_id: siteId, name: b.name, rows: b.rows, cols: b.cols, zone: b.zone,
    x: b.x ?? null, y: b.y ?? null, w: b.w ?? null, h: b.h ?? null, rot: b.rot ?? null,
    color: b.color ?? null, kind: b.kind ?? 'park', shape: b.shape ?? null,
    transposed: b.transposed ?? false,
  }
}

function rowToBlock(r: any): Block {
  return {
    id: r.id, name: r.name ?? r.id, rows: r.rows ?? 4, cols: r.cols ?? 10,
    zone: (r.zone as Block['zone']) ?? 'Y',
    x: r.x ?? undefined, y: r.y ?? undefined, w: r.w ?? undefined, h: r.h ?? undefined,
    rot: r.rot ?? undefined, color: r.color ?? undefined,
    kind: (r.kind as Block['kind']) ?? 'park',
    shape: (r.shape as Block['shape']) ?? undefined,
    transposed: r.transposed ?? undefined,
  }
}

export async function fetchBlocks(siteId: string): Promise<Block[]> {
  if (!isConfigured()) return []
  const { data, error } = await supabase.from('blocks').select('*').eq('site_id', siteId)
  if (error) { console.error('[db] fetchBlocks', error); return [] }
  return (data ?? []).map(rowToBlock)
}

/** Mirror a site's whole layout to the cloud: upsert every block, then prune
 *  cloud rows that no longer exist locally (covers delete + id rename). */
export async function replaceBlocks(siteId: string, blocks: Block[]): Promise<void> {
  if (!isConfigured()) return
  if (blocks.length) {
    const { error } = await supabase.from('blocks').upsert(blocks.map((b) => blockToRow(siteId, b)), { onConflict: 'site_id,id' })
    if (error) { console.error('[db] upsertBlocks', error); return } // don't prune if the upsert failed
  }
  const keep = blocks.map((b) => `"${b.id}"`).join(',')
  const del = supabase.from('blocks').delete().eq('site_id', siteId)
  const { error: e2 } = await (blocks.length ? del.not('id', 'in', `(${keep})`) : del)
  if (e2) console.error('[db] pruneBlocks', e2)
}

// ── operation work queues (Operation page / station scan) ───────────────────
// Whole queue per row (items = jsonb) — queues are small (≤ a few hundred VINs).
// All functions tolerate the ops_queues table not existing yet (log + local-only).

function rowToQueue(r: any): WorkQueue {
  return {
    id: r.id, name: r.name ?? '', createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
    createdBy: r.created_by ?? undefined, items: (r.items as WorkQueue['items']) ?? [],
    site: r.site_id ?? undefined,
  }
}

/** null = fetch failed (table missing / offline) — caller keeps local state. */
export async function fetchOpsQueues(): Promise<WorkQueue[] | null> {
  if (!isConfigured()) return null
  const { data, error } = await supabase.from('ops_queues').select('*').order('created_at', { ascending: true })
  if (error) { console.error('[db] fetchOpsQueues', error); return null }
  return (data ?? []).map(rowToQueue)
}

export async function upsertOpsQueue(q: WorkQueue): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('ops_queues').upsert({
    id: q.id, site_id: q.site ?? null, name: q.name,
    created_at: new Date(q.createdAt).toISOString(), created_by: q.createdBy ?? null,
    items: q.items, updated_at: new Date().toISOString(),
  }, { onConflict: 'id' })
  if (error) console.error('[db] upsertOpsQueue', error)
}

export async function deleteOpsQueue(id: string): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('ops_queues').delete().eq('id', id)
  if (error) console.error('[db] deleteOpsQueue', error)
}

export async function clearOpsQueues(): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('ops_queues').delete().neq('id', '')
  if (error) console.error('[db] clearOpsQueues', error)
}

// ── bulk damage upsert (migration / resilience — onConflict id, FK-safe) ────

export async function upsertDamages(items: { vin: string; d: Damage }[]): Promise<void> {
  if (!isConfigured() || !items.length) return
  // parallel chunks + retry — 16k+ defect rows finish in a few seconds and no
  // chunk is silently dropped on a transient error (that stranded ~6k rows before)
  await bulkUpsert('damages', items.map(({ vin, d }) => damageToRow(vin, d)), 500, 'id')
}

// ── tracking rows (master vehicle list — flexible JSONB columns) ────────────

type TrackRowRow = { vin: string; cells: Record<string, string> | null; updated_at: string | null; site?: string | null; history?: TrackRow['history'] | null; deleted_at?: string | null }
const toTrackRow = (r: TrackRowRow): TrackRow => ({
  vin: r.vin,
  cells: r.cells ?? {},
  updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : undefined,
  site: r.site ?? undefined,
  history: r.history ?? undefined,
  deletedAt: r.deleted_at ? new Date(r.deleted_at).getTime() : undefined,
})

/**
 * Fetch tracking rows from Supabase.
 * - `sinceMs` set → INCREMENTAL: only rows changed after that time (small, fast).
 * - omitted → FULL: all rows, fetched with every page IN PARALLEL (≈1 round-trip
 *   instead of 8 sequential ones → ~10s becomes ~1s).
 */
export async function fetchTrackingRows(sinceMs?: number): Promise<TrackRow[]> {
  if (!isConfigured()) return []
  const PAGE = 1000
  const sinceIso = sinceMs ? new Date(sinceMs).toISOString() : null

  const page = async (from: number): Promise<TrackRowRow[]> => {
    const run = (cols: string) => {
      let q: any = supabase.from('tracking_rows').select(cols).order('vin')
      if (sinceIso) q = q.gt('updated_at', sinceIso)
      return q.range(from, from + PAGE - 1)
    }
    let res: any = await run('vin, cells, updated_at, site, history, deleted_at')
    if (res.error) res = await run('vin, cells, updated_at, site, history') // `deleted_at` column not migrated yet
    if (res.error) res = await run('vin, cells, updated_at, site') // `history` column not migrated yet
    if (res.error) res = await run('vin, cells, updated_at') // `site` column not migrated yet
    if (res.error) { console.error('[db] fetchTrackingRows', res.error); return [] }
    return (res.data ?? []) as TrackRowRow[]
  }

  // incremental deltas are small → walk sequentially
  if (sinceIso) {
    const out: TrackRow[] = []
    for (let from = 0; ; from += PAGE) {
      const batch = await page(from)
      for (const r of batch) out.push(toTrackRow(r))
      if (batch.length < PAGE) break
    }
    return out
  }

  // full pull → count, then fetch all pages concurrently
  const { count } = await supabase.from('tracking_rows').select('vin', { count: 'exact', head: true })
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const all = await Promise.all(Array.from({ length: pages }, (_, i) => page(i * PAGE)))
  return all.flat().map(toTrackRow)
}

/**
 * Fetch only the rows for one yard, filtered SERVER-SIDE by "Location yard".
 * Used to reveal the active site fast on a fresh device (≈2 MB vs 11 MB).
 */
export async function fetchTrackingRowsForSite(locationYard: string): Promise<TrackRow[]> {
  if (!isConfigured() || !locationYard) return []
  const PAGE = 1000
  const out: TrackRow[] = []
  for (let from = 0; ; from += PAGE) {
    const run = (cols: string) =>
      supabase.from('tracking_rows').select(cols).eq('cells->>Location yard', locationYard).order('vin').range(from, from + PAGE - 1)
    let res: any = await run('vin, cells, updated_at, site, history, deleted_at')
    if (res.error) res = await run('vin, cells, updated_at, site, history')
    if (res.error) res = await run('vin, cells, updated_at, site')
    if (res.error) res = await run('vin, cells, updated_at')
    if (res.error) { console.error('[db] fetchTrackingRowsForSite', res.error); break }
    const batch = (res.data ?? []) as TrackRowRow[]
    // skip tombstoned rows — a soft-deleted VIN must not resurface in a yard view
    for (const r of batch) { const tr = toTrackRow(r); if (!tr.deletedAt) out.push(tr) }
    if (batch.length < PAGE) break
  }
  return out
}

/** บันทึก/อัปเดตรายการรถ (batch ทีละ 500 แถว) */
export async function upsertTrackingRows(rows: TrackRow[]): Promise<void> {
  if (!isConfigured() || !rows.length) return
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    // full payload; `deleted_at` is always written (null on a live row) so any
    // normal edit/import automatically clears an old tombstone → re-importing a
    // removed VIN brings it back cleanly.
    const full = (r: TrackRow) => ({
      vin: r.vin, cells: r.cells ?? {},
      updated_at: new Date(r.updatedAt ?? Date.now()).toISOString(),
      site: r.site ?? null,
      history: r.history ?? null,
      deleted_at: r.deletedAt ? new Date(r.deletedAt).toISOString() : null,
    })
    // progressively drop columns that may not be migrated yet, newest-added first
    const variants = [
      (r: TrackRow) => full(r),
      (r: TrackRow) => { const { deleted_at, ...rest } = full(r); return rest }, // no deleted_at
      (r: TrackRow) => { const { deleted_at, history, ...rest } = full(r); return rest }, // no history
      (r: TrackRow) => { const { deleted_at, history, site, ...rest } = full(r); return rest }, // no site
    ]
    let error: any = null
    for (const build of variants) {
      ;({ error } = await supabase.from('tracking_rows').upsert(slice.map(build), { onConflict: 'vin' }))
      if (!error) break
    }
    if (error) console.error('[db] upsertTrackingRows chunk', i, error)
  }
}

/** ลบรถออกจาก Unit List — soft-delete (tombstone): เขียน `deleted_at` แทนการลบแถวจริง
 *  เพื่อให้ทุกเครื่อง (แม้เครื่องที่ยัง cache แถวนี้ไว้ใน IndexedDB) รู้ว่าถูกลบแล้ว
 *  และจะไม่อัปโหลดกลับขึ้น cloud อีก (ต้นเหตุ "ลบแล้วเด้งกลับมา"). */
export async function deleteTrackingRows(vins: string[]): Promise<void> {
  if (!isConfigured() || !vins.length) return
  const nowIso = new Date().toISOString()
  const CHUNK = 500
  for (let i = 0; i < vins.length; i += CHUNK) {
    const slice = vins.slice(i, i + CHUNK)
    const { error } = await supabase.from('tracking_rows')
      .upsert(slice.map((vin) => ({ vin, deleted_at: nowIso, updated_at: nowIso, cells: {} })), { onConflict: 'vin' })
    if (error) {
      // `deleted_at` column not migrated yet → fall back to the old hard delete
      const { error: dErr } = await supabase.from('tracking_rows').delete().in('vin', slice)
      if (dErr) console.error('[db] deleteTrackingRows', dErr)
    }
  }
}

/** ล้าง tombstone เก่าทิ้งถาวร (แถวที่ถูก soft-delete นานเกิน `olderThanMs`) เพื่อไม่ให้ตารางบวม */
export async function purgeTrackingTombstones(olderThanMs: number): Promise<void> {
  if (!isConfigured()) return
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  const { error } = await supabase.from('tracking_rows').delete().not('deleted_at', 'is', null).lt('deleted_at', cutoff)
  if (error && error.code !== '42703') console.error('[db] purgeTrackingTombstones', error) // ignore "column doesn't exist"
}

export async function clearTrackingRows(): Promise<void> {
  if (!isConfigured()) return
  const { error } = await supabase.from('tracking_rows').delete().neq('vin', '')
  if (error) console.error('[db] clearTrackingRows', error)
}
