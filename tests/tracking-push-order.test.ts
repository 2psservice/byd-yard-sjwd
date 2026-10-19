import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * F18 NYB2 19 ต.ค. 14:36: ยิงตามแถวสองรอบติดกัน → ประวัติการเลื่อนของรถคันเดียวกันถูกส่ง (ทั้งแถว) สองครั้ง
 * สัญญาณช้า ครั้งแรกถึงคลาวด์ทีหลังแล้วทับครั้งที่สอง → บรรทัดเลื่อนล่าสุดหาย ตำแหน่งถูกแต่ประวัติค้างช่องเก่า
 * คลาวด์จำลอง: เขียนทับทั้งแถวตามลำดับที่ "ถึง" · การส่งครั้งแรกช้ากว่าครั้งที่สอง
 */
describe('ส่งแถวติดตามของรถคันเดียวกันตามลำดับ', () => {
  afterEach(() => { vi.doUnmock('../src/lib/db'); vi.doUnmock('../src/lib/supabase'); vi.resetModules() })

  it('ประวัติเลื่อนสองบรรทัดติดกัน: ครั้งแรกช้า → คลาวด์ยังได้บรรทัดล่าสุด', async () => {
    vi.resetModules(); localStorage.clear()
    const cloud = new Map<string, any>()
    let call = 0
    vi.doMock('../src/lib/supabase', () => ({
      isConfigured: () => true,
      supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
    }))
    vi.doMock('../src/lib/db', async (orig) => ({
      ...(await orig<object>()), isConfigured: () => true,
      upsertVisits: async () => {}, bulkUpsert: async () => {}, deleteTrackingRows: async () => {}, upsertStationChecks: async () => {},
      upsertTrackingRows: async (rows: any[]) => {
        const snap = rows.map((r) => JSON.parse(JSON.stringify(r)))
        const delay = ++call === 1 ? 50 : 0 // ครั้งแรกช้า (สัญญาณหน้าลาน)
        await new Promise((r) => setTimeout(r, delay))
        for (const r of snap) cloud.set(r.vin, r)
      },
    }))
    const { useTracking } = await import('../src/store/useTracking')
    useTracking.setState({ loaded: true, rows: { V1: { vin: 'V1', site: 'S1', history: [], updatedAt: 1, cells: { Vin: 'V1' } } } })
    const t0 = Date.now()
    const add = useTracking.getState().appendHistory
    // คนละคนกัน → ไม่ถูกรวมเป็นบรรทัดเดียว ได้สองการส่ง
    add('V1', { at: t0, by: 'A', field: 'Location', from: 'F1801', to: 'F1802', src: 'scan' })
    add('V1', { at: t0 + 1000, by: 'B', field: 'Location', from: 'F1802', to: 'F1803', src: 'scan' })
    await new Promise((r) => setTimeout(r, 200))
    expect(call).toBe(2)
    const last = cloud.get('V1').history.at(-1)
    expect(last.to).toBe('F1803')
  })
})
