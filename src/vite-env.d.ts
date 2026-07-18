/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Build timestamp injected by vite.config `define` — shown in the UI to spot stale service-worker builds. */
declare const __BUILD__: string
