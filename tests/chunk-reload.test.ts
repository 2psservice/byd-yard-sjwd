import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, _resetChunkReload, isChunkLoadError, reloadForChunkError, shouldReloadForChunk } from '../src/lib/chunkReload'

/** 16 ต.ค. deploy กลางกะ → หน้างานติดจอ "Failed to fetch dynamically imported module" — ต้องรีโหลดเองครั้งเดียว ไม่วน */
describe('chunk reload', () => {
  beforeEach(() => { sessionStorage.clear(); _resetChunkReload() })

  it('จำข้อความ error ของเบราว์เซอร์หลัก ๆ ได้ (Chrome / Safari / Firefox / CSS)', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/YardOps-DTG8s6Ub.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true)
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
  })

  it('รีโหลดครั้งแรก และจำเวลาไว้', () => {
    const reload = vi.fn()
    expect(reloadForChunkError(1_000_000, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1000000')
  })

  it('รีโหลดไปแล้วไม่ถึง 30 วิ (หลังรีโหลดยังล้ม) → ไม่รีโหลดซ้ำ ให้แสดงหน้า error ตามเดิม', () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(1_000_000))
    const reload = vi.fn()
    expect(reloadForChunkError(1_000_000 + 5_000, reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('เกิน 30 วิแล้ว (deploy รอบใหม่) → รีโหลดได้อีก', () => {
    expect(shouldReloadForChunk(1_000_000 + CHUNK_RELOAD_WINDOW_MS + 1, 1_000_000)).toBe(true)
    expect(shouldReloadForChunk(1_000_000 - 1, 1_000_000)).toBe(false) // เวลาเครื่องย้อน
  })

  it('อีเวนต์และ ErrorBoundary เรียกซ้ำในหน้าเดียวกัน → สั่งรีโหลดครั้งเดียว แต่ตอบว่ากำลังรีโหลด', () => {
    const reload = vi.fn()
    expect(reloadForChunkError(1_000_000, reload)).toBe(true)
    expect(reloadForChunkError(1_000_100, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
