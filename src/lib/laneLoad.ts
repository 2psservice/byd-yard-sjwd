/**
 * Lane load ซ้ำ — ไฟล์ Grouping ตั้ง lane ให้กลุ่มละ 1 lane ไม่ซ้ำ (O1, O2, …) lane ที่ 2 กลุ่มใช้ร่วมกัน
 * จึงเกิดจากการพิมพ์แก้เอง หน้า Grouping แจ้งเตือนให้เห็นชัด (ไม่บล็อก — 2 กลุ่มเล็กขึ้น lane เดียวกันอาจตั้งใจ)
 */

/** ค่าเทียบ: ตัวพิมพ์ใหญ่ ไม่มีช่องว่าง เลขไม่มี 0 นำหน้า — "o 01" กับ "O1" คือ lane เดียวกัน */
export const laneKey = (lane: string): string =>
  (lane ?? '').toUpperCase().replace(/\s+/g, '').replace(/^([A-Z]+)0+(?=\d)/, '$1')

export interface LaneDup { lane: string; groups: string[] }

/** lane ที่มีมากกว่า 1 กลุ่มใช้ (groupOf: เลข Grouping → lane ของกลุ่ม) เรียง O2 ก่อน O10 */
export function laneDuplicates(laneOf: Map<string, string>): LaneDup[] {
  const by = new Map<string, LaneDup>()
  for (const [g, l] of laneOf) {
    const k = laneKey(l)
    if (!k) continue
    const e = by.get(k) ?? { lane: k, groups: [] }
    e.groups.push(g)
    by.set(k, e)
  }
  return [...by.values()].filter((e) => e.groups.length > 1)
    .sort((a, b) => a.lane.localeCompare(b.lane, undefined, { numeric: true }))
}

/** เลข Grouping แบบสั้นไว้แสดงใต้ช่อง lane: "SJWD261029-080" → "080" */
export const shortGroup = (g: string): string => {
  const i = g.lastIndexOf('-')
  return i >= 0 && i < g.length - 1 ? g.slice(i + 1) : g
}
