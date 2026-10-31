// Cloudflare Pages Function — damage-photo storage on R2.
//
// Routes (same origin as the app, deployed automatically with `functions/`):
//   POST /api/photos/upload   body = image blob  → stores to R2, returns { url }
//   GET  /api/photos/<key>    streams the image back (long immutable cache)
//
// One-time setup in the Cloudflare dashboard:
//   1. R2 → Create bucket:  sjwd-photos
//   2. Workers & Pages → byd-yard-sjwd → Settings → Bindings → Add →
//      R2 bucket · Variable name: PHOTOS · Bucket: sjwd-photos
//   3. Redeploy (any push to main).
//
// Until the binding exists this API answers 501 and the app silently keeps
// embedding photos as data-URLs exactly as before — nothing breaks.

interface Env {
  // ตรวจว่าผู้อัปโหลดล็อกอินอยู่ (RPC sjwd_session_ok — supabase-photo-upload-session.sql)
  // ตั้งใน Cloudflare Pages → Settings → Variables · ยังไม่ตั้ง = ไม่ตรวจ (เหมือนเดิม)
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  PHOTOS?: {
    put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
    get(key: string): Promise<{ body: ReadableStream; httpEtag?: string; httpMetadata?: { contentType?: string } } | null>
  }
}
type Ctx = { request: Request; env: Env; params: { path?: string | string[] } }

const MAX_BYTES = 2 * 1024 * 1024 // photos arrive pre-compressed at ~100-300 KB

// โทเค็นที่ตรวจผ่านแล้ว จำไว้สั้น ๆ ต่อ isolate — ถ่ายรูปรัว ๆ ไม่ต้องถามฐานข้อมูลทุกรูป
const OK_TTL_MS = 5 * 60_000
const okTokens = new Map<string, number>()

async function sessionOk(env: Env, token: string): Promise<boolean> {
  const at = okTokens.get(token)
  if (at && Date.now() - at < OK_TTL_MS) return true
  const res = await fetch(`${env.SUPABASE_URL!.replace(/\/$/, '')}/rest/v1/rpc/sjwd_session_ok`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY!, authorization: `Bearer ${env.SUPABASE_ANON_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
  })
  if (!res.ok) throw new Error(`session check ${res.status}`)
  const ok = (await res.json()) === true
  if (ok) okTokens.set(token, Date.now())
  return ok
}
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  if (!env.PHOTOS) return new Response('R2 not configured', { status: 501 })
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    const token = request.headers.get('x-sjwd-token') || ''
    let ok = false
    try { ok = !!token && await sessionOk(env, token) } catch { return new Response('session check failed', { status: 503 }) }
    if (!ok) return new Response('login required', { status: 401 })
  }
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim()
  if (!TYPES.has(ct)) return new Response('unsupported type', { status: 415 })
  const buf = await request.arrayBuffer()
  if (!buf.byteLength || buf.byteLength > MAX_BYTES) return new Response('bad size', { status: 413 })
  const d = new Date()
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
  const ext = ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : 'jpg'
  const key = `d/${ym}/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: ct } })
  return Response.json({ url: `/api/photos/${key}` })
}

export const onRequestGet = async ({ env, params }: Ctx): Promise<Response> => {
  if (!env.PHOTOS) return new Response('R2 not configured', { status: 501 })
  const key = Array.isArray(params.path) ? params.path.join('/') : String(params.path ?? '')
  if (!key || key === 'upload') return new Response('not found', { status: 404 })
  const obj = await env.PHOTOS.get(key)
  if (!obj) return new Response('not found', { status: 404 })
  const headers = new Headers()
  headers.set('content-type', obj.httpMetadata?.contentType ?? 'image/jpeg')
  headers.set('cache-control', 'public, max-age=31536000, immutable') // keys are unique → safe to cache forever
  if (obj.httpEtag) headers.set('etag', obj.httpEtag)
  return new Response(obj.body, { headers })
}
