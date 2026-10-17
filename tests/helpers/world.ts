/**
 * โลกจำลองสำหรับทดสอบการ sync ตำแหน่งรถ — "คลาวด์" ในหน่วยความจำ + สาย broadcast + หลายเครื่อง
 *
 * 1 เครื่อง = สำเนา useYard store ชุดใหม่ (vi.resetModules + import ใหม่) ที่ต่อกับคลาวด์/สายเดียวกัน
 * จึงมี state ระดับโมดูลของตัวเอง (posShared, placementIntent, คิวเขียน) เหมือนมือถือคนละเครื่องจริง
 * ทุกอย่างใช้ fake timers: เวลาในโลกนี้เดินเมื่อสั่ง world.advance(ms) เท่านั้น
 */
import { vi } from 'vitest'
import type { Unit } from '../../src/types'

type Handler = (payload: any) => void
export interface Device {
  name: string
  yard: typeof import('../../src/store/useYard')['useYard']
  mod: typeof import('../../src/store/useYard')
}

export class World {
  /** ตาราง units บนคลาวด์ (vin → แถว) */
  cloud = new Map<string, Unit>()
  /** ผลักการเขียนขึ้นคลาวด์ให้ช้า/ล้มเหลวได้ */
  writeLatencyMs = 0
  failWrites = false
  /** ให้การเขียน "ลงทะเบียนรถ" (importUnits) ถึงคลาวด์ช้ากว่าการเขียนอื่น — จำลองการแข่งกันตอน Confirm Gate-in */
  registerDelayMs = 0
  /** ความหน่วงของสาย broadcast */
  busDelayMs = 0
  private handlers = new Map<string, Map<string, Handler[]>>() // device → event → handlers
  log: string[] = []

  seedCloud(u: Unit) { this.cloud.set(u.vin, { ...u }) }

  /** ส่ง payload ไปทุกเครื่องยกเว้นผู้ส่ง (เหมือน broadcast self:false) */
  deliver(from: string, event: string, payload: unknown) {
    for (const [dev, evs] of this.handlers) {
      if (dev === from) continue
      for (const h of evs.get(event) ?? []) setTimeout(() => h(JSON.parse(JSON.stringify(payload))), this.busDelayMs)
    }
  }
  register(dev: string, event: string, h: Handler) {
    const evs = this.handlers.get(dev) ?? new Map<string, Handler[]>()
    evs.set(event, [...(evs.get(event) ?? []), h])
    this.handlers.set(dev, evs)
  }

  async write(units: Unit[]) {
    if (this.writeLatencyMs) await new Promise<void>((r) => setTimeout(r, this.writeLatencyMs))
    if (this.failWrites) throw new Error('network down')
    for (const u of units) this.cloud.set(u.vin, { ...u })
  }

  async advance(ms: number) { await vi.advanceTimersByTimeAsync(ms) }

  async createDevice(name: string): Promise<Device> {
    const world = this
    vi.resetModules()
    localStorage.clear() // persist hydrate ต้องไม่ปนกับเครื่องอื่น
    vi.doMock('../../src/lib/supabase', () => ({
      isConfigured: () => true,
      supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
    }))
    vi.doMock('../../src/lib/idb', async (orig) => ({
      ...(await orig<object>()),
      idbGetAllUnits: async () => [], idbPutUnits: async () => {}, idbDeleteUnits: async () => {},
    }))
    vi.doMock('../../src/lib/syncBus', async (orig) => ({
      ...(await orig<object>()),
      onSync: (event: string, h: Handler) => world.register(name, event, h),
      sendSync: (event: string, payload: object = {}) => world.deliver(name, event, payload),
    }))
    vi.doMock('../../src/lib/db', async (orig) => ({
      ...(await orig<object>()),
      isConfigured: () => true,
      upsertUnitsStrict: async (units: Unit[]) => world.write(units),
      upsertUnits: async (units: Unit[]) => world.write(units),
      upsertUnit: async (u: Unit) => world.write([u]),
      // สร้างแถวเฉพาะคันที่ยังไม่มีในคลาวด์ (เหมือน db.insertUnitsIfAbsent)
      insertUnitsIfAbsent: async (units: Unit[]) => {
        if (world.registerDelayMs) await new Promise<void>((r) => setTimeout(r, world.registerDelayMs))
        await world.write(units.filter((u) => !world.cloud.has(u.vin)))
      },
      // ส่งทั้งแถวยกเว้นตำแหน่ง — ตำแหน่งในคลาวด์คงเดิม (เหมือน db.upsertUnitsKeepPlacement)
      upsertUnitsKeepPlacement: async (units: Unit[]) => { if (world.registerDelayMs) await new Promise<void>((r) => setTimeout(r, world.registerDelayMs)); return world.write(units.map((u) => {
        const cur = world.cloud.get(u.vin)
        const { block: _b, row: _r, slot: _s, planMode: _p, assignedAt: _a, driver: _d, drivingStartedAt: _ds, parkedAt: _pa, ...rest } = u
        return { ...rest, block: cur?.block, row: cur?.row, slot: cur?.slot, planMode: cur?.planMode, assignedAt: cur?.assignedAt, driver: cur?.driver, drivingStartedAt: cur?.drivingStartedAt, parkedAt: cur?.parkedAt } as Unit
      })) },
      // แก้เฉพาะข้อมูลรถจากไฟล์ของแถวที่มีอยู่ — สถานะ/ยาร์ด/ตำแหน่งในคลาวด์คงเดิม (เหมือน db.patchUnitsCatalog)
      patchUnitsCatalog: async (patches: { vin: string; fields: Record<string, unknown> }[]) => {
        if (world.registerDelayMs) await new Promise<void>((r) => setTimeout(r, world.registerDelayMs))
        const map: Record<string, string> = { model: 'model', model_name: 'modelName', variant: 'variant', color: 'color', color_hex: 'colorHex', trailer: 'trailer', lot: 'lot', site_id: 'site' }
        const next: Unit[] = []
        for (const p of patches) {
          const cur = world.cloud.get(p.vin)
          if (!cur) continue // UPDATE ไม่สร้างแถวใหม่
          const u = { ...cur } as Record<string, unknown>
          for (const [k, v] of Object.entries(p.fields)) u[map[k]] = v ?? undefined
          next.push(u as unknown as Unit)
        }
        await world.write(next)
      },
      fetchUnitPlacements: async () => [...world.cloud.values()].map((u) => ({ ...u })),
      // รถทุกคันในช่อง (slot) ของยาร์ด — เหมือน db.fetchUnitsInLane (laneFromCloud ใช้ตอนยิงตามแถว)
      fetchUnitsInLane: async (siteId: string | null, slot: number) =>
        [...world.cloud.values()].filter((u) => u.slot === slot && u.status !== 'DEPARTED' && (!siteId || u.site === siteId)).map((u) => ({ ...u })),
      fetchUnitsByVins: async (vins: string[]) => vins.map((v) => world.cloud.get(v)).filter((u): u is Unit => !!u).map((u) => ({ ...u })),
      updatePlacementIfUnchanged: async (guard: { vin: string; from: { block?: string; row?: number; slot?: number } }, next: Unit) => {
        const cur = world.cloud.get(guard.vin)
        if (cur && (cur.block !== guard.from.block || cur.row !== guard.from.row || cur.slot !== guard.from.slot)) {
          return { applied: false as const, current: { block: cur.block, row: cur.row, slot: cur.slot, status: cur.status } }
        }
        await world.write([next])
        return { applied: true as const }
      },
    }))
    const mod = await import('../../src/store/useYard')
    return { name, yard: mod.useYard, mod }
  }
}

export const car = (vin: string, block: string, slot: number, row: number, extra: Partial<Unit> = {}): Unit => ({
  vin, model: 'm', modelName: 'BYD TEST', color: 'White', trailer: 0, damages: [], importedAt: 0,
  status: 'PARKED', block, slot, row, parkedAt: 0, site: 'S1', ...extra,
})

export const where = (u?: Unit) => (u ? `${u.block ?? '-'}${u.slot ?? ''}-${u.row ?? ''}${u.status === 'DEPARTED' ? ' (DEPARTED)' : ''}` : 'missing')
