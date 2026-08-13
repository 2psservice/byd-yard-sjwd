/**
 * Data mode: MIRROR + cache (default) vs ONLINE 100% (opt-in per device).
 * ──────────────────────────────────────────────────────────────────────
 * Default — mirror + local cache: yard data lives in IndexedDB/localStorage so
 * the app opens instantly from the last known state, then syncs. Consistency
 * across devices comes from mirror mode (local must equal the count-verified
 * cloud set; ghosts are dropped, own un-pushed edits rescued) plus the numbers
 * that MUST match everywhere being counted on the cloud directly (In Yard chip,
 * Dashboard card, sync badge).
 *
 * ONLINE 100% — nothing of the yard is kept on the device; every load pulls
 * fresh from the cloud. Guaranteed identical screens, but every open re-loads
 * everything and offline shows a gate instead of data. A device opts in via
 * Settings → โหมดข้อมูล; the choice is per-device.
 */
const KEY = 'sjwd.onlineOnly'

export function isOnlineOnly(): boolean {
  try {
    return localStorage.getItem(KEY) === '1' // default OFF → mirror + cache
  } catch {
    return false
  }
}

export function setOnlineOnly(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch { /* private mode — the default (mirror + cache) applies */ }
}
