import { describe, expect, it } from 'vitest'
import { createKeyedQueue } from '../src/lib/keyedQueue'

const defer = () => { let resolve!: () => void, reject!: (e: unknown) => void; const p = new Promise<void>((a, b) => { resolve = a; reject = b }); return { p, resolve, reject } }
const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * การส่งแถวติดตามทั้งแถว (upsert) ของรถคันเดียวกัน: ครั้งเก่าที่ช้าต้องไม่ถึงทีหลังครั้งใหม่
 * (F18 NYB2 19 ต.ค.: บรรทัดเลื่อนตามแถวครั้งที่สองหาย เพราะการส่งครั้งแรกถึงทีหลังแล้วทับ)
 */
describe('createKeyedQueue', () => {
  it('คีย์เดียวกัน: งานที่สองรองานแรกเสร็จก่อน → ค่าสุดท้ายในคลาวด์เป็นของงานที่สอง', async () => {
    const run = createKeyedQueue()
    const cloud = new Map<string, string>()
    const slow = defer()
    const order: string[] = []
    const a = run(['V1'], async () => { order.push('A start'); await slow.p; cloud.set('V1', 'history v1'); order.push('A done') })
    const b = run(['V1'], async () => { order.push('B start'); cloud.set('V1', 'history v2'); order.push('B done') })
    await tick()
    expect(order).toEqual(['A start']) // B ยังไม่เริ่มระหว่าง A ค้าง
    slow.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['A start', 'A done', 'B start', 'B done'])
    expect(cloud.get('V1')).toBe('history v2')
  })

  it('คีย์ต่างกัน: ไม่รอกัน', async () => {
    const run = createKeyedQueue()
    const slow = defer()
    const order: string[] = []
    const a = run(['V1'], async () => { await slow.p; order.push('V1') })
    const b = run(['V2'], async () => { order.push('V2') })
    await b
    expect(order).toEqual(['V2'])
    slow.resolve(); await a
  })

  it('ชุดหลายคีย์รอทุกคีย์ที่ทับกัน · งานล้มไม่ขวางงานถัดไป และผู้เรียกยังได้ error', async () => {
    const run = createKeyedQueue()
    const order: string[] = []
    const a = run(['V1'], async () => { order.push('A'); throw new Error('network') })
    const b = run(['V1', 'V2'], async () => { order.push('B') })
    await expect(a).rejects.toThrow('network')
    await b
    expect(order).toEqual(['A', 'B'])
  })
})
