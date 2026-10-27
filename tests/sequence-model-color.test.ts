import { describe, expect, it, vi } from 'vitest'

/** คิวส่งรถเก็บ Model / Color จากไฟล์แผน — พิมพ์ใบ Grouping / ใบหารถซ้ำได้แม้ยาร์ดนี้ไม่มีแถวชีตของรถคันนั้น */

async function setup() {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  vi.doMock('../src/lib/db', async (orig) => ({ ...(await orig<object>()), isConfigured: () => true, upsertQueue: async () => {}, upsertQueues: async () => {} }))
  const { useYard } = await import('../src/store/useYard')
  useYard.setState({ sites: [{ id: 'S1', name: 'NYB2 Phase 2', createdAt: 0 }], currentSite: 'S1' } as any)
  return import('../src/store/useOps')
}

describe('Create Sequence เก็บ Model / Color ของไฟล์แผน', () => {
  it('เก็บค่าที่มี · ค่าว่างไม่เก็บ · อัปโหลดชื่อเดิมซ้ำได้ค่าจากไฟล์ใหม่', async () => {
    const ops = await setup()
    const id = ops.useOps.getState().createSequence('run 27/10', 'admin', [
      { vin: 'LGXC74C40SG009826', model: ' SEALION6 ', color: 'BLACK', group: 'G1', laneLoad: 'O6' },
      { vin: 'LC0CE4CB7TG037146', model: '', color: '', group: 'G1', laneLoad: 'O4' },
    ])
    const items = () => ops.useOps.getState().queues.find((q: any) => q.id === id)!.items
    expect(items()[0]).toMatchObject({ model: 'SEALION6', color: 'BLACK' })
    expect('model' in items()[1]).toBe(false)
    ops.useOps.getState().createSequence('run 27/10', 'admin', [{ vin: 'LGXC74C40SG009826', model: 'SEALION 6', color: 'BLACK', group: 'G1', laneLoad: 'O6' }])
    expect(items()[0]).toMatchObject({ model: 'SEALION 6', color: 'BLACK' })
  })
})
