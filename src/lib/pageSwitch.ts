/**
 * เปลี่ยนหน้าแบบ "หน้าเดิมออกก่อน" (หน้าแอดมิน) — แบบเว็บ AMS ในคลิปของแอดมิน
 *
 * view ใน store เปลี่ยนทันทีที่กดเมนู (เมนูซ้ายเปลี่ยนแถบที่เลือกทันที) แต่หน้าที่แสดง (`shown`) รอให้
 * หน้าเดิมจางออกก่อน PAGE_OUT_MS แล้วค่อยสลับ หน้าใหม่จางเข้าด้วย .page-in ตามเดิม
 * ระหว่างจางออกเริ่มโหลดไฟล์ของหน้าใหม่ไว้ก่อน (prefetch) — พอถึงเวลาสลับ ไฟล์มักอยู่ในเครื่องแล้ว
 * ไม่ต้องขึ้นโลโก้โหลดเต็มจอ
 * `busy` = ตั้งแต่กดจนหน้าใหม่ขึ้นจริง (onReady จากหน้าใหม่) — แถบโหลดด้านบน (NavProgress) วิ่งตามนี้
 * กดหลายเมนูติดกัน: นับเวลาใหม่จากครั้งล่าสุด แสดงหน้าสุดท้ายที่กด · กดกลับหน้าเดิมระหว่างจางออก = ยกเลิก
 * เครื่องที่ตั้งลดการเคลื่อนไหว: สลับทันทีเหมือนเดิม
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export const PAGE_OUT_MS = 150

const reduceMotion = () => {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false } catch { return false }
}

export function usePageSwitch<V extends string>(view: V, prefetch?: (v: V) => void) {
  const [shown, setShown] = useState(view)
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shownRef = useRef(shown)
  shownRef.current = shown

  useEffect(() => {
    clearTimeout(timer.current)
    if (view === shownRef.current) { setLeaving(false); setBusy(false); return }
    setBusy(true)
    try { prefetch?.(view) } catch { /* the page's own lazy load retries */ }
    if (reduceMotion()) { setShown(view); setLeaving(false); return }
    setLeaving(true)
    timer.current = setTimeout(() => { setShown(view); setLeaving(false) }, PAGE_OUT_MS)
    return () => clearTimeout(timer.current)
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  /** หน้าใหม่ขึ้นแล้ว (ไฟล์โหลดเสร็จและแสดงผลแล้ว) — แถบโหลดวิ่งจนเต็มแล้วจางหาย */
  const onReady = useCallback(() => setBusy(false), [])
  return { shown, leaving, busy, onReady }
}
