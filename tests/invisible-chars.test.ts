import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement, useState } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { installInvisibleCharGuard, stripInvisible } from '../src/lib/invisibleChars'

/**
 * 09/11 Report 2PS: วาง VIN ที่มีตัวอักษรล่องหนติดมาข้างหน้า → ค้นไม่เจอทั้งสองแท็บ
 * ช่องข้อความทุกช่องต้องตัดตัวล่องหนทิ้งก่อน React อ่านค่า
 */

const VIN = 'LC0CE4CBXT4335837'
let seen = ''
function Box() {
  const [v, setV] = useState('')
  seen = v
  return createElement('input', { type: 'text', value: v, onChange: (e: any) => setV(e.target.value) })
}

let root: Root, el: HTMLDivElement, off: () => void
// what the browser does on paste: set the node's value natively, then fire `input`
const paste = (input: HTMLInputElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('ตัวอักษรล่องหนในช่องข้อความ', () => {
  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    el = document.createElement('div'); document.body.appendChild(el)
    root = createRoot(el); off = installInvisibleCharGuard()
    act(() => { root.render(createElement(Box)) })
  })
  afterEach(() => { off(); act(() => root.unmount()); el.remove() })

  it('ตัดตัวล่องหนที่ติดมากับ VIN ที่วาง (zero-width / ตัวกำหนดทิศทาง / BOM) · ZWJ ของอีโมจิไม่ตัด', () => {
    for (const junk of ['​', '‪', '‎', '﻿', '⁦']) expect(stripInvisible(`${junk}${VIN}${junk}`)).toBe(VIN)
    expect(stripInvisible('👨‍👩')).toBe('👨‍👩')
  })

  it('วาง "\\u202A" + VIN ในช่องค้นหา → React ได้ VIN สะอาด ค้นแล้วเจอ', () => {
    const input = el.querySelector('input')!
    paste(input, `‪${VIN}‬`)
    expect(seen).toBe(VIN)
    expect(input.value).toBe(VIN)
    expect(VIN.includes(seen.trim().toUpperCase())).toBe(true)
  })

  it('ข้อความปกติ (ไทย / ช่องว่าง) ไม่ถูกแตะ', () => {
    const input = el.querySelector('input')!
    paste(input, 'รอยขีดลึก ประตู LH')
    expect(seen).toBe('รอยขีดลึก ประตู LH')
  })
})
