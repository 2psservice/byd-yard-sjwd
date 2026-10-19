/**
 * คิวเรียงลำดับตามคีย์: งานที่แตะคีย์เดียวกัน (เช่น VIN เดียวกัน) รอกันตามลำดับที่สั่ง ส่วนคีย์ต่างกันวิ่งพร้อมกันได้
 *
 * ใช้กับการส่งแถวติดตามขึ้นคลาวด์ — การเขียนแต่ละครั้งส่ง "ทั้งแถว" (upsert) ถ้าสองครั้งของรถคันเดียวกันวิ่งพร้อมกัน
 * บนสัญญาณช้า ครั้งเก่าถึงทีหลังแล้วทับครั้งใหม่ได้ (ประวัติเลื่อนตามแถวที่ F18 NYB2 19 ต.ค. 14:36 หายไป 3 คัน)
 * งานล้มไม่ขวางงานถัดไปของคีย์เดียวกัน
 */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<void>>()
  return function run<T>(keys: Iterable<string>, job: () => Promise<T>): Promise<T> {
    const ks = [...new Set(keys)]
    const prev = Promise.all(ks.map((k) => tails.get(k) ?? Promise.resolve()))
    const p = prev.then(job)
    const settled = p.then(() => undefined, () => undefined)
    for (const k of ks) tails.set(k, settled)
    void settled.then(() => { for (const k of ks) if (tails.get(k) === settled) tails.delete(k) })
    return p
  }
}
