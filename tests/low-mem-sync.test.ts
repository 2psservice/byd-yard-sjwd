import { describe, expect, it } from 'vitest'
import { chooseSyncMode, isLowMemDevice, deviceMemoryGb, readDeviceInfo, dailyReportDue, markDailyReport, compactMarks, isWedgeBurst } from '../src/lib/deviceInfo'

/**
 * 12–13 พ.ย.: handheld ทุกเครื่องค้างตอนเปิดแอป — ทุกเช้าเครื่องดาวน์โหลดแถวรถทั้งบริษัท (~66k แถว/~114 MB) ใหม่หมด
 * เครื่อง RAM น้อยต้องดึงเฉพาะที่เปลี่ยน · เครื่องปกติทำงานแบบเดิม
 */
const H = 3600_000
const now = Date.UTC(2026, 10, 13, 1, 0)
const base = { hasLocal: true, now, purged: true, lowMem: false }

describe('chooseSyncMode', () => {
  it('เครื่องปกติ ไม่ได้เปิดข้ามคืน (16–20 ชม.) → ดึงเฉพาะที่เปลี่ยน (เดิมดึงทั้งบริษัททุกเช้า ค้างหลายนาที)', () => {
    expect(chooseSyncMode({ ...base, lastSync: now - 7 * H })).toBe('incremental')
    expect(chooseSyncMode({ ...base, lastSync: now - 20 * H })).toBe('incremental')
  })
  it('เครื่องปกติ ไม่ได้ซิงก์เกิน 7 วัน → ดึงทั้งหมด (ตรวจซ้ำ)', () => {
    expect(chooseSyncMode({ ...base, lastSync: now - 8 * 24 * H })).toBe('full')
  })
  it('เครื่อง RAM น้อย ไม่ได้ซิงก์เกิน 7 วัน → ไม่ดึงทั้งหมดเพราะเวลา', () => {
    expect(chooseSyncMode({ ...base, lastSync: now - 17 * 24 * H, lowMem: true })).toBe('incremental')
  })
  it('เครื่องปกติ รอบล้างประวัติระบบยังไม่ทำ → ดึงทั้งหมด (เหมือนเดิม)', () => {
    expect(chooseSyncMode({ ...base, lastSync: now - H, purged: false })).toBe('full')
  })
  it('เครื่องปกติ เพิ่งซิงก์ → ดึงเฉพาะที่เปลี่ยน', () => {
    expect(chooseSyncMode({ ...base, lastSync: now - H })).toBe('incremental')
  })
  it('เครื่อง RAM น้อย ห่างรอบก่อนข้ามคืน → ดึงเฉพาะที่เปลี่ยน', () => {
    expect(chooseSyncMode({ ...base, lastSync: now - 15 * H, lowMem: true })).toBe('incremental')
  })
  it('เครื่อง RAM น้อย ยังไม่ล้างประวัติระบบ → ไม่บังคับดึงทั้งหมด', () => {
    expect(chooseSyncMode({ ...base, lastSync: now - H, purged: false, lowMem: true })).toBe('incremental')
  })
  it('เครื่อง RAM น้อย ยังไม่เคยซิงก์ / ไม่มีแถวในเครื่อง → ดึงทั้งหมด (ครั้งแรกต้องได้ครบ)', () => {
    expect(chooseSyncMode({ ...base, lastSync: 0, lowMem: true })).toBe('full')
    expect(chooseSyncMode({ ...base, lastSync: now - H, hasLocal: false, lowMem: true })).toBe('full')
  })
})

describe('isLowMemDevice', () => {
  const nav = (deviceMemory?: number) => ({ deviceMemory } as unknown as Navigator)
  it('2 / 4 GB → RAM น้อย · 8 GB → ไม่ใช่', () => {
    expect(isLowMemDevice(nav(2))).toBe(true)
    expect(isLowMemDevice(nav(4))).toBe(true)
    expect(isLowMemDevice(nav(8))).toBe(false)
  })
  it('ไม่รู้ RAM (iPhone/Firefox) → ไม่ใช่ (ทำงานแบบเดิม)', () => {
    expect(isLowMemDevice(nav(undefined))).toBe(false)
    expect(deviceMemoryGb(undefined)).toBeNull()
  })
})

describe('readDeviceInfo', () => {
  it('อ่านรุ่นจาก Client Hints', async () => {
    const n = { deviceMemory: 2, hardwareConcurrency: 8, userAgentData: { platform: 'Android', getHighEntropyValues: async () => ({ model: 'CT40', platformVersion: '11.0.0' }) } } as unknown as Navigator
    const i = await readDeviceInfo(n)
    expect(i).toMatchObject({ model: 'CT40', osVersion: '11.0.0', platform: 'Android', mem: 2, cores: 8, lowMem: true })
  })
  it('ไม่มี Client Hints / ถูกปฏิเสธ → ช่องว่าง ไม่โยน error', async () => {
    expect((await readDeviceInfo({} as Navigator)).model).toBe('')
    const refused = { userAgentData: { getHighEntropyValues: async () => { throw new Error('no') } } } as unknown as Navigator
    expect((await readDeviceInfo(refused)).model).toBe('')
  })
})

describe('รายงานวันละครั้ง', () => {
  it('ยังไม่ส่ง → ถึงกำหนด · ส่งสำเร็จแล้ว → ไม่ส่งซ้ำวันเดียวกัน · แยกชนิด boot/synced', () => {
    const m = new Map<string, string>()
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    expect(dailyReportDue('boot', '2026-11-13', st)).toBe(true)
    markDailyReport('boot', '2026-11-13', st)
    expect(dailyReportDue('boot', '2026-11-13', st)).toBe(false)
    expect(dailyReportDue('synced', '2026-11-13', st)).toBe(true)
    expect(dailyReportDue('boot', '2026-11-14', st)).toBe(true)
  })
  it('รายงานเต็มที่สุดยังไม่เกินช่อง op 1,500 ตัวอักษร (ตัดแล้ว JSON อ่านไม่ได้)', async () => {
    const marks = compactMarks(Array.from({ length: 40 }, (_, i) => ({ name: `idb-done 66665 rows very long name ${i}`, ms: 123456 + i })))
    const info = await readDeviceInfo({ deviceMemory: 2, hardwareConcurrency: 8, userAgentData: { platform: 'Android', getHighEntropyValues: async () => ({ model: 'X'.repeat(40), platformVersion: '13.0.0' }) } } as unknown as Navigator)
    const op = JSON.stringify({ kind: 'synced', ...info, site: 'site-1-3d-thungkrat', rows: 66665, units: 7000, lastSyncAgeH: 123.4, purged: 99, synced: true, long: { n: 9999, total: 999999, max: 99999 }, marks })
    expect(marks.length).toBe(20)
    expect(op.length).toBeLessThan(1500)
  })
})

describe('isWedgeBurst', () => {
  it('17 ตัวติดกันห่าง ~10 ms → ปุ่มยิง', () => {
    expect(isWedgeBurst(Array(16).fill(10), 17)).toBe(true)
  })
  it('คนพิมพ์ (ห่าง 150 ms) / สั้นกว่า 8 ตัว → ไม่ใช่', () => {
    expect(isWedgeBurst(Array(16).fill(150), 17)).toBe(false)
    expect(isWedgeBurst(Array(4).fill(10), 5)).toBe(false)
  })
})
