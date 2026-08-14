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
let swRegistration: ServiceWorkerRegistration | null = null
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    swRegistration = registration
    setInterval(() => registration.update(), 60_000)
  },
  onNeedRefresh() { showUpdateBanner() },
})

// The actual "run the new build" step, shared by the banner's button AND the
// idle/hidden safety net below — a device stuck on an old bundle keeps
// running whatever sync logic shipped that day forever, no matter how many
// fixes land afterward, until SOMETHING reloads it.
let applying = false
function applyUpdate() {
  if (applying) return
  applying = true
  let done = false
  const reload = () => { if (done) return; done = true; window.location.reload() }
  // whichever happens first: the new worker taking over, or 1.5s
  navigator.serviceWorker?.addEventListener('controllerchange', reload, { once: true })
  setTimeout(reload, 1500)
  try {
    swRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' })
    void Promise.resolve(updateSW(true)).catch(() => reload())
  } catch { reload() }
}

function showUpdateBanner() {
  // a yard tablet left open for days on a stale build never gets any of the
  // sync/reconcile fixes shipped after it booted — that alone can be why one
  // screen's In Yard number never matches the others no matter what the
  // backend does. "ไว้ก่อน" only hides the banner; it does not cancel this —
  // the update applies on its own the next moment nothing is being typed
  // (tab hidden, or 5 min idle), so no device is stuck on old code forever.
  scheduleAutoApply()

  if (document.getElementById('sw-update-banner')) return
  const bar = document.createElement('div')
  bar.id = 'sw-update-banner'
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:16px;z-index:100000;display:flex;align-items:center;gap:12px;padding:12px 16px;background:#0f172a;color:#fff;border-radius:16px;box-shadow:0 10px 32px -8px rgba(0,0,0,.4);font-family:inherit;font-size:14px'
  bar.innerHTML = '<span style="flex:1">🚀 มีเวอร์ชันใหม่พร้อมใช้งาน</span>'
  const btn = document.createElement('button')
  btn.textContent = 'อัปเดตเลย'
  btn.style.cssText = 'padding:8px 16px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;font-size:13.5px;cursor:pointer'
  // "อัปเดตเลย" reloads the page HERE rather than trusting the plugin's own
  // reload: the worker is built with skipWaiting + clientsClaim, so by the time
  // this banner appears the new build has usually activated already — there is
  // no "waiting" worker left to message and no controllerchange left to fire,
  // and the button sat on "กำลังอัปเดต…" forever. Reloading is all that is
  // actually needed to run the new build.
  btn.onclick = () => { btn.textContent = 'กำลังอัปเดต…'; btn.disabled = true; applyUpdate() }
  const later = document.createElement('button')
  later.textContent = 'ไว้ก่อน'
  later.style.cssText = 'padding:8px 12px;border:none;border-radius:10px;background:rgba(255,255,255,.14);color:#fff;font-size:13px;cursor:pointer'
  later.onclick = () => bar.remove()
  bar.append(btn, later)
  document.body.appendChild(bar)
}

let autoApplyArmed = false
function scheduleAutoApply() {
  if (autoApplyArmed) return
  autoApplyArmed = true
  const IDLE_MS = 5 * 60_000
  let idleTimer: ReturnType<typeof setTimeout>
  const cleanup = () => {
    document.removeEventListener('visibilitychange', onHidden)
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.removeEventListener(ev, bump)
    clearTimeout(idleTimer)
  }
  const fire = () => { cleanup(); applyUpdate() }
  // safest moment: the tab isn't being looked at right now (screen locked,
  // operator switched apps) — nothing on screen can be interrupted
  const onHidden = () => { if (document.visibilityState === 'hidden') fire() }
  // fallback for a screen that never goes hidden (a wall-mounted tablet with
  // the display always on): apply once nobody has touched it for a while
  const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(fire, IDLE_MS) }
  bump()
  document.addEventListener('visibilitychange', onHidden)
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, bump, { passive: true })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
