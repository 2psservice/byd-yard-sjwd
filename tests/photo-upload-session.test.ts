import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../functions/api/photos/[[path]]'

/** อัปโหลดรูปต้องแนบโทเค็นเซสชันที่ยังใช้ได้ · ยังไม่ตั้งค่าตัวตรวจ = ทำงานเหมือนเดิม */
const put = vi.fn(async () => ({}))
const env = (check = true) => ({ PHOTOS: { put, get: async () => null }, ...(check ? { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' } : {}) })
const req = (token?: string) => new Request('https://app/api/photos/upload', {
  method: 'POST', body: new Uint8Array([1, 2, 3]),
  headers: { 'content-type': 'image/jpeg', ...(token ? { 'x-sjwd-token': token } : {}) },
})
const rpc = (valid: string[]) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
  const { p_token } = JSON.parse(String((init as RequestInit).body))
  return new Response(JSON.stringify(valid.includes(p_token)), { status: 200 })
})

describe('อัปโหลดรูปต้องล็อกอิน', () => {
  afterEach(() => { vi.restoreAllMocks(); put.mockClear() })

  it('ไม่มีโทเค็น → 401 ไม่เก็บรูป', async () => {
    rpc(['good'])
    const res = await onRequestPost({ request: req(), env: env(), params: {} })
    expect(res.status).toBe(401); expect(put).not.toHaveBeenCalled()
  })

  it('โทเค็นใช้ไม่ได้ → 401', async () => {
    rpc(['good'])
    const res = await onRequestPost({ request: req('bad'), env: env(), params: {} })
    expect(res.status).toBe(401); expect(put).not.toHaveBeenCalled()
  })

  it('โทเค็นใช้ได้ → เก็บรูป คืน url', async () => {
    rpc(['good-1'])
    const res = await onRequestPost({ request: req('good-1'), env: env(), params: {} })
    expect(res.status).toBe(200); expect(put).toHaveBeenCalledOnce()
    expect(((await res.json()) as { url: string }).url).toMatch(/^\/api\/photos\/d\//)
  })

  it('ตรวจเซสชันไม่ได้ (ฐานข้อมูลล่ม) → 503 ไม่เก็บรูป', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 500 }))
    const res = await onRequestPost({ request: req('good-2'), env: env(), params: {} })
    expect(res.status).toBe(503); expect(put).not.toHaveBeenCalled()
  })

  it('ยังไม่ตั้งค่าตัวตรวจ → เก็บรูปเหมือนเดิม', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
    const res = await onRequestPost({ request: req(), env: env(false), params: {} })
    expect(res.status).toBe(200); expect(f).not.toHaveBeenCalled()
  })
})
