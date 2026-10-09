/**
 * Quota-safe localStorage for zustand persist. The default storage calls
 * localStorage.setItem synchronously inside set(): once the origin's quota is
 * full (Safari: ~5 MB, shared by every key), the QuotaExceededError throws
 * straight through the calling action — the Grouping "Create Sequence" click
 * died exactly this way. The cloud owns all of this data; the local snapshot
 * is only a boot cache, so a failed write must never break the action itself.
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware'

let warnedOnce = false

// รวมการเขียนที่ถี่: persist เรียก setItem ทุกครั้งที่ set() และเดิม JSON.stringify + localStorage.setItem ทั้งก้อนทุกครั้ง —
// โปรไฟล์หน้าแรกหลัง login (โน้ตบุ๊ก): ~860ms (≈19%) ไปกับสองอย่างนี้ เพราะตอน login/โหลดข้อมูลมี set() ต่อเนื่องเป็นร้อยครั้ง
// ตอนนี้เก็บ "ค่าล่าสุด" ต่อคีย์แล้วเขียนครั้งเดียวหลังเงียบ PERSIST_DEBOUNCE_MS (stringify ตอนเขียนจริง ไม่ใช่ทุก set)
// และเขียนทันทีเมื่อแท็บถูกซ่อน/ปิด (visibilitychange, pagehide) เพื่อไม่ให้งานค้างที่เพิ่งเกิดหาย
// getItem ใช้ตอนเริ่มระบบเท่านั้น จึงไม่ต้องรู้เรื่องค่าที่รอเขียน
const PERSIST_DEBOUNCE_MS = 400
const pending = new Map<string, { value: unknown; onQuotaError?: () => void }>()
let timer: ReturnType<typeof setTimeout> | null = null

function writeNow(name: string, value: unknown, onQuotaError?: () => void) {
  try {
    localStorage.setItem(name, JSON.stringify(value))
  } catch (e) {
    console.error('[persist] setItem failed', name, e)
    if (!warnedOnce) {
      warnedOnce = true
      try { onQuotaError?.() } catch { /* toast is best-effort */ }
    }
  }
}
export function flushPersistNow() {
  if (timer) { clearTimeout(timer); timer = null }
  for (const [name, p] of pending) writeNow(name, p.value, p.onQuotaError)
  pending.clear()
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPersistNow() })
  window.addEventListener('pagehide', flushPersistNow)
}

export function quotaSafeStorage<S>(onQuotaError?: () => void): PersistStorage<S> {
  return {
    getItem: (name) => {
      const str = localStorage.getItem(name)
      return str ? (JSON.parse(str) as StorageValue<S>) : null
    },
    setItem: (name, value) => {
      pending.set(name, { value, onQuotaError })
      if (!timer) timer = setTimeout(flushPersistNow, PERSIST_DEBOUNCE_MS)
    },
    removeItem: (name) => { pending.delete(name); localStorage.removeItem(name) },
  }
}
