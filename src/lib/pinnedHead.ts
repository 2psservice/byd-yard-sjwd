/**
 * ตรึงแถบเครื่องมือ + หัวตาราง ของใบ Grouping ไว้บนจอตอนเลื่อนลง (เลื่อนไปคันที่ 100 ก็ยังกดพิมพ์ได้)
 *
 * แถบเครื่องมือใช้ position: sticky ตรง ๆ ได้ แต่หัวตารางอยู่ในกรอบที่เลื่อนซ้ายขวาได้ (overflow-x)
 * ซึ่งทำให้ sticky ไม่ทำงาน — จึงเลื่อนหัวตารางลงมาเองด้วย transform ให้ไปต่อใต้แถบเครื่องมือพอดี
 * (ค่าใส่ไว้ใน --gh-shift ของตาราง) · ไม่เกินแถวสุดท้าย หัวตารางไม่ลอยทับแถวรวม
 */
import { useEffect, type RefObject } from 'react'

/** px ที่หัวตารางต้องเลื่อนลง: ให้ขอบบนหัวตารางอยู่ใต้แถบเครื่องมือ แต่ไม่ลงเลยแถวสุดท้ายของตาราง */
export function headShift(barBottom: number, tableTop: number, tableH: number, headH: number, footH: number): number {
  const max = Math.max(0, tableH - headH - footH)
  return Math.round(Math.max(0, Math.min(barBottom - tableTop, max)))
}

export function usePinnedHead(barRef: RefObject<HTMLElement | null>, tableRef: RefObject<HTMLTableElement | null>, active: boolean): void {
  useEffect(() => {
    const bar = barRef.current, table = tableRef.current
    if (!active || !bar || !table) return
    const main = table.closest('main')
    const scroller: HTMLElement | Window = main ?? window
    // sticky top:0 sits under the scroller's padding, so the bar parks with rows showing above it —
    // pull it up by that padding (it changes with the screen width) so it sits flush with the top
    const fitTop = () => { bar.style.top = main ? `-${parseFloat(getComputedStyle(main).paddingTop) || 0}px` : '0px' }
    let raf = 0
    let resized = true
    const update = () => {
      raf = 0
      if (resized) { resized = false; fitTop() }
      const t = table.getBoundingClientRect()
      const b = bar.getBoundingClientRect()
      const headH = table.tHead?.offsetHeight ?? 0
      const footH = table.tFoot?.offsetHeight ?? 0
      const shift = headShift(b.bottom, t.top, t.height, headH, footH)
      table.style.setProperty('--gh-shift', `${shift}px`)
      if (shift > 0) table.dataset.headPinned = '1'; else delete table.dataset.headPinned
      // the bar is "stuck" once the table has slid under it
      if (t.top < b.bottom - 0.5) bar.dataset.stuck = '1'; else delete bar.dataset.stuck
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    const onResize = () => { resized = true; onScroll() }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null
    ro?.observe(table)
    update()
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      cancelAnimationFrame(raf)
      table.style.removeProperty('--gh-shift')
      delete table.dataset.headPinned
      delete bar.dataset.stuck
      bar.style.removeProperty('top')
    }
  }, [active, barRef, tableRef])
}
