/**
 * One car, fresh from the cloud, adopted into the store — damages included.
 *
 * Every screen that focuses a single VIN (ตรวจสอบข้อมูลรถ, Walk Around Check,
 * PDI, admin Unit detail) used to read whatever copy this device happened to
 * hold. Two ways that copy lies:
 *
 *  - it is STALE: the defect was recorded on another device after this
 *    device's last site pull, so the local copy simply predates it;
 *  - it is FROZEN: gate-out marks the unit DEPARTED, and every site-wide pull
 *    filters DEPARTED out — so from that moment no pull ever refreshes the
 *    car again, and whatever this device held (often damage-less) is what
 *    every screen shows forever.
 *
 * Either way the defect sits safely in the database while the screen says
 * there is none — หน้างานลง Defect แล้ว แต่เปิดดูไม่เจอ. The per-VIN fetch has
 * no status or site filter and costs one row, so a focused car can always
 * afford the truth.
 */
import { fetchUnitsByVins, isConfigured } from './db'
import { useYard, attachPendingDamages } from '../store/useYard'

const inFlight = new Set<string>()

/** Fetch this VIN's unit (with damages) and adopt it over the local copy.
 *  Local-only pending defects are re-attached, never lost. Returns false when
 *  the cloud has no such unit (caller may retry). */
export async function refreshUnitFocus(vin: string): Promise<boolean> {
  if (!isConfigured() || !vin || inFlight.has(vin)) return false
  inFlight.add(vin)
  try {
    const [u] = await fetchUnitsByVins([vin])
    if (!u) return false
    useYard.setState((s) => ({ units: { ...s.units, [u.vin]: attachPendingDamages(s.pendingDamages, u) } }))
    return true
  } catch (e) {
    console.error('[db] refreshUnitFocus', vin, e)
    return false
  } finally {
    inFlight.delete(vin)
  }
}
