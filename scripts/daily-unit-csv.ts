/**
 * Nightly backup, part 1 of 2: every yard's Unit List as a CSV, read-only from Supabase.
 *
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… TZ=Asia/Bangkok node <bundle of this file> <out dir>
 *
 * Run by .github/workflows/daily-unit-backup.yml (bundled with esbuild so it shares the app's own
 * src/lib code — see lib/unitBackup). Writes one CSV per yard plus summary.json into <out dir>; part 2
 * (send-unit-backup.py) zips them and e-mails them.
 *
 * Reads only, with the same anon key the app ships. The repository is public, so its Actions log is
 * too: nothing about a car is printed, only how many rows were read.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Site } from '../src/types'
import type { TrackRow } from '../src/lib/excelTracking'
import type { Column } from '../src/lib/trackingColumns'
import type { DbDamage } from '../src/lib/database.types'
import { rowToDamage, DAMAGE_LIGHT_COLS, DAMAGE_LIGHT_COLS_BASIC } from '../src/lib/damageRow'
import { backupColumns, backupFileName, tallyYard, yardCsv, yardUnitList, type BackupUnit, type YardTally } from '../src/lib/unitBackup'

const BASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const KEY = process.env.SUPABASE_ANON_KEY ?? ''
const OUT = process.argv[2] || 'unit-backup'
if (!BASE || !KEY) { console.error('SUPABASE_URL / SUPABASE_ANON_KEY ไม่ได้ตั้งค่า'); process.exit(2) }
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'x-sjwd-device': 'daily-unit-backup' }
const PAGE = 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class HttpError extends Error { constructor(public status: number, public body: string) { super(`HTTP ${status}: ${body.slice(0, 200)}`) } }

/** GET a PostgREST path, retrying network blips and 5xx; a 4xx is the query's fault and is thrown at once. */
async function get<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}/rest/v1/${path}`, { headers: HEADERS })
      if (r.ok) return (await r.json()) as T
      const body = await r.text()
      if (r.status < 500 || attempt >= 4) throw new HttpError(r.status, body)
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) throw e
      if (attempt >= 4) throw e
    }
    await sleep(1000 * 2 ** attempt)
  }
}

/** Rows matching a filter, as the database counts them (null = could not count). */
async function countRows(table: string, filter: string): Promise<number | null> {
  try {
    const r = await fetch(`${BASE}/rest/v1/${table}?select=vin&${filter}`, { method: 'HEAD', headers: { ...HEADERS, Prefer: 'count=exact', Range: '0-0' } })
    const n = Number((r.headers.get('content-range') ?? '').split('/')[1])
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

/** Every row of a filter, keyset-paged on vin (unique within each of these filters). */
async function allByVin<T extends { vin: string }>(table: string, select: string, filter: string): Promise<T[]> {
  const out: T[] = []
  let after = ''
  for (;;) {
    const page = await get<T[]>(`${table}?select=${select}&${filter}${after ? `&vin=gt.${encodeURIComponent(after)}` : ''}&order=vin.asc&limit=${PAGE}`)
    out.push(...page)
    if (page.length < PAGE) return out
    after = page[page.length - 1].vin
  }
}

const eq = (v: string) => `eq.${encodeURIComponent(v)}`

type TrackRowRow = { vin: string; cells: Record<string, string> | null; updated_at: string | null; site: string | null }
const toTrackRow = (r: TrackRowRow): TrackRow => ({
  vin: r.vin, cells: r.cells ?? {}, site: r.site ?? undefined,
  updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : undefined,
})
const TRACK_SELECT = 'vin,cells,updated_at,site'
const LIVE = 'deleted_at=is.null'

async function appConfig<T>(id: string): Promise<T | null> {
  const rows = await get<{ value: T }[]>(`app_config?select=value&id=${eq(id)}`).catch(() => [])
  return rows[0]?.value ?? null
}

type UnitRow = { vin: string; block: string | null; row: number | null; slot: number | null; damages?: DbDamage[]; units?: { damages?: DbDamage[] } | null }

/** One yard's cars on its plan (in-yard only, like the app's own load) with their defects, photos left out. */
async function yardUnits(table: string, siteId: string): Promise<Record<string, BackupUnit>> {
  const embed = (cols: string) => (table === 'yard_units' ? `units(damages(${cols}))` : `damages(${cols})`)
  const filter = `site_id=${eq(siteId)}&status=neq.DEPARTED`
  let rows: UnitRow[]
  try {
    rows = await allByVin<UnitRow>(table, `vin,block,row,slot,${embed(DAMAGE_LIGHT_COLS.replace(/\s+/g, ''))}`, filter)
  } catch (e) {
    // an older database without the remark / Thai-name defect columns
    if (!(e instanceof HttpError && e.status === 400)) throw e
    rows = await allByVin<UnitRow>(table, `vin,block,row,slot,${embed(DAMAGE_LIGHT_COLS_BASIC.replace(/\s+/g, ''))}`, filter)
  }
  const out: Record<string, BackupUnit> = {}
  for (const r of rows) {
    out[r.vin] = {
      block: r.block ?? undefined, row: r.row ?? undefined, slot: r.slot ?? undefined,
      damages: (r.damages ?? r.units?.damages ?? []).map(rowToDamage),
    }
  }
  return out
}

/** The Bangkok calendar day and clock time of `ms` (the job sets TZ, this does not depend on it). */
function bangkok(ms: number): { day: string; stamp: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, stamp: `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` }
}

interface YardResult extends YardTally { site: string; name: string; file: string | null; read: number; expected: number | null }

;(async () => {
  const startedAt = Date.now()
  const { day, stamp } = bangkok(startedAt)
  mkdirSync(OUT, { recursive: true })

  const sites: Site[] = (await get<{ id: string; name: string; code: string | null; custom: boolean | null; created_at: string | null }[]>('sites?select=id,name,code,custom,created_at'))
    .map((r) => ({ id: r.id, name: r.name, code: r.code ?? undefined, custom: r.custom ?? false, createdAt: r.created_at ? new Date(r.created_at).getTime() : 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th'))
  if (!sites.length) throw new Error('อ่านรายชื่อยาร์ดไม่ได้ (ได้ 0 ยาร์ด)')

  const view = await appConfig<{ columns?: Column[] }>('unit_view_default')
  const columns = backupColumns(view?.columns)
  const unitsMode = (await appConfig<{ mode?: string }>('units_mode'))?.mode === 'yard_units' ? 'yard_units' : 'units'

  // rows not tagged with a yard yet: legacy rows matched by their Location yard cell, and shared-shuttle
  // arrivals still waiting to be claimed — the list's own rule (rowsForSite) decides which yard shows them
  const untagged = (await allByVin<TrackRowRow>('tracking_rows', TRACK_SELECT, `site=is.null&${LIVE}`)).map(toTrackRow)
  console.log(`ยาร์ด ${sites.length} · คอลัมน์ ${columns.length} · ตารางรถ ${unitsMode} · แถวยังไม่ติดยาร์ด ${untagged.length}`)

  const results: YardResult[] = []
  const usedNames = new Set<string>()
  for (const site of sites) {
    const filter = `site=${eq(site.id)}&${LIVE}`
    const expected = await countRows('tracking_rows', filter)
    const own = (await allByVin<TrackRowRow>('tracking_rows', TRACK_SELECT, filter)).map(toTrackRow)
    const units = await yardUnits(unitsMode, site.id)
    const list = yardUnitList(site, sites, [...own, ...untagged], units)
    let file: string | null = null
    if (list.length) {
      file = backupFileName(site, day)
      if (usedNames.has(file)) file = file.replace(/\.csv$/, `_${site.id}.csv`)
      usedNames.add(file)
      writeFileSync(join(OUT, file), yardCsv(columns, list))
    }
    results.push({ site: site.id, name: site.name, file, read: own.length, expected, ...tallyYard(list) })
    console.log(`  ยาร์ด ${results.length}/${sites.length}: ${list.length} แถว${expected !== null && expected !== own.length ? ` (ฐานข้อมูลนับได้ ${expected})` : ''}`)
  }

  const total = results.reduce((s, r) => s + r.total, 0)
  // a yard whose read came up short of the database's own count is named in the e-mail, never silently sent
  const short = results.filter((r) => r.expected !== null && r.read < r.expected).map((r) => r.name)
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({
    day, stamp, total, columns: columns.length, seconds: Math.round((Date.now() - startedAt) / 1000), short, yards: results,
  }, null, 2))
  console.log(`รวม ${total} แถว จาก ${results.filter((r) => r.file).length} ยาร์ด${short.length ? ` · อ่านไม่ครบ ${short.length} ยาร์ด` : ''}`)
})().catch((e) => { console.error('ล้มเหลว:', e instanceof Error ? e.message : e); process.exit(1) })
