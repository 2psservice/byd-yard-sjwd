/**
 * Links the Mechanic station's repair app (public/repair/index.html, "งานซ่อม + รูป") to the yard's
 * own defects, both ways, WITHOUT changing the repair app's file:
 *
 *  SJWD → repair app
 *    The repair app finds a car's defects in its "Defect-Yard" sheet — normally a Co file someone
 *    uploads. That sheet's columns are SJWD's own defect columns (VIN · Position · Defect · Status
 *    Repair · Category Repair · Incharge · Stock of Status · Date · Model · yard), so the bridge
 *    hands it the yard's LIVE defects in exactly that row shape. For a VIN SJWD knows, SJWD's
 *    defects are used; Co file rows stay for VINs SJWD does not have. Everything downstream (🔍
 *    ค้นหาแผล, ticking a defect into a repair job, its duplicate rules) is the repair app's own code.
 *
 *  repair app → SJWD
 *    When the repair app saves a job as repaired or accepted, the matching SJWD defect (same VIN,
 *    same position + defect) moves out of Waiting Repair with the same status, its repair date and
 *    an audit line naming the repair app's technician. Only forward from Waiting Repair: a status
 *    someone already set in SJWD is never overwritten, and nothing is ever reopened.
 *
 * The repair app is a classic script on the same origin, so its top-level functions are window
 * properties the bridge can wrap. If a later version renames them, the bridge does nothing and the
 * repair app works exactly as it does on its own.
 */
import type { Damage, DamageStatusRepair, Unit } from '../types'
import type { TrackRow } from './excelTracking'
import { isAccessoryCheckEntry } from './finalCheckList'

/** The repair app's job statuses that resolve a defect, and the SJWD status each one means. */
export const REPAIR_TO_SJWD: Record<string, DamageStatusRepair> = {
  done: 'Repaired',
  accbyd: 'ACC BYD',
  accsjwd: 'ACC SJWD',
  accrever: 'ACC REVER',
}

/** One repair-app Defect-Yard row: [vin, position, defect, status, categoryRepair, incharge, stock, dateISO, model, yard]. */
export type CoDefRow = [string, string, string, string, string, string, string, string, string, string]

const isoDay = (ts?: number) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Waiting = not resolved yet (blank counts as waiting, the same rule the repair app uses). */
export const isWaiting = (s?: string) => !s || /^waiting\s*repair$/i.test(s.trim())

/** The yard's defects as repair-app Defect-Yard rows. Stock checks are not defects and are left out. */
export function sjwdDefectRows(units: Record<string, Unit>, rows: Record<string, TrackRow>, siteName: (id?: string) => string): CoDefRow[] {
  const out: CoDefRow[] = []
  for (const vin in units) {
    const u = units[vin]
    if (!u?.damages?.length) continue
    const c = rows[vin]?.cells ?? {}
    for (const d of u.damages) {
      if (isAccessoryCheckEntry(d)) continue
      const pos = (d.area || d.areaTh || '').trim()
      const def = (d.item || d.itemTh || d.type || '').trim()
      if (!pos && !def) continue
      out.push([
        vin.toUpperCase(), pos, def,
        d.statusRepair || 'Waiting Repair',
        d.categoryRepair || '', d.incharge || '',
        c['Stock of Status'] || '', isoDay(d.at),
        c['Model'] || c['Model name'] || u.modelName || '',
        siteName(u.site) || '',
      ])
    }
  }
  return out
}

/** Spelling-proof key: letters and digits only, Thai kept, case folded. */
const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9฀-๿]+/g, '')

/** A repair job as the repair app holds it (only the fields the bridge reads). */
export interface RepairJob {
  id?: string; vin?: string; status?: string; tech?: string; repairDate?: string
  part?: string; partTH?: string; problem?: string; problemTH?: string
}

/** The SJWD defect a repair job is about: same position AND same defect, by English or Thai name.
 *  Only still-waiting defects are candidates; `claimed` keeps two jobs from closing the same one. */
export function matchDamage(unit: Unit, job: RepairJob, claimed: Set<string>): Damage | null {
  const jp = [norm(job.part), norm(job.partTH)].filter(Boolean)
  const jd = [norm(job.problem), norm(job.problemTH)].filter(Boolean)
  if (!jp.length || !jd.length) return null
  for (const d of unit.damages ?? []) {
    if (claimed.has(d.id) || !isWaiting(d.statusRepair) || isAccessoryCheckEntry(d)) continue
    const dp = [norm(d.area), norm(d.areaTh)].filter(Boolean)
    // the old walk-around kept only a damage-type id — compare it only when there is no defect name
    const dd = [norm(d.item), norm(d.itemTh)].filter(Boolean)
    if (!dd.length && d.type) dd.push(norm(d.type))
    if (dp.some((p) => jp.includes(p)) && dd.some((x) => jd.includes(x))) return d
  }
  return null
}

/** The SJWD changes a batch of saved repair jobs implies (pure — the caller applies them). */
export function writeBackPlan(units: Record<string, Unit>, jobs: RepairJob[], now: number): { vin: string; damage: Damage; patch: Partial<Damage> }[] {
  const claimed = new Set<string>()
  const out: { vin: string; damage: Damage; patch: Partial<Damage> }[] = []
  for (const j of jobs) {
    const status = REPAIR_TO_SJWD[String(j.status ?? '')]
    const vin = String(j.vin ?? '').toUpperCase()
    const unit = status && vin ? units[vin] : undefined
    if (!status || !unit) continue
    const d = matchDamage(unit, j, claimed)
    if (!d) continue
    claimed.add(d.id)
    const day = j.repairDate ? Date.parse(`${j.repairDate}T12:00:00`) : NaN
    const by = j.tech ? `${j.tech} · แอปงานซ่อม` : 'แอปงานซ่อม'
    out.push({
      vin, damage: d,
      patch: {
        statusRepair: status,
        repairDate: Number.isFinite(day) ? day : now,
        repairedBy: j.tech || 'แอปงานซ่อม',
        repairHistory: [...(d.repairHistory ?? []), { status, from: d.statusRepair, at: now, by }],
      },
    })
  }
  return out
}

export interface BridgeDeps {
  units: () => Record<string, Unit>
  rows: () => Record<string, TrackRow>
  siteName: (id?: string) => string
  updateDamage: (vin: string, id: string, patch: Partial<Damage>) => void
  /** told after each write-back, for a toast */
  onWriteBack?: (n: number) => void
}

/** Wrap the repair app's Defect-Yard loader and its job save. Returns what got linked. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachRepairBridge(win: any, deps: BridgeDeps): { defects: boolean; writeBack: boolean } {
  const linked = { defects: false, writeBack: false }
  if (!win || win.__sjwdBridge) return linked
  win.__sjwdBridge = true

  // ── SJWD → repair app: the live defects are the Defect-Yard sheet ──
  if (typeof win.coDefLoad === 'function') {
    const orig = win.coDefLoad
    let memo: { units: unknown; rows: unknown; out: CoDefRow[] } | null = null
    const live = () => {
      const u = deps.units(), r = deps.rows()
      if (!memo || memo.units !== u || memo.rows !== r) memo = { units: u, rows: r, out: sjwdDefectRows(u, r, deps.siteName) }
      return memo.out
    }
    win.coDefLoad = async function (...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let co: any = null
      try { co = await orig.apply(this, args) } catch { co = null }
      const sj = live()
      if (!sj.length) return co
      const known = new Set(sj.map((r) => r[0]))
      const rest = Array.isArray(co?.rows) ? co.rows.filter((r: string[]) => !known.has(r[0])) : []
      // _dd: already one row per defect — the repair app must not re-merge or cache this sheet as a Co file
      return { ...(co ?? {}), rows: [...sj, ...rest], name: rest.length ? `SJWD (สด) + ${co?.name || 'Co'}` : 'SJWD (ข้อมูลสด)', at: Date.now(), _dd: true, _sjwd: true }
    }
    linked.defects = true
  }

  // ── repair app → SJWD: a saved repair closes the matching yard defect ──
  if (typeof win.sbPushJobs === 'function') {
    const orig = win.sbPushJobs
    win.sbPushJobs = async function (jobs: RepairJob[], ...rest: unknown[]) {
      const res = await orig.call(this, jobs, ...rest)
      if (res !== false) {
        try {
          const plan = writeBackPlan(deps.units(), Array.isArray(jobs) ? jobs : [], Date.now())
          for (const p of plan) deps.updateDamage(p.vin, p.damage.id, p.patch)
          if (plan.length) deps.onWriteBack?.(plan.length)
        } catch (e) { console.error('[repairBridge] write-back', e) }
      }
      return res
    }
    linked.writeBack = true
  }
  return linked
}
