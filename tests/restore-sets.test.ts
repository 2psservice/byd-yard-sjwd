import { describe, expect, it } from 'vitest'
import * as sets from '../src/lib/restoreSets'

/** ชุด VIN ที่สั่งคืนตำแหน่ง: ทุกคันต้องเป็นเลขวินที่ถูกต้อง (check digit) และไม่ซ้ำในชุด — พิมพ์ผิดคันเดียว = คืนผิดคัน */

const T: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
}
const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]
const checkDigitOk = (v: string) => {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false
  const s = [...v].reduce((a, c, i) => a + (/\d/.test(c) ? +c : T[c]) * W[i], 0) % 11
  return v[8] === (s === 10 ? 'X' : String(s))
}

describe('ชุด VIN คืนตำแหน่ง', () => {
  for (const [name, list] of Object.entries(sets)) {
    it(`${name}: ${(list as string[]).length} คัน check digit ถูก ไม่ซ้ำ`, () => {
      const vins = list as string[]
      expect(vins.filter((v) => !checkDigitOk(v))).toEqual([])
      expect(new Set(vins).size).toBe(vins.length)
    })
  }
  it('3D LCB 28 ต.ค. = 8 คันที่แอดมินระบุ', () => {
    expect(sets.LCB_LOST_LOCATION_20261028).toHaveLength(8)
  })
})
