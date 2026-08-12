import { createClient } from '@supabase/supabase-js'

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

export const supabase = createClient(
  SUPABASE_URL ?? 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY ?? 'placeholder-key',
  {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 20 } },
  },
)
