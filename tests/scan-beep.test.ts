import { afterEach, describe, expect, it, vi } from 'vitest'

/** สแกนติดแล้วมีเสียงปี๊บ (+ สั่นที่เครื่องรองรับ) · ไม่มีเสียงในเครื่องก็ไม่พังการสแกน */

function fakeAudio() {
  const started: number[] = []
  const freqs: number[] = []
  let resumed = 0
  class FakeCtx {
    state = 'suspended'
    currentTime = 1
    destination = {}
    resume() { resumed++; this.state = 'running'; return Promise.resolve() }
    createOscillator() {
      const o = { type: '', frequency: { value: 0 }, connect: (n: unknown) => n, start: (t: number) => { started.push(t); freqs.push(o.frequency.value) }, stop: () => {} }
      return o
    }
    createGain() {
      const g = { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: (n: unknown) => n }
      return g
    }
  }
  return { FakeCtx, started, freqs, resumes: () => resumed }
}

describe('scanBeep', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('แตะเปิดกล้อง = ปลุกเสียงไว้ · สแกนติด = ปี๊บ 2400 Hz ครั้งเดียว และสั่น', async () => {
    const a = fakeAudio()
    vi.stubGlobal('AudioContext', a.FakeCtx)
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, vibrate })
    const { primeScanBeep, scanBeep } = await import('../src/lib/scanBeep')
    primeScanBeep()
    expect(a.resumes()).toBe(1)
    expect(a.started).toEqual([])
    scanBeep()
    expect(a.started).toEqual([1])
    expect(a.freqs).toEqual([2400])
    expect(vibrate).toHaveBeenCalledWith(60)
  })

  it('เครื่องไม่มีเสียง / ไม่มีสั่น: ไม่โยน error', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    vi.stubGlobal('navigator', { ...navigator, vibrate: undefined })
    const { primeScanBeep, scanBeep } = await import('../src/lib/scanBeep')
    expect(() => { primeScanBeep(); scanBeep() }).not.toThrow()
  })
})
