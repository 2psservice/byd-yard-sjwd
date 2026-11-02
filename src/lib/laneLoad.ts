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

// ── อัปโหลดไฟล์ Grouping ใหม่: กลุ่มที่เคยแก้ Lane load ไว้ ใช้ lane ที่แก้ล่าสุด ──────────────

/** lane ของกลุ่มหนึ่ง + ใคร / เมื่อไหร่ที่แก้ (ไม่มี = lane ที่ระบบตั้งให้) */
export interface LaneMemo { lane: string; by?: string; at?: number }

const groupKey = (g: string | undefined): string => (g ?? '').trim().toUpperCase()

/** lane ที่แก้ด้วยมือล่าสุดของแต่ละกลุ่ม จากทุกคิวงานส่งมอบที่ส่งมา (รอบที่ระบบตั้ง lane เองไม่นับ) */
export function lastEditedLanes(
  runs: { items: { group?: string; laneLoad?: string; laneBy?: string; laneAt?: number }[] }[],
  groups: Iterable<string>,
): Map<string, LaneMemo> {
  const want = new Set([...groups].map(groupKey).filter(Boolean))
  const out = new Map<string, LaneMemo>()
  for (const run of runs) {
    for (const it of run.items) {
      const g = groupKey(it.group)
      const lane = (it.laneLoad ?? '').trim()
      if (!g || !want.has(g) || !lane || !it.laneBy || !it.laneAt) continue
      const had = out.get(g)
      if (!had || it.laneAt > (had.at ?? 0)) out.set(g, { lane, by: it.laneBy, at: it.laneAt })
    }
  }
  return out
}

/**
 * Lane ของไฟล์ที่เพิ่งอัปโหลด (กลุ่มเรียงตามลำดับในไฟล์):
 *   · กลุ่มที่เคยแก้ lane ไว้ → lane ที่แก้ล่าสุด (พร้อมชื่อคนแก้ / เวลา)
 *   · กลุ่มอื่น → O + ลำดับในไฟล์เหมือนเดิม (กลุ่มที่ 3 = O3) ถ้า lane นั้นมีกลุ่มที่แก้ไว้ใช้อยู่แล้ว
 *     ใช้เลข O ที่ว่างตัวแรกแทน ไม่ให้ซ้ำกัน
 */
export function assignLanes(order: string[], kept: Map<string, LaneMemo>): Map<string, LaneMemo> {
  const out = new Map<string, LaneMemo>()
  const used = new Set<string>()
  for (const g of order) { const k = kept.get(groupKey(g)); if (k) { out.set(g, k); used.add(laneKey(k.lane)) } }
  let next = 1
  const free = () => { while (used.has(`O${next}`)) next++; return `O${next}` }
  order.forEach((g, i) => {
    if (out.has(g)) return
    const own = `O${i + 1}`
    const lane = used.has(own) ? free() : own
    used.add(lane)
    out.set(g, { lane })
  })
  return out
}
