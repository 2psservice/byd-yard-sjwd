/**
 * คิวงานส่งมอบ (Grouping to Dealer) ของ "แผนเดียวกัน" = ยาร์ดเดียวกัน · ชื่อยาร์ดบนหัวไฟล์เดียวกัน · วันที่แผนเดียวกัน
 * อัปโหลดไฟล์ใหม่ของแผนเดิม (จำนวนคัน / กลุ่มเปลี่ยน ชื่อไฟล์เลยเปลี่ยนตาม) ต้องต่อเข้าคิวงานเดิม ไม่ใช่สร้างคิวใหม่:
 * เดิม 70 คัน ออกไปแล้ว 20 → ไฟล์ใหม่ 140 คัน = คิวเดียว 140 คัน ออกไปแล้ว 20
 */
import type { QueueItem } from '../store/useOps'

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** "NYB2 - Grouping to Dealer ( 133 Units / 28 Groups) Date 02 November 2026" → "NYB2|2026-11-02"
 *  · ชื่อที่ไม่ใช่หัวไฟล์ Grouping to Dealer (ไม่มีวันที่) → '' (จับคู่ได้เฉพาะชื่อตรงกันทั้งชื่อ) */
export function seqPlanKey(name: string, day?: string): string {
  const m = /^(.*?)\s*-\s*grouping\s+to\s+dealer\b.*?\bdate\s+(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/i.exec(name ?? '')
  if (!m) return ''
  const mon = m[3].toLowerCase()
  const mi = MONTHS.findIndex((x) => x === mon || (mon.length >= 3 && x.startsWith(mon)))
  const prefix = m[1].trim().toUpperCase().replace(/\s+/g, ' ')
  if (mi < 0 || !prefix) return ''
  return `${prefix}|${day || `${m[4]}-${pad2(mi + 1)}-${pad2(+m[2])}`}`
}

/** how far a car got on its run — the furthest record of a car wins when two runs both hold it */
const reach = (i: QueueItem): number => (i.gatedOut ? 4 : 0) + (i.done ? 2 : 0) + (i.atLaneAt || i.atWashAt ? 1 : 0)

/**
 * รายการรถของคิวงานหลังอัปโหลดไฟล์ใหม่ของแผนเดิม — ทีละกลุ่ม (Grouping No.):
 * · กลุ่มที่ไฟล์ใหม่มี → รถตามไฟล์ใหม่ (ลำดับ / lane / ปลายทางตามไฟล์) โดยแต่ละคันยังมีความคืบหน้าเดิม
 *   (ออกไปแล้ว · ล้าง · lane · พิมพ์แล้ว · เวลาเข้าคิว) · คันที่ยังไม่ออกและไฟล์ใหม่ไม่มีแล้ว → หลุดจากกลุ่ม
 * · กลุ่มที่ไฟล์ใหม่ไม่มี → อยู่ต่อตามเดิม (ไฟล์รอบสองเป็นรถเพิ่ม ไม่ใช่แผนทั้งหมด: 16/11 NYB2 รอบแรก 29 คัน
 *   รอบสอง 24 คันคนละกลุ่ม = คิวเดียว 53 คัน) · ไฟล์ทั้งแผนที่อัปซ้ำมีทุกกลุ่มอยู่แล้ว ผลจึงเหมือนเดิม
 * · รถที่ออกไปแล้ว อยู่ในคิวเสมอ (ส่งไปแล้วคือส่งไปแล้ว ยอดออกไม่ถอยหลัง)
 * ลำดับ: กลุ่มเดิมที่ไฟล์ใหม่ไม่มีก่อน แล้วตามด้วยรถตามไฟล์ใหม่ แล้วคันที่ส่งไปแล้วซึ่งไฟล์ใหม่ไม่มี
 */
export function mergeSeqItems(rows: QueueItem[], oldRuns: QueueItem[][]): QueueItem[] {
  const g = (s?: string) => (s ?? '').toUpperCase().replace(/\s+/g, '')
  const was = new Map<string, QueueItem>()
  for (const items of oldRuns) for (const i of items) { const p = was.get(i.vin); if (!p || reach(i) > reach(p)) was.set(i.vin, i) }
  const inFile = new Set(rows.map((r) => r.vin))
  const fileGroups = new Set(rows.map((r) => g(r.group)).filter(Boolean))
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
  const rest = [...was.values()].filter((i) => !inFile.has(i.vin))
  const keptGroups = rest.filter((i) => !!g(i.group) && !fileGroups.has(g(i.group)))
  const sent = rest.filter((i) => !keptGroups.includes(i) && (i.done || i.gatedOut))
  return [...keptGroups, ...merged, ...sent]
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** หัวคิวงานที่วันที่ในชื่อเป็น `day` (yyyy-mm-dd) — หัวไฟล์ที่ลอกวันที่เก่ามา ("Date 11 November" ใน sheet 16.11.26)
 *  ใช้วันที่ของ sheet แทน คิวงานจึงอยู่วันเดียวกับแผนจริง · ชื่อที่ไม่มี "Date …" ได้วันที่ต่อท้าย */
export function withPlanDay(name: string, day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m || titlePlanDay(name) === day) return name
  const text = `Date ${m[3]} ${MONTH_NAME[+m[2] - 1]} ${m[1]}`
  return /Date\s+\d{1,2}\s+[A-Za-z]+\.?\s+\d{4}/i.test(name) ? name.replace(/Date\s+\d{1,2}\s+[A-Za-z]+\.?\s+\d{4}/i, text) : `${name.trim()} ${text}`
}

/** "( 29 Units / 15 Groups)" ในหัวคิวงาน → จำนวนจริงหลังรวมไฟล์ · ชื่อที่ไม่มีวงเล็บนี้คงเดิม */
export function withPlanCounts(name: string, units: number, groups: number): string {
  return name.replace(/\(\s*\d+\s*Units?\s*\/\s*\d+\s*Groups?\s*\)/i,
    `( ${units} Unit${units === 1 ? '' : 's'} / ${groups} Group${groups === 1 ? '' : 's'})`)
}

/** วันที่ของแผนจาก "Date 02 November 2026" ในหัวไฟล์ / ชื่อคิว (yyyy-mm-dd) · ไม่มี = '' */
export function titlePlanDay(name: string | undefined): string {
  const m = /Date\s+(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})/i.exec(name ?? '')
  if (!m) return ''
  const mon = m[2].toLowerCase()
  const mi = MONTHS.findIndex((x) => x === mon || (mon.length >= 3 && x.startsWith(mon)))
  return mi >= 0 ? `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''
}

/** วันที่ของแผน (yyyy-mm-dd) — "Date 02 November 2026" ในชื่อคิว · ไม่มีในชื่อ = วันที่สร้างคิว */
export function seqPlanDay(name: string | undefined, createdAt: number): string {
  const t = titlePlanDay(name)
  if (t) return t
  const d = new Date(createdAt)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
