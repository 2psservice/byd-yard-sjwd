import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

/**
 * นับแถวของยาร์ดในคลาวด์ไม่ได้ (หมดเวลา/ฐานข้อมูลช้า) ≠ ติดต่อคลาวด์ไม่ได้ — เดิมโค้ดหยุดและไม่ดึงแถวของยาร์ดเลย (ทั้งที่เอกสารของ
 * countTrackingRowsForSite บอกว่า "นับไม่ได้ → โหลดต่อโดยไม่มีเป้าหมาย") และป้ายบอกผู้ใช้ว่า "ยังติดต่อคลาวด์ไม่ได้"
 */
const SITE = { id: 'S1', name: 'NYB2 Phase 2', code: 'NYB2', createdAt: 0 }
const cloudRow = (i: number) => ({ vin: 'V' + String(i).padStart(6, '0'), cells: { Vin: 'V' + String(i).padStart(6, '0'), 'Car Status': 'In Yard', 'Location yard': SITE.name }, site: 'S1', history: [], updatedAt: 5_000 })

async function setup(opts: { count: number | null; fetchRows?: ReturnType<typeof cloudRow>[]; fetchFails?: boolean; localRows?: number }) {
  vi.resetModules(); localStorage.clear()
  const fetchTrackingRowsForSite = vi.fn(async (_site: unknown, onBatch?: (b: any[]) => void) => {
    if (opts.fetchFails) throw new Error('boom')
    const rows = opts.fetchRows ?? []
    onBatch?.(rows)
    return rows
  })
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true,
    countTrackingRowsForSite: async () => opts.count,
    fetchTrackingRowsForSite,
  }))
  const { useTracking } = await import('../src/store/useTracking')
  const { useYard } = await import('../src/store/useYard')
  useYard.setState({ sites: [SITE], currentSite: 'S1' })
  const local = Object.fromEntries(Array.from({ length: opts.localRows ?? 0 }, (_, i) => { const r = { ...cloudRow(i), updatedAt: 1_000 }; return [r.vin, r] }))
  useTracking.setState({ loaded: true, rows: local })
  return { useTracking, useYard, fetchTrackingRowsForSite }
}

describe('loadSiteRows — นับแถวในคลาวด์ไม่ได้', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

  it('นับไม่ได้ + เครื่องยังไม่มีแถวของยาร์ด → ยังดึงแถวต่อ (ไม่รู้เป้าหมาย) ได้แถวครบและสถานะ done', async () => {
    const t = await setup({ count: null, fetchRows: Array.from({ length: 50 }, (_, i) => cloudRow(i)) })
    await t.useTracking.getState().loadSiteRows('S1')
    expect(t.fetchTrackingRowsForSite).toHaveBeenCalledTimes(1)
    expect(Object.keys(t.useTracking.getState().rows)).toHaveLength(50)
    expect(t.useTracking.getState().siteLoad?.status).toBe('done')
  })

  it('นับไม่ได้ + เครื่องมีแถวของยาร์ดอยู่แล้ว → ใช้ของในเครื่องไปก่อน ไม่ดึงซ้ำทั้งก้อน (offline เหมือนเดิม)', async () => {
    const t = await setup({ count: null, localRows: 10, fetchRows: [cloudRow(99)] })
    await t.useTracking.getState().loadSiteRows('S1')
    expect(t.fetchTrackingRowsForSite).not.toHaveBeenCalled()
    expect(t.useTracking.getState().siteLoad?.status).toBe('offline')
  })

  it('นับไม่ได้ + ดึงแถวก็ล้ม → offline', async () => {
    const t = await setup({ count: null, fetchFails: true })
    await t.useTracking.getState().loadSiteRows('S1')
    expect(t.useTracking.getState().siteLoad?.status).toBe('offline')
  })

  it('(ควบคุม) นับได้ และในเครื่องมีครบ → ข้ามการดึง (cached) เหมือนเดิม', async () => {
    const t = await setup({ count: 10, localRows: 10 })
    await t.useTracking.getState().loadSiteRows('S1')
    expect(t.fetchTrackingRowsForSite).not.toHaveBeenCalled()
    expect(t.useTracking.getState().siteLoad?.status).toBe('done')
  })

  it('(ควบคุม) นับได้ แต่ในเครื่องมีไม่ครบ → ดึง และมีเป้าหมายจำนวนแถว', async () => {
    const t = await setup({ count: 30, localRows: 5, fetchRows: Array.from({ length: 30 }, (_, i) => cloudRow(i)) })
    await t.useTracking.getState().loadSiteRows('S1')
    expect(t.fetchTrackingRowsForSite).toHaveBeenCalledTimes(1)
    expect(t.useTracking.getState().siteLoad).toMatchObject({ status: 'done', total: 30 })
  })
})

describe('ป้าย SiteLoadGate', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })
  async function render(siteLoad: Record<string, unknown>) {
    const t = await setup({ count: 1 })
    t.useTracking.setState({ siteLoad: { siteId: 'S1', startedAt: Date.now(), progressAt: Date.now(), have: 0, total: null, status: 'loading', ...siteLoad } as never })
    t.useYard.setState({ unitsCloudDone: true })
    const { SiteLoadGate } = await import('../src/components/SiteLoadGate')
    // renderToStaticMarkup อ่านสถานะเริ่มต้นของ zustand เสมอ (server snapshot) จึงต้องเรนเดอร์จริงใน jsdom
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    flushSync(() => root.render(createElement(SiteLoadGate, { mode: 'banner' })))
    const html = host.innerHTML
    root.unmount(); host.remove()
    return html
  }
  it('offline: ข้อความไม่บอกว่า "ติดต่อคลาวด์ไม่ได้" (อาจแค่นับแถวไม่ทัน) แต่บอกว่าตรวจข้อมูลล่าสุดไม่สำเร็จ', async () => {
    const html = await render({ status: 'offline' })
    expect(html).toContain('ใช้ข้อมูลในเครื่องไปก่อน')
    expect(html).not.toContain('ยังติดต่อคลาวด์ไม่ได้')
    expect(html).toContain('ตรวจข้อมูลล่าสุดจากคลาวด์ไม่สำเร็จ')
  })
  it('กำลังโหลดโดยไม่รู้จำนวนทั้งหมด: โชว์จำนวนแถวที่ได้แล้ว ไม่ใช่ "Loading 0%"', async () => {
    const html = await render({ status: 'loading', total: null, have: 1234 })
    expect(html).toContain('1,234')
    expect(html).not.toContain('Loading 0%')
  })
  it('รู้จำนวนทั้งหมด: โชว์เปอร์เซ็นต์เหมือนเดิม', async () => {
    const html = await render({ status: 'loading', total: 200, have: 100 })
    expect(html).toContain('Loading 50%')
  })
})
