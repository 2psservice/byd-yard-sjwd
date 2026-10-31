/**
 * ตรึงแถบพิมพ์ / Excel ของใบ Grouping ไว้บนสุดของจอตอนเลื่อนลง (เลื่อนไปคันที่ 100 ก็ยังกดพิมพ์ได้)
 * หัวตารางสีเหลืองไม่ตรึง เลื่อนไปกับตารางตามปกติ
 *
 * ตัวแถบเป็น position: sticky (CSS .gdoc-bar) — ที่นี่แค่ดึงแถบขึ้นเท่ากับ padding ของ <main>
 * ให้ชิดขอบบนพอดี (sticky top:0 ค้างอยู่ใต้ padding แถวตารางเลยโผล่เหนือแถบ) และติด data-stuck
 * ตอนแถบค้างอยู่ ให้มีเงาบาง ๆ แยกจากตารางด้านล่าง
 */
import { useEffect, type RefObject } from 'react'

export function useStickyBar(barRef: RefObject<HTMLElement | null>, belowRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const bar = barRef.current, below = belowRef.current
    if (!active || !bar || !below) return
    const main = bar.closest('main')
    const scroller: HTMLElement | Window = main ?? window
    const fitTop = () => { bar.style.top = main ? `-${parseFloat(getComputedStyle(main).paddingTop) || 0}px` : '0px' }
    let raf = 0
    const update = () => {
      raf = 0
      // stuck = what sits under the bar has slid up behind it
      if (below.getBoundingClientRect().top < bar.getBoundingClientRect().bottom - 0.5) bar.dataset.stuck = '1'
      else delete bar.dataset.stuck
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    const onResize = () => { fitTop(); onScroll() }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    fitTop(); update()
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
      delete bar.dataset.stuck
      bar.style.removeProperty('top')
    }
  }, [active, barRef, belowRef])
}
