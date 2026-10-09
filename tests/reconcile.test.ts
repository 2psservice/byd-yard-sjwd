import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World } from './helpers/world'

/**
 * reconcileGateOuts (ตัวซิงก์คิวงานกับสถานะแถวชีต) ถูกเขียนใหม่ให้ไม่วนทุกแถวซ้ำ — test นี้รัน "ฟังก์ชันเดิม"
 * (tests/tmp/useOps.old.ts = ไฟล์จาก git ก่อนแก้ ไม่ดัดแปลงนอกจาก import path + export) กับฟังก์ชันใหม่บนข้อมูลสุ่มชุดเดียวกัน
 * แล้วต้องได้ผลเหมือนกันทุกประการ (คิว + รายการที่ถูกเอาออกจากกระดานประตู) รวมกรณีที่เวลาข้ามรอบ flush 09:30
 */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

function makeData(seed: number, nowMs: number) {
  const r = rng(seed)
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]
  const statuses = ['Pre Gate-in', 'In Yard', 'Gate-out', 'Pre Gate-out', '', 'In yard', 'PARKING PM · PM2', 'Preload'] as const
  const groups = ['', '', 'G1', 'g1', 'G2', 'G3', 'เศษรอ Mix', 'mix', ' G4 ', 'G5']
  const dayMs = 86_400_000
  const rows: Record<string, any> = {}
  const N = 160
  for (let i = 0; i < N; i++) {
    const vin = 'VIN' + String(i).padStart(4, '0')
    const cells: Record<string, string> = { 'Car Status': pick(statuses), 'Grouping  Number': pick(groups), Vin: vin }
    if (cells['Car Status'] === 'Pre Gate-out') {
      // สแกนออกก่อน/หลัง flush ของวันนี้ และหลายวันก่อน → ผลขึ้นกับ "ตอนนี้" เทียบ 09:30
      cells['Gate Out Time'] = String(nowMs - Math.floor(r() * 3 * dayMs))
    }
    if (r() < 0.1) cells['Gate Out Date'] = '29/07/2026'
    if (r() < 0.25) cells['PM1'] = '01/10/2026'
    if (r() < 0.15) cells['Gate In Time'] = String(nowMs - Math.floor(r() * 2 * dayMs))
    rows[vin] = {
      vin, site: pick(['S1', 'S1', 'S2'] as const), updatedAt: Math.floor(r() * 1000), cells,
      history: r() < 0.2 ? [{ field: 'Grouping  Number', at: Math.floor(r() * 1000), to: pick(['', 'เศษ', 'G2']) }] : [],
    }
  }
  const vins = Object.keys(rows)
  const missing = ['GHOST1', 'GHOST2']
  const anyVin = () => (r() < 0.05 ? pick(missing) : pick(vins))
  const queues: any[] = []
  const qn = 3 + Math.floor(r() * 8)
  for (let q = 0; q < qn; q++) {
    const kind = r() < 0.6 ? 'sequence' : undefined
    const type = kind ? undefined : pick(['PM', 'PDI', 'FINAL', 'GATEIN', 'WASH'] as const)
    const items: any[] = []
    const k = Math.floor(r() * 25)
    const used = new Set<string>()
    for (let j = 0; j < k; j++) {
      const vin = anyVin()
      if (used.has(vin)) continue
      used.add(vin)
      const it: any = { vin, addedAt: Math.floor(r() * 1000), done: r() < 0.3 }
      if (it.done) { it.doneAt = Math.floor(r() * 2000); if (r() < 0.3) it.gatedOut = true }
      if (r() < 0.6) it.group = pick(['G1', 'G2', 'G3', 'G5', 'g1'])
      if (r() < 0.3) { it.laneLoad = 'O' + Math.floor(r() * 5); it.dest = 'D' + Math.floor(r() * 5) }
      items.push(it)
    }
    queues.push({ id: 'Q' + q, name: type === 'GATEIN' ? '(S1 · 01/10 · 5)' : 'queue' + q, createdAt: Math.floor(r() * 500), kind, type, site: pick(['S1', 'S1', 'S2', undefined] as const), items })
  }
  const dismissed: Record<string, number> = {}
  for (let i = 0; i < 10; i++) dismissed[anyVin()] = 1
  return { rows, queues, dismissed }
}

describe('reconcileGateOuts: ฟังก์ชันใหม่ = ฟังก์ชันเดิม', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetModules() })

  // เวลาจำลอง: ก่อน flush 09:30, หลัง flush, และข้ามคืน — ผล (Pre Gate-out → gone) ต้องตรงกันทุกกรณี
  const NOWS = ['2026-10-05T08:00:00+07:00', '2026-10-05T12:00:00+07:00', '2026-10-06T09:29:00+07:00', '2026-10-06T09:31:00+07:00']

  for (const nowIso of NOWS) {
    it(`ผลเหมือนกันบนข้อมูลสุ่ม 40 ชุด @ ${nowIso}`, async () => {
      vi.useFakeTimers({ now: new Date(nowIso) })
      const w = new World()
      await w.createDevice('A') // mock supabase/db/syncBus/idb
      const trk = await import('../src/store/useTracking')
      const neu = await import('../src/store/useOps')
      const old: any = await import('./tmp/useOps.old')
      const nowMs = Date.now()
      let checked = 0
      for (let seed = 1; seed <= 40; seed++) {
        const d = makeData(seed * 7919, nowMs)
        trk.useTracking.setState({ rows: JSON.parse(JSON.stringify(d.rows)), loaded: true } as any)
        for (const mod of [neu, old]) {
          mod.useOps.setState({ queues: JSON.parse(JSON.stringify(d.queues)), dismissed: { ...d.dismissed } } as any)
        }
        old.reconcileGateOuts()
        neu.reconcileGateOuts()
        const a = old.useOps.getState(), b = neu.useOps.getState()
        expect(b.queues, `queues seed=${seed}`).toEqual(a.queues)
        expect(b.dismissed, `dismissed seed=${seed}`).toEqual(a.dismissed)
        // ครั้งที่ 2 บนแถวเดิม (ผ่านแคช) ต้องนิ่งและเท่ากันเช่นกัน
        old.reconcileGateOuts(); neu.reconcileGateOuts()
        expect(neu.useOps.getState().queues, `queues(2nd) seed=${seed}`).toEqual(old.useOps.getState().queues)
        checked++
      }
      expect(checked).toBe(40)
    })
  }

  it('ข้ามรอบ flush 09:30 บนแถวเดิม (ผ่านแคช) ผลยังตรงกับฟังก์ชันเดิม', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T09:29:00+07:00') })
    const w = new World()
    await w.createDevice('A')
    const trk = await import('../src/store/useTracking')
    const neu = await import('../src/store/useOps')
    const old: any = await import('./tmp/useOps.old')
    const { hasLeftGate } = await import('../src/lib/carStatus')
    const scanned = new Date('2026-10-05T18:00:00+07:00').getTime()
    const cells = { 'Car Status': 'Pre Gate-out', 'Gate Out Time': String(scanned), 'Grouping  Number': '' }
    const row = { vin: 'V1', site: 'S1', updatedAt: 1, cells, history: [] }
    trk.useTracking.setState({ rows: { V1: row }, loaded: true } as any)
    // หมายเหตุ: hasLeftGate นับ Pre Gate-out กับ Gate-out เป็น "ออกแล้ว" เหมือนกัน → ผลไม่ต่างข้าม flush (ตรวจเป็นเงื่อนไขตั้งต้น)
    // คิวไม่มี site → "ออกแล้ว" ตัดสินจากสถานะแถว (gone) อย่างเดียว ไม่ผ่าน departedFromSite
    const q = () => ({ id: 'Q', name: 'x', createdAt: 0, kind: 'sequence', items: [{ vin: 'V1', addedAt: 0, done: false, group: 'G1' }] })
    for (const [iso, left] of [['2026-10-06T09:29:00+07:00', true], ['2026-10-06T09:31:00+07:00', true]] as const) {
      vi.setSystemTime(new Date(iso)) // แถวเดิมออบเจ็กต์เดิมทั้งสองครั้ง — แคชต้องไม่ค้าง
      expect(hasLeftGate(cells), `เงื่อนไขตั้งต้น @ ${iso}`).toBe(left)
      for (const mod of [neu, old]) mod.useOps.setState({ queues: [q()] } as any)
      old.reconcileGateOuts(); neu.reconcileGateOuts()
      expect(!!neu.useOps.getState().queues[0].items[0].gatedOut, `ใหม่ @ ${iso}`).toBe(left)
      expect(neu.useOps.getState().queues, `ใหม่ = เดิม @ ${iso}`).toEqual(old.useOps.getState().queues)
    }
  })
})
