import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * คิวงานในเครื่อง (localStorage 'sjwd-ops') เก็บเฉพาะคิวที่สร้างภายใน 7 วัน — 26 ต.ค. คิวทั้งระบบ ~3.8MB เกินโควตา Safari
 * บันทึกล้มทุกครั้ง ("พื้นที่จัดเก็บในเครื่องเต็ม") และเครื่องค้างสำเนาเก่าไว้ใช้ตอนเปิดแอป
 */
const DAY = 86_400_000

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => false,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  const ops = await import('../src/store/useOps')
  const { flushPersistNow } = await import('../src/lib/persistStorage')
  return { ops, flushPersistNow }
}

const q = (id: string, createdAt: number) => ({ id, name: id, createdAt, items: [{ vin: 'V' + id, addedAt: createdAt, done: false }] })

describe('คิวที่เก็บในเครื่อง', () => {
  afterEach(() => { vi.useRealTimers() })

  it('queuesToPersist: เก็บคิวที่สร้างภายใน 7 วัน ตัดคิวที่เก่ากว่าและคิวที่ไม่มีวันที่สร้าง', async () => {
    const { ops } = await setup()
    const now = Date.UTC(2026, 9, 26, 5)
    const kept = ops.queuesToPersist([q('new', now - DAY), q('edge', now - 7 * DAY), q('old', now - 8 * DAY), q('none', 0)] as any, now)
    expect(kept.map((x) => x.id)).toEqual(['new', 'edge'])
  })

  it('localStorage ได้แค่คิวล่าสุด ส่วนในแอปยังเห็นคิวครบ', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-26T12:00:00+07:00') })
    const { ops, flushPersistNow } = await setup()
    const now = Date.now()
    ops.useOps.setState({ queues: [q('today', now - 3600_000), q('lastMonth', now - 30 * DAY)] } as any)
    flushPersistNow()
    const saved = JSON.parse(localStorage.getItem('sjwd-ops') ?? '{}')
    expect(saved.state.queues.map((x: any) => x.id)).toEqual(['today'])
    expect(ops.useOps.getState().queues.map((x) => x.id)).toEqual(['today', 'lastMonth'])
  })
})
