import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // build stamp shown in the UI so stale service-worker builds are identifiable
  define: { __BUILD__: JSON.stringify(new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt': a new deploy must NOT hard-reload every open device mid-work
      // (it wiped in-progress PDI checklists / defect forms within 60s of every
      // push). main.tsx shows an "อัปเดต" banner instead; the user applies it.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['apple-touch-icon.png', '2ps-logo.png', 'front.png', 'side.png', 'car-top.png', 'wrench.png'],
      manifest: {
        name: 'SJWD Yard Control',
        short_name: 'SJYMS',
        description: 'ระบบบริหารลานจอดรถ SJWD — Automotive Yard Management System',
        lang: 'th',
        theme_color: '#1B4FA8',
        background_color: '#f0f4fb',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // prompt-mode update: the waiting SW activates only when the user taps
        // the update banner (updateSW → SKIP_WAITING) — no mid-work reloads
        skipWaiting: false,
        clientsClaim: true,
        // precache the app shell (JS/CSS/HTML/fonts/images) → instant cold loads.
        // Skip the lazily-imported Excel engines (~1.4 MB) — they're admin
        // import/export features a field phone never runs; fetched on demand.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        globIgnores: ['**/exceljs*', '**/xlsx-*'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: '/index.html',
        // never cache the Supabase API/realtime — data must stay live
        navigateFallbackDenylist: [/^\/rest\//, /^\/realtime\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
          {
            // damage photos on R2 (immutable keys) — cache so previously viewed
            // photos still show offline, like the old inline data-URLs did
            urlPattern: /\/api\/photos\/.+/,
            handler: 'CacheFirst',
            options: { cacheName: 'damage-photos', expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 90 } },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, host: true },
})
