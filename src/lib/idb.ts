/**
 * Tiny promise wrapper around IndexedDB — the Tracking dataset (thousands of
 * rows × 65 columns ≈ several MB) is far too big for localStorage, so the rows
 * live here while only the small column-config sits in Zustand/localStorage.
 *
 * Object stores, both keyed by VIN:
 *  - "rows"  — tracking rows { vin, cells, … }
 *  - "units" — yard-plan cars with positions. These used to ride in the
 *    zustand/localStorage snapshot, but localStorage caps out around 5 MB and
 *    a QuotaExceededError there is SILENT — the cache simply stopped saving,
 *    so the yard plan started empty and re-downloaded everything on every
 *    single open ("รถไม่แสดงบนผัง ต้องเริ่มโหลดใหม่ทุกครั้ง").
 */
import type { TrackRow } from './excelTracking'
import type { Unit } from '../types'

const DB_NAME = 'sjwd-yard'
const DB_VERSION = 2
const STORE = 'rows'
const UNITS = 'units'

let dbp: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'vin' })
      if (!db.objectStoreNames.contains(UNITS)) db.createObjectStore(UNITS, { keyPath: 'vin' })
    }
    req.onsuccess = () => {
      // if the connection closes later (versionchange / browser eviction),
      // drop the cache so the next call reopens instead of failing forever
      req.result.onclose = () => { dbp = null }
      resolve(req.result)
    }
    req.onerror = () => { dbp = null; reject(req.error) } // don't cache a rejected open — retry next call
  })
  return dbp
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, store: string = STORE) {
  return db.transaction(store, mode).objectStore(store)
}

export async function idbGetAllRows(): Promise<TrackRow[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAll()
    req.onsuccess = () => resolve(req.result as TrackRow[])
    req.onerror = () => reject(req.error)
  })
}

export async function idbBulkPut(rows: TrackRow[]): Promise<void> {
  if (!rows.length) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    for (const r of rows) store.put(r)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export async function idbPut(row: TrackRow): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(row)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function idbDelete(vins: string[]): Promise<void> {
  if (!vins.length) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    for (const v of vins) store.delete(v)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('idb transaction aborted')) // quota/versionchange — never hang forever
  })
}

export async function idbClear(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').clear()
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function idbCount(): Promise<number> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// ── units store (yard-plan boot cache) ───────────────────────────────────────

export async function idbGetAllUnits(): Promise<Unit[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly', UNITS).getAll()
    req.onsuccess = () => resolve(req.result as Unit[])
    req.onerror = () => reject(req.error)
  })
}

export async function idbPutUnits(units: Unit[]): Promise<void> {
  if (!units.length) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(UNITS, 'readwrite')
    const store = t.objectStore(UNITS)
    for (const u of units) store.put(u)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('idb transaction aborted'))
  })
}

export async function idbDeleteUnits(vins: string[]): Promise<void> {
  if (!vins.length) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(UNITS, 'readwrite')
    const store = t.objectStore(UNITS)
    for (const v of vins) store.delete(v)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('idb transaction aborted'))
  })
}
