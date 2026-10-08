import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** แคช/การรวมการเขียนที่เพิ่มเพื่อลดงานเมนเธรดบนมือถือเก่า — ต้องไม่เปลี่ยนผลลัพธ์ */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

describe('deriveCarStatus (มีแคชต่อ cells)', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-06T08:00:00+07:00') }) })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  it('ผลเท่ากับการคำนวณใหม่ทุกครั้ง (คัดลอก cells = พลาดแคช) บนข้อมูลสุ่ม ข้ามหลายช่วงเวลา', async () => {
    const { deriveCarStatus } = await import('../src/lib/carStatus')
    const r = rng(42)
    const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]
    const statuses = ['Pre Gate-in', 'In Yard', 'Gate-out', 'Pre Gate-out', '', 'Gate-in', 'PARKING PM · PM2', 'X OK', 'Preload']
    const now0 = Date.now()
    const list = Array.from({ length: 300 }, () => {
      const c: Record<string, string> = { 'Car Status': pick(statuses), 'Vin Of Status': pick(['', 'NG', 'Total loss', 'total loss']), 'Grouping  Number': pick(['', 'G1']) }
      if (r() < 0.5) c['Gate Out Time'] = String(now0 - Math.floor(r() * 3 * 86_400_000))
      if (r() < 0.3) c['Gate In Date'] = '01/10/2026'
      if (r() < 0.2) c['storage Yard'] = 'A'
      return c
    })
    for (const iso of ['2026-10-06T08:00:00+07:00', '2026-10-06T09:29:59+07:00', '2026-10-06T09:30:01+07:00', '2026-10-06T20:00:00+07:00', '2026-10-07T09:31:00+07:00']) {
      vi.setSystemTime(new Date(iso))
      for (const c of list) {
        expect(deriveCarStatus(c), `${iso}`).toBe(deriveCarStatus({ ...c }))
        expect(deriveCarStatus(c)).toBe(deriveCarStatus(c)) // ครั้งที่สองผ่านแคชต้องเท่าเดิม
      }
    }
  })

  it('Pre Gate-out กลายเป็น Gate-out ทันทีที่ข้าม 09:30 บน cells ออบเจ็กต์เดิม (แคชไม่ค้างข้ามรอบ flush)', async () => {
    const { deriveCarStatus } = await import('../src/lib/carStatus')
    const scanned = new Date('2026-10-05T18:00:00+07:00').getTime()
    const c = { 'Car Status': 'Pre Gate-out', 'Gate Out Time': String(scanned) }
    vi.setSystemTime(new Date('2026-10-06T09:29:00+07:00'))
    expect(deriveCarStatus(c)).toBe('Pre Gate-out')
    expect(deriveCarStatus(c)).toBe('Pre Gate-out') // ผ่านแคช
    vi.setSystemTime(new Date('2026-10-06T09:31:00+07:00'))
    expect(deriveCarStatus(c)).toBe('Gate-out')
    vi.setSystemTime(new Date('2026-10-06T09:00:00+07:00')) // เวลาถอยหลัง (ตั้งนาฬิกาใหม่) ต้องไม่ใช้ผลของอนาคต
    expect(deriveCarStatus(c)).toBe('Pre Gate-out')
  })

  it('แก้ Car Status ที่เดิม (เช่น ImportPage ตั้ง Pre Gate-in) → ผลต้องตามค่าใหม่ ไม่ใช่ค่าจากแคช', async () => {
    const { deriveCarStatus } = await import('../src/lib/carStatus')
    const c: Record<string, string> = { 'Car Status': 'In Yard' }
    expect(deriveCarStatus(c)).toBe('In Yard')
    c['Car Status'] = 'Pre Gate-in'
    expect(deriveCarStatus(c)).toBe('Pre Gate-in')
  })
})

describe('quotaSafeStorage (รวมการเขียน)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetModules() })

  it('set ถี่ ๆ → เขียนจริงครั้งเดียวหลังเงียบ 400ms ด้วยค่าล่าสุด', async () => {
    const { quotaSafeStorage } = await import('../src/lib/persistStorage')
    const spy = vi.spyOn(localStorage, 'setItem')
    const st = quotaSafeStorage<any>()
    for (let i = 1; i <= 50; i++) st.setItem('k', { state: { n: i }, version: 0 })
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(399)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem('k')!).state.n).toBe(50)
  })

  it('แท็บถูกซ่อน (visibilitychange) → เขียนทันที ไม่รอ 400ms', async () => {
    const { quotaSafeStorage } = await import('../src/lib/persistStorage')
    const st = quotaSafeStorage<any>()
    st.setItem('k2', { state: { n: 7 }, version: 0 })
    expect(localStorage.getItem('k2')).toBeNull()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(JSON.parse(localStorage.getItem('k2')!).state.n).toBe(7)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('pagehide → เขียนทันที และ removeItem ยกเลิกค่าที่รอเขียน', async () => {
    const { quotaSafeStorage } = await import('../src/lib/persistStorage')
    const st = quotaSafeStorage<any>()
    st.setItem('k3', { state: { n: 1 }, version: 0 })
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(localStorage.getItem('k3')!).state.n).toBe(1)
    st.setItem('k4', { state: { n: 2 }, version: 0 })
    st.removeItem('k4')
    await vi.advanceTimersByTimeAsync(1000)
    expect(localStorage.getItem('k4')).toBeNull()
  })

  it('เขียนไม่สำเร็จ (โควตาเต็ม) ไม่โยน error ใส่ผู้เรียก และเรียก onQuotaError ครั้งเดียว', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { quotaSafeStorage } = await import('../src/lib/persistStorage')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    const onQuota = vi.fn()
    const st = quotaSafeStorage<any>(onQuota)
    expect(() => st.setItem('q', { state: {}, version: 0 })).not.toThrow()
    await vi.advanceTimersByTimeAsync(500)
    st.setItem('q', { state: { a: 1 }, version: 0 })
    await vi.advanceTimersByTimeAsync(500)
    expect(onQuota).toHaveBeenCalledTimes(1)
  })
})

describe('isSequenceQueue (มีแคชต่ออาร์เรย์ items)', () => {
  it('ตรรกะเดิม: kind=sequence, มี laneLoad/dest = ใช่, นอกนั้นไม่ใช่ และตามค่าใหม่เมื่อ items ถูกแทนที่', async () => {
    vi.resetModules()
    const { World } = await import('./helpers/world')
    await new World().createDevice('A')
    const { isSequenceQueue } = await import('../src/store/useOps')
    const base = { id: 'q', name: 'n', createdAt: 0 }
    const plain: any = { ...base, items: [{ vin: 'A', addedAt: 0, done: false }] }
    expect(isSequenceQueue(plain)).toBe(false)
    expect(isSequenceQueue(plain)).toBe(false) // ผ่านแคช
    expect(isSequenceQueue({ ...plain, kind: 'sequence' })).toBe(true)
    expect(isSequenceQueue({ ...plain, items: [{ vin: 'A', addedAt: 0, done: false, laneLoad: 'O1' }] })).toBe(true)
    expect(isSequenceQueue({ ...plain, items: [{ vin: 'A', addedAt: 0, done: false, dest: 'D' }] })).toBe(true)
    expect(isSequenceQueue({ ...plain, items: [] })).toBe(false)
  })
})
