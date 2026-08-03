/**
 * Shared shape of a station inspection sheet (PDI · FINAL CHECK).
 *
 * A sheet is tabs → groups → items; every item is answered OK / NG / NG Heavy,
 * and each NG becomes a Defect in the damage system on save.
 */

export type CheckResult = 'OK' | 'NG' | 'NG Heavy'

export interface CheckItem {
  /** Printed label. Thai forms keep the Thai wording here and leave `en` unset. */
  th?: string
  en?: string
  /** Optional "ระบุ…" field (e.g. Qty / Key Code) shown under the buttons. */
  spec?: string
}

export interface CheckGroup {
  title: string
  items: CheckItem[]
}

export interface CheckTab {
  key: string
  label: string
  groups: CheckGroup[]
}

/** Stable id for one item — tab key + group index + item index. */
export const checkItemId = (tabKey: string, gi: number, ii: number) => `${tabKey}.${gi}.${ii}`

/** What the operator has entered for one item. */
export interface CheckItemState {
  result: CheckResult
  note?: string
  photos?: string[]
  spec?: string
}
