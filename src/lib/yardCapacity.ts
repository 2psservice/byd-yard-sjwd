/** Per-site "Max Cap." — the app's only source for the yard's REAL parking
 *  capacity, set once by an admin in Report → รายงานประจำวัน (DailyStockReport).
 *  Distinct from (and usually much smaller than) the sum of every drawn
 *  block's rows×cols on the Yard Plan, which is a planning-grid figure, not
 *  the yard's actual physical capacity.
 *
 *  Stored in one `app_config` row keyed by site id, shared across devices;
 *  cached in localStorage so it's visible offline. This constant/cache-key
 *  pair is shared by every reader/writer — keep it that way, or a stale
 *  duplicate key will silently desync from the real value. */
export const YARD_CAPACITY_CONFIG_ID = 'yardCapacity'
export const YARD_CAPACITY_CACHE_KEY = 'sjwd.yardCapacity'

import { useEffect, useState } from 'react'
import * as db from './db'

/** Read-only per-site capacity map — for editing, see DailyStockReport.tsx
 *  (the one page that owns the "Max Cap." input). */
export function useYardCapacityMap(): Record<string, number> {
  const [caps, setCaps] = useState<Record<string, number>>(() => {
    try {
      const cached = localStorage.getItem(YARD_CAPACITY_CACHE_KEY)
      return cached ? JSON.parse(cached) : {}
    } catch { return {} }
  })
  useEffect(() => {
    db.fetchAppConfig<Record<string, number>>(YARD_CAPACITY_CONFIG_ID)
      .then((v) => {
        if (!v) return
        setCaps(v)
        try { localStorage.setItem(YARD_CAPACITY_CACHE_KEY, JSON.stringify(v)) } catch { /* private mode */ }
      })
      .catch((e) => console.error('[yardCapacity] load', e))
  }, [])
  return caps
}
