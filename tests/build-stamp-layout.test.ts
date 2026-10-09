import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

/** หน้าแอดมิน (Layout) แสดงเลข build ในแถบล่างทุกหน้า — ไว้เช็กรายเครื่องว่าอัปเดตแล้วหรือยัง */
describe('Layout footer — เลข build', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })
  it('แถบล่างมี build stamp (vitest กำหนด __BUILD__ = test) ข้างวันที่', async () => {
    vi.resetModules(); localStorage.clear()
    vi.doMock('../src/lib/supabase', () => ({
      isConfigured: () => false,
      supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
    }))
    const { Layout } = await import('../src/components/Layout')
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    flushSync(() => root.render(createElement(Layout, null, createElement('div', null, 'content'))))
    const footer = host.querySelector('footer')
    const stamp = host.querySelector('[data-testid="build-stamp"]')
    expect(footer, 'มีแถบล่าง').toBeTruthy()
    expect(stamp, 'มีเลข build').toBeTruthy()
    expect(footer!.contains(stamp), 'เลข build อยู่ในแถบล่าง').toBe(true)
    expect(stamp!.textContent).toContain('build test')
    root.unmount(); host.remove()
  })
})
