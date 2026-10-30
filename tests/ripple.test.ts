import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installRipple, rippleGeometry } from '../src/lib/ripple'

/** คลื่นตอนกดปุ่ม: วงคลุมทั้งปุ่มจากจุดที่กด · ไม่แตะปุ่มที่ทำให้ตำแหน่งลูกเพี้ยน · ปุ่มปิดใช้งาน / data-no-ripple ไม่มีคลื่น */

const press = (el: Element, x = 10, y = 5) =>
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }))

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect
  }
  return document.body.firstElementChild as HTMLElement
}

describe('คลื่นตอนกดปุ่ม', () => {
  beforeAll(() => installRipple())
  beforeEach(() => { document.body.innerHTML = '' })

  it('วงคลื่นมีศูนย์กลางที่จุดกด รัศมีถึงมุมที่ไกลที่สุด', () => {
    expect(rippleGeometry(100, 40, 0, 0)).toEqual({ size: 2 * Math.ceil(Math.hypot(100, 40)), left: -Math.ceil(Math.hypot(100, 40)), top: -Math.ceil(Math.hypot(100, 40)) })
    const mid = rippleGeometry(100, 40, 50, 20)
    expect(mid.size).toBe(2 * Math.ceil(Math.hypot(50, 20)))
  })

  it('กดปุ่ม: ใส่ชั้นคลื่นเป็นลูกตัวแรก (ข้อความในปุ่มไม่ขยับ) และวงคลื่นขนาดคลุมปุ่ม', () => {
    const btn = mount('<button class="btn"><span>บันทึก</span></button>')
    press(btn.querySelector('span')!, 10, 5)
    const host = btn.firstElementChild as HTMLElement
    expect(host.className).toBe('ripple-host')
    const dot = host.querySelector<HTMLElement>('.ripple')!
    const g = rippleGeometry(100, 40, 10, 5)
    expect(dot.style.width).toBe(`${g.size}px`)
    expect(dot.style.left).toBe(`${g.left}px`)
    expect(btn.lastElementChild!.textContent).toBe('บันทึก')
  })

  it('ปุ่ม position: static ที่มีลูกเป็น absolute: ข้าม ไม่เปลี่ยนตำแหน่งของปุ่ม', () => {
    const btn = mount('<button><span style="position:absolute">3</span>เมนู</button>')
    press(btn)
    expect(btn.querySelector('.ripple-host')).toBeNull()
    expect(btn.style.position).toBe('')
  })

  it('ปุ่มที่ปิดใช้งาน และ data-no-ripple: ไม่มีคลื่น', () => {
    const a = mount('<button disabled>ส่ง</button>')
    press(a)
    expect(a.querySelector('.ripple-host')).toBeNull()
    const b = mount('<div data-no-ripple><button>ส่ง</button></div>')
    press(b.querySelector('button')!)
    expect(b.querySelector('.ripple-host')).toBeNull()
  })

  it('ไม่ใช่ปุ่ม: ไม่มีคลื่น', () => {
    const d = mount('<div><span>ข้อความ</span></div>')
    press(d.querySelector('span')!)
    expect(d.querySelector('.ripple-host')).toBeNull()
  })
})
