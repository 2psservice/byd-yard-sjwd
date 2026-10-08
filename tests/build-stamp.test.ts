import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BuildStamp } from '../src/components/BuildStamp'

/** เลข build ท้ายเมนู Yard Ops — ไว้เช็กรายเครื่องว่าอัปเดตแล้วหรือยัง */
describe('BuildStamp', () => {
  it('แสดง "build <เลข build>" (vitest กำหนด __BUILD__ = test) พร้อม data-testid และเลือกคัดลอกได้', () => {
    const html = renderToStaticMarkup(createElement(BuildStamp))
    expect(html).toContain('data-testid="build-stamp"')
    expect(html).toContain('build test')
    expect(html).toContain('select-all')
  })
  it('รับ className เพิ่มได้ (ใช้ w-full ในแถบสถานะ)', () => {
    expect(renderToStaticMarkup(createElement(BuildStamp, { className: 'w-full' }))).toContain('w-full')
  })
})
