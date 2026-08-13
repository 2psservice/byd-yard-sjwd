/**
 * ONLINE 100% mode
 * ────────────────
 * Every device shows the CLOUD and nothing else: yard data (tracking rows,
 * units, yard-plan layout) is fetched fresh on every load and lives only in
 * memory for that session — it is never written to IndexedDB / localStorage
 * and therefore can never differ from one device to the next.
 *
 * What still lives on the device (deliberately, and none of it is yard data):
 *  - UI preferences: column layout, filters, language, plan mode
 *  - the login roster + session, so a device can reach the login screen fast
 *
 * Trade-off (explicit): with this on, the app needs a connection. Offline the
 * screen shows the "no connection" gate instead of yesterday's cached numbers.
 * `setOnlineOnly(false)` turns the local cache back on for a device on a bad
 * yard link (Settings → โหมดข้อมูล).
 */
const KEY = 'sjwd.onlineOnly'

export function isOnlineOnly(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0' // default ON
  } catch {
    return true
  }
}

export function setOnlineOnly(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch { /* private mode — the default (ON) applies */ }
}
