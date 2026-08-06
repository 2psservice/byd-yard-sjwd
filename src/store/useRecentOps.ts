/**
 * Per-device history of what the Yard Ops stations did — the VINs an operator
 * searched and the saves they made, newest first, shown under each station's
 * scan box so the last few cars are one tap away. Local to the device on
 * purpose: it is a personal worklist, not shared yard state.
 */
import { create } from 'zustand'
import { quotaSafeStorage } from '../lib/persistStorage'
import { persist } from 'zustand/middleware'

export interface RecentEntry {
  vin: string
  at: number
  note?: string // what the save did, e.g. "ย้ายไป T1201" — searches have none
}

interface RecentOpsState {
  lists: Record<string, RecentEntry[]> // key: "<station>:search" | "<station>:save"
  record: (key: string, vin: string, note?: string) => void
  clear: (key: string) => void
}

const MAX_RECENT = 10

export const useRecentOps = create<RecentOpsState>()(
  persist(
    (set) => ({
      lists: {},
      record: (key, vin, note) =>
        set((s) => {
          // a re-scan of the same VIN moves it to the top instead of duplicating
          const rest = (s.lists[key] ?? []).filter((e) => e.vin !== vin)
          return { lists: { ...s.lists, [key]: [{ vin, at: Date.now(), note }, ...rest].slice(0, MAX_RECENT) } }
        }),
      clear: (key) => set((s) => ({ lists: { ...s.lists, [key]: [] } })),
    }),
    { name: 'sjwd-ops-recent', storage: quotaSafeStorage() },
  ),
)
