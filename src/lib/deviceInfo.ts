/**
 * เครื่องนี้คืออะไร — 12–13 พ.ย. handheld ทุกเครื่องค้างตอนเปิดแอป/เปลี่ยนหน้า แต่ระบบแยก handheld ออกจากมือถือไม่ได้
 * (Chrome Android ส่ง UA "Android 10; K" เหมือนกันทุกเครื่อง) จึงรายงานรุ่นจริง (Client Hints) + RAM + เวลาโหลดแต่ละช่วง
 * วันละครั้งต่อเครื่องไปที่ client_build_log (tbl='device') — ไม่มีข้อมูลส่วนตัว
 */

type Nav = Navigator & {
  deviceMemory?: number
  userAgentData?: { mobile?: boolean; platform?: string; getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>> }
}
const nav = (): Nav | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as Nav))

/** RAM ของเครื่อง (GB, ค่าปัดของเบราว์เซอร์ 0.25…8) · ไม่รู้ = null (Safari/Firefox) */
export function deviceMemoryGb(n: Nav | undefined = nav()): number | null {
  const m = n?.deviceMemory
  return typeof m === 'number' && m > 0 ? m : null
}

/** เกณฑ์ "เครื่อง RAM น้อย" — 4 GB ลงไป (handheld ส่วนใหญ่ 2–4 GB) · ไม่รู้ RAM = ไม่ใช่ (iPhone/คอม ทำงานแบบเดิม) */
export const LOW_MEM_GB = 4
export function isLowMemDevice(n: Nav | undefined = nav()): boolean {
  const m = deviceMemoryGb(n)
  return m != null && m <= LOW_MEM_GB
}

const WEDGE_KEY = 'sjwd-wedge-seen'
/** เครื่องนี้เคยรับ VIN จากปุ่มยิงบาร์โค้ด (พิมพ์รัว + Enter) — ป้ายบอกว่าเป็น handheld */
export function markWedgeScan(): void { try { if (!localStorage.getItem(WEDGE_KEY)) localStorage.setItem(WEDGE_KEY, String(Date.now())) } catch { /* no storage */ } }
export function wedgeSeen(): boolean { try { return !!localStorage.getItem(WEDGE_KEY) } catch { return false } }

export interface DeviceInfo {
  model: string
  platform: string
  osVersion: string
  mem: number | null
  cores: number | null
  screen: string
  dpr: number
  wedge: boolean
  lowMem: boolean
}

/** อ่านข้อมูลเครื่อง — ไม่มี Client Hints (iPhone/Firefox) = ช่องว่าง ไม่โยน error */
export async function readDeviceInfo(n: Nav | undefined = nav()): Promise<DeviceInfo> {
  let model = ''
  let osVersion = ''
  try {
    const h = await n?.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion'])
    model = typeof h?.model === 'string' ? h.model : ''
    osVersion = typeof h?.platformVersion === 'string' ? h.platformVersion : ''
  } catch { /* hints refused */ }
  const sc = typeof screen === 'undefined' ? null : screen
  return {
    model,
    platform: n?.userAgentData?.platform ?? '',
    osVersion,
    mem: deviceMemoryGb(n),
    cores: typeof n?.hardwareConcurrency === 'number' ? n.hardwareConcurrency : null,
    screen: sc ? `${sc.width}x${sc.height}` : '',
    dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
    wedge: wedgeSeen(),
    lowMem: isLowMemDevice(n),
  }
}

const REPORT_KEY = 'sjwd-device-report'
/** ส่งรายงานชนิดนี้ไปแล้ววันนี้หรือยัง (ตามวันที่เครื่อง) · จดเฉพาะหลังส่งสำเร็จ (markDailyReport) — ออฟไลน์ตอนเปิดแอปจะได้ส่งรอบถัดไป */
type Store = Pick<Storage, 'getItem' | 'setItem'> | null
const ls = (): Store => { try { return localStorage } catch { return null } }
export function dailyReportDue(kind: string, today: string, storage: Store = ls()): boolean {
  try { return !!storage && storage.getItem(`${REPORT_KEY}-${kind}`) !== today } catch { return false }
}
export function markDailyReport(kind: string, today: string, storage: Store = ls()): void {
  try { storage?.setItem(`${REPORT_KEY}-${kind}`, today) } catch { /* full */ }
}

/** ไทม์ไลน์โหลดแบบย่อ ให้ JSON ทั้งก้อนไม่เกินช่อง op (1,500 ตัวอักษร) — ตัดชื่อยาว เก็บ 20 จุดแรก */
export function compactMarks(marks: { name: string; ms: number }[], max = 20): string[] {
  return marks.slice(0, max).map((m) => `${m.name.slice(0, 24)}@${m.ms}`)
}

/**
 * ซิงก์แถวรถรอบนี้ต้องดึงทั้งบริษัท (full ~66k แถว/~114 MB) หรือดึงเฉพาะที่เปลี่ยน
 * เครื่อง RAM น้อย: ไม่ดึงทั้งบริษัทเพียงเพราะ "ห่างรอบก่อนเกิน 6 ชม." หรือรอบล้างประวัติระบบ — ตัวนี้แหละที่ทำ handheld ค้างทุกเช้า
 * (การดึงเฉพาะที่เปลี่ยนตั้งแต่ lastSync ครอบทุกการแก้อยู่แล้ว · ตัวตรวจ "แถวในเครื่องขาด > 20" ใน syncCloud ยังบังคับ full ได้เหมือนเดิม)
 */
export function chooseSyncMode(i: { lastSync: number; hasLocal: boolean; now: number; purged: boolean; lowMem: boolean }): 'full' | 'incremental' {
  if (!(i.lastSync > 0) || !i.hasLocal) return 'full'
  if (i.lowMem) return 'incremental'
  const stale = i.now - i.lastSync > 6 * 3600_000
  return stale || !i.purged ? 'full' : 'incremental'
}

/** งานที่ทำให้จอค้าง (> 50 ms ต่อชิ้น, Chrome เท่านั้น) — นับรวมตั้งแต่เปิดหน้า: จำนวน · รวม ms · ชิ้นยาวสุด */
const longTasks = { n: 0, total: 0, max: 0 }
try {
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks.n++; longTasks.total += e.duration; longTasks.max = Math.max(longTasks.max, e.duration) }
    }).observe({ type: 'longtask', buffered: true })
  }
} catch { /* unsupported */ }
export const getLongTasks = () => ({ n: longTasks.n, total: Math.round(longTasks.total), max: Math.round(longTasks.max) })

/**
 * ฟังปุ่มยิงบาร์โค้ด (keyboard-wedge) ทั้งแอป — ≥ 8 ตัวอักษรที่ห่างกัน < 60 ms แล้วตามด้วย Enter = เครื่องยิง ไม่ใช่คนพิมพ์
 * (คีย์บอร์ดบนจอ Android ส่ง key 'Unidentified' จึงไม่นับ) · แค่จดว่าเคยเห็น ไม่แตะการยิง
 */
export function isWedgeBurst(gapsMs: number[], chars: number): boolean {
  return chars >= 8 && gapsMs.length >= 7 && gapsMs.every((g) => g < 60)
}
let wedgeWatching = false
export function startWedgeWatch(): void {
  if (wedgeWatching || typeof document === 'undefined' || wedgeSeen()) return
  wedgeWatching = true
  let last = 0
  let chars = 0
  let gaps: number[] = []
  const onKey = (e: KeyboardEvent) => {
    const now = Date.now()
    if (/^[a-zA-Z0-9]$/.test(e.key)) {
      if (chars > 0 && now - last >= 60) { chars = 0; gaps = [] } // คนพิมพ์ — เริ่มนับใหม่
      if (chars > 0) gaps.push(now - last)
      if (gaps.length > 30) gaps = gaps.slice(-30)
      chars++
      last = now
    } else if (e.key === 'Enter') {
      if (isWedgeBurst(gaps.slice(-(chars - 1)), chars) && now - last < 200) {
        markWedgeScan()
        document.removeEventListener('keydown', onKey, true)
        return
      }
      chars = 0; gaps = []
    } else { chars = 0; gaps = [] }
  }
  document.addEventListener('keydown', onKey, true)
}
