import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chargeMs, dailySummary, evCellText, evChargeId, fmtDuration, openChargeOf, parsePct, hoursOf, type EvCharge,
} from '../src/lib/evCharging'
import { defaultColumns, EV_CHARGING_KEY } from '../src/lib/trackingColumns'

/** งานชาร์จแบต EV: สรุปเวลาชาร์จต่อคัน · วันละกี่คัน · ช่องสรุปในชีต · AI อ่าน % จากรูป */

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
function ev(vin: string, before: number, after = 0, beforePct: number | null = 18, afterPct: number | null = null): EvCharge {
  return {
    id: evChargeId(vin, before), vin, model: 'DOLPHIN', color: 'GREY', from: '38RAI', remark: '',
    vinPhoto: 'v', beforePhoto: 'b', beforePct, beforeAi: beforePct, beforeAt: before, beforeBy: 'A',
    afterPhoto: after ? 'a' : '', afterPct, afterAi: afterPct, afterAt: after, afterBy: after ? 'B' : '', updatedAt: after || before,
  }
}

describe('เวลาชาร์จต่อคัน', () => {
  it('รอบที่จบแล้ว = เวลาบันทึกหลัง − เวลาบันทึกก่อน', () => {
    const c = ev('LC0CE4CC4SG029237', at(1, 8, 15), at(1, 12, 0), 18, 62)
    expect(chargeMs(c)).toBe(3.75 * 3_600_000)
    expect(fmtDuration(chargeMs(c))).toBe('3:45 ชม.')
    expect(hoursOf(chargeMs(c))).toBe(3.75)
  })
  it('รอบที่ยังชาร์จอยู่นับถึงตอนนี้', () => {
    const c = ev('V1', at(1, 8))
    expect(chargeMs(c, at(1, 9, 30))).toBe(1.5 * 3_600_000)
  })
})

describe('สรุปรายวัน — วันละกี่คัน คันละกี่ชั่วโมง', () => {
  it('นับคันที่เสร็จตามวันที่บันทึกหลังชาร์จ · เฉลี่ยเฉพาะคันที่เสร็จ', () => {
    const list = [
      ev('V1', at(1, 8), at(1, 12), 18, 62),       // 4 ชม. เสร็จวันที่ 1
      ev('V2', at(1, 9), at(1, 11), 19, 66),       // 2 ชม. เสร็จวันที่ 1
      ev('V3', at(1, 22), at(2, 2), 10, 80),       // ข้ามคืน: เริ่มวันที่ 1 เสร็จวันที่ 2
      ev('V4', at(2, 8)),                          // ยังชาร์จอยู่
    ]
    const days = dailySummary(list)
    expect(days.map((d) => d.day)).toEqual(['2026-10-02', '2026-10-01'])
    const d1 = days.find((d) => d.day === '2026-10-01')!
    expect(d1).toMatchObject({ started: 3, finished: 2 })
    expect(d1.avgMs).toBe(3 * 3_600_000)
    const d2 = days.find((d) => d.day === '2026-10-02')!
    expect(d2).toMatchObject({ started: 1, finished: 1, totalMs: 4 * 3_600_000 })
  })
})

describe('รอบที่ค้าง / ช่อง EV Charging ในชีต', () => {
  it('ยิงคันเดิมระหว่างชาร์จ → เจอรอบที่ยังไม่จบ (ไม่ใช่รอบเก่าที่จบแล้ว)', () => {
    const old = ev('V1', at(1, 8), at(1, 12), 18, 62)
    const cur = ev('V1', at(3, 8))
    expect(openChargeOf([old, cur, ev('V2', at(3, 9))], 'V1')?.id).toBe(cur.id)
    expect(openChargeOf([old], 'V1')).toBeUndefined()
  })
  it('ข้อความในช่อง: กำลังชาร์จ / ก่อน → หลัง · เวลา · วันที่', () => {
    expect(evCellText(ev('V1', at(1, 9, 5)))).toBe('กำลังชาร์จ 18% · 01/10/26 09:05')
    expect(evCellText(ev('V1', at(1, 8), at(1, 11, 30), 18, 62))).toBe('18% → 62% · 3:30 ชม. · 01/10/26')
  })
  it('คอลัมน์ EV Charging อยู่ในตารางรถ เปิดไว้ตั้งแต่แรก และแก้มือไม่ได้', () => {
    const col = defaultColumns().find((c) => c.key === EV_CHARGING_KEY)
    expect(col).toBeTruthy()
    expect(col!.visible).toBe(true)
    expect(col!.editable).toBe(false)
  })
  it('ช่องกรอก %: 0–100 เท่านั้น', () => {
    expect(parsePct('18')).toBe(18)
    expect(parsePct(' 62% ')).toBe(62)
    expect(parsePct('101')).toBeNull()
    expect(parsePct('')).toBeNull()
    expect(parsePct('abc')).toBeNull()
  })
})

// ── Pages Function: /api/ev/battery ─────────────────────────────────────────

const create = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { status?: number }
  class Anthropic {
    static APIError = APIError
    beta = { messages: { create } }
    constructor(public opts: unknown) {}
  }
  return { default: Anthropic }
})

const { onRequestPost, percentFrom } = await import('../functions/api/ev/battery')
const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://yard.example.com/api/ev/battery', { method: 'POST', body, headers: { 'content-type': 'image/jpeg', ...headers } })

describe('AI อ่าน % แบตจากรูป', () => {
  beforeEach(() => create.mockReset())

  it('แปลงคำตอบ JSON → เลข 0–100 (นอกช่วง/อ่านไม่ออก = null)', () => {
    expect(percentFrom('{"percent":18}')).toBe(18)
    expect(percentFrom('{"percent":61.6}')).toBe(62)
    expect(percentFrom('{"percent":null}')).toBeNull()
    expect(percentFrom('{"percent":140}')).toBeNull()
    expect(percentFrom('not json')).toBeNull()
  })
  it('ยังไม่ได้ตั้งคีย์ → 501 (แอปให้กรอกเอง)', async () => {
    const res = await onRequestPost({ request: req(new Uint8Array([1, 2, 3])), env: {} })
    expect(res.status).toBe(501)
    expect(create).not.toHaveBeenCalled()
  })
  it('เว็บอื่นเรียกไม่ได้ (ใช้เครดิต API)', async () => {
    const res = await onRequestPost({ request: req(new Uint8Array([1]), { origin: 'https://evil.example.net' }), env: { ANTHROPIC_API_KEY: 'k' } })
    expect(res.status).toBe(403)
  })
  it('ไม่ใช่รูป → 415', async () => {
    const res = await onRequestPost({ request: req('x', { 'content-type': 'text/plain' }), env: { ANTHROPIC_API_KEY: 'k' } })
    expect(res.status).toBe(415)
  })
  it('ส่งรูปให้โมเดลแบบ base64 + บังคับรูปแบบคำตอบ แล้วคืน % ที่อ่านได้', async () => {
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"percent":18}' }] })
    const res = await onRequestPost({ request: req(new Uint8Array([255, 216, 255]), { origin: 'https://yard.example.com' }), env: { ANTHROPIC_API_KEY: 'k' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ percent: 18 })
    const args = create.mock.calls[0][0]
    expect(args.model).toBe('claude-opus-5-5')
    expect(args.output_config.format.type).toBe('json_schema')
    expect(args.fallbacks).toBe('default')
    const img = args.messages[0].content[0]
    expect(img).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } })
  })
  it('โมเดลปฏิเสธ → percent null (แอปให้กรอกเอง)', async () => {
    create.mockResolvedValue({ stop_reason: 'refusal', content: [] })
    const res = await onRequestPost({ request: req(new Uint8Array([1])), env: { ANTHROPIC_API_KEY: 'k' } })
    expect(await res.json()).toEqual({ percent: null, reason: 'refusal' })
  })
})
