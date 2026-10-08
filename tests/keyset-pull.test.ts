import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * การดึง tracking_rows ทั้งบริษัท (full pull) ต้องไม่ใช้ OFFSET ลึก ๆ — ฐานข้อมูลจริงตัดคำขอที่เกิน ~3 วินาที (57014 statement timeout)
 * หน้าที่ offset ≥ ~30,000 จึงล้มทุกครั้ง การซิงก์ทั้งรอบถูกทิ้ง ลองใหม่ทุกนาที = error เป็นพันต่อวัน (วัดจริง 8 ต.ค.)
 * ฐานข้อมูลปลอมนี้จำลองเพดานนั้น: คำขอข้อมูลที่ offset ≥ DEEP_LIMIT → error 57014
 */
interface Q { cols: string; gte?: string; gt?: string; lt?: string; from?: number; to?: number; limit?: number; head?: boolean }

function fakeDb(vins: string[], opts: { deepLimit?: number; failFromData?: number; failCount?: boolean; insertDuring?: () => string[] } = {}) {
  const stats = { running: 0, max: 0, dataCalls: 0, boundaryCalls: 0, maxOffsetData: 0, queries: [] as Q[] }
  let table = [...vins].sort()
  const exec = async (q: Q) => {
    stats.running++; stats.max = Math.max(stats.max, stats.running)
    await new Promise((r) => setTimeout(r, 15))
    stats.running--
    const isBoundary = q.cols.trim() === 'vin'
    const offset = q.from ?? 0
    if (isBoundary) stats.boundaryCalls++
    else { stats.dataCalls++; stats.maxOffsetData = Math.max(stats.maxOffsetData, offset) }
    stats.queries.push(q)
    if (opts.deepLimit != null && offset >= opts.deepLimit && !isBoundary) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    if (!isBoundary && opts.failFromData != null && stats.dataCalls >= opts.failFromData) return { data: null, error: { code: '500', message: 'boom' } }
    if (!isBoundary && opts.insertDuring && stats.dataCalls === 3) table = [...table, ...opts.insertDuring()].sort()
    let rows = table.filter((v) => (q.gte == null || v >= q.gte) && (q.gt == null || v > q.gt) && (q.lt == null || v < q.lt))
    const lim = q.limit ?? 1000
    rows = q.from != null ? rows.slice(q.from, (q.to ?? q.from) + 1) : rows.slice(0, lim)
    return { data: rows.map((v) => ({ vin: v, cells: { Vin: v }, updated_at: '2026-10-06T00:00:00Z', site: 'S1', history: [], deleted_at: null })), error: null }
  }
  const from = () => ({
    select: (cols: string, o?: { head?: boolean }) => {
      if (o?.head) return Promise.resolve(opts.failCount ? { count: null, error: { message: 'count failed' } } : { count: table.length, error: null })
      const q: Q = { cols }
      const b: any = {
        order: () => b, limit: (n: number) => { q.limit = n; return b },
        gte: (_c: string, v: string) => { q.gte = v; return b }, gt: (c: string, v: string) => { if (c === 'vin') q.gt = v; return b }, lt: (_c: string, v: string) => { q.lt = v; return b },
        range: (a: number, z: number) => { q.from = a; q.to = z; return b },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => exec(q).then(res, rej),
      }
      return b
    },
  })
  return { stats, mod: { isConfigured: () => true, supabase: { from } } }
}

const mkVins = (n: number) => Array.from({ length: n }, (_, i) => 'V' + String(i).padStart(7, '0'))

describe('fetchTrackingRows — keyset (ต่อจาก VIN) แทน OFFSET ลึก', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.restoreAllMocks() })

  async function pull(vins: string[], o: Parameters<typeof fakeDb>[1] = {}) {
    vi.resetModules()
    const { stats, mod } = fakeDb(vins, o)
    vi.doMock('../src/lib/supabase', () => mod)
    const db = await import('../src/lib/db')
    const p = db.fetchTrackingRows().then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }))
    await vi.runAllTimersAsync()
    return { stats, res: await p, db }
  }

  it('เพดานเวลาจำลอง (offset ≥ 5,000 ล้ม 57014): ดึง 12,500 แถวได้ครบ เรียง VIN ไม่ซ้ำ — โค้ดแบบ offset จะล้ม', async () => {
    const vins = mkVins(12_500)
    const { res, stats } = await pull(vins, { deepLimit: 5_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.v.map((r) => r.vin)).toEqual(vins)
    expect(stats.maxOffsetData, 'คำขอข้อมูลต้องไม่มี offset ลึก').toBe(0)
  })

  it('ความขนานรวม ≤ FULL_PULL_CONCURRENCY และใช้มากกว่า 1', async () => {
    const { res, stats, db } = await pull(mkVins(9_000))
    expect(res.ok).toBe(true)
    expect(stats.max).toBeLessThanOrEqual(db.FULL_PULL_CONCURRENCY)
    expect(stats.max).toBeGreaterThan(1)
  })

  it('จุดแบ่งช่วงถามเฉพาะคอลัมน์ vin (เบา) และมีไม่เกิน FULL_PULL_CONCURRENCY − 1 ครั้ง', async () => {
    const { stats, db } = await pull(mkVins(9_000))
    expect(stats.boundaryCalls).toBeGreaterThan(0)
    expect(stats.boundaryCalls).toBeLessThanOrEqual(db.FULL_PULL_CONCURRENCY - 1)
  })

  it('แถวใหม่เพิ่มเข้ามาระหว่างดึง: ไม่ซ้ำ ไม่ขาดแถวเดิม', async () => {
    const vins = mkVins(6_000)
    const extra = ['V0000500a', 'V0003000a', 'V0005999z']
    const { res } = await pull(vins, { insertDuring: () => extra })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const got = res.v.map((r) => r.vin)
    expect(new Set(got).size).toBe(got.length) // ไม่ซ้ำ
    for (const v of vins) expect(got).toContain(v) // แถวเดิมครบ
  })

  it('จำนวนแถวหาร 1,000 ลงตัวพอดี (หน้าสุดท้ายเต็ม) และตารางเล็ก/ว่าง', async () => {
    const a = await pull(mkVins(4_000)); expect(a.res.ok && a.res.v.length).toBe(4_000)
    const b = await pull(mkVins(250)); expect(b.res.ok && b.res.v.length).toBe(250)
    const c = await pull([]); expect(c.res.ok && c.res.v.length).toBe(0)
  })

  it('หน้าข้อมูลล้มต่อเนื่อง (ลองซ้ำก็ล้ม) → โยน error (ห้ามกลืนเป็นหน้าว่างแล้วบอกว่าครบ)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res } = await pull(mkVins(9_000), { failFromData: 4 })
    expect(res.ok).toBe(false)
  })

  it('นับแถวไม่ได้ (count ล้ม) → ดึงเป็นช่วงเดียวต่อเนื่อง ได้ครบเรียงถูก ไม่ใช้ offset ลึก', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const vins = mkVins(7_300)
    const { res, stats } = await pull(vins, { failCount: true, deepLimit: 2_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.v.map((r) => r.vin)).toEqual(vins)
    expect(stats.maxOffsetData).toBe(0)
  })
})
