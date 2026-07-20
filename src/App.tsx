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
import { Damages } from './pages/Damages'
import { Grouping } from './pages/Grouping'
import { Settings } from './pages/Settings'
import type { View } from './types'

// same local calendar day? (device-local time — matches how the yard works shifts)
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

export default function App() {
  const loggedInUserId = useYard((s) => s.loggedInUserId)
  const me = useMe()
  const opsOnly = isOpsOnlyRole(me?.role)
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

  // ── one-time: seed this device's Unit-List view (columns + filters) from the
  //    shared admin default, until the user customises their own ──
  useEffect(() => { if (loggedInUserId) useTracking.getState().seedViewDefault().catch(() => {}) }, [loggedInUserId])

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
    loadFromSupabase().catch((e) => console.error('[App] background units load', e))
    useOps.getState().loadFromCloud().catch((e) => console.error('[App] ops queues load', e))
    const t = setTimeout(() => { if (!cancelled) setBooting(false) }, 600)
    return () => { cancelled = true; clearTimeout(t) }
  }, [loggedInUserId, loadFromSupabase])

  // require site selection after login
  useEffect(() => {
    if (!currentSite) openSiteModal()
  }, [currentSite, openSiteModal])

  // ── daily session expiry: any session that crossed midnight is logged out
  //    (all roles, admin included). Checked at mount, every minute, and when
  //    the tab becomes visible again (PWA left open overnight on a phone). ──
  useEffect(() => {
    if (!loggedInUserId) return
    const check = () => {
      const { loggedInUserId: uid, loginAt, logout, toast } = useYard.getState()
      if (!uid) return
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

  // once tracking rows are available, purge any leftover sample units/trips
  useEffect(() => {
    if (!purgedRef.current && trackingRows.length > 0) {
      purgedRef.current = true
      purgeNonTracking(new Set(trackingRows.map((r) => r.vin)))
    }
  }, [trackingRows, purgeNonTracking])

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
    damages:   <Damages />,
    grouping:  <Grouping />,
    settings: <Settings />,
  }

  // brand loader while the shared login roster loads — must resolve before
  // the login form can trust its "invalid username/password" verdict
  if (!usersReady) return <><LogoLoaderOverlay label="กำลังเตรียมระบบ" /><Toaster /></>

  if (!loggedInUserId) return <><LoginScreen /><Toaster /></>

  // brand loader while the boot animation plays or yard data is still loading
  if (booting || !trackingLoaded)
    return <><LogoLoaderOverlay label="กำลังโหลดข้อมูล" /><Toaster /></>

  // field roles (driver / walk-around / PM / mechanic) live in Yard Ops only —
  // no sidebar, no admin pages
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
