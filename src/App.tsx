import { useEffect, useRef, useState } from 'react'
import { Layout } from './components/Layout'
import { LoginScreen } from './components/LoginScreen'
import { LogoLoaderOverlay } from './components/LogoLoader'
import { Toaster } from './components/ui'
import { SelectSiteModal } from './components/SelectSiteModal'
import { OpsShell } from './components/OpsShell'
import { useYard, useMe, isOpsOnlyRole } from './store/useYard'
import { useTrackingRows, useTracking } from './store/useTracking'
import { useOps } from './store/useOps'
import { startSyncBus, stopSyncBus } from './lib/syncBus'
import { deriveCarStatus } from './lib/carStatus'
import { yardLocCode, LAST_LOCATION_KEY } from './lib/groupingImport'
import { matchModel } from './lib/sampleData'
import { isPhone } from './lib/device'
import { Dashboard } from './pages/Dashboard'
import { ImportPage } from './pages/ImportPage'
import { Report } from './pages/Report'
import { Report2ps } from './pages/Report2ps'
import { GateIn } from './pages/GateIn'
import { Driver } from './pages/Driver'
import { YardPlan } from './pages/YardPlan'
import { Units } from './pages/Units'
import { Rules } from './pages/Rules'
import { YardOps } from './pages/YardOps'
import { Tracking } from './pages/Tracking'
import { Operation } from './pages/Operation'
import { PmPlan } from './pages/PmPlan'
import { Damages } from './pages/Damages'
import { Grouping } from './pages/Grouping'
import { Settings } from './pages/Settings'
import type { View } from './types'

// same local calendar day? (device-local time — matches how the yard works shifts)
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

// placeholder codes from a Vin List file's template rows ("QAQANYB2000001") —
// not real VINs (a real VIN never contains the letter Q, and no WMI starts
// with QAQ), so anything in this family is import junk to purge everywhere
const isJunkVin = (v: string) => v.startsWith('QAQA')

export default function App() {
  const loggedInUserId = useYard((s) => s.loggedInUserId)
  const me = useMe()
  // a phone only ever gets the Yard Ops station — the admin screens are wide
  // data tables, unusable on a handset — so the gate is the device, not the role
  const opsOnly = isOpsOnlyRole(me?.role) || isPhone
  const view = useYard((s) => s.view)
  const ensureUnitSites = useYard((s) => s.ensureUnitSites)
  const purgeNonTracking = useYard((s) => s.purgeNonTracking)
  const loadFromSupabase = useYard((s) => s.loadFromSupabase)
  const subscribeUnits = useYard((s) => s.subscribeRealtime)
  const unsubscribeUnits = useYard((s) => s.unsubscribeRealtime)
  const hasUnits = useYard((s) => Object.keys(s.units).length > 0)
  const currentSite = useYard((s) => s.currentSite)
  const openSiteModal = useYard((s) => s.openSiteModal)
  const trackingRows = useTrackingRows()
  const trackingLoaded = useTracking((s) => s.loaded)
  const loadFromIdb = useTracking((s) => s.loadFromIdb)
  const subscribeTracking = useTracking((s) => s.subscribeRealtime)
  const unsubscribeTracking = useTracking((s) => s.unsubscribeRealtime)
  const purgedRef = useRef(false)

  // ── Supabase Realtime: live status / yard-plan / ops updates across all devices ──
  useEffect(() => {
    if (!loggedInUserId) return
    subscribeTracking()
    subscribeUnits()
    startSyncBus() // broadcast bus: yard-plan blocks + ops queues + trailers
    return () => { unsubscribeTracking(); unsubscribeUnits(); stopSyncBus() }
  }, [loggedInUserId, subscribeTracking, subscribeUnits, unsubscribeTracking, unsubscribeUnits])

  // ── seed this device's Unit-List view (columns + filters) from the shared
  //    admin default, then restore the USER's own saved view (บันทึก) — the
  //    newer of the two wins, so a refresh never loses a saved customization ──
  useEffect(() => {
    if (!loggedInUserId) return
    const t = useTracking.getState()
    t.seedViewDefault().catch(() => {}).then(() => t.loadMyView()).catch(() => {})
  }, [loggedInUserId])

  // ── login roster: fetch BEFORE showing the login screen, logged-in or not —
  //    a field account created on the admin's computer must be able to log in
  //    from its own phone, which never had that account in its local cache. ──
  //    …but a device that ALREADY holds a roster must not sit on the loading
  //    screen re-confirming it: on flaky yard wifi that held the whole app —
  //    yard plan included — for seconds before anything drew. Open straight
  //    away when we have a local roster; the fetch still runs and refreshes it
  //    the moment it lands. A first-ever device (no roster) still waits, but
  //    never longer than 4s.
  const [usersReady, setUsersReady] = useState(() => useYard.getState().appUsers.length > 0)
  useEffect(() => {
    let cancelled = false
    useYard.getState().loadAppUsersFromCloud()
      .catch((e) => console.error('[App] appUsers load', e))
      .finally(() => { if (!cancelled) setUsersReady(true) })
    const t = setTimeout(() => { if (!cancelled) setUsersReady(true) }, 4000)
    return () => { cancelled = true; clearTimeout(t) }
  }, [])

  // ── branded boot loader: fetches data from Supabase on login,
  //    shows SCGJWD fill animation while loading.
  //    StrictMode-safe: cleanup cancels the in-flight load. ──
  const [booting, setBooting] = useState(() => useYard.getState().loggedInUserId != null)
  useEffect(() => {
    if (!loggedInUserId) return
    let cancelled = false
    setBooting(true)
    // units + damages are heavy (~8 MB / ~15k rows) — load them in the BACKGROUND.
    // The Unit List + Dashboard render from tracking rows, so the splash only needs
    // a brief beat; it also lifts as soon as trackingLoaded flips (local-first).
    loadFromSupabase().catch((e) => console.error('[App] background units load', e))
    useOps.getState().loadFromCloud().catch((e) => console.error('[App] ops queues load', e))
    useYard.getState().loadPolicies().catch((e) => console.error('[App] parking policies load', e))
    const t = setTimeout(() => { if (!cancelled) setBooting(false) }, 600)
    return () => { cancelled = true; clearTimeout(t) }
  }, [loggedInUserId, loadFromSupabase])

  // require site selection after login
  useEffect(() => {
    if (!currentSite) openSiteModal()
  }, [currentSite, openSiteModal])

  // stale-session cleanup: if the signed-in account was deleted/deactivated
  // while this device was open, clear the session state too (the render gate
  // below already fails closed — this keeps loggedInUserId consistent).
  useEffect(() => {
    if (loggedInUserId && (!me || !me.active)) useYard.getState().logout()
  }, [loggedInUserId, me])

  // ── daily session expiry: any session that crossed midnight is logged out
  //    (all roles, admin included). Checked at mount, every minute, and when
  //    the tab becomes visible again (PWA left open overnight on a phone). ──
  useEffect(() => {
    if (!loggedInUserId) return
    let warned = false
    const check = () => {
      const { loggedInUserId: uid, loginAt, logout, toast } = useYard.getState()
      if (!uid) return
      // heads-up 10 min before the midnight cutoff so a night-shift inspector
      // can finish/save instead of losing an in-progress checklist to the logout
      const now = new Date()
      if (!warned && now.getHours() === 23 && now.getMinutes() >= 50) {
        warned = true
        toast('err', 'ระบบจะหมดเวลาใช้งานตอนเที่ยงคืน — กรุณาบันทึกงานที่ค้างไว้')
      }
      if (!loginAt || !sameDay(loginAt, Date.now())) {
        logout()
        toast('info', 'ครบกำหนดการใช้งานรายวัน — กรุณาเข้าสู่ระบบใหม่')
      }
    }
    check()
    const iv = setInterval(check, 60_000)
    const onVis = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [loggedInUserId])

  // load real tracking data from IndexedDB on startup
  // tracking rows AND the yard-plan units both boot from IndexedDB — the plan
  // paints its cars from the local cache before any network answer
  useEffect(() => { loadFromIdb(); useYard.getState().loadUnitsFromIdb() }, [loadFromIdb])

  // ── a gated-out car must not keep holding a parking slot ──────────────────
  // Cars leave through several paths (ops-scan + 09:30 flush, Co-Inspection
  // import, restored gate-out history) and only the ops-scan path released its
  // slot — the rest stayed painted into their lane, blocking the row. Sweep on
  // boot and every minute (the flush is clock-driven, no data change fires it):
  // any positioned unit whose sheet derives Gate-out is marked departed — the
  // slot frees, the lane closes up, and the tracking row's history stays.
  useEffect(() => {
    if (!loggedInUserId) return
    const sweep = () => {
      const { units } = useYard.getState()
      const { rows } = useTracking.getState()
      const gone: string[] = []
      for (const vin in units) {
        const u = units[vin]
        if (u.block == null && u.row == null && u.slot == null) continue
        const r = rows[vin]
        if (r && deriveCarStatus(r.cells) === 'Gate-out') gone.push(vin)
      }
      if (gone.length) {
        // snapshot each car's last slot before markDepartedMany clears it — this
        // path (unlike the ops-scan gate-out) never ran doGateOut, so it never
        // got its own snapshot; without this a reprinted Grouping / find-car
        // sheet would show "ไม่พบ" for every car this sweep releases
        for (const vin of gone) {
          const loc = yardLocCode(units[vin])
          if (loc) useTracking.getState().updateCell(vin, LAST_LOCATION_KEY, loc)
        }
        useYard.getState().markDepartedMany(gone)
      }

      // ── model heal: the sheet's รุ่น is the truth — a unit created from an
      // older file keeps a stale class forever (a SEAL 5 painted "SEAL" on the
      // yard plan). Re-derive the class from the row's model text and fix any
      // mismatch (importUnits re-runs matchModel + pushes to cloud). Unknown
      // text (OTHER) never overwrites a unit's existing class.
      {
        const allU = useYard.getState().units
        const fixes: { vin: string; model: string; color: string }[] = []
        for (const vin in allU) {
          const u = allU[vin]
          const txt = (rows[vin]?.cells['Model name'] || rows[vin]?.cells['Model'] || '').trim()
          if (!txt) continue
          const m = matchModel(txt)
          if (m.id !== 'OTHER' && m.id !== u.model) fixes.push({ vin, model: txt, color: '' })
        }
        if (fixes.length) useYard.getState().importUnits(fixes)
      }
    }
    const t = setTimeout(sweep, 9000) // let the boot loads settle first
    const iv = setInterval(sweep, 60_000)
    return () => { clearTimeout(t); clearInterval(iv) }
  }, [loggedInUserId])

  // ── realtime catch-up: a tab that slept or lost network missed events ──
  // Realtime keeps the yard plan live, but a phone in a pocket or a laptop
  // lid-closed misses everything while suspended. On waking after ≥60s (or
  // when the network returns) pull the gap: incremental tracking sync + this
  // yard's units, so re-locations done meanwhile appear without a refresh.
  useEffect(() => {
    if (!loggedInUserId) return
    const catchUp = () => {
      useTracking.getState().syncCloud().catch(() => {})
      // push any defect that failed to save earlier BEFORE the full re-pull —
      // otherwise loadFromSupabase's cloud merge can race the flush and briefly
      // show the car without its still-unsynced defect
      useYard.getState().flushPendingDamages().catch(() => {})
      useYard.getState().loadFromSupabase().catch(() => {})
    }
    // a defect can be left pending from a session that got killed before its
    // retry landed — the boot loadFromSupabase() (below/elsewhere) already
    // covers the full re-pull, this only needs to push the queued write
    useYard.getState().flushPendingDamages().catch(() => {})
    let hiddenAt = 0
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
      if (hiddenAt && Date.now() - hiddenAt > 60_000) catchUp()
      hiddenAt = 0
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', catchUp)
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', catchUp) }
  }, [loggedInUserId])

  // dev-only store handles for automated tests (same pattern as Units' __tracking)
  useEffect(() => {
    if (import.meta.env.DEV) { (window as any).__yard = useYard; (window as any).__ops = useOps; (window as any).__tracking = useTracking }
  }, [])

  // once tracking rows are available, purge any leftover sample units/trips —
  // but only AFTER a cloud sync completed (lastSync > 0). On a fresh device the
  // first non-empty set is the site-scoped partial load; purging against it
  // deleted every unit whose VIN wasn't in that subset.
  useEffect(() => {
    if (!purgedRef.current && trackingRows.length > 0 && useTracking.getState().lastSync > 0) {
      purgedRef.current = true
      // data fix: tombstone-delete leaked placeholder codes so they never
      // resurface from another device's cache, and keep them OUT of the
      // keep-set below so any stray unit of theirs is purged the same pass
      const junk = trackingRows.filter((r) => isJunkVin(r.vin)).map((r) => r.vin)
      if (junk.length) useTracking.getState().deleteRows(junk)
      purgeNonTracking(new Set(trackingRows.filter((r) => !isJunkVin(r.vin)).map((r) => r.vin)))
    }
  }, [trackingRows, purgeNonTracking])

  // the same placeholder codes also sit inside work queues (the import that
  // created them added them to a Pre Gate-in queue) — strip them wherever found
  const opsQueues = useOps((s) => s.queues)
  useEffect(() => {
    for (const q of opsQueues)
      for (const it of q.items)
        if (isJunkVin(it.vin)) useOps.getState().removeVin(q.id, it.vin)
  }, [opsQueues])

  // assign sites to real units (no-op if already set)
  useEffect(() => {
    if (hasUnits) ensureUnitSites()
  }, [hasUnits, ensureUnitSites])

  const pages: Record<View, JSX.Element> = {
    dashboard: <Dashboard />,
    import: <ImportPage />,
    trailers: <Report />, // legacy view id — devices with a saved 'trailers' view land here
    report: <Report />,
    report2ps: <Report2ps />,
    gatein: <GateIn />,
    driver: <Driver />,
    yard: <YardPlan />,
    units: <Units />,
    rules: <Rules />,
    yardops: <YardOps />,
    tracking: <Tracking />,
    operation: <Operation />,
    pm: <PmPlan />,
    damages:   <Damages />,
    grouping:  <Grouping />,
    settings: <Settings />,
  }

  // brand loader while the shared login roster loads — must resolve before
  // the login form can trust its "invalid username/password" verdict
  if (!usersReady) return <><LogoLoaderOverlay label="กำลังเตรียมระบบ" /><Toaster /></>

  // fail-CLOSED: a session whose account no longer resolves (deleted from the
  // roster) or is deactivated goes back to login. It used to fall through with
  // a null role — `isOpsOnlyRole(undefined) === false` — straight into the
  // full admin shell.
  if (!loggedInUserId || !me || !me.active) return <><LoginScreen /><Toaster /></>

  // brand loader while the boot animation plays or yard data is still loading
  if (booting || !trackingLoaded)
    return <><LogoLoaderOverlay label="กำลังโหลดข้อมูล" /><Toaster /></>

  // field roles (driver / walk-around / PM / mechanic) — and ANY account on a
  // phone — live in Yard Ops only: no sidebar, no admin pages
  if (opsOnly)
    return (
      <>
        <OpsShell><YardOps /></OpsShell>
        <SelectSiteModal />
        <Toaster />
      </>
    )

  return (
    <>
      <Layout>{pages[view]}</Layout>
      <SelectSiteModal />
      <Toaster />
    </>
  )
}
