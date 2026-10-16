import { describe, expect, it } from 'vitest'
import { HEARTBEAT_MIN_INTERVAL_MS, buildHeartbeat, deviceId, shouldSendHeartbeat } from '../src/lib/heartbeat'

/** แต่ละเครื่องรายงานเวอร์ชันแอปขึ้นคลาวด์ — ตามหาเครื่องที่ยังไม่อัปเดต (เครื่องแอปเก่าเคยล้าง/ย้ายตำแหน่งรถหลายร้อยคัน) */
describe('heartbeat', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

  it('รหัสเครื่องสุ่มครั้งแรกแล้วจำไว้ใช้ซ้ำ', () => {
    const st = mem()
    const a = deviceId(st)
    expect(a.length).toBeGreaterThan(8)
    expect(deviceId(st)).toBe(a)
    expect(deviceId(mem())).not.toBe(a)
  })

  it('เก็บข้อมูลไม่ได้ (private mode) → ยังทำงาน ไม่ throw', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(deviceId(broken)).toBe('no-storage')
  })

  it('ส่งครั้งแรก · ไม่ส่งซ้ำภายใน 15 นาที · ส่งเมื่อผู้ใช้/ยาร์ดเปลี่ยน · เวลาย้อนก็ส่ง', () => {
    expect(shouldSendHeartbeat(1_000, null, 'u|s')).toBe(true)
    expect(shouldSendHeartbeat(1_000 + 60_000, { at: 1_000, key: 'u|s' }, 'u|s')).toBe(false)
    expect(shouldSendHeartbeat(1_000 + HEARTBEAT_MIN_INTERVAL_MS, { at: 1_000, key: 'u|s' }, 'u|s')).toBe(true)
    expect(shouldSendHeartbeat(2_000, { at: 1_000, key: 'u|s' }, 'u|s2')).toBe(true)
    expect(shouldSendHeartbeat(500, { at: 1_000, key: 'u|s' }, 'u|s')).toBe(true)
  })

  it('แถวที่ส่ง: ตัด user-agent ยาว ไม่ส่งเวลาจากเครื่อง (เซิร์ฟเวอร์ใส่เอง)', () => {
    const row = buildHeartbeat({ deviceId: 'd1', userId: 'u1', userName: 'บาส km', siteId: 'site-7-nyb', build: '16 Oct, 11:18 · 627253d', userAgent: 'x'.repeat(500), standalone: true })
    expect(row.user_agent.length).toBe(300)
    expect(row).toMatchObject({ device_id: 'd1', user_name: 'บาส km', site_id: 'site-7-nyb', build: '16 Oct, 11:18 · 627253d', standalone: true })
    expect(Object.keys(row)).not.toContain('last_seen')
  })
})
