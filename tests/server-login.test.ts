import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * ความปลอดภัย ระยะ 1: ล็อกอิน/จัดการผู้ใช้ผ่านฟังก์ชันฝั่งเซิร์ฟเวอร์ (supabase-security-phase1.sql)
 * เบราว์เซอร์ไม่ถือรหัสผ่าน/hash ของใคร · ไม่มีบัญชีเริ่มต้นในโค้ด · ไม่อัปโหลดรายชื่อจากเครื่อง
 */
async function setup(rpc: (fn: string, args: any) => Promise<{ data: any; error: any }>, roster: any[] = []) {
  vi.resetModules(); localStorage.clear()
  const upserts: any[] = []
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: {
      channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {},
      rpc: vi.fn(rpc),
      from: (table: string) => ({
        select: async () => ({ data: table === 'app_users_public' ? roster : [], error: null }),
        upsert: async (row: any) => { upserts.push({ table, row }); return { error: null } },
      }),
    },
  }))
  const { useYard } = await import('../src/store/useYard')
  const { supabase } = await import('../src/lib/supabase')
  return { useYard, rpc: (supabase as any).rpc as ReturnType<typeof vi.fn>, upserts }
}

describe('ล็อกอินที่เซิร์ฟเวอร์', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('ไม่มีบัญชีเริ่มต้น admin/admin ในเครื่อง', async () => {
    const { useYard } = await setup(async () => ({ data: null, error: null }))
    expect(useYard.getState().appUsers).toEqual([])
  })

  it('รหัสถูก → เข้าระบบ เก็บโทเค็น · รายชื่อในเครื่องไม่มีรหัสผ่าน', async () => {
    const { useYard, rpc } = await setup(async (fn) => fn === 'sjwd_login'
      ? { data: { id: 'u9', name: 'สมใจ', role: 'admin', username: 'somjai', active: true, token: 'tok-1' }, error: null }
      : { data: null, error: null })
    expect(await useYard.getState().login('somjai', 'pw')).toBe(true)
    expect(rpc).toHaveBeenCalledWith('sjwd_login', { p_username: 'somjai', p_password: 'pw' })
    const st = useYard.getState()
    expect(st.loggedInUserId).toBe('u9')
    expect(st.sessionToken).toBe('tok-1')
    expect(st.appUsers.find((u) => u.id === 'u9')?.password).toBeUndefined()
  })

  it('รหัสผิด → ไม่เข้า · ติดต่อเซิร์ฟเวอร์ไม่ได้ → ไม่เข้า', async () => {
    const wrong = await setup(async () => ({ data: null, error: null }))
    expect(await wrong.useYard.getState().login('x', 'y')).toBe(false)
    const offline = await setup(async () => ({ data: null, error: { message: 'fetch failed' } }))
    expect(await offline.useYard.getState().login('x', 'y')).toBe(false)
    expect(offline.useYard.getState().loggedInUserId).toBeNull()
  })

  it('คลาวด์ว่าง → ไม่อัปโหลดรายชื่อจากเครื่องขึ้นไป', async () => {
    const { useYard, upserts } = await setup(async () => ({ data: null, error: null }), [])
    useYard.setState({ appUsers: [{ id: 'z', name: 'z', role: 'admin', active: true, username: 'z', password: 'z' }] } as any)
    await useYard.getState().loadAppUsersFromCloud()
    expect(upserts).toEqual([])
    expect(useYard.getState().appUsers).toEqual([])
  })

  it('เพิ่ม/แก้/ลบผู้ใช้ส่งผ่านฟังก์ชัน admin พร้อมโทเค็น และส่งรหัสจริงให้เซิร์ฟเวอร์ hash', async () => {
    const { useYard, rpc } = await setup(async (fn) => ({ data: fn === 'sjwd_admin_save_user' ? { id: 'n1' } : null, error: null }))
    useYard.setState({ sessionToken: 'tok-a', appUsers: [] } as any)
    useYard.getState().addAppUser('ใหม่', 'driver', 'new1', 'secret')
    await vi.waitFor(() => expect(useYard.getState().appUsers.map((u) => u.id)).toEqual(['n1']))
    expect(rpc).toHaveBeenCalledWith('sjwd_admin_save_user', expect.objectContaining({ p_token: 'tok-a', p_username: 'new1', p_password: 'secret' }))
    useYard.getState().updateAppUser('n1', { active: false })
    await vi.waitFor(() => expect(useYard.getState().appUsers[0].active).toBe(false))
    expect(rpc).toHaveBeenLastCalledWith('sjwd_admin_save_user', expect.objectContaining({ p_id: 'n1', p_active: false, p_password: null }))
    useYard.getState().removeAppUser('n1')
    await vi.waitFor(() => expect(useYard.getState().appUsers).toEqual([]))
    expect(rpc).toHaveBeenLastCalledWith('sjwd_admin_delete_user', { p_token: 'tok-a', p_id: 'n1' })
  })

  it('เซิร์ฟเวอร์ปฏิเสธ (ไม่ใช่ admin) → รายชื่อในเครื่องไม่เปลี่ยน', async () => {
    const { useYard } = await setup(async () => ({ data: null, error: { message: 'SJWD_NOT_ADMIN' } }))
    useYard.setState({ sessionToken: 'tok-d', appUsers: [{ id: 'a', name: 'A', role: 'driver', active: true, username: 'a' }] } as any)
    useYard.getState().updateAppUser('a', { role: 'admin' })
    await new Promise((r) => setTimeout(r, 0))
    expect(useYard.getState().appUsers[0].role).toBe('driver')
  })
})

describe('csvSafe (กันสูตร Excel)', () => {
  it('ใส่ \' นำหน้าค่าที่ขึ้นต้นด้วย = + - @ · ตัวเลขติดลบ/ข้อความปกติไม่แตะ', async () => {
    const { csvSafe } = await import('../src/lib/excel')
    expect(csvSafe('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`)
    expect(csvSafe('+cmd')).toBe(`'+cmd`)
    expect(csvSafe('@SUM(A1)')).toBe(`'@SUM(A1)`)
    expect(csvSafe('-5')).toBe('-5')
    expect(csvSafe('12.5')).toBe('12.5')
    expect(csvSafe('LC0C74C4XTG022362')).toBe('LC0C74C4XTG022362')
  })
})
