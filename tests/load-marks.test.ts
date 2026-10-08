import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** ตัวจับเวลาช่วงโหลด: เวลานับจาก site-load-start ล่าสุด, ล้างของรอบก่อน, ไม่แสดงผลถ้าไม่ได้เปิดสวิตช์ */
describe('loadMarks', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); document.body.innerHTML = '' })
  afterEach(() => { vi.restoreAllMocks() })

  it('เวลานับจาก site-load-start และรอบใหม่ล้างรอบเก่า', async () => {
    const now = vi.spyOn(performance, 'now')
    const m = await import('../src/lib/loadMarks')
    now.mockReturnValue(1000); m.loadMark('site-load-start')
    now.mockReturnValue(1300); m.loadMark('site-count')
    now.mockReturnValue(5300); m.loadMark('site-rows-done')
    expect(m.getLoadMarks()).toEqual([
      { name: 'site-load-start', ms: 0 }, { name: 'site-count', ms: 300 }, { name: 'site-rows-done', ms: 4300 },
    ])
    now.mockReturnValue(9000); m.loadMark('site-load-start') // เลือกยาร์ดใหม่
    now.mockReturnValue(9100); m.loadMark('units-done')
    expect(m.getLoadMarks()).toEqual([{ name: 'site-load-start', ms: 0 }, { name: 'units-done', ms: 100 }])
  })

  it('ไม่เปิดสวิตช์ → ไม่สร้างข้อความบนหน้าและไม่พิมพ์ Console', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const m = await import('../src/lib/loadMarks')
    m.loadMark('site-load-start'); m.loadMark('units-done')
    expect(document.querySelector('[data-testid="load-marks"]')).toBeNull()
    expect(info).not.toHaveBeenCalled()
  })

  it('เปิดด้วย localStorage loadmarks=1 → ขึ้นข้อความบนหน้าและพิมพ์ Console', async () => {
    localStorage.setItem('loadmarks', '1')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const m = await import('../src/lib/loadMarks')
    m.loadMark('site-load-start'); m.loadMark('units-done')
    const box = document.querySelector('[data-testid="load-marks"]')
    expect(box?.textContent).toContain('units-done')
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[load] units-done'))
  })
})
