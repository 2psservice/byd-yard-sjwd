import { describe, expect, it } from 'vitest'
import { BUILD_HEADER, buildHeaders } from '../src/lib/supabase'

/** ทุกคำขอขึ้นฐานข้อมูลแนบเวลา build — ฐานข้อมูลใช้แยกแอปเวอร์ชันเก่าที่ค้างในเครื่อง (supabase-client-build-guard.sql) */
describe('buildHeaders', () => {
  it('แนบ x-sjwd-build เป็นตัวเลข ms ของเวลา build', () => {
    const h = buildHeaders()
    expect(BUILD_HEADER).toBe('x-sjwd-build')
    expect(h[BUILD_HEADER]).toMatch(/^\d{13}$/)
    expect(Number(h[BUILD_HEADER])).toBe(1792500000000)
  })
})
