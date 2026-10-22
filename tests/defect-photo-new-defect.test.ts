import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * รูป Defect โหลดเฉพาะคันที่เปิดดู แล้วจำว่า "โหลดแล้ว" — Defect ใหม่ที่เครื่องอื่นเพิ่งถ่ายรูปมา (ซิงก์มาแบบไม่มีรูป)
 * ต้องถูกดึงรูปอีกรอบ (22 ต.ค.: ไฟท้าย RH 11:35 ของกนกวรรณ ไม่ขึ้นรูปบนมือถือ Theerachai แต่ขึ้นบนเครื่อง admin)
 */

const dmg = (id: string, extra: object = {}) => ({ id, area: 'A', type: 'T', severity: 'minor', recordedAt: '', recordedBy: 'x', ...extra })

async function setup(cloud: Map<string, { photo?: string; photos?: string[] }>) {
  vi.resetModules(); localStorage.clear()
  vi.doMock('../src/lib/supabase', () => ({
    isConfigured: () => true,
    supabase: { channel: () => ({ on() { return this }, subscribe() { return this }, send: async () => 'ok' }), removeChannel() {} },
  }))
  const fetchPhotos = vi.fn(async (vins: string[]) => {
    void vins
    return new Map(cloud)
  })
  vi.doMock('../src/lib/db', async (orig) => ({
    ...(await orig<object>()), isConfigured: () => true, fetchDamagePhotosByVins: fetchPhotos,
  }))
  const { useYard } = await import('../src/store/useYard')
  return { useYard, fetchPhotos }
}

const setDamages = (useYard: any, damages: object[]) =>
  useYard.setState((s: any) => ({ units: { ...s.units, V1: { vin: 'V1', status: 'PARKED', damages } } }))

const photosOf = (useYard: any, id: string) => useYard.getState().units.V1.damages.find((d: any) => d.id === id)?.photos

describe('รูป Defect: Defect ใหม่หลังโหลดรูปแล้ว', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Defect ใหม่ (ซิงก์มาไม่มีรูป) → ดึงรูปอีกรอบ รูปขึ้น', async () => {
    const cloud = new Map([['D1', { photo: 'p1', photos: ['p1'] }]])
    const { useYard, fetchPhotos } = await setup(cloud)
    setDamages(useYard, [dmg('D1')])
    await useYard.getState().loadPhotosFor('V1')
    expect(photosOf(useYard, 'D1')).toEqual(['p1'])

    // เครื่องอื่นบันทึก D2 พร้อมรูป — เครื่องนี้ได้แถวแบบไม่มีรูป
    cloud.set('D2', { photo: 'p2', photos: ['p2', 'p3'] })
    setDamages(useYard, [...useYard.getState().units.V1.damages, dmg('D2')])
    await useYard.getState().loadPhotosFor('V1')
    expect(fetchPhotos).toHaveBeenCalledTimes(2)
    expect(photosOf(useYard, 'D2')).toEqual(['p2', 'p3'])
  })

  it('(ควบคุม) ไม่มี Defect ใหม่ → ไม่ดึงซ้ำ (รวม Defect จากไฟล์ที่ไม่มีรูปเลย)', async () => {
    const { useYard, fetchPhotos } = await setup(new Map([['D1', { photo: 'p1', photos: ['p1'] }]]))
    setDamages(useYard, [dmg('D1'), dmg('F1')]) // F1 = Defect จากไฟล์ ไม่มีรูปในคลาวด์
    await useYard.getState().loadPhotosFor('V1')
    await useYard.getState().loadPhotosFor('V1')
    await useYard.getState().loadPhotosFor('V1')
    expect(fetchPhotos).toHaveBeenCalledTimes(1)
  })

  it('Defect ที่มาถึงระหว่างกำลังดึง → ดึงต่ออีกรอบเอง', async () => {
    const cloud = new Map([['D1', { photos: ['p1'] }], ['D2', { photos: ['p2'] }]])
    const { useYard, fetchPhotos } = await setup(cloud)
    setDamages(useYard, [dmg('D1')])
    const first = useYard.getState().loadPhotosFor('V1')
    setDamages(useYard, [dmg('D1'), dmg('D2')]) // มาถึงก่อนรอบแรกเสร็จ
    await useYard.getState().loadPhotosFor('V1') // ระหว่าง loading → ข้าม
    await first
    await vi.waitFor(() => expect(photosOf(useYard, 'D2')).toEqual(['p2']))
    expect(fetchPhotos).toHaveBeenCalledTimes(2)
  })
})
