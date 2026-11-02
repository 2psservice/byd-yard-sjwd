import { describe, expect, it } from 'vitest'
import { buildIrHtml, buildIrPaperHtml, type MeasureText } from '../src/lib/dnir'
import { labelModel } from '../src/lib/vehicleLabel'
import type { TrackRow } from '../src/lib/excelTracking'

/** ใบ IR (กระดาษ IR และ IR เต็มฟอร์ม): ช่อง Model ใช้ Sub-Model เหมือน Vehicle Label — BYD DOLPHIN → BYD DOLPHIN (490KM-EXT) */

const row = (cells: Record<string, string>): TrackRow =>
  ({ vin: 'LC0CE4CB6TG037218', cells: { Vin: 'LC0CE4CB6TG037218', Color: 'GREY', ...cells } })
const modelField = (html: string) => /class="irpf" style="left:15pt;top:[\d.]+pt;font-size:([\d.]+)pt">([^<]*)</.exec(html)

describe('IR · Model = Sub-Model', () => {
  it('prints the Sub-Model with the brand, on both IR styles, same as the Vehicle Label', () => {
    const r = row({ Model: 'DOLPHIN', 'Model name': 'BYD DOLPHIN', 'Sub Model': 'DOLPHIN (490KM-EXT)' })
    expect(labelModel(r.cells)).toBe('BYD DOLPHIN (490KM-EXT)')
    const paper = buildIrPaperHtml([r], 'NYB2 Phase 2')
    expect(modelField(paper)?.[2]).toBe('BYD DOLPHIN (490KM-EXT)')
    expect(paper).not.toContain('>BYD DOLPHIN<')
    expect(buildIrHtml([r], 'NYB2 Phase 2')).toContain('>BYD DOLPHIN (490KM-EXT)<')
  })

  it('no Sub-Model: Model name, then Model, as before (with the brand)', () => {
    expect(modelField(buildIrPaperHtml([row({ 'Model name': 'BYD ATTO 3' })]))?.[2]).toBe('BYD ATTO 3')
    expect(modelField(buildIrPaperHtml([row({ Model: 'D9' })]))?.[2]).toBe('BYD D9')
    expect(modelField(buildIrPaperHtml([row({})]))).toBeNull() // nothing known → the box stays empty
  })

  it('a long Sub-Model is set smaller so it never runs into the Color box', () => {
    const perChar = 5.5 // 12pt, roughly TH Sarabun New's capitals
    const measure: MeasureText = (s) => s.length * perChar
    const short = modelField(buildIrPaperHtml([row({ 'Sub-Model': 'SEAL 5' })], '', undefined, measure))!
    expect(Number(short[1])).toBe(12)
    const long = modelField(buildIrPaperHtml([row({ 'Sub-Model': 'SEALION 7 PERFORMANCE AWD' })], '', undefined, measure))!
    const size = Number(long[1])
    expect(size).toBeLessThan(12)
    expect((long[2].length * perChar * size) / 12).toBeLessThanOrEqual(112)
    // never below 8pt, however long — still readable on the form
    expect(Number(modelField(buildIrPaperHtml([row({ 'Sub-Model': 'X'.repeat(60) })], '', undefined, measure))![1])).toBe(8)
  })
})
