/**
 * รายงาน "เครื่องนี้รันแอปเวอร์ชันไหน" ขึ้นคลาวด์ (ตาราง app_heartbeats) — เพื่อรู้ว่าเครื่องไหนยังไม่อัปเดต
 *
 * 15–16 ต.ค. เครื่องที่ยังเป็นแอปรุ่นเก่า (ล็อกอิน "นางสาว จตุพร วงศ์คำภู") ล้างตำแหน่ง/ย้ายรถข้ามยาร์ดไปหลายร้อยคัน และหลังสลับไป
 * yard_units เครื่องเก่าจะ "ยิงแล้วไม่ขึ้น" เงียบ ๆ — ไม่มีทางรู้จากฐานข้อมูลว่าเครื่องไหนเป็นเวอร์ชันไหน ต้องรอให้คนถ่ายภาพเลข build ส่งมา
 * ตอนนี้แต่ละเครื่องจดตัวเองไว้: รหัสเครื่อง (สุ่มครั้งแรก เก็บใน localStorage), ชื่อผู้ใช้, build, ยาร์ด, ชนิดเบราว์เซอร์, เวลาล่าสุด
 * ไม่บล็อกงาน: เขียนล้ม/ยังไม่มีตาราง = เงียบ · เขียนไม่เกินหนึ่งครั้งต่อ HEARTBEAT_MIN_INTERVAL_MS เว้นแต่ผู้ใช้/ยาร์ดเปลี่ยน
 */
export const HEARTBEAT_MIN_INTERVAL_MS = 15 * 60_000
const DEVICE_KEY = 'sjwd-device-id'

export interface HeartbeatRow {
  device_id: string
  user_id: string | null
  user_name: string | null
  site_id: string | null
  build: string
  user_agent: string
  standalone: boolean
}

/** รหัสเครื่อง — สุ่มครั้งแรกแล้วจำไว้ (ล้างข้อมูลเว็บ = ได้รหัสใหม่ ซึ่งก็คือ "เครื่องที่ล้างแล้ว") */
export function deviceId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string {
  try {
    const cur = storage?.getItem(DEVICE_KEY)
    if (cur) return cur
    const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
    storage?.setItem(DEVICE_KEY, id)
    return id
  } catch {
    return 'no-storage'
  }
}
function safeStorage(): Storage | null { try { return localStorage } catch { return null } }

export function buildHeartbeat(i: { deviceId: string; userId: string | null; userName: string | null; siteId: string | null; build: string; userAgent: string; standalone: boolean }): HeartbeatRow {
  return {
    device_id: i.deviceId, user_id: i.userId, user_name: i.userName, site_id: i.siteId,
    build: i.build, user_agent: i.userAgent.slice(0, 300), standalone: i.standalone,
  }
}

/** ควรส่งไหม — ครั้งแรก / ผู้ใช้หรือยาร์ดเปลี่ยน / ห่างจากครั้งก่อนเกิน interval (เวลาเครื่องย้อน = ส่ง) */
export function shouldSendHeartbeat(now: number, last: { at: number; key: string } | null, key: string): boolean {
  if (!last || last.key !== key) return true
  const since = now - last.at
  return since < 0 || since >= HEARTBEAT_MIN_INTERVAL_MS
}
