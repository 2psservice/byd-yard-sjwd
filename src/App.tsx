import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Layout } from './components/Layout'
import { LoginScreen } from './components/LoginScreen'
import { LogoLoaderOverlay } from './components/LogoLoader'
import { Toaster } from './components/ui'
import { SelectSiteModal } from './components/SelectSiteModal'
import { OpsShell } from './components/OpsShell'
import { SiteLoadGate } from './components/SiteLoadGate'
import { useYard, useMe, isOpsOnlyRole } from './store/useYard'
import { useTrackingRows, useTracking } from './store/useTracking'
import { siteIdForLocation } from './lib/siteScope'
import { useOps, repairMissingStationDates } from './store/useOps'
import { useVisits } from './store/useVisits'
import { startSyncBus, stopSyncBus } from './lib/syncBus'
import { startKeyboardGuard } from './lib/keyboardGuard'
import { deriveCarStatus } from './lib/carStatus'
import { yardLocCode, LAST_LOCATION_KEY } from './lib/groupingImport'
import { matchModel } from './lib/sampleData'
import { isPhone } from './lib/device'
import { useMasterDefect } from './store/useMasterDefect'
import type { View } from './types'

// Every page used to be a static import, so a phone opening ONLY Yard Ops
// still paid to parse/compile every admin page (Dashboard, Report, Import…)
// bundled into the same ~1.4 MB chunk before anything could render — a real
// cost on weak CPUs, not just a download-speed one. Each page is its own
// chunk now, fetched the first time its view is actually opened (Suspense
// fallback below) — a phone that only ever opens opsOnly's <YardOps/> now
// loads just that one page's code.
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const ImportPage = lazy(() => import('./pages/ImportPage').then((m) => ({ default: m.ImportPage })))
const Report = lazy(() => import('./pages/Report').then((m) => ({ default: m.Report })))
const Report2ps = lazy(() => import('./pages/Report2ps').then((m) => ({ default: m.Report2ps })))
const GateIn = lazy(() => import('./pages/GateIn').then((m) => ({ default: m.GateIn })))
const Driver = lazy(() => import('./pages/Driver').then((m) => ({ default: m.Driver })))
const YardPlan = lazy(() => import('./pages/YardPlan').then((m) => ({ default: m.YardPlan })))
const Units = lazy(() => import('./pages/Units').then((m) => ({ default: m.Units })))
const Rules = lazy(() => import('./pages/Rules').then((m) => ({ default: m.Rules })))
const YardOps = lazy(() => import('./pages/YardOps').then((m) => ({ default: m.YardOps })))
const Tracking = lazy(() => import('./pages/Tracking').then((m) => ({ default: m.Tracking })))
const Operation = lazy(() => import('./pages/Operation').then((m) => ({ default: m.Operation })))
const PmPlan = lazy(() => import('./pages/PmPlan').then((m) => ({ default: m.PmPlan })))
const PdiBoard = lazy(() => import('./pages/PdiBoard').then((m) => ({ default: m.PdiBoard })))
const Damages = lazy(() => import('./pages/Damages').then((m) => ({ default: m.Damages })))
const Grouping = lazy(() => import('./pages/Grouping').then((m) => ({ default: m.Grouping })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))

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
  const runPendingSiteCleanup = useYard((s) => s.runPendingSiteCleanup)
  const sites = useYard((s) => s.sites)
  const purgeNonTracking = useYard((s) => s.purgeNonTracking)
  const loadFromSupabase = useYard((s) => s.loadFromSupabase)
  const subscribeUnits = useYard((s) => s.subscribeRealtime)
  const unsubscribeUnits = useYard((s) => s.unsubscribeRealtime)
  const hasUnits = useYard((s) => Object.keys(s.units).length > 0)
  const currentSite = useYard((s) => s.currentSite)
  const unitsCloudDone = useYard((s) => s.unitsCloudDone)
  const openSiteModal = useYard((s) => s.openSiteModal)
  const trackingRows = useTrackingRows()
  const trackingLoaded = useTracking((s) => s.loaded)
  const loadFromIdb = useTracking((s) => s.loadFromIdb)
  const subscribeTracking = useTracking((s) => s.subscribeRealtime)
  const unsubscribeTracking = useTracking((s) => s.unsubscribeRealtime)
  const purgedRef = useRef(false)

  // ── แป้นพิมพ์มือถือต้องไม่บังกล่องยืนยัน ──
  // after a scan the field still holds focus, so the keyboard stays up and the
  // result box ("Pre Gate-out สำเร็จ!") opens behind it with its ตกลง button
  // covered. Blur the field whenever a full-screen box appears.
  useEffect(() => startKeyboardGuard(), [])

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
    useMasterDefect.getState().loadFromCloud().catch((e) => console.error('[App] master defect list load', e))
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
  useEffect(() => { loadFromIdb(); useYard.getState().loadUnitsFromIdb(); useVisits.getState().load().catch(() => {}) }, [loadFromIdb])
  // แยกยาร์ด แยกงาน ขั้นที่ 1: รอบที่ปิดไปแล้วซึ่งยังซ่อนอยู่ในก้อน __trips ของแถวสด
  // → สร้างเป็นแถวรอบจริงของยาร์ดต้นทาง (ทำซ้ำได้ ไม่สร้างซ้ำ) — รันหลังแถวสดโหลดแล้ว
  // และรันซ้ำหลังซิงก์คลาวด์ครั้งแรก เผื่อแถวที่เพิ่งมาถึง
  useEffect(() => {
    if (!trackingLoaded) return
    const run = () => {
      const rows = Object.values(useTracking.getState().rows)
      const sites = useYard.getState().sites
      if (!rows.length || !sites.length) return
      const n = useVisits.getState().migrateFromTrips(rows, sites)
      if (n) console.info(`[visits] migrated ${n} closed round(s)`)
    }
    run()
    const t = setTimeout(run, 30_000)
    return () => clearTimeout(t)
  }, [trackingLoaded])

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
      // ── ระบบห้ามย้ายรถข้ามยาร์ดเอง ─────────────────────────────────────────
      // ตรงนี้เคยมีกฎ "heal" ที่เดาจากหลักฐานบนแถว (ไซต์ที่ยืนยันสถานะ · เวลาออก
      // กับเวลายิงรับ · ล็อตรับรถของยาร์ดอื่น · ชื่อยาร์ดใน Dealer Location) แล้ว
      // เรียก transferToYard ให้เองทุก 60 วิ บนทุกเครื่อง — รถที่ย้าย 3D LCB →
      // 60 Rai ถูกต้องแล้วทุกคันผ่านด่านครึ่งแรกของกฎนั้นอยู่แล้ว (มีรอยออกจาก
      // ต้นทาง + ยิงรับที่ปลายทาง) เหลือแค่ข้อมูลชิ้นเดียวที่บอกว่า "ปลายทางถัดไป
      // = 3D LCB" ก็โดนปิดรอบที่ 60 Rai (อ่านเป็น Gate-out) เปิดรอบ Pre Gate-in
      // ที่ 3D LCB และล้างตำแหน่งจอดทิ้งทั้งล็อต 79 คันพร้อมกัน โดยไม่มีใครทำ
      // ยาร์ดเปลี่ยนได้จากคนเท่านั้น: ยิง Gate-out ปลายทางยาร์ดเรา (doGateOut) ·
      // ยิง Gate-in ที่ปลายทาง (doTrackingGateIn) · แอดมินแก้ช่อง Location yard
      // (applyYardMove) — ไฟล์ระบบกลางก็ย้ายรถที่ยาร์ดนี้รับไปแล้วไม่ได้เช่นกัน
      // (ดู commitCoInspection) กฎเดียวกับตำแหน่งจอด: ระบบไม่ปรับข้อมูลเอง

      // ── ตัวกวาด "ยาร์ดของ unit ต้องตรงกับป้ายยาร์ดของแถวชีต" ถูกถอดออก (6 ต.ค.) ──
      // เดิม: ป้ายไม่ตรง → moveUnitsToSite ให้เอง ซึ่ง "ล้างช่องจอดทิ้ง + ตั้ง EXPECTED
      // + เขียนคลาวด์" โดยไม่ลงประวัติ Location — รถที่เพิ่งยิง Relocation ที่ 60 RAI
      // (unit ประทับยาร์ดของเครื่องที่ยิง) แต่แถวชีตยังติดป้ายยาร์ดอื่น จึงหายจากผัง
      // ภายใน 60 วิ ทั้งบล็อก F/L/N โดยไม่มีใครสั่ง ยาร์ดเปลี่ยนได้จากคนเท่านั้น
      // (ดูคอมเมนต์ด้านบน) ป้ายที่ไม่ตรงปล่อยไว้ให้แอดมินตัดสิน — ตำแหน่งที่คนยิงคง
      // อยู่ตามที่ยิง (คืนตำแหน่งที่เคยถูกล้าง: Settings → คืนตำแหน่งตามบล็อก)
      for (const vin in units) {
        const u = units[vin]
        const r = rows[vin]
        if (!r) continue
        // กฎ "ปล่อยช่องจอดคืน" ใช้กับรถที่กินช่องอยู่เท่านั้น — รถที่ไม่มีช่อง
        // ก็ไม่มีอะไรให้ปล่อย
        const positioned = u.block != null || u.row != null || u.slot != null
        if (positioned && deriveCarStatus(r.cells) === 'Gate-out') gone.push(vin)
      }
      // snapshot each car's last slot before it is cleared — this path (unlike
      // the ops-scan gate-out) never ran doGateOut, so it never got its own
      // snapshot; without this a reprinted Grouping / find-car sheet would
      // show "ไม่พบ" for every car this sweep releases
      //
      // เขียนได้เฉพาะเมื่อช่องยังว่าง — ห้ามทับค่าที่มีอยู่ เครื่องแต่ละเครื่องถือสำเนา
      // ตำแหน่งเก่าของรถคันเดียวกันคนละค่า (เครื่องที่พลาด realtime ตอนหลับ และการดึง
      // units ตอนเข้ายาร์ดกรองรถที่ออกแล้วทิ้ง สำเนาเก่าจึงไม่เคยถูกแก้) ตัวเก็บกวาดของ
      // ทุกเครื่องเลยผลัดกันเขียน N05 → N08 → N05 … ขึ้นประวัติในชื่อคนที่ล็อกอินอยู่
      // ทั้งที่ไม่มีใครย้ายรถ และทุกครั้งคือการส่งทั้งแถวจากสำเนาเก่าขึ้นคลาวด์ด้วย
      const snapshotSlot = (vin: string) => {
        const loc = yardLocCode(units[vin])
        if (!loc) return
        if ((rows[vin]?.cells[LAST_LOCATION_KEY] ?? '').trim()) return // มีค่าอยู่แล้ว — ของจริงคือค่าที่เขียนตอนยิงออก
        useTracking.getState().updateCell(vin, LAST_LOCATION_KEY, loc)
      }
      if (gone.length) {
        for (const vin of gone) snapshotSlot(vin)
        useYard.getState().markDepartedMany(gone)
      }

      // (ตรงนี้เคยมี "auto-transfer": รถที่สถานะอ่านเป็น Gate-out และ Dealer
      // Location สะกดชื่อยาร์ดของเรา → เปิดรอบ Pre Gate-in ที่ยาร์ดนั้นให้เอง —
      // ตัดออกด้วยเหตุผลเดียวกับด้านบน ยิง Gate-out ที่ประตู (doGateOut) ย้ายรถ
      // ให้เองอยู่แล้วตอนกดปุ่ม ส่วน Gate-out ที่แอดมินตั้งเองที่ Unit List ปลายทาง
      // รับได้ด้วยการยิง Gate-in ตามปกติ ไม่ต้องให้ระบบเดาจากชื่อใน Dealer Location)

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
          // the sheet's Color is the truth too — a unit an older defect import
          // registered carries the MODEL text as its colour ("SEALION 7");
          // re-stamp it from the sheet wherever the two disagree
          const sheetColor = (rows[vin]?.cells['Color'] || '').trim()
          const badColor = !!sheetColor && u.color !== sheetColor
          const badModel = m.id !== 'OTHER' && m.id !== u.model
          // a colour-only fix re-sends the unit's OWN model name, so unknown
          // sheet text still never overwrites an existing class
          if (badModel || badColor) fixes.push({ vin, model: badModel ? txt : u.modelName, color: badColor ? sheetColor : '' })
        }
        if (fixes.length) useYard.getState().importUnits(fixes)
      }
    }
    const t = setTimeout(sweep, 9000) // let the boot loads settle first
    const iv = setInterval(sweep, 60_000)
    // dev-only: let automated tests trigger this sweep on demand instead of
    // waiting on real timers (same pattern as the __yard/__ops/__tracking hooks)
    if (import.meta.env.DEV) (window as unknown as { __sweepNow?: () => void }).__sweepNow = sweep
    return () => { clearTimeout(t); clearInterval(iv) }
  }, [loggedInUserId])

  // ── คืนตำแหน่งครั้งเดียว (6 ต.ค.): บล็อก F / L / N ของ 60 RAI ──────────────
  // ตัวกวาด "ป้ายยาร์ดไม่ตรง → ย้ายยาร์ด/ล้างช่องเอง" (ถอดออกด้านบนแล้ว) ล้างช่อง
  // จอดของรถที่เพิ่งยิง Relocation ทั้งสามบล็อกทิ้งโดยไม่ลงประวัติ — ประวัติ Location
  // ยังอยู่ครบ จึงคืนจากบรรทัดล่าสุดที่คนบันทึก (restorePositionsInBlocks) ทำครั้งเดียว
  // ต่อเครื่อง เฉพาะเครื่องแอดมินที่เลือก 60 RAI อยู่ หลังรถและแถวชีตโหลดครบ ไม่ทับ
  // ช่องที่มีรถอื่นจอด ไม่แตะรถที่มีช่องแล้ว ทำซ้ำบนเครื่องอื่นก็ไม่มีอะไรให้แก้เพิ่ม
  useEffect(() => {
    if (!loggedInUserId || opsOnly || !trackingLoaded || !unitsCloudDone || !currentSite) return
    const KEY = 'sjwd-restore-fln-60rai-20261006'
    try { if (localStorage.getItem(KEY)) return } catch { return }
    if (siteIdForLocation({ 'Location yard': '60 RAI' }, sites) !== currentSite) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await useTracking.getState().restorePositionsInBlocks(['F', 'L', 'N'])
        if (cancelled) return
        try { localStorage.setItem(KEY, String(Date.now())) } catch { /* เครื่องไม่ให้เก็บ — รอบหน้าก็ไม่มีอะไรให้แก้แล้ว */ }
        if (res.fixed || res.collided.length) {
          useYard.getState().toast(res.collided.length ? 'info' : 'ok',
            `คืนตำแหน่งรถบล็อก F/L/N ของ 60 RAI ${res.fixed} คัน${res.collided.length ? ` · ช่องถูกจอดทับ ${res.collided.length} คัน: ${res.collided.map((c) => `${c.vin.slice(-6)}→${c.want}`).join(', ')}` : ''}`)
        }
      } catch (e) { console.error('[restore] F/L/N 60 RAI', e) } // ไม่ตั้งธง — เปิดครั้งหน้าลองใหม่
    }, 12_000)
    return () => { cancelled = true; clearTimeout(t) }
  }, [loggedInUserId, opsOnly, trackingLoaded, unitsCloudDone, currentSite, sites])

  // ── realtime catch-up: a tab that slept or lost network missed events ──
  // Realtime keeps the yard plan live, but a phone in a pocket or a laptop
  // lid-closed misses everything while suspended. On waking after ≥60s (or
  // when the network returns) pull the gap: incremental tracking sync + this
  // yard's units, so re-locations done meanwhile appear without a refresh.
  useEffect(() => {
    if (!loggedInUserId) return
    const catchUp = () => {
      useTracking.getState().syncCloud().catch(() => {})
      // push any defect (or move) that failed to save earlier BEFORE the full
      // re-pull — otherwise loadFromSupabase's cloud merge can race the flush
      // and briefly show the car without its still-unsynced defect, or slide
      // it back onto its old slot before the retry lands
      useYard.getState().flushPendingDamages().catch(() => {})
      useYard.getState().flushPendingPlacements().catch(() => {})
      useYard.getState().loadFromSupabase().catch(() => {})
    }
    // a defect or move can be left pending from a session that got killed
    // before its retry landed — the boot loadFromSupabase() (below/elsewhere)
    // already covers the full re-pull, this only needs to push the queued write
    useYard.getState().flushPendingDamages().catch(() => {})
    useYard.getState().flushPendingPlacements().catch(() => {})
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
    if (import.meta.env.DEV) {
      (window as any).__yard = useYard; (window as any).__ops = useOps; (window as any).__tracking = useTracking; (window as any).__visits = useVisits
      ;(window as any).__repairStationDates = repairMissingStationDates
      // lets a test drive the cloud writers directly (e.g. photo-preserving upserts)
      import('./lib/db').then((m) => { (window as any).__db = m }).catch(() => {})
      // lets a test play the part of "another device" announcing a move
      import('./lib/syncBus').then((m) => { (window as any).__sync = m }).catch(() => {})
    }
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

  // one-time correction for units ensureUnitSites' old round-robin bug
  // wrongly dumped onto a site named in pendingSiteCleanup — no-op once done.
  // Re-tries on `sites` too: a name not yet in this device's site list (still
  // syncing from cloud) needs another pass once that site actually arrives.
  useEffect(() => {
    if (hasUnits) runPendingSiteCleanup()
  }, [hasUnits, sites, runPendingSiteCleanup])

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
    pdi: <PdiBoard />,
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
        <OpsShell>
          <Suspense fallback={<LogoLoaderOverlay label="กำลังโหลดหน้า" />}><YardOps /></Suspense>
        </OpsShell>
        <SiteLoadGate mode="banner" />
        <SelectSiteModal />
        <Toaster />
      </>
    )

  return (
    <>
      <Layout>
        <Suspense fallback={<LogoLoaderOverlay label="กำลังโหลดหน้า" />}>{pages[view]}</Suspense>
      </Layout>
      {/* หน้า loading ของยาร์ดที่เลือก — รอแถวชีต + รถในผังของยาร์ดครบก่อนเปิดตัวเลข */}
      <SiteLoadGate mode="overlay" />
      <SelectSiteModal />
      <Toaster />
    </>
  )
}
