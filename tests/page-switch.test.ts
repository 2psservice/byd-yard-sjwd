import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { PAGE_OUT_MS, usePageSwitch } from '../src/lib/pageSwitch'

/** เปลี่ยนหน้าแบบหน้าเดิมออกก่อน: สลับหลังจางออก · กดรัวได้หน้าสุดท้าย · กดกลับหน้าเดิมระหว่างจาง = ยกเลิก · แถบโหลดรอหน้าใหม่ขึ้นจริง */

let latest: ReturnType<typeof usePageSwitch<string>>
const prefetched: string[] = []
function Probe({ view }: { view: string }) {
  latest = usePageSwitch(view, (v) => prefetched.push(v))
  return null
}

let root: Root
let el: HTMLDivElement
const render = (view: string) => act(() => { root.render(createElement(Probe, { view })) })

describe('เปลี่ยนหน้าแบบหน้าเดิมออกก่อน', () => {
  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    prefetched.length = 0
    el = document.createElement('div'); document.body.appendChild(el)
    root = createRoot(el)
  })
  afterEach(() => { act(() => root.unmount()); el.remove(); vi.useRealTimers() })

  it('หน้าเดิมจางออกก่อน แล้วค่อยสลับ · โหลดไฟล์หน้าใหม่ไว้ก่อน · แถบโหลดค้างจนหน้าใหม่บอกว่าขึ้นแล้ว', () => {
    render('dashboard')
    expect(latest).toMatchObject({ shown: 'dashboard', leaving: false, busy: false })
    render('operation')
    expect(latest).toMatchObject({ shown: 'dashboard', leaving: true, busy: true })
    expect(prefetched).toEqual(['operation'])
    act(() => { vi.advanceTimersByTime(PAGE_OUT_MS) })
    expect(latest).toMatchObject({ shown: 'operation', leaving: false, busy: true })
    act(() => latest.onReady())
    expect(latest.busy).toBe(false)
  })

  it('กดรัว 2 เมนู: นับเวลาใหม่ แสดงหน้าสุดท้ายที่กด', () => {
    render('dashboard')
    render('units')
    act(() => { vi.advanceTimersByTime(PAGE_OUT_MS - 50) })
    render('grouping')
    act(() => { vi.advanceTimersByTime(PAGE_OUT_MS - 50) })
    expect(latest.shown).toBe('dashboard')
    act(() => { vi.advanceTimersByTime(50) })
    expect(latest).toMatchObject({ shown: 'grouping', leaving: false })
  })

  it('กดกลับหน้าเดิมระหว่างจางออก: ยกเลิก ไม่สลับ แถบโหลดหยุด', () => {
    render('dashboard')
    render('units')
    render('dashboard')
    expect(latest).toMatchObject({ shown: 'dashboard', leaving: false, busy: false })
    act(() => { vi.advanceTimersByTime(PAGE_OUT_MS * 2) })
    expect(latest.shown).toBe('dashboard')
  })
})
