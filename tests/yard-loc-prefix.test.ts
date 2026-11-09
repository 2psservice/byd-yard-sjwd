import { describe, expect, it } from 'vitest'
import { siteGroupingConfig, yardLocPrefix } from '../src/lib/groupingImport'

/** ตัวย่อยาร์ดหน้า Location ในใบ Grouping / ใบหารถ (admin 09/11): 3 ตัวแรกของชื่อยาร์ด · ยาร์ด "xx ไร่" ใช้ตัวเลข */
describe('ตัวย่อยาร์ดของ Location', () => {
  it('3 ตัวแรกของชื่อ ไม่นับช่องว่าง · ยาร์ดไร่ใช้ตัวเลข', () => {
    const got = Object.fromEntries(['60 RAI', '3D LCB', '3D RINCHA', '3D THUNGKRAT', 'NYB2 Phase 2', 'Rayong', '20 Rai', '38 Rai', 'SOI 5'].map((n) => [n, yardLocPrefix(n)]))
    expect(got).toEqual({ '60 RAI': '60', '3D LCB': '3DL', '3D RINCHA': '3DR', '3D THUNGKRAT': '3DT', 'NYB2 Phase 2': 'NYB', Rayong: 'RAY', '20 Rai': '20', '38 Rai': '38', 'SOI 5': 'SOI' })
  })
  it('ใบพิมพ์ใช้ตัวย่อใหม่ · การเลือก sheet ในไฟล์ยังเหมือนเดิม', () => {
    expect(siteGroupingConfig('3D LCB')).toEqual({ sheetKeys: ['3dl'], prefix: '3DL' })
    expect(siteGroupingConfig('NYB2 Phase 2')).toEqual({ sheetKeys: ['nyb'], prefix: 'NYB' })
    expect(siteGroupingConfig('Rayong')).toEqual({ sheetKeys: ['ry', 'rayong'], prefix: 'RAY' })
    expect(siteGroupingConfig('60 RAI').prefix).toBe('60')
  })
})
