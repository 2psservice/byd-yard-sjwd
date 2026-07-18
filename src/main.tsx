import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'

// PWA devices (phones left open for hours/days) can silently keep running an
// old JS bundle — the previous "autoUpdate" setup only swapped the cached
// service worker in the background and never reloaded the open tab, so a
// mobile session could run stale code (missing recent sync fixes) indefinitely
// while a desktop tab that gets refreshed more often stayed current. Poll for
// a new deploy every 60s and force-reload as soon as one is found.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    setInterval(() => registration.update(), 60_000)
  },
  onNeedRefresh() { updateSW(true) },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
