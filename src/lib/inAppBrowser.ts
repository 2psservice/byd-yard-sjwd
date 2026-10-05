/** เบราว์เซอร์ในตัวของ LINE / Facebook / Instagram — ไม่ยอมให้เว็บใช้กล้อง (ปฏิเสธทันทีโดยไม่ถาม)
 *  คนหน้างานมักกดลิงก์จากกลุ่ม LINE แล้วเจอหน้านี้ */
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : ''
export const IN_APP_BROWSER = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram/i.test(UA)
export const IS_LINE_BROWSER = /\bLine\//i.test(UA)

/** ออกจากเบราว์เซอร์ในตัว LINE → Chrome: LINE รองรับ ?openExternalBrowser=1 (ต่อท้ายลิงก์แล้วเปิดนอกแอป) */
export function openExternal() {
  const u = new URL(location.href)
  u.searchParams.set('openExternalBrowser', '1')
  location.href = u.toString()
}

export const IS_ANDROID = /Android/i.test(UA)

/** เปิด Chrome ด้วย Android intent — ใช้ได้กับเบราว์เซอร์ฝังตัวที่ไม่มี openExternalBrowser (Facebook/Instagram ฯลฯ)
 *  ไม่มี Chrome ในเครื่อง → browser_fallback_url พากลับมาหน้าเดิม (ไม่พัง แต่ก็ไม่เปิด Chrome) */
export function openChromeIntent() {
  const u = new URL(location.href)
  u.hash = ''
  const scheme = u.protocol.replace(':', '')
  location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${scheme};package=com.android.chrome;`
    + `S.browser_fallback_url=${encodeURIComponent(u.toString())};end`
}

const REDIRECT_KEY = 'inapp-redirect-tried'

/**
 * เรียกครั้งเดียวตอนเริ่มแอป (main.tsx) ก่อนวาดอะไร — เปิดในเบราว์เซอร์ของ LINE/โซเชียล
 * → เด้งไป Chrome ทันที ผู้ใช้จะได้เริ่มงาน (login → สแกน) ใน Chrome ตั้งแต่ต้น ไม่ใช่ทำไป
 * ครึ่งทางแล้วค่อยเจอว่ากล้องใช้ไม่ได้
 *  - LINE → ?openExternalBrowser=1 · เบราว์เซอร์ฝังตัวอื่นบน Android → intent:// ของ Chrome
 *  - ลองครั้งเดียวต่อเซสชัน: เด้งไม่สำเร็จ (กลับมาหน้าเดิม) จะไม่วนซ้ำ แต่ยังเห็นแถบเตือน
 *    InAppBrowserBanner ที่มีปุ่มให้กดเองเป็นทางสำรอง
 * ฝั่ง Chrome: ลบ openExternalBrowser ออกจาก URL ให้ลิงก์สะอาด (บุ๊กมาร์ก/แชร์ต่อไม่ติดไปด้วย)
 */
export function escapeInAppBrowser() {
  if (!IN_APP_BROWSER) {
    try {
      const u = new URL(location.href)
      if (u.searchParams.has('openExternalBrowser')) {
        u.searchParams.delete('openExternalBrowser')
        history.replaceState(history.state, '', u.toString())
      }
    } catch { /* ไม่สำคัญ */ }
    return
  }
  try {
    if (sessionStorage.getItem(REDIRECT_KEY) === '1') return
    sessionStorage.setItem(REDIRECT_KEY, '1')
  } catch { return } // จำไม่ได้ว่าลองแล้ว → ไม่เด้งเอง (กันวนไม่รู้จบ) ใช้แถบเตือนแทน
  if (IS_LINE_BROWSER) openExternal()
  else if (IS_ANDROID) openChromeIntent()
}

/** คัดลอกลิงก์ของเว็บ — คืน true ถ้าคัดลอกได้ ไม่ได้ (clipboard ถูกบล็อก) ให้เด้งช่องให้คัดลอกเอง */
export async function copyLink(): Promise<boolean> {
  const link = location.origin + location.pathname
  try { await navigator.clipboard.writeText(link); return true }
  catch { window.prompt('คัดลอกลิงก์นี้ไปวางใน Chrome', link); return false }
}
