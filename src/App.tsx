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
import { isPhone } from './lib/device'
import { Dashboard } from './pages/Dashboard'
import { ImportPage } from './pages/ImportPage'
import { Report } from './pages/Report'
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
  const [usersReady, setUsersReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    useYard.getState().loadAppUsersFromCloud()
      .catch((e) => console.error('[App] appUsers load', e))
      .finally(() => { if (!cancelled) setUsersReady(true) })
    return () => { cancelled = true }
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
    loadFromSupabase()
      .catch((e) => console.error('[App] background units load', e))
      // heal lane holes left from before auto-compaction existed (idempotent)
      .finally(() => { try { useYard.getState().compactAllLanes() } catch { /* noop */ } })
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
  useEffect(() => { loadFromIdb() }, [loadFromIdb])

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
      if (gone.length) useYard.getState().markDepartedMany(gone)
    }
    const t = setTimeout(sweep, 9000) // let the boot loads settle first
    const iv = setInterval(sweep, 60_000)
    return () => { clearTimeout(t); clearInterval(iv) }
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
