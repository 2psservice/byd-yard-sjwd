/**
 * Quota-safe localStorage for zustand persist. The default storage calls
 * localStorage.setItem synchronously inside set(): once the origin's quota is
 * full (Safari: ~5 MB, shared by every key), the QuotaExceededError throws
 * straight through the calling action — the Grouping "Create Sequence" click
 * died exactly this way. The cloud owns all of this data; the local snapshot
 * is only a boot cache, so a failed write must never break the action itself.
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware'

let warnedOnce = false

export function quotaSafeStorage<S>(onQuotaError?: () => void): PersistStorage<S> {
  return {
    getItem: (name) => {
      const str = localStorage.getItem(name)
      return str ? (JSON.parse(str) as StorageValue<S>) : null
    },
    setItem: (name, value) => {
      try {
        localStorage.setItem(name, JSON.stringify(value))
      } catch (e) {
        console.error('[persist] setItem failed', name, e)
        if (!warnedOnce) {
          warnedOnce = true
          try { onQuotaError?.() } catch { /* toast is best-effort */ }
        }
      }
    },
    removeItem: (name) => localStorage.removeItem(name),
  }
}
