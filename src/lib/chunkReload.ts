/**
 * โหลดไฟล์หน้า (chunk) ไม่ได้ → รีโหลดเองครั้งเดียว
 *
 * หลัง deploy ใหม่ เครื่องที่เปิดแอปค้างไว้ยังถือ index เก่าที่ชี้ไฟล์หน้า (เช่น YardOps-xxxx.js) ชุดเดิม หรือโหลดกลางจังหวะที่
 * ไฟล์ชุดใหม่กำลังขึ้น / สัญญาณสะดุด → "Failed to fetch dynamically imported module" แล้วหน้างานติดจอ "เกิดข้อผิดพลาดในหน้านี้"
 * (16 ต.ค. 10:50 deploy กลางกะ) — รีโหลดหนึ่งครั้งได้ไฟล์ชุดล่าสุดเสมอ และไม่มีงานค้างให้หาย เพราะหน้ายังเปิดไม่ขึ้น
 * กันวน: รีโหลดเองได้ไม่เกินหนึ่งครั้งต่อ CHUNK_RELOAD_WINDOW_MS (จำใน sessionStorage ข้ามการรีโหลดในแท็บเดียวกัน)
 */
export const CHUNK_RELOAD_KEY = 'sjwd-chunk-reload-at'
export const CHUNK_RELOAD_WINDOW_MS = 30_000

// "is not a valid JavaScript MIME type" = Safari ขอไฟล์หน้าของ build เก่าที่ไม่มีแล้ว เซิร์ฟเวอร์ตอบ index.html แทน (30 ต.ค. 21:46 iPhone หลัง deploy)
const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|is not a valid JavaScript MIME type/i

/** ข้อผิดพลาดนี้มาจากโหลดไฟล์หน้าไม่ได้ (ไม่ใช่บั๊กในหน้า) */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return CHUNK_ERROR_RE.test(msg)
}

/** รีโหลดได้ไหม — ไม่เคยรีโหลดเอง หรือรีโหลดครั้งก่อนนานกว่า window แล้ว (เวลาเครื่องย้อน = ไม่เสี่ยงวน → ไม่รีโหลด) */
export function shouldReloadForChunk(now: number, lastAt: number | null): boolean {
  if (lastAt == null) return true
  const since = now - lastAt
  return since >= 0 && since > CHUNK_RELOAD_WINDOW_MS
}

let pending = false
/** สั่งรีโหลดไปแล้วในหน้านี้ (ErrorBoundary ใช้แสดง "กำลังโหลด…" แทนหน้า error) */
export const isChunkReloadPending = () => pending

function readLast(): number | null {
  try {
    const v = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

/** รีโหลดเองถ้ายังไม่ได้รีโหลดภายใน window — คืน true เมื่อสั่งรีโหลด (หรือสั่งไปแล้วในหน้านี้) */
export function reloadForChunkError(now = Date.now(), reload: () => void = () => window.location.reload()): boolean {
  if (pending) return true
  if (!shouldReloadForChunk(now, readLast())) return false
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now)) } catch { return false } // จำไม่ได้ = เสี่ยงวน → ไม่รีโหลดเอง
  pending = true
  reload()
  return true
}

/** สำหรับเทสต์ */
export function _resetChunkReload(): void { pending = false }
