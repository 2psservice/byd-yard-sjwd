import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { World } from './helpers/world'

/** ซิงก์ทั้งบริษัท (full pull 62k แถว) ไม่ควรแข่งกับหน้าแรก — การดึงแบบ keyset ทดสอบที่ tests/keyset-pull.test.ts */

describe('syncCloudWhenReady — ไม่แข่งกับหน้าแรก', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  async function setup() {
    const w = new World()
    await w.createDevice('A') // mock supabase/db/syncBus/idb ให้ store ใช้
    const trk = await import('../src/store/useTracking')
    const { useYard } = await import('../src/store/useYard')
    return { trk, useYard }
  }

  it('ไม่มียาร์ดที่เลือก → รันทันที', async () => {
    const { trk } = await setup()
    const run = vi.fn()
    trk.syncCloudWhenReady(run, null)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('รถของยาร์ดโหลดเสร็จแล้ว → รันทันที', async () => {
    const { trk, useYard } = await setup()
    useYard.setState({ unitsCloudDone: true })
    const run = vi.fn()
    trk.syncCloudWhenReady(run, 'S1')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('ยังโหลดรถอยู่ → รอ, พอ unitsCloudDone เป็น true จึงรัน "ครั้งเดียว" (เรียกซ้ำระหว่างรอรวมเป็นหนึ่ง)', async () => {
    const { trk, useYard } = await setup()
    useYard.setState({ unitsCloudDone: false })
    const run = vi.fn()
    trk.syncCloudWhenReady(run, 'S1'); trk.syncCloudWhenReady(run, 'S1'); trk.syncCloudWhenReady(run, 'S1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).not.toHaveBeenCalled()
    useYard.setState({ unitsCloudDone: true })
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000) // ตัวจับเวลาเพดานต้องไม่รันซ้ำ
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('โหลดรถไม่เสร็จ (ล้ม/ช้ามาก) → ครบเพดาน 20 วินาทีแล้วรันเอง ไม่ค้างตลอดไป', async () => {
    const { trk, useYard } = await setup()
    useYard.setState({ unitsCloudDone: false })
    const run = vi.fn()
    trk.syncCloudWhenReady(run, 'S1')
    await vi.advanceTimersByTimeAsync(trk.SYNC_AFTER_FIRST_SCREEN_MS - 1)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(run).toHaveBeenCalledTimes(1)
    // หลังรันแล้ว รอบถัดไปรอได้ใหม่ (ไม่ค้างสถานะ "กำลังรอ")
    useYard.setState({ unitsCloudDone: false })
    const run2 = vi.fn()
    trk.syncCloudWhenReady(run2, 'S1')
    useYard.setState({ unitsCloudDone: true })
    expect(run2).toHaveBeenCalledTimes(1)
  })
})
