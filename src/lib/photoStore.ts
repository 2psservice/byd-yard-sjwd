/**
 * Damage-photo storage: upload a captured photo to Cloudflare R2 (via the
 * /api/photos Pages Function) and keep only the short URL in the database,
 * instead of embedding the whole image as a base64 data-URL.
 *
 * Fail-open by design: if the R2 binding isn't configured yet (501), the
 * device is offline, or the upload times out, the original data-URL is
 * returned unchanged — the app then behaves exactly as before the migration.
 */

const UPLOAD_URL = '/api/photos/upload'
const TIMEOUT_MS = 15_000

export async function storePhoto(dataUrl: string): Promise<string> {
  // already a URL (re-edit of an uploaded photo) → nothing to do
  if (!dataUrl.startsWith('data:')) return dataUrl
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      body: blob,
      headers: { 'content-type': blob.type || 'image/jpeg' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return dataUrl // 501 = R2 not set up yet, 4xx/5xx = keep local copy
    const { url } = (await res.json()) as { url?: string }
    return url || dataUrl
  } catch {
    return dataUrl // offline / timeout → data-URL still syncs through Supabase as before
  }
}
