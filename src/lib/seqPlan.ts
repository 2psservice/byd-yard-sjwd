/**
 * คิวงานส่งมอบ (Grouping to Dealer) ของ "แผนเดียวกัน" = ยาร์ดเดียวกัน · ชื่อยาร์ดบนหัวไฟล์เดียวกัน · วันที่แผนเดียวกัน
 * อัปโหลดไฟล์ใหม่ของแผนเดิม (จำนวนคัน / กลุ่มเปลี่ยน ชื่อไฟล์เลยเปลี่ยนตาม) ต้องต่อเข้าคิวงานเดิม ไม่ใช่สร้างคิวใหม่:
 * เดิม 70 คัน ออกไปแล้ว 20 → ไฟล์ใหม่ 140 คัน = คิวเดียว 140 คัน ออกไปแล้ว 20
 */
import type { QueueItem } from '../store/useOps'

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** "NYB2 - Grouping to Dealer ( 133 Units / 28 Groups) Date 02 November 2026" → "NYB2|2026-11-02"
 *  · ชื่อที่ไม่ใช่หัวไฟล์ Grouping to Dealer (ไม่มีวันที่) → '' (จับคู่ได้เฉพาะชื่อตรงกันทั้งชื่อ) */
export function seqPlanKey(name: string): string {
  const m = /^(.*?)\s*-\s*grouping\s+to\s+dealer\b.*?\bdate\s+(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/i.exec(name ?? '')
  if (!m) return ''
  const mon = m[3].toLowerCase()
  const mi = MONTHS.findIndex((x) => x === mon || (mon.length >= 3 && x.startsWith(mon)))
  const prefix = m[1].trim().toUpperCase().replace(/\s+/g, ' ')
  if (mi < 0 || !prefix) return ''
  return `${prefix}|${m[4]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

/** how far a car got on its run — the furthest record of a car wins when two runs both hold it */
const reach = (i: QueueItem): number => (i.gatedOut ? 4 : 0) + (i.done ? 2 : 0) + (i.atLaneAt || i.atWashAt ? 1 : 0)

/**
 * รายการรถของคิวงานหลังอัปโหลดไฟล์ใหม่: รถตามไฟล์ใหม่ (ลำดับ / กลุ่ม / lane / ปลายทางตามไฟล์) โดยแต่ละคัน
 * ยังมีความคืบหน้าเดิม (ออกไปแล้ว · ล้าง · lane · พิมพ์แล้ว · เวลาเข้าคิว) จากคิวเดิมทุกคิวของแผนนี้
 * · รถที่ออกไปแล้วแต่ไฟล์ใหม่ไม่มี ยังอยู่ในคิว (ส่งไปแล้วคือส่งไปแล้ว ยอดออกไม่ถอยหลัง)
 * · รถที่ยังไม่ออกและไฟล์ใหม่ไม่มี → หลุดจากคิว (แผนใหม่ไม่เอาคันนั้นแล้ว)
 */
export function mergeSeqItems(rows: QueueItem[], oldRuns: QueueItem[][]): QueueItem[] {
  const was = new Map<string, QueueItem>()
  for (const items of oldRuns) for (const i of items) { const p = was.get(i.vin); if (!p || reach(i) > reach(p)) was.set(i.vin, i) }
  const inFile = new Set(rows.map((r) => r.vin))
  const merged = rows.map((it) => {
    const p = was.get(it.vin)
    // addedAt เดิมด้วย — การออกจากลานนับเฉพาะหลังรถเข้าคิว (ดู itemLeftYard)
    // อัปโหลดซ้ำแล้วเวลาเข้าคิวเลื่อนมาเป็นตอนนี้ = รถที่ออกไปก่อนหน้าค้างเป็น "รอ"
    if (!p) return it
    // a hand-set lane the new sheet keeps unchanged keeps its who / when too
    const lane = !it.laneBy && p.laneBy && p.laneLoad === it.laneLoad ? { laneBy: p.laneBy, laneAt: p.laneAt } : {}
    // print marks name their grouping, so one from an old group never reads as printed for the new one
    return { ...it, ...lane, printed: p.printed, addedAt: p.addedAt ?? it.addedAt, done: p.done, gatedOut: p.gatedOut, doneAt: p.doneAt, doneBy: p.doneBy, stage: p.stage,
      atWashAt: p.atWashAt, atLaneAt: p.atLaneAt, deliveredBy: p.deliveredBy, returnedBy: p.returnedBy, returnedAt: p.returnedAt }
  })
  const sent = [...was.values()].filter((i) => !inFile.has(i.vin) && (i.done || i.gatedOut))
  return [...merged, ...sent]
}

/** วันที่ของแผน (yyyy-mm-dd) — "Date 02 November 2026" ในชื่อคิว · ไม่มีในชื่อ = วันที่สร้างคิว */
export function seqPlanDay(name: string | undefined, createdAt: number): string {
  const m = /Date\s+(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})/i.exec(name ?? '')
  if (m) {
    const mon = m[2].toLowerCase()
    const mi = MONTHS.findIndex((x) => x === mon || (mon.length >= 3 && x.startsWith(mon)))
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  const d = new Date(createdAt)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
