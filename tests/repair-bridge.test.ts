import { describe, expect, it, vi } from 'vitest'
import { attachRepairBridge, matchDamage, sjwdDefectRows, writeBackPlan } from '../src/lib/repairBridge'
import { ACCESSORY_TAB_LABELS } from '../src/lib/finalCheckList'

/**
 * เมนูช่าง ↔ Defect ของ SJWD
 *  - แอปงานซ่อมค้นแผลของ VIN จากชีต Defect-Yard → ได้ Defect สดของ SJWD ในรูปแถวเดียวกับไฟล์ Co
 *  - ช่างบันทึกงานว่าซ่อมแล้ว / ACC → Defect เดียวกันใน SJWD ขยับออกจาก Waiting Repair ตาม
 */

const VIN = 'LC0CE4CB2T4321172'
const dmg = (id: string, o: object = {}) => ({ id, area: 'Rear Bumper', areaTh: 'กันชนหลัง', item: 'Dent', itemTh: 'บุบ', type: 'dent', severity: 'minor', at: new Date(2026, 10, 3, 9, 0).getTime(), by: 'qc', statusRepair: 'Waiting Repair', categoryRepair: 'Re Dent', incharge: 'SJWD', ...o })
const units = () => ({
  [VIN]: { vin: VIN, model: 'atto2', modelName: 'BYD ATTO 2', color: 'BLACK', trailer: 0, status: 'parked', site: 'nyb2', damages: [
    dmg('d1'),
    dmg('d2', { area: 'Front Door LH', areaTh: 'ประตูหน้าซ้าย', item: 'Scratch', itemTh: 'รอยขีดข่วน', type: 'scratch', statusRepair: 'ACC BYD' }),
    dmg('d3', { area: 'Hood', areaTh: '', item: 'Stone chip', itemTh: '', type: 'chip', statusRepair: undefined }),
    // a stock count, not a defect
    { id: 'acc', area: 'Accessory', item: `${ACCESSORY_TAB_LABELS[0]} · กุญแจ 2/2`, type: 'accessory', severity: 'minor', at: 0, by: 'x', source: 'accessoryImport' },
  ] },
}) as any
const rows = { [VIN]: { vin: VIN, site: 'nyb2', updatedAt: 0, history: [], cells: { Vin: VIN, Model: 'ATTO 2', 'Stock of Status': 'Stock' } } } as any
const siteName = (id?: string) => (id === 'nyb2' ? 'NYB2 Phase 2' : '')

describe('SJWD → แอปงานซ่อม: Defect สดในรูปแถว Defect-Yard', () => {
  it('แถวละแผล ช่องเรียงตามไฟล์ Co · ไม่เอารายการนับของ', () => {
    const r = sjwdDefectRows(units(), rows, siteName)
    expect(r).toHaveLength(3)
    expect(r[0]).toEqual([VIN, 'Rear Bumper', 'Dent', 'Waiting Repair', 'Re Dent', 'SJWD', 'Stock', '2026-11-03', 'ATTO 2', 'NYB2 Phase 2'])
    expect(r[1][3]).toBe('ACC BYD')
    expect(r[2][3]).toBe('Waiting Repair') // no status yet = waiting
  })
})

describe('แอปงานซ่อม → SJWD: บันทึกซ่อมแล้ว ปิด Defect เดียวกัน', () => {
  const job = (o: object) => ({ id: 'j1', vin: VIN, part: 'Rear Bumper', partTH: 'กันชนหลัง', problem: 'Dent', problemTH: 'บุบ', status: 'done', tech: 'ช่างกัน', repairDate: '2026-11-04', ...o })

  it('จับคู่ด้วยตำแหน่ง + อาการ (อังกฤษหรือไทย) เฉพาะแผลที่ยังรอซ่อม', () => {
    const u = units()[VIN]
    expect(matchDamage(u, job({}), new Set())?.id).toBe('d1')
    expect(matchDamage(u, job({ part: '', problem: '', partTH: 'กันชนหลัง', problemTH: 'บุบ' }), new Set())?.id).toBe('d1')
    // ACC BYD already — never reopened or overwritten
    expect(matchDamage(u, job({ part: 'Front Door LH', partTH: '', problem: 'Scratch', problemTH: '' }), new Set())).toBeNull()
    // same position, different defect → no match
    expect(matchDamage(u, job({ problem: 'Scratch', problemTH: 'รอยขีดข่วน' }), new Set())).toBeNull()
  })

  it('ซ่อมแล้ว → Repaired พร้อมวันที่ซ่อมและชื่อช่าง · ACC → ACC ตามแอป · รอซ่อม / ซ่อมไม่ได้ ไม่แตะ', () => {
    const now = Date.now()
    const plan = writeBackPlan(units(), [job({}), job({ id: 'j2', part: 'Hood', partTH: '', problem: 'Stone chip', problemTH: '', status: 'accsjwd' }),
      job({ id: 'j3', status: 'wait' }), job({ id: 'j4', status: 'cant' })], now)
    expect(plan.map((p) => [p.damage.id, p.patch.statusRepair])).toEqual([['d1', 'Repaired'], ['d3', 'ACC SJWD']])
    expect(new Date(plan[0].patch.repairDate!).getDate()).toBe(4)
    expect(plan[0].patch.repairedBy).toBe('ช่างกัน')
    expect(plan[0].patch.repairHistory!.at(-1)).toMatchObject({ status: 'Repaired', from: 'Waiting Repair', by: 'ช่างกัน · แอปงานซ่อม' })
  })

  it('สองงานของแผลเดียวกันปิดแผลได้ครั้งเดียว', () => {
    const plan = writeBackPlan(units(), [job({}), job({ id: 'j9' })], Date.now())
    expect(plan).toHaveLength(1)
  })
})

describe('ต่อเข้ากับแอปงานซ่อมโดยไม่แก้ไฟล์ของแอป', () => {
  it('ค้นแผลได้ Defect ของ SJWD แทนไฟล์ Co ของคันเดียวกัน · คันที่ SJWD ไม่มียังใช้ไฟล์ Co · บันทึกงานแล้วอัปเดต SJWD', async () => {
    const coRows = [[VIN, 'Old pos', 'Old def', 'Waiting Repair', '', '', '', '', '', ''], ['LOTHERVIN00000001', 'Roof', 'Dent', '', '', '', '', '', '', '']]
    const win: any = {
      coDefLoad: vi.fn(async () => ({ name: 'Co 03-11', rows: coRows, at: 1 })),
      sbPushJobs: vi.fn(async () => true),
    }
    const updateDamage = vi.fn()
    const onWriteBack = vi.fn()
    const linked = attachRepairBridge(win, { units, rows: () => rows, siteName, updateDamage, onWriteBack })
    expect(linked).toEqual({ defects: true, writeBack: true })

    const def = await win.coDefLoad()
    expect(def.rows.filter((r: string[]) => r[0] === VIN).map((r: string[]) => r[1])).toEqual(['Rear Bumper', 'Front Door LH', 'Hood'])
    expect(def.rows.some((r: string[]) => r[0] === 'LOTHERVIN00000001')).toBe(true)
    expect(def._dd).toBe(true)
    expect(def.name).toContain('SJWD')

    await win.sbPushJobs([{ id: 'j1', vin: VIN, part: 'Rear Bumper', problem: 'Dent', status: 'done', tech: 'ช่างกัน' }])
    expect(updateDamage).toHaveBeenCalledWith(VIN, 'd1', expect.objectContaining({ statusRepair: 'Repaired' }))
    expect(onWriteBack).toHaveBeenCalledWith(1)
  })

  it('บันทึกขึ้นคลาวด์ของแอปไม่สำเร็จ → ไม่แตะ SJWD · แอปเวอร์ชันที่ไม่มีฟังก์ชันเหล่านี้ → ไม่ทำอะไรเลย', async () => {
    const win: any = { sbPushJobs: vi.fn(async () => { throw new Error('offline') }) }
    const updateDamage = vi.fn()
    attachRepairBridge(win, { units, rows: () => rows, siteName, updateDamage })
    await expect(win.sbPushJobs([{ vin: VIN, part: 'Rear Bumper', problem: 'Dent', status: 'done' }])).rejects.toThrow('offline')
    expect(updateDamage).not.toHaveBeenCalled()
    expect(attachRepairBridge({}, { units, rows: () => rows, siteName, updateDamage })).toEqual({ defects: false, writeBack: false })
  })
})
