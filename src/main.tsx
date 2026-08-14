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
  },
  onNeedRefresh() { showUpdateBanner() },
})

function showUpdateBanner() {
  if (document.getElementById('sw-update-banner')) return
  const bar = document.createElement('div')
  bar.id = 'sw-update-banner'
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:16px;z-index:100000;display:flex;align-items:center;gap:12px;padding:12px 16px;background:#0f172a;color:#fff;border-radius:16px;box-shadow:0 10px 32px -8px rgba(0,0,0,.4);font-family:inherit;font-size:14px'
  bar.innerHTML = '<span style="flex:1">🚀 มีเวอร์ชันใหม่พร้อมใช้งาน</span>'
  const btn = document.createElement('button')
  btn.textContent = 'อัปเดตเลย'
  btn.style.cssText = 'padding:8px 16px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;font-size:13.5px;cursor:pointer'
  btn.onclick = () => { btn.textContent = 'กำลังอัปเดต…'; btn.disabled = true; updateSW(true) }
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
