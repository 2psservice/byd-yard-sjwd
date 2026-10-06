// Node 25 มี localStorage ทดลองในตัวที่ใช้ไม่ได้ถ้าไม่ตั้ง --localstorage-file และบังของ jsdom —
// ใส่ Storage แบบหน่วยความจำให้ชัดเจน เพื่อให้ผลทดสอบเหมือนกันทุกเวอร์ชัน Node
class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  [name: string]: unknown
}
for (const target of [globalThis, window] as object[]) {
  Object.defineProperty(target, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true })
}
