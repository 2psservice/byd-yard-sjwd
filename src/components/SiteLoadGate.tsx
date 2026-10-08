/**
 * หน้า loading ของ "ยาร์ดที่เลือก" — ค้างไว้จนแถวชีตและรถในผังของยาร์ดนั้นมาครบ
 * แล้วค่อยเปิดหน้าด้วยตัวเลขที่ถูกต้องทีเดียว
 *
 * ของเดิมเปิดหน้าทันทีที่อ่านแคชในเครื่องเสร็จ แล้วค่อย ๆ เติมจากคลาวด์เบื้องหลัง
 * โดยไม่บอกอะไร — Dashboard จึงขึ้น "15 In Yard" (แถวที่บังเอิญมีในแคช) ค้างอยู่
 * 1–2 นาที ก่อนเด้งเป็น 3,004 เมื่อ sync ทั้งบริษัทมาถึง ตัวเลขทุกใบในช่วงนั้นผิดหมด
 * (Gate-out 351 / Damage 0 / Pre Gate-in 0) ไม่ใช่แค่น้อย
 *
 *  · overlay (จอแอดมิน): บังทั้งหน้าพร้อม "Loading 45%" (แถวชีตของยาร์ด · ค้าง 99%
 *    จนรถในผังมาครบ)
 *  · banner (มือถือ Yard Ops): แถบเล็กด้านบน "Loading 45%" ไม่บล็อกการสแกน
 *  · ไม่ค้างตลอดไป: ถ้าไม่มีความคืบหน้าเกิน STALL_MS (เน็ตล่ม) หรือรวมเกิน MAX_MS
 *    ปล่อยหน้าเปิดด้วยของในเครื่อง พร้อมป้าย "กำลังซิงก์" แทน
 */
import { loadMark } from '../lib/loadMarks'
import { useEffect, useMemo, useState } from 'react'
import { useTracking } from '../store/useTracking'
import { useYard } from '../store/useYard'
import { LogoLoader } from './LogoLoader'
import { isConfigured } from '../lib/db'

const STALL_MS = 8_000   // ไม่มีแถวใหม่มาเลยนานเท่านี้ → ถือว่าค้าง เปิดหน้าไปก่อน
const MAX_MS = 45_000    // เพดานรวม — ยาร์ดใหญ่บนเน็ตช้าก็ไม่ควรค้างเกินนี้
const OFFLINE_BANNER_MS = 12_000

export function SiteLoadGate({ mode }: { mode: 'overlay' | 'banner' }) {
  const siteLoad = useTracking((s) => s.siteLoad)
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const unitsCloudDone = useYard((s) => s.unitsCloudDone)
  const units = useYard((s) => s.units)
  const [now, setNow] = useState(() => Date.now())

  const active = !!siteLoad && siteLoad.siteId === currentSite && isConfigured()
  const rowsLoading = active && siteLoad!.status === 'loading'
  const unitsLoading = active && !unitsCloudDone
  const pending = rowsLoading || unitsLoading

  // ป้ายหยุดบล็อกแล้ว (แถวของยาร์ด + รถครบ) — จุดสิ้นสุดของ "ป้าย Loading" ที่ผู้ใช้จับเวลา
  useEffect(() => { if (active && !pending) loadMark('gate-clear') }, [active, pending])

  // นาฬิกาเดินเฉพาะตอนที่กำลังรอ — ใช้ตัดสินว่า "ค้าง" หรือยังเดินอยู่
  useEffect(() => {
    if (!pending && !(active && siteLoad!.status === 'offline')) return
    const iv = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(iv)
  }, [pending, active, siteLoad])

  const unitsHere = useMemo(() => {
    if (!currentSite) return 0
    let n = 0
    for (const vin in units) if (units[vin].site === currentSite) n++
    return n
  }, [units, currentSite])

  if (!active) return null
  const siteName = sites.find((s) => s.id === currentSite)?.name ?? ''
  const { have, total, status, startedAt, progressAt } = siteLoad!
  const elapsed = now - startedAt
  const sinceProgress = now - progressAt
  // รอได้ถ้ายังเดินอยู่ (มีแถวใหม่มาเรื่อย ๆ) และยังไม่ชนเพดานรวม
  const stillWaiting = pending && elapsed < MAX_MS && (rowsLoading ? sinceProgress < STALL_MS : elapsed < STALL_MS)
  // one number for the whole load: this yard's rows (have / total) — held at 99%
  // while the yard-plan cars are still arriving, so 100% means everything is in
  const shownTotal = total != null ? Math.max(total, have) : null
  const rowsPct = !rowsLoading ? 100 : shownTotal ? Math.min(100, Math.floor((have / shownTotal) * 100)) : 0
  const pct = unitsLoading ? Math.min(rowsPct, 99) : rowsPct
  // นับแถวในคลาวด์ไม่ได้แต่กำลังดึงอยู่: ไม่รู้เป้าหมาย → ไม่แสดงเปอร์เซ็นต์ (เดิมค้าง "0%") โชว์จำนวนแถวที่ได้แล้วแทน
  const unknownTotal = rowsLoading && shownTotal == null
  const loadingLabel = unknownTotal ? `Loading… ${have.toLocaleString('en-US')} แถว` : `Loading ${pct}%`
  void unitsHere

  if (mode === 'overlay' && stillWaiting) {
    return (
      <div className="logo-loader-overlay" data-testid="site-load-gate">
        <LogoLoader width={230} />
        <div style={{ width: 260 }}>
          <div className="track"><div className={`fill${unknownTotal ? ' animate-pulse' : ''}`} style={{ width: unknownTotal ? '40%' : `${pct}%` }} /></div>
        </div>
        <div className="text-[13px] font-semibold tabular" style={{ color: '#6b7a99', letterSpacing: 0.4 }}>
          {loadingLabel}
        </div>
      </div>
    )
  }

  // แถบเล็ก: มือถือ (ไม่บล็อก) · หรือจอแอดมินหลังปล่อยหน้าเปิดทั้งที่ยังโหลดไม่ครบ
  const offlineFresh = status === 'offline' && elapsed < OFFLINE_BANNER_MS
  if (!pending && !offlineFresh) return null
  const text = status === 'offline'
    ? `ใช้ข้อมูลในเครื่องไปก่อน · ยังตรวจข้อมูลล่าสุดจากคลาวด์ไม่สำเร็จ (${siteName})`
    : loadingLabel
  return (
    <div data-testid="site-load-banner"
      className="fixed left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-[12px] font-semibold tabular shadow-md flex items-center gap-2"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 8px)', zIndex: 9000, background: status === 'offline' ? '#fff7ed' : '#eef4ff', color: status === 'offline' ? '#c2410c' : '#1d4ed8', border: '1px solid rgba(0,0,0,0.06)' }}>
      {status !== 'offline' && <span className="animate-pulse">●</span>}
      {text}
    </div>
  )
}
