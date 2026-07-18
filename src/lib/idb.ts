/**
 * Tiny promise wrapper around IndexedDB — the Tracking dataset (thousands of
 * rows × 65 columns ≈ several MB) is far too big for localStorage, so the rows
 * live here while only the small column-config sits in Zustand/localStorage.
 *
 * One object store: "rows", keyed by VIN. Each value = { vin, cells }.
 */
import type { TrackRow } from './excelTracking'

const DB_NAME = 'sjwd-yard'
const DB_VERSION = 1
const STORE = 'rows'

let dbp: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'vin' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE, mode).objectStore(STORE)
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
