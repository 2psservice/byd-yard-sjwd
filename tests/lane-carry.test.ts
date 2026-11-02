import { describe, expect, it } from 'vitest'
import { assignLanes, lastEditedLanes } from '../src/lib/laneLoad'
import { loadGroupingUploads, recordGroupingUpload } from '../src/lib/groupingUploads'

/** อัปโหลดไฟล์ Grouping ใหม่: กลุ่มที่เคยแก้ Lane load ไว้ ใช้ lane ที่แก้ล่าสุด ไม่รีเซ็ตเป็น O1–O10 */

const G = (n: number) => `SJWD261027-${100 + n}`
const order = Array.from({ length: 10 }, (_, i) => G(i)) // 10 groups, 1 car each
const edited = ['O1', 'O2', 'O3', 'O4', 'O5', 'O11', 'O12', 'O13', 'O14', 'O15']
const run = (lanes: string[], by?: string, at?: number) => ({
  items: order.map((g, i) => ({ group: g, laneLoad: lanes[i], ...(by ? { laneBy: by, laneAt: at } : {}) })),
})

describe('Lane load ที่แก้ไว้ ติดไปกับไฟล์ที่อัปโหลดใหม่', () => {
  it('the admin\'s example: O1–O5, O11–O15 come back instead of O1–O10', () => {
    const kept = lastEditedLanes([run(edited, 'admin', 1000)], order)
    const lanes = assignLanes(order, kept)
    expect(order.map((g) => lanes.get(g)!.lane)).toEqual(edited)
    expect(lanes.get(G(5))).toEqual({ lane: 'O11', by: 'admin', at: 1000 })
  })

  it('a first upload (nothing edited yet) numbers O1 … O10 as before', () => {
    const lanes = assignLanes(order, lastEditedLanes([], order))
    expect(order.map((g) => lanes.get(g)!.lane)).toEqual(order.map((_, i) => `O${i + 1}`))
  })

  it('lanes the system set itself are not "edited" — only hand edits carry over', () => {
    const auto = run(order.map((_, i) => `O${i + 21}`)) // e.g. an older run numbered differently, no laneBy
    expect(lastEditedLanes([auto], order).size).toBe(0)
  })

  it('the newest edit wins across runs, any case of the group code', () => {
    const older = { items: [{ group: G(0), laneLoad: 'I10', laneBy: 'a', laneAt: 100 }] }
    const newer = { items: [{ group: G(0).toLowerCase(), laneLoad: 'I14', laneBy: 'b', laneAt: 200 }] }
    expect(lastEditedLanes([newer, older], [G(0)]).get(G(0))).toEqual({ lane: 'I14', by: 'b', at: 200 })
  })

  it('one group edited: the others keep their place number; a clash takes the first free O-number', () => {
    // group 3 was moved onto O1 → group 1 can't have O1 any more and takes the first free number
    const kept = lastEditedLanes([{ items: [{ group: G(2), laneLoad: 'O1', laneBy: 'admin', laneAt: 5 }] }], order)
    const lanes = order.map((g) => assignLanes(order, kept).get(g)!.lane)
    expect(lanes.slice(0, 4)).toEqual(['O2', 'O3', 'O1', 'O4'])
    expect(new Set(lanes).size).toBe(order.length) // never two groups on one lane
  })

  it('a new group in the file goes to a free lane, not one an edited group holds', () => {
    const more = [...order, G(10)]
    const lanes = assignLanes(more, lastEditedLanes([run(edited, 'admin', 1000)], more))
    expect(lanes.get(G(10))!.lane).toBe('O6') // O11 (its place) is taken by an edited group → first free
  })
})

describe('ประวัติอัปโหลด', () => {
  it('records who / which file / when and lists the yard\'s uploads newest first', async () => {
    localStorage.clear()
    const base = { site: 'nyb2', sheet: 'NYB2', units: 10, groups: 10, keptLanes: 0, title: '' }
    await recordGroupingUpload({ ...base, at: 1000, by: 'admin', file: 'NYB2 Grouping 01 Nov.xlsx' })
    await recordGroupingUpload({ ...base, at: 2000, by: 'จตุพร', file: 'NYB2 Grouping 02 Nov.xlsx', keptLanes: 10 })
    await recordGroupingUpload({ ...base, at: 3000, by: 'x', file: 'other yard.xlsx', site: 'ry' })
    const list = await loadGroupingUploads('nyb2')
    expect(list.map((u) => [u.by, u.file, u.at])).toEqual([['จตุพร', 'NYB2 Grouping 02 Nov.xlsx', 2000], ['admin', 'NYB2 Grouping 01 Nov.xlsx', 1000]])
  })
})
