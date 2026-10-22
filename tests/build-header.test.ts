import { describe, expect, it } from 'vitest'
import { BUILD_HEADER, DEVICE_HEADER, buildHeaders } from '../src/lib/supabase'
import { deviceId } from '../src/lib/heartbeat'

/** ทุกคำขอขึ้นฐานข้อมูลแนบเวลา build + รหัสเครื่อง — ฐานข้อมูลใช้แยกแอปเวอร์ชันเก่าที่ค้างในเครื่อง (supabase-client-build-guard.sql) */
describe('buildHeaders', () => {
  it('แนบ x-sjwd-build เป็นตัวเลข ms ของเวลา build', () => {
    const h = buildHeaders()
    expect(BUILD_HEADER).toBe('x-sjwd-build')
    expect(h[BUILD_HEADER]).toMatch(/^\d{13}$/)
    expect(Number(h[BUILD_HEADER])).toBe(1792500000000)
  })

  it('แนบ x-sjwd-device = รหัสเครื่องเดียวกับที่รายงานใน app_heartbeats', () => {
    expect(DEVICE_HEADER).toBe('x-sjwd-device')
    expect(buildHeaders()[DEVICE_HEADER]).toBe(deviceId())
    expect(buildHeaders('dev-123')[DEVICE_HEADER]).toBe('dev-123')
  })
})
