import { describe, expect, it } from 'vitest'
import { keepNewerPlacement } from '../src/store/useYard'
import { nextFreeSlotInBlock } from '../src/lib/parkingEngine'
import type { Block, Unit } from '../src/types'

/**
 * 31 ต.ค. 08:07–08:25 NYB2: ช่วง "Loading 99%" หน้าที่ดึงรถค้างมาถึงหลัง Gate-in — สำเนาก่อน Gate-in (EXPECTED ไม่มีช่อง)
 * ลบช่อง WCL ที่เครื่องเพิ่งให้ → Gate-in คันถัดไปได้ช่องเดิมซ้ำ (WCL0284 ซ้อนจากเครื่องเดียว ห่าง 12 วิ)
 */
const SITE = 'site-7-nyb'
const unit = (vin: string, p: Partial<Unit> = {}): Unit =>
  ({ vin, model: 'm', modelName: 'ATTO 3', color: 'White', trailer: 0, status: 'EXPECTED', damages: [], site: SITE, ...p }) as Unit
const WCL: Block = { id: 'WCL', name: 'WCL', rows: 400, cols: 1, zone: 'Y' }
const now = Date.now()
const parked = unit('A', { status: 'PARKED', block: 'WCL', row: 1, slot: 1, parkedAt: now, gateInAt: now, gateInBy: 'อัญชลี', inspected: true })

describe('สำเนาก่อน Gate-in ไม่ลบช่อง WCL ที่เพิ่งให้', () => {
  it('EXPECTED ของยาร์ดเดียวกันมาถึงหลังจอด → คงช่องและสถานะของเรา', () => {
    const out = keepNewerPlacement(parked, unit('A', { status: 'EXPECTED' }))
    expect([out.status, out.block, out.row, out.slot, out.gateInBy]).toEqual(['PARKED', 'WCL', 1, 1, 'อัญชลี'])
  })

  it('Gate-in คันถัดไปบนเครื่องเดียวกันได้ช่องใหม่ ไม่ซ้ำ', () => {
    const merged = keepNewerPlacement(parked, unit('A', { status: 'EXPECTED' }))
    expect(nextFreeSlotInBlock('WCL', [WCL], [merged, unit('B')])).toEqual({ block: 'WCL', row: 2, slot: 1 })
  })

  it('รถออกจริง / รีเซ็ต / ย้ายยาร์ด / จอดนานแล้ว → รับสำเนาที่ไม่มีช่องตามเดิม', () => {
    expect(keepNewerPlacement(parked, unit('A', { status: 'DEPARTED' })).block).toBeUndefined()
    expect(keepNewerPlacement(parked, unit('A', { status: 'GATE_IN' })).block).toBeUndefined()
    expect(keepNewerPlacement(parked, unit('A', { status: 'EXPECTED', site: 'site-1-3d-lcb' })).block).toBeUndefined()
    const old = { ...parked, parkedAt: now - 11 * 60_000 }
    expect(keepNewerPlacement(old, unit('A', { status: 'EXPECTED' })).block).toBeUndefined()
  })
})
