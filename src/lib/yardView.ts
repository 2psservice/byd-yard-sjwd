/**
 * Yard Plan "VIEW" dropdown — colour every occupied slot by a chosen
 * dimension instead of just parking status, each with its own legend
 * (matches the RoRo TOS reference: Block/Unit/Port/Model/Vessel/Transshipment
 * view switcher). We ship the 3 dimensions the user asked for; Status stays
 * the default/existing behaviour.
 *
 * `resolveSlotColor` is the single source of truth for slot colour — shared
 * by the BlockPopup grid AND the mini colour grid drawn on each block card
 * on the main board, so both always agree.
 */
import { finalColor } from './carStatus'
import type { Unit } from '../types'

export type YardViewMode = 'status' | 'model' | 'grouping' | 'finalStatus'

export const YARD_VIEW_OPTIONS: { id: YardViewMode; label: string }[] = [
  { id: 'status', label: 'สถานะ (Status)' },
  { id: 'model', label: 'รุ่นรถ (Model)' },
  { id: 'grouping', label: 'Grouping' },
  { id: 'finalStatus', label: 'Final Status' },
]

// distinct, readable-on-white categorical palette for the Model view
const MODEL_PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2',
  '#db2777', '#65a30d', '#ea580c', '#4338ca', '#0d9488', '#b45309',
  '#9333ea', '#059669', '#e11d48', '#0369a1',
]

/** Stable colour per model name, assigned in sorted order so the same model
 *  always gets the same colour across renders/blocks (memoize the input list
 *  upstream — this is a pure function of the sorted distinct-name list). */
export function buildModelPalette(modelNames: Iterable<string>): Map<string, string> {
  const names = [...new Set(modelNames)].filter(Boolean).sort()
  const map = new Map<string, string>()
  names.forEach((name, i) => map.set(name, MODEL_PALETTE[i % MODEL_PALETTE.length]))
  return map
}

export const GROUPING_META = {
  grouped: { color: '#16a34a', label: 'จัดกลุ่มแล้ว (Grouped)' },
  ungrouped: { color: '#94a3b8', label: 'ยังไม่จัดกลุ่ม (No group)' },
}

const FINAL_STATUS_FALLBACK = { color: '#0f172a', bg: '#e2e8f0' }
/** Fixed legend order — matches the Dashboard Summary table's column order. */
export const FINAL_STATUS_ORDER = ['Waiting', 'Waiting Repair', 'OK-Repaired', 'OK-Accept'] as const

export function finalStatusSlotColor(v: string): { color: string; bg: string } {
  const trimmed = v.trim()
  if (!trimmed) return FINAL_STATUS_FALLBACK
  return finalColor(trimmed) ?? FINAL_STATUS_FALLBACK
}

// slot colour by vehicle status (RoRo-TOS style) — the default VIEW mode
export const STATUS_META: { key: Unit['status'] | 'PENDING'; c: string; label: string }[] = [
  { key: 'PARKED',   c: '#22c55e', label: 'R — ในลาน' },
  { key: 'ASSIGNED', c: '#a855f7', label: 'Th — กำลังนำจอด' },
  { key: 'LOADED',   c: '#3b82f6', label: 'DT — โหลดแล้ว' },
  { key: 'DEPARTED', c: '#64748b', label: 'E — ออกแล้ว' },
  { key: 'PENDING',  c: '#eab308', label: 'P — รอ' },
]
export const slotColor = (u: Unit): string =>
  u.status === 'PARKED' ? '#22c55e' : u.status === 'ASSIGNED' ? '#a855f7'
  : u.status === 'LOADED' ? '#3b82f6' : u.status === 'DEPARTED' ? '#64748b' : '#eab308'

const GROUPING_KEY = 'Grouping  Number'
const FINAL_STATUS_KEY = 'Final Status'

/** Slot fill colour for the active VIEW mode. Grouping/Final Status need a
 *  VIN → tracking-cells lookup since those fields live on the tracking row,
 *  not the yard Unit. */
export function resolveSlotColor(
  u: Unit,
  viewMode: YardViewMode,
  vinCells?: Map<string, Record<string, string>>,
  modelColors?: Map<string, string>,
): string {
  if (viewMode === 'model') return modelColors?.get(u.modelName) ?? '#94a3b8'
  if (viewMode === 'grouping') {
    const grouped = !!vinCells?.get(u.vin)?.[GROUPING_KEY]?.trim()
    return grouped ? GROUPING_META.grouped.color : GROUPING_META.ungrouped.color
  }
  if (viewMode === 'finalStatus') return finalStatusSlotColor(vinCells?.get(u.vin)?.[FINAL_STATUS_KEY] ?? '').bg
  return slotColor(u)
}
