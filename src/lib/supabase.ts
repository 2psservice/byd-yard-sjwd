import { createClient } from '@supabase/supabase-js'
import { deviceId } from './heartbeat'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** true เมื่อตั้งค่า env ครบ — ถ้า false ระบบทำงาน offline (localStorage เท่านั้น) */
export const isConfigured = () =>
  !!SUPABASE_URL &&
  !SUPABASE_URL.includes('xxxxxxxxxxxxxxxxxxxx') &&
  !SUPABASE_URL.includes('your-project') && // .env.example placeholder ≠ configured
  !!SUPABASE_ANON_KEY &&
  !SUPABASE_ANON_KEY.includes('your-anon-key-here') &&
  !SUPABASE_ANON_KEY.includes('your-anon-public-key')

/**
 * หัวคำขอบอกเวอร์ชันแอป (เวลา build, ms) — ทุกคำขอขึ้นฐานข้อมูลแนบไปด้วย
 * ฐานข้อมูลใช้แยก "แอปเวอร์ชันเก่าที่ค้างในเครื่อง" (ไม่มีหัวนี้ หรือเลขต่ำกว่าที่กำหนด) — จดไว้ และเมื่อเปิดล็อกแล้วไม่ให้เขียน
 * (supabase-client-build-guard.sql) · 20 ต.ค. โน้ตบุ๊กที่เปิดแอปเวอร์ชันก่อน 3 ต.ค. ย้ายแถวรถ 144 คันข้ามยาร์ดเองในชื่อคนที่ล็อกอินค้าง
 */
export const BUILD_HEADER = 'x-sjwd-build'
/** รหัสเครื่อง (ตัวเดียวกับ app_heartbeats.device_id) — log ของตัวกันจึงบอกได้ว่าเป็นเครื่องของใคร
 *  (22 ต.ค. ชนิดเครื่อง/เบราว์เซอร์อย่างเดียวแยกมือถือรุ่นเดียวกันไม่ออก) */
export const DEVICE_HEADER = 'x-sjwd-device'
export const buildHeaders = (device: string = deviceId()): Record<string, string> =>
  ({ [BUILD_HEADER]: String(__BUILD_AT__), [DEVICE_HEADER]: device })

export const supabase = createClient(
  SUPABASE_URL ?? 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY ?? 'placeholder-key',
  {
    global: { headers: buildHeaders() },
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 20 } },
  },
)
