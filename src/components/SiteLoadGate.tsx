/**
 * หน้า loading ของ "ยาร์ดที่เลือก" — ค้างไว้จนแถวชีตและรถในผังของยาร์ดนั้นมาครบ
 * แล้วค่อยเปิดหน้าด้วยตัวเลขที่ถูกต้องทีเดียว
 *
 * ของเดิมเปิดหน้าทันทีที่อ่านแคชในเครื่องเสร็จ แล้วค่อย ๆ เติมจากคลาวด์เบื้องหลัง
 * โดยไม่บอกอะไร — Dashboard จึงขึ้น "15 In Yard" (แถวที่บังเอิญมีในแคช) ค้างอยู่
 * 1–2 นาที ก่อนเด้งเป็น 3,004 เมื่อ sync ทั้งบริษัทมาถึง ตัวเลขทุกใบในช่วงนั้นผิดหมด
 * (Gate-out 351 / Damage 0 / Pre Gate-in 0) ไม่ใช่แค่น้อย
 *
 *  · overlay (จอแอดมิน): บังทั้งหน้าพร้อมความคืบหน้า "แถวชีต 1,000 / 3,004 · รถในผัง 800"
 *  · banner (มือถือ Yard Ops): แถบเล็กด้านบน ไม่บล็อกการสแกน
 *  · ไม่ค้างตลอดไป: ถ้าไม่มีความคืบหน้าเกิน STALL_MS (เน็ตล่ม) หรือรวมเกิน MAX_MS
 *    ปล่อยหน้าเปิดด้วยของในเครื่อง พร้อมป้าย "กำลังซิงก์" แทน
 */
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
  const shownTotal = total != null ? Math.max(total, have) : null
  const pct = shownTotal ? Math.min(100, Math.round((have / shownTotal) * 100)) : null
  const rowsText = `แถวชีต ${have.toLocaleString()}${shownTotal != null ? ` / ${shownTotal.toLocaleString()}` : ''}`
  const unitsText = `รถในผัง ${unitsHere.toLocaleString()}${unitsLoading ? '…' : ''}`

  if (mode === 'overlay' && stillWaiting) {
    return (
      <div className="logo-loader-overlay" data-testid="site-load-gate">
        <LogoLoader width={230} />
        <div className="logo-loader-label">กำลังโหลดข้อมูล {siteName}</div>
        <div style={{ width: 260 }}>
          <div className="track"><div className="fill" style={{ width: `${pct ?? 15}%`, ...(pct == null ? { opacity: 0.5 } : {}) }} /></div>
          <div className="flex justify-between mt-2 text-[12px] tabular" style={{ color: '#6b7a99' }}>
            <span>{rowsText}</span>
            <span>{unitsText}</span>
          </div>
        </div>
      </div>
    )
  }

  // แถบเล็ก: มือถือ (ไม่บล็อก) · หรือจอแอดมินหลังปล่อยหน้าเปิดทั้งที่ยังโหลดไม่ครบ
  const offlineFresh = status === 'offline' && elapsed < OFFLINE_BANNER_MS
  if (!pending && !offlineFresh) return null
  const text = status === 'offline'
    ? `ใช้ข้อมูลในเครื่องไปก่อน · ยังติดต่อคลาวด์ไม่ได้ (${siteName})`
    : `กำลังโหลด ${siteName} … ${rowsText}${unitsLoading ? ` · ${unitsText}` : ''}`
  return (
    <div data-testid="site-load-banner"
      className="fixed left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-[12px] font-semibold tabular shadow-md flex items-center gap-2"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 8px)', zIndex: 9000, background: status === 'offline' ? '#fff7ed' : '#eef4ff', color: status === 'offline' ? '#c2410c' : '#1d4ed8', border: '1px solid rgba(0,0,0,0.06)' }}>
      {status !== 'offline' && <span className="animate-pulse">●</span>}
      {text}
    </div>
  )
}
