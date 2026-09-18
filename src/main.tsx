import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
// self-hosted fonts (bundled + precached by the PWA) — replaces the Google
// Fonts stylesheet that render-blocked the first paint for 10s+ whenever the
// yard network was slow or the CDN unreachable
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/ibm-plex-sans-thai/300.css'
import '@fontsource/ibm-plex-sans-thai/400.css'
import '@fontsource/ibm-plex-sans-thai/500.css'
import '@fontsource/ibm-plex-sans-thai/600.css'
import '@fontsource/ibm-plex-sans-thai/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// PWA update flow: poll for a new deploy every 60s, but NEVER force-reload an
// open session (the old auto-reload wiped in-progress checklists/forms within
// a minute of every push). Instead show a small banner; the operator applies
// the update when they're between tasks.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    setInterval(() => registration.update(), 60_000)
    // หน้างานสลับแอปบ่อย (LINE ↔ แอปนี้) — ตอนกลับมาให้เช็กเวอร์ชันใหม่ทันที
    // ไม่ต้องรอรอบ 60 วิ ซึ่งเบราว์เซอร์มักหน่วงไว้ตอนแท็บอยู่เบื้องหลัง
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {})
    })
  },
  onNeedRefresh() { showUpdateBanner() },
})

// กด "อัปเดตเลย" แล้วต้องได้ของใหม่จริง ไม่ใช่ค้าง "กำลังอัปเดต…" ตลอดไป —
// ที่หน้างานเจอ: เราปล่อยหลายรอบต่อวัน service worker ตัวที่ "รอ" ตอนแถบขึ้น
// ถูกแทนด้วยตัวใหม่กว่าไปแล้ว ข้อความ SKIP_WAITING จากทางปกติจึงส่งไปหาตัวที่
// ตายแล้ว ไม่มีอะไรเกิดขึ้น เครื่องนั้นเลยค้างอยู่ที่บิลด์เก่าเป็นวัน (และทุก
// แพตช์กล้องหลังจากนั้นไม่เคยไปถึงเครื่องเลย) — จึงยิงซ้ำหาตัวที่รออยู่ "ตอนนี้"
// และถ้า 5 วิแล้วยังไม่รีโหลด ก็ล้างแคช ถอด SW แล้วโหลดใหม่จากเซิร์ฟเวอร์ตรงๆ
async function applyUpdate(btn: HTMLButtonElement) {
  btn.textContent = 'กำลังอัปเดต…'; btn.disabled = true
  let reloading = false
  const reload = () => { if (reloading) return; reloading = true; window.location.reload() }
  navigator.serviceWorker?.addEventListener('controllerchange', reload, { once: true })
  updateSW(true) // ทางปกติของ workbox
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    await reg?.update().catch(() => {})
    reg?.waiting?.postMessage({ type: 'SKIP_WAITING' })
  } catch { /* ไปทางสุดท้าย */ }
  setTimeout(async () => {
    if (reloading) return
    btn.textContent = 'โหลดใหม่ทั้งหมด…'
    try {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    } catch { /* ยังไงก็รีโหลด */ }
    reload()
  }, 5000)
}

function showUpdateBanner() {
  if (document.getElementById('sw-update-banner')) return
  const bar = document.createElement('div')
  bar.id = 'sw-update-banner'
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:16px;z-index:100000;display:flex;align-items:center;gap:12px;padding:12px 16px;background:#0f172a;color:#fff;border-radius:16px;box-shadow:0 10px 32px -8px rgba(0,0,0,.4);font-family:inherit;font-size:14px'
  // บอกด้วยว่าเครื่องนี้อยู่บิลด์ไหน — คนหน้างานถ่ายจอส่งมาจะได้รู้ทันที
  bar.innerHTML = `<span style="flex:1">🚀 มีเวอร์ชันใหม่พร้อมใช้งาน<br><span style="font-size:11px;opacity:.6;font-family:monospace">เครื่องนี้: build ${__BUILD__}</span></span>`
  const btn = document.createElement('button')
  btn.textContent = 'อัปเดตเลย'
  btn.style.cssText = 'padding:8px 16px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;font-size:13.5px;cursor:pointer'
  btn.onclick = () => { void applyUpdate(btn) }
  const later = document.createElement('button')
  later.textContent = 'ไว้ก่อน'
  later.style.cssText = 'padding:8px 12px;border:none;border-radius:10px;background:rgba(255,255,255,.14);color:#fff;font-size:13px;cursor:pointer'
  later.onclick = () => bar.remove()
  bar.append(btn, later)
  document.body.appendChild(bar)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
