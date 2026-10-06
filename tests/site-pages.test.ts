import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** fetchTrackingRowsForSite: แถวของยาร์ดทีละ 4 หน้าพร้อมกัน + รอบ "ของเก่าไม่มีป้ายไซต์" ไม่ดึงซ้ำแถวที่ติดป้ายแล้ว */

interface FakeRow { vin: string; site: string | null; ly: string }
const mk = (i: number, site: string | null, ly: string): FakeRow => ({ vin: 'V' + String(i).padStart(6, '0'), site, ly })

function fakeSupabase(table: FakeRow[], opts: { failFrom?: number } = {}) {
  const stats = { running: 0, max: 0, calls: 0, rowsServed: 0, offsets: [] as number[] }
  const from = () => ({
    select: () => {
      const f: { site?: string; siteNull?: boolean; ly?: string } = {}
      const q: any = {
        eq: (col: string, v: string) => { if (col === 'site') f.site = v; else f.ly = v; return q },
        is: (col: string, v: null) => { if (col === 'site' && v === null) f.siteNull = true; return q },
        order: () => q,
        range: async (a: number, b: number) => {
          stats.calls++; stats.offsets.push(a); stats.running++; stats.max = Math.max(stats.max, stats.running)
          await new Promise((r) => setTimeout(r, 20 + ((a / 1000) % 3) * 9)) // เวลาไม่เท่ากัน → หน้าเสร็จสลับลำดับ
          stats.running--
          if (opts.failFrom != null && a === opts.failFrom) return { data: null, error: { message: 'boom' } }
          let rows = table.filter((r) => (f.site == null || r.site === f.site) && (f.ly == null || r.ly === f.ly) && (!f.siteNull || r.site === null))
          rows = rows.sort((x, y) => (x.vin < y.vin ? -1 : 1)).slice(a, b + 1)
          stats.rowsServed += rows.length
          return { data: rows.map((r) => ({ vin: r.vin, cells: { Vin: r.vin, 'Location yard': r.ly }, updated_at: '2026-10-06T00:00:00Z', site: r.site, history: [], deleted_at: null })), error: null }
        },
      }
      return q
    },
  })
  return { stats, mod: { isConfigured: () => true, supabase: { from } } }
}

const SITE = { id: 'S1', name: 'NYB2 Phase 2', code: 'NYB2' }

describe('fetchTrackingRowsForSite', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  async function run(table: FakeRow[], opts: { failFrom?: number } = {}, onBatch?: (b: any[]) => void) {
    const { stats, mod } = fakeSupabase(table, opts)
    vi.doMock('../src/lib/supabase', () => mod)
    const db = await import('../src/lib/db')
    const p = db.fetchTrackingRowsForSite(SITE, onBatch)
    const settled = p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }))
    await vi.runAllTimersAsync()
    return { stats, res: await settled, db }
  }

  it('21 หน้า: ได้ครบทุกแถว, ค้างพร้อมกัน ≤ 4 (และ >1), เรียก onBatch เรียงตามหน้า', async () => {
    const table = Array.from({ length: 20_580 }, (_, i) => mk(i, 'S1', SITE.name))
    const batches: string[][] = []
    const { stats, res, db } = await run(table, {}, (b) => batches.push(b.map((r) => r.vin)))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.v).toHaveLength(20_580)
    expect(res.v.map((r) => r.vin)).toEqual(table.map((r) => r.vin)) // ลำดับ vin เดิม
    expect(stats.max).toBeLessThanOrEqual(db.SITE_PULL_CONCURRENCY)
    expect(stats.max, 'ใช้ความขนานจริง').toBeGreaterThan(1)
    // onBatch ต้องมาตามลำดับหน้า (ไม่สลับ) แม้หน้าเสร็จไม่พร้อมกัน
    expect(batches.flat()).toEqual(table.map((r) => r.vin))
  })

  it('หน้าสุดท้ายพอดี 1,000 แถว: หยุดถูก ไม่ขาด ไม่วนไม่รู้จบ', async () => {
    const table = Array.from({ length: 3_000 }, (_, i) => mk(i, 'S1', SITE.name))
    const { res, stats } = await run(table)
    expect(res.ok && res.v.length).toBe(3_000)
    expect(stats.calls).toBeLessThan(20)
  })

  it('ไม่มีแถว → คืนอาร์เรย์ว่าง', async () => {
    const { res } = await run([])
    expect(res.ok && res.v.length).toBe(0)
  })

  it('หน้าหนึ่งล้ม → โยน error (ห้ามกลืนเป็นหน้าว่างแล้วบอกว่าครบ)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const table = Array.from({ length: 9_000 }, (_, i) => mk(i, 'S1', SITE.name))
    const { res } = await run(table, { failFrom: 3_000 })
    expect(res.ok).toBe(false)
    vi.restoreAllMocks()
  })
})
