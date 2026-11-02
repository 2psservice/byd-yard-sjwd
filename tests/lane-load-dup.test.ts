import { describe, expect, it } from 'vitest'
import { laneDuplicates, laneKey, shortGroup } from '../src/lib/laneLoad'

describe('laneKey', () => {
  it('treats case, spaces and leading zeros as the same lane', () => {
    expect(laneKey('o 01')).toBe('O1')
    expect(laneKey('O1')).toBe('O1')
    expect(laneKey(' O10 ')).toBe('O10')
    expect(laneKey('O0')).toBe('O0')
    expect(laneKey('')).toBe('')
  })
})

describe('laneDuplicates', () => {
  it('lists every lane two or more groups share, O2 before O10', () => {
    const laneOf = new Map([
      ['SJWD261029-064', 'O1'], ['SJWD261029-075', 'O10'], ['SJWD261029-076', 'O2'],
      ['SJWD261029-080', 'O10'], ['SJWD261029-081', 'o02'], ['SJWD261029-082', 'O3'],
    ])
    expect(laneDuplicates(laneOf)).toEqual([
      { lane: 'O2', groups: ['SJWD261029-076', 'SJWD261029-081'] },
      { lane: 'O10', groups: ['SJWD261029-075', 'SJWD261029-080'] },
    ])
  })
  it('a blank lane is never a duplicate, and unique lanes give nothing', () => {
    expect(laneDuplicates(new Map([['A', ''], ['B', ''], ['C', 'O1'], ['D', 'O2']]))).toEqual([])
  })
})

describe('shortGroup', () => {
  it('keeps the part after the last dash', () => {
    expect(shortGroup('SJWD261029-080')).toBe('080')
    expect(shortGroup('ATL260803-12')).toBe('12')
    expect(shortGroup('G7')).toBe('G7')
  })
})
