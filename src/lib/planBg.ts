/**
 * Yard-plan background underlay — import a PDF (or image) of a CAD site plan and
 * render it to a compressed image that sits *behind* the editable blocks, so the
 * exact drawing (every line / curve / angle) shows 1:1 while operators trace
 * capacity blocks on top. Images live in IndexedDB (too big for localStorage);
 * only their presence is reflected in the in-memory store.
 */
import { create } from 'zustand'
import type { Block } from '../types'

export interface PlanBg {
  img: string   // compressed JPEG dataURL
  w: number     // natural pixel size of the render
  h: number
  name?: string // source file name
}

// ── tiny IndexedDB (one store, keyed by site id) ──────────────────────────────
const DB = 'sjwd-planbg'
const STORE = 'bg'
let dbp: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}
async function idbGet(key: string): Promise<PlanBg | undefined> {
  const db = await open()
  return new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
}
async function idbPut(key: string, v: PlanBg): Promise<void> {
  const db = await open()
  return new Promise((res, rej) => { const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error) })
}
async function idbDel(key: string): Promise<void> {
  const db = await open()
  return new Promise((res, rej) => { const r = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error) })
}
async function idbKeys(): Promise<string[]> {
  const db = await open()
  return new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(); r.onsuccess = () => res(r.result as string[]); r.onerror = () => rej(r.error) })
}

// ── pdf.js (lazy-loaded from CDN; only needed at import time) ──────────────────
let pdfjs: any = null
async function loadPdfjs(): Promise<any> {
  if (pdfjs) return pdfjs
  if (!(window as any).pdfjsLib) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
      s.onload = () => resolve(); s.onerror = () => reject(new Error('โหลดตัวอ่าน PDF ไม่สำเร็จ (ต้องต่ออินเทอร์เน็ตตอนนำเข้า)'))
      document.head.appendChild(s)
    })
  }
  pdfjs = (window as any).pdfjsLib
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  return pdfjs
}

/** How many pages a PDF has (1 for images). */
export async function pdfPageCount(file: File): Promise<number> {
  if (file.type !== 'application/pdf') return 1
  const lib = await loadPdfjs()
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise
  return pdf.numPages
}

/** Render one PDF page (or an image file) to a compressed JPEG underlay. */
export async function renderPlanFile(file: File, page = 1, maxW = 2000): Promise<PlanBg> {
  if (file.type !== 'application/pdf') return imageToBg(file, maxW)
  const lib = await loadPdfjs()
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise
  const pg = await pdf.getPage(Math.min(Math.max(1, page), pdf.numPages))
  const base = pg.getViewport({ scale: 1 })
  const scale = Math.min(3, maxW / base.width)
  const vp = pg.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height) // flatten transparency
  await pg.render({ canvasContext: ctx, viewport: vp }).promise
  return { img: canvas.toDataURL('image/jpeg', 0.85), w: canvas.width, h: canvas.height, name: file.name }
}

function imageToBg(file: File, maxW: number): Promise<PlanBg> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width)
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h)
        resolve({ img: canvas.toDataURL('image/jpeg', 0.85), w, h, name: file.name })
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

// ── auto-detect parking blocks from the plan ──────────────────────────────────
// The slot grids are the densest ink regions; we find those dense zones and tile
// each with a grid of blocks. Approximate (a CAD survey can't be read exactly),
// so the result is a starting layout the operator fine-tunes over the underlay.
async function fileToCanvas(file: File, maxW: number): Promise<HTMLCanvasElement> {
  if (file.type === 'application/pdf') {
    const lib = await loadPdfjs()
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise
    const pg = await pdf.getPage(1)
    const base = pg.getViewport({ scale: 1 })
    const vp = pg.getViewport({ scale: maxW / base.width })
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height)
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height)
    await pg.render({ canvasContext: ctx, viewport: vp }).promise
    return c
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader(); r.onerror = reject
    r.onload = () => { const im = new Image(); im.onerror = reject; im.onload = () => {
      const s = Math.min(1, maxW / im.width); const c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s)
      const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(im, 0, 0, c.width, c.height); resolve(c)
    }; im.src = r.result as string }
    r.readAsDataURL(file)
  })
}

const DET_ZONES: Block['zone'][] = ['Y', 'B', 'G', 'R']

/** Detect parking zones from the plan and tile each into blocks (board coords). */
export async function detectBlocks(file: File, _page = 1, boardW = 1240): Promise<Partial<Block>[]> {
  const canvas = await fileToCanvas(file, 1400)
  const W = canvas.width, H = canvas.height
  const data = canvas.getContext('2d')!.getImageData(0, 0, W, H).data
  const CELL = 10, GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL)
  const dens = new Float32Array(GW * GH)
  for (let y = 0; y < H; y++) { const gy = (y / CELL) | 0; for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 120) dens[gy * GW + ((x / CELL) | 0)]++ } }
  let bin = new Uint8Array(GW * GH)
  for (let i = 0; i < dens.length; i++) bin[i] = dens[i] / (CELL * CELL) > 0.34 ? 1 : 0
  // dilate by 1 cell to bridge thin driving lanes inside a zone
  const dil = new Uint8Array(GW * GH)
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) { if (!bin[gy * GW + gx]) continue; for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) { const nx = gx + xx, ny = gy + yy; if (nx >= 0 && ny >= 0 && nx < GW && ny < GH) dil[ny * GW + nx] = 1 } }
  bin = dil
  // connected components → zones
  const lab = new Int32Array(GW * GH), comps: { x: number; y: number; w: number; h: number; ar: number }[] = [], st: number[] = []
  for (let i = 0; i < bin.length; i++) {
    if (bin[i] && !lab[i]) {
      const id = comps.length + 1; let mnx = GW, mny = GH, mxx = 0, mxy = 0, ar = 0; st.push(i); lab[i] = id
      while (st.length) { const p = st.pop()!; const px = p % GW, py = (p / GW) | 0; ar++; if (px < mnx) mnx = px; if (px > mxx) mxx = px; if (py < mny) mny = py; if (py > mxy) mxy = py
        for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) { const nx = px + xx, ny = py + yy; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue; const np = ny * GW + nx; if (bin[np] && !lab[np]) { lab[np] = id; st.push(np) } } }
      comps.push({ x: mnx * CELL, y: mny * CELL, w: (mxx - mnx + 1) * CELL, h: (mxy - mny + 1) * CELL, ar })
    }
  }
  const zones = comps.filter((c) => c.ar > 120 && c.w > 60 && c.h > 60).sort((a, b) => b.ar - a.ar).slice(0, 8)
  const sc = boardW / W
  const TBW = 150, TBH = 120, GAP = 14
  const out: Partial<Block>[] = []; let n = 0
  zones.forEach((z, zi) => {
    const cols = Math.max(1, Math.round(z.w / (TBW + GAP))), rows = Math.max(1, Math.round(z.h / (TBH + GAP)))
    const bw = (z.w - (cols - 1) * GAP) / cols, bh = (z.h - (rows - 1) * GAP) / rows
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const X = Math.round((z.x + c * (bw + GAP)) * sc), Y = Math.round((z.y + r * (bh + GAP)) * sc)
      const Wp = Math.round(bw * sc), Hp = Math.round(bh * sc)
      out.push({ name: `B${++n}`, kind: 'park', zone: DET_ZONES[zi % 4], x: X, y: Y, w: Wp, h: Hp, rows: Math.max(2, Math.round(Hp / 26)), cols: Math.max(2, Math.round(Wp / 22)) })
    }
  })
  return out
}

// ── store (in-memory cache of the loaded backgrounds, keyed by site id) ────────
interface PlanBgState {
  bgs: Record<string, PlanBg>
  loaded: boolean
  loadAll: () => Promise<void>
  setBg: (siteId: string, bg: PlanBg) => Promise<void>
  removeBg: (siteId: string) => Promise<void>
}
export const usePlanBg = create<PlanBgState>((set, get) => ({
  bgs: {},
  loaded: false,
  loadAll: async () => {
    if (get().loaded) return
    try {
      const keys = await idbKeys()
      const bgs: Record<string, PlanBg> = {}
      for (const k of keys) { const v = await idbGet(k); if (v) bgs[k] = v }
      set({ bgs, loaded: true })
    } catch { set({ loaded: true }) }
  },
  setBg: async (siteId, bg) => { set((s) => ({ bgs: { ...s.bgs, [siteId]: bg } })); await idbPut(siteId, bg).catch(() => {}) },
  removeBg: async (siteId) => { set((s) => { const b = { ...s.bgs }; delete b[siteId]; return { bgs: b } }); await idbDel(siteId).catch(() => {}) },
}))
