// Cloudflare Pages Function — reads the battery % off a photo of the car's screen
// (EV Charging station: before / after photos).
//
// Route (same origin as the app, deployed automatically with `functions/`):
//   POST /api/ev/battery   body = image blob (jpeg/png/webp) → { percent: number | null }
//
// One-time setup in the Cloudflare dashboard:
//   Workers & Pages → byd-yard-sjwd → Settings → Variables and Secrets → Add →
//   Type: Secret · Variable name: ANTHROPIC_API_KEY · Value: the key from console.anthropic.com
//   then redeploy (any push to main).
//
// Until the key exists this API answers 501 and the station simply asks the
// operator to type the % — nothing breaks. The % field is always editable, so a
// misread is corrected by the person holding the car, never trusted blindly.

import Anthropic from '@anthropic-ai/sdk'

interface Env { ANTHROPIC_API_KEY?: string }
type Ctx = { request: Request; env: Env }

const MAX_BYTES = 4 * 1024 * 1024 // the app sends a ~1280px JPEG (~150-400 KB)
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const PROMPT = `This photo shows the dashboard / center screen of an electric car (usually a BYD) while it is parked or charging.
Read the battery state of charge (SOC) shown on the screen, as a whole-number percentage from 0 to 100.
The SOC is the number next to a % sign or inside / beside the battery icon. Do not confuse it with the driving range (km), the speed, the clock, charging power (kW) or time remaining.
If no battery percentage is clearly readable, answer null instead of guessing.`

// Structured output: the reply is exactly {"percent": <integer|null>}
const SCHEMA = {
  type: 'object',
  properties: { percent: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
  required: ['percent'],
  additionalProperties: false,
}

/** Model reply text → percent (0–100, whole number) or null when unreadable / out of range. */
export function percentFrom(text: string): number | null {
  try {
    const v = (JSON.parse(text) as { percent?: unknown }).percent
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    const n = Math.round(v)
    return n >= 0 && n <= 100 ? n : null
  } catch { return null }
}

/** ArrayBuffer → base64 without Node's Buffer (Workers runtime); chunked so a
 *  large photo never blows the argument limit of String.fromCharCode. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  if (!env.ANTHROPIC_API_KEY) return new Response('AI not configured', { status: 501 })
  // same-origin only — this spends API credit, so other sites must not be able to call it
  const origin = request.headers.get('origin')
  if (origin) {
    try { if (new URL(origin).host !== new URL(request.url).host) return new Response('forbidden', { status: 403 }) }
    catch { return new Response('forbidden', { status: 403 }) }
  }
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim()
  if (!TYPES.has(ct)) return new Response('unsupported type', { status: 415 })
  const buf = await request.arrayBuffer()
  if (!buf.byteLength || buf.byteLength > MAX_BYTES) return new Response('bad size', { status: 413 })

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 45_000 })
  try {
    const msg = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 2048,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // reading one number off a screen — low effort keeps it fast and cheap
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: ct as 'image/jpeg' | 'image/png' | 'image/webp', data: toBase64(buf) } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })
    if (msg.stop_reason === 'refusal') return Response.json({ percent: null, reason: 'refusal' })
    let text = ''
    for (const b of msg.content) if (b.type === 'text') text += b.text
    return Response.json({ percent: percentFrom(text) })
  } catch (e) {
    const reason = e instanceof Anthropic.APIError ? `api ${e.status ?? ''}`.trim() : 'error'
    console.error('[ev/battery]', e)
    return Response.json({ percent: null, reason }, { status: 502 })
  }
}
