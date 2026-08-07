/**
 * useUnitsView — the Unit List's working state: open tab (Grouping No. /
 * Units / Units Mylist), the filter values, active + ticked groupings, the
 * Mylist VIN paste and the sort. Persisted so switching to another sidebar
 * page — or leaving the app, or coming back tomorrow after the day-change
 * auto-logout — lands exactly where work stopped, filters intact.
 * (logout() only clears auth fields, never this key.)
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { quotaSafeStorage } from '../lib/persistStorage'

export type UnitsTab = 'grouping' | 'units' | 'mylist'

export interface UnitsViewState {
  tab: UnitsTab
  q: string                          // Unit Nbr search box
  fGroup: string                     // Grouping filter box
  colFilters: Record<string, string> // column key → picked value ('ALL'/'' = off)
  filtersOpen: boolean
  sortKey: string
  sortDir: 1 | -1
  grpSearch: string                  // Grouping-No. tab: list search
  grpActive: string | null           // Grouping-No. tab: opened group
  grpPicked: string[]                // Grouping-No. tab: ticked groups (Set serialized)
  mylistText: string                 // Mylist tab: pasted VINs
  patch: (p: Partial<Omit<UnitsViewState, 'patch'>>) => void
}

export const useUnitsView = create<UnitsViewState>()(
  persist(
    (set) => ({
      tab: 'units',
      q: '',
      fGroup: '',
      colFilters: {},
      filtersOpen: true,
      sortKey: 'No',
      sortDir: -1,
      grpSearch: '',
      grpActive: null,
      grpPicked: [],
      mylistText: '',
      patch: (p) => set(p),
    }),
    { name: 'sjwd-units-view', storage: quotaSafeStorage() },
  ),
)
