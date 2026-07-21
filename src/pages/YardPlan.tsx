import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Zap, Layers, MapPin, Pencil, Eye, Plus, Trash2, RotateCw, Square, MousePointer2,
  Copy, X, Maximize2, Upload, Loader2, ImageOff, Grid3x3, ArrowLeftRight, ChevronDown,
  Search, Printer, Download,
} from 'lucide-react'
import { useYard, useUnits, useBlocks } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { deriveCarStatus, IN_YARD_STATUSES, CAR_STATUS_META } from '../lib/carStatus'
import { rowInSite } from '../lib/siteScope'
import { rowsToCsv, type TrackRow } from '../lib/excelTracking'
import { matchVins, toFindListRows } from '../lib/findCar'
import { printFindList, exportFindListXlsx } from '../lib/groupingPrint'
import { makeT } from '../i18n'
import { MODELS, ZONE_COLOR } from '../lib/sampleData'
import { BlockPopup } from '../components/BlockPopup'
import { ViewLegend } from '../components/ViewLegend'
import { PageHead } from '../components/ui'
import { usePlanBg, renderPlanFile, pdfPageCount, detectBlocks } from '../lib/planBg'
import { buildModelPalette, resolveSlotColor, YARD_VIEW_OPTIONS, type YardViewMode } from '../lib/yardView'
import type { Block, Unit } from '../types'

const BOARD_W = 1240

const SNAP = 10
const ZONES: Block['zone'][] = ['Y', 'B', 'R', 'G']
const ZONE_NAME: Record<string, string> = { Y: 'เหลือง', B: 'น้ำเงิน', R: 'แดง', G: 'เขียว' }
const snap = (n: number) => Math.round(n / SNAP) * SNAP
const blockFill = (b: Block) => b.color || ZONE_COLOR[b.zone] || '#64748b'

// ── free-form polygon shapes (normalised 0..1 inside the block box) ──
type Pt = { x: number; y: number }
const RECT_PTS: Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
const SHAPE_PRESETS: { key: string; label: string; pts: Pt[] | null }[] = [
  { key: 'rect', label: 'สี่เหลี่ยม', pts: null },
  { key: 'free', label: 'อิสระ (ลากมุม)', pts: RECT_PTS },
  { key: 'L', label: 'ตัว L', pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }] },
  { key: 'tri', label: 'สามเหลี่ยม', pts: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
  { key: 'trap', label: 'คางหมู', pts: [{ x: 0.22, y: 0 }, { x: 0.78, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
  { key: 'hex', label: 'หกเหลี่ยม', pts: [{ x: 0.25, y: 0 }, { x: 0.75, y: 0 }, { x: 1, y: 0.5 }, { x: 0.75, y: 1 }, { x: 0.25, y: 1 }, { x: 0, y: 0.5 }] },
]
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
const clipPathOf = (pts: Pt[]) => `polygon(${pts.map((p) => `${(p.x * 100).toFixed(2)}% ${(p.y * 100).toFixed(2)}%`).join(', ')})`
const polyPoints = (pts: Pt[]) => pts.map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(' ')
const centroidOf = (pts: Pt[]) => { let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y } return { x: x / pts.length, y: y / pts.length } }
const distToSeg = (px: number, py: number, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

// A starting layout that mirrors the BYD "PRE-LOADING AREA · PASSENGER CAR" plan
const SAMPLE_LAYOUT: Partial<Block>[] = [
  { id: 'A', name: 'PASSENGER CAR', kind: 'park', zone: 'B', rows: 3, cols: 30, x: 40,  y: 40,  w: 520, h: 150 },
  { id: 'B', name: 'PASSENGER CAR', kind: 'park', zone: 'B', rows: 3, cols: 30, x: 600, y: 40,  w: 520, h: 150 },
  { id: 'C', name: 'PRE-LOADING AREA', kind: 'park', zone: 'G', rows: 4, cols: 10, x: 40,  y: 230, w: 230, h: 200 },
  { id: 'D', name: 'PASSENGER CAR', kind: 'park', zone: 'B', rows: 3, cols: 24, x: 300, y: 230, w: 420, h: 150 },
  { id: 'PDI', name: 'PDI', kind: 'area', zone: 'R', rows: 1, cols: 1, x: 760, y: 230, w: 130, h: 90, color: '#ef4444' },
  { id: 'E', name: 'PASSENGER CAR', kind: 'park', zone: 'Y', rows: 8, cols: 4, x: 760, y: 350, w: 130, h: 200 },
]

/** Guarantee every block has x/y/w/h — blocks created before the editor get a flow layout. */
function withLayout(blocks: Block[]): (Block & { x: number; y: number; w: number; h: number })[] {
  let fx = 40, fy = 40, rowH = 0
  return blocks.map((b) => {
    if (b.x != null && b.y != null && b.w != null && b.h != null) return b as any
    const w = b.w ?? 260, h = b.h ?? 130
    if (fx + w > 1180) { fx = 40; fy += rowH + 30; rowH = 0 }
    const placed = { ...b, x: fx, y: fy, w, h }
    fx += w + 30; rowH = Math.max(rowH, h)
    return placed
  })
}

/** Mini colour-coded occupancy grid painted straight onto a block card on the
 *  main board — same per-slot colours as the BlockPopup grid (via
 *  resolveSlotColor), so switching the VIEW dropdown recolours every card
 *  immediately without opening a popup. Drawn on a tiny canvas (1 backing
 *  pixel per slot, scaled up with crisp/pixelated edges) so it stays cheap
 *  even with hundreds of slots across many visible blocks. */
function MiniSlotGrid({
  block, occ, viewMode, vinCells, modelColors,
}: {
  block: Block; occ: Unit[]; viewMode: YardViewMode
  vinCells: Map<string, Record<string, string>>; modelColors: Map<string, string>
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const transposed = !!block.transposed
  const w = transposed ? block.rows : block.cols
  const h = transposed ? block.cols : block.rows

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || w < 1 || h < 1) return
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    for (const u of occ) {
      if (!u.row || !u.slot) continue
      if (u.status !== 'PARKED' && u.status !== 'ASSIGNED' && u.status !== 'LOADED') continue
      const r = u.row - 1, c = u.slot - 1
      if (r < 0 || r >= block.rows || c < 0 || c >= block.cols) continue
      const dr = transposed ? c : r, dc = transposed ? r : c
      ctx.fillStyle = resolveSlotColor(u, viewMode, vinCells, modelColors)
      ctx.fillRect(dc, dr, 1, 1)
    }
  }, [block.rows, block.cols, transposed, occ, viewMode, vinCells, modelColors, w, h])

  if (w < 1 || h < 1) return null
  return (
    <canvas ref={ref} className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%', imageRendering: 'pixelated' }} />
  )
}

export function YardPlan() {
  const lang = useYard((s) => s.lang)
  const allUnits = useUnits()
  const blocks = useBlocks()
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const { autoParkAll, addBlock, updateBlock, removeBlock, renameBlockId, toast } = useYard()
  const t = makeT(lang)
  const siteName = sites.find((x) => x.id === currentSite)?.name

  const [edit, setEdit] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)
  const [panelId, setPanelId] = useState<string | null>(null) // block whose edit popup is open
  const [genOpen, setGenOpen] = useState(false)
  const [popups, setPopups] = useState<string[]>([]) // block ids with a floating slot popup open, front-to-back = array order
  // open a block's popup, or if already open, raise it to the front (top of z-order) — last in array = front
  const openOrFocus = (id: string) => setPopups((p) => (p.length && p[p.length - 1] === id ? p : [...p.filter((x) => x !== id), id]))
  const [live, setLive] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null)
  const [liveShape, setLiveShape] = useState<{ id: string; pts: Pt[] } | null>(null)
  const drag = useRef<null | {
    id: string; mode: 'move' | 'resize' | 'vertex'
    sx: number; sy: number; ox: number; oy: number; ow: number; oh: number
    cur: { x: number; y: number; w: number; h: number }
    vi?: number; opx?: number; opy?: number; pts?: Pt[]; curShape?: Pt[]
  }>(null)

  // ── imported PDF/image underlay (per site) ──
  const { bgs, loadAll, setBg, removeBg } = usePlanBg()
  useEffect(() => { loadAll() }, [loadAll])
  const bgKey = currentSite ?? 'default'
  const bg = bgs[bgKey] ?? null
  const [bgOpacity, setBgOpacity] = useState(0.65)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    setImporting(true)
    try {
      let page = 1
      if (f.type === 'application/pdf') {
        const n = await pdfPageCount(f)
        if (n > 1) {
          const ans = window.prompt(`PDF มี ${n} หน้า — เลือกหน้าที่จะนำเข้า (1-${n})`, '1')
          if (ans === null) { setImporting(false); return }
          page = Math.min(n, Math.max(1, parseInt(ans) || 1))
        }
      }
      const next = await renderPlanFile(f, page)
      await setBg(bgKey, next)
      // auto-detect parking zones and create blocks over the plan
      const detected = await detectBlocks(f, page, BOARD_W)
      if (detected.length && (blocks.length === 0 || confirm(`พบพื้นที่จอด ${detected.length} บล็อก — สร้างอัตโนมัติ (แทนบล็อกเดิม)?`))) {
        blocks.map((b) => b.id).forEach(removeBlock)
        detected.forEach((b) => addBlock(b))
        setSelId(null)
      }
      setEdit(true)
      toast('ok', detected.length ? `นำเข้าแปลน + สร้าง ${detected.length} บล็อกอัตโนมัติ · ปรับแต่งได้` : 'นำเข้าแปลนแล้ว · วาดบล็อกทับเพื่อกำหนดที่จอด')
    } catch (err: any) { toast('err', err?.message || 'นำเข้าไม่สำเร็จ') }
    setImporting(false)
  }

  const units = useMemo(
    () => (currentSite ? allUnits.filter((u) => u.site === currentSite) : allUnits),
    [allUnits, currentSite],
  )

  // ── find-car (ใบหารถ): Ctrl+F opens a bulk VIN search over this yard ──
  const [findOpen, setFindOpen] = useState(false)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // match by physical key (e.code) so it fires even when the keyboard is on
      // Thai (Ctrl+F then produces e.key='ด'); keep e.key as a fallback
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyF' || e.key === 'f' || e.key === 'F' || e.key === 'ด')) { e.preventDefault(); setFindOpen(true) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // ── slot colouring mode: Status (default) / Model / Grouping / Final Status ──
  const [viewMode, setViewMode] = useState<YardViewMode>('status')
  const [viewOpen, setViewOpen] = useState(false)
  const trackingRows = useTrackingRows()
  // VIN → tracking cells, for Grouping/Final Status (not fields on Unit itself)
  const vinCells = useMemo(() => new Map(trackingRows.map((r) => [r.vin, r.cells])), [trackingRows])
  // stable colour per model name, sorted so it doesn't shuffle as cars move
  const modelColors = useMemo(() => buildModelPalette(units.map((u) => u.modelName)), [units])
  // keyed by the unit's block tag (internal id OR block name — the Update
  // Location import tags cars by block name, e.g. "NN")
  const occByBlock = useMemo(() => {
    const m = new Map<string, Unit[]>()
    for (const u of units) {
      if (u.block && (u.status === 'PARKED' || u.status === 'ASSIGNED' || u.status === 'LOADED')) {
        const k = u.block.trim().toUpperCase()
        const a = m.get(k) ?? []; a.push(u); m.set(k, a)
      }
    }
    return m
  }, [units])
  const occFor = (b: { id: string; name: string }): Unit[] => {
    const id = b.id.trim().toUpperCase(), name = b.name.trim().toUpperCase()
    const byId = occByBlock.get(id) ?? []
    return name && name !== id ? [...byId, ...(occByBlock.get(name) ?? [])] : byId
  }
  // headline total across every park block in this plan (matches the per-tile numbers)
  const totals = useMemo(() => {
    let filled = 0, cap = 0
    for (const b of blocks) {
      if ((b.kind ?? 'park') !== 'park') continue
      filled += occFor(b).length
      cap += b.rows * b.cols
    }
    return { filled, cap, pct: cap ? Math.round((filled / cap) * 100) : 0 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, occByBlock])

  // Reconcile the Yard Plan (cars shown on the map) against the master In-Yard
  // count so every In-Yard car is accounted for: on-map + off-map = In Yard.
  // A car can be In Yard yet not appear on a tile for TWO different reasons:
  //   1. no block assigned at all → "ยังไม่จัดช่อง"
  //   2. it HAS a block tag, but that block isn't drawn on this plan (name
  //      mismatch / block never created) → "บล็อกไม่ตรงกับผัง"
  // The old reconcile only caught (1); cars in case (2) silently vanished from
  // both the tiles and the "unplaced" count, so the headline never added up.
  const inYardStats = useMemo(() => {
    // block keys actually drawn as PARK tiles (id + name, upper-cased) — this is
    // exactly what `totals.filled` matches a parked car against.
    const drawnKeys = new Set<string>()
    for (const b of blocks) {
      if ((b.kind ?? 'park') !== 'park') continue
      drawnKeys.add(b.id.trim().toUpperCase())
      if (b.name) drawnKeys.add(b.name.trim().toUpperCase())
    }
    // per parked VIN: its block tag + whether that tag is a drawn tile
    const blockOfVin = new Map<string, string>()
    const onMapVins = new Set<string>()
    for (const [key, arr] of occByBlock.entries()) {
      const drawn = drawnKeys.has(key)
      for (const u of arr) {
        if (!blockOfVin.has(u.vin)) blockOfVin.set(u.vin, key)
        if (drawn) onMapVins.add(u.vin)
      }
    }
    const unplacedRows: TrackRow[] = []                       // (1) no block at all
    const offMapRows: { row: TrackRow; block: string }[] = [] // (2) block tag not on the plan
    let inYard = 0
    for (const r of trackingRows) {
      if (!rowInSite(r, currentSite, sites)) continue
      if (!IN_YARD_STATUSES.has(deriveCarStatus(r.cells))) continue
      inYard++
      if (onMapVins.has(r.vin)) continue // shown on a tile
      const blk = blockOfVin.get(r.vin)
      if (blk) offMapRows.push({ row: r, block: blk })
      else unplacedRows.push(r)
    }
    return { inYard, unplaced: unplacedRows.length, unplacedRows, offMap: offMapRows.length, offMapRows }
  }, [trackingRows, occByBlock, blocks, currentSite, sites])
  const [showUnplaced, setShowUnplaced] = useState(false)

  const laid = useMemo(() => withLayout(blocks), [blocks])
  const panelBlock = panelId ? laid.find((b) => b.id === panelId) ?? null : null
  const boardH = useMemo(() => {
    const blocksH = Math.max(620, ...laid.map((b) => b.y + b.h + 60))
    return bg ? Math.max(blocksH, Math.round(BOARD_W * bg.h / bg.w)) : blocksH
  }, [laid, bg])

  // ── drag / resize (commit on pointer-up to avoid persisting every frame) ──
  const onDown = (e: React.PointerEvent, b: typeof laid[number], mode: 'move' | 'resize') => {
    if (!edit || e.altKey) return // Alt = open slot popup (handled in onClick), not drag
    e.stopPropagation()
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* synthetic/no-pointer */ }
    setSelId(b.id)
    drag.current = { id: b.id, mode, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, ow: b.w, oh: b.h, cur: { x: b.x, y: b.y, w: b.w, h: b.h } }
    setLive({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (d.mode === 'vertex') {
      const nx = clamp01((d.opx ?? 0) + dx / Math.max(1, d.ow)), ny = clamp01((d.opy ?? 0) + dy / Math.max(1, d.oh))
      const pts = (d.pts ?? RECT_PTS).map((p, i) => (i === d.vi ? { x: nx, y: ny } : p))
      d.curShape = pts; setLiveShape({ id: d.id, pts })
      return
    }
    const g = d.mode === 'move'
      ? { x: snap(Math.max(0, d.ox + dx)), y: snap(Math.max(0, d.oy + dy)), w: d.ow, h: d.oh }
      : { x: d.ox, y: d.oy, w: Math.max(60, snap(d.ow + dx)), h: Math.max(44, snap(d.oh + dy)) }
    d.cur = g
    setLive({ id: d.id, ...g })
  }
  const onUp = () => {
    const d = drag.current
    if (d) {
      if (d.mode === 'vertex') { if (d.curShape) updateBlock(d.id, { shape: d.curShape }) }
      else updateBlock(d.id, d.cur) // commit from the ref (latest), not the live-state closure
    }
    drag.current = null; setLive(null); setLiveShape(null)
  }

  // ── free-form shape editing: drag a vertex, double-click an edge to add, right-click to remove ──
  const ptsOf = (b: Block): Pt[] => (b.shape && b.shape.length >= 3 ? b.shape.map((p) => ({ ...p })) : RECT_PTS.map((p) => ({ ...p })))
  const onVertexDown = (e: React.PointerEvent, b: typeof laid[number], vi: number) => {
    if (!edit) return
    e.stopPropagation()
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* synthetic */ }
    const pts = ptsOf(b)
    setSelId(b.id)
    drag.current = { id: b.id, mode: 'vertex', sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, ow: b.w, oh: b.h, cur: { x: b.x, y: b.y, w: b.w, h: b.h }, vi, opx: pts[vi].x, opy: pts[vi].y, pts, curShape: pts }
    setLiveShape({ id: b.id, pts })
  }
  const addVertex = (b: typeof laid[number], e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const px = clamp01((e.clientX - r.left) / r.width), py = clamp01((e.clientY - r.top) / r.height)
    const pts = ptsOf(b)
    let bi = 0, best = Infinity
    for (let i = 0; i < pts.length; i++) { const d = distToSeg(px, py, pts[i], pts[(i + 1) % pts.length]); if (d < best) { best = d; bi = i } }
    pts.splice(bi + 1, 0, { x: px, y: py })
    updateBlock(b.id, { shape: pts })
  }
  const removeVertex = (b: typeof laid[number], vi: number) => {
    const pts = ptsOf(b)
    if (pts.length <= 3) { toast('info', 'ต้องมีอย่างน้อย 3 จุด'); return }
    pts.splice(vi, 1); updateBlock(b.id, { shape: pts })
  }

  const geom = (b: typeof laid[number]) => (live && live.id === b.id ? { ...b, ...live } : b)

  const doAdd = (kind: 'park' | 'area') => {
    const x = snap(60 + (blocks.length % 4) * 40), y = snap(60 + (blocks.length % 4) * 30)
    const id = addBlock(kind === 'area'
      ? { kind: 'area', name: 'พื้นที่ใหม่', rows: 1, cols: 1, w: 200, h: 120, x, y, zone: 'R', color: '#f59e0b' }
      : { kind: 'park', name: 'บล็อกใหม่', rows: 4, cols: 12, w: 300, h: 130, x, y, zone: 'Y' })
    setSelId(id); setPanelId(id); setEdit(true)
  }
  const doSeed = () => {
    if (blocks.length && !confirm('แทนที่ผังปัจจุบันด้วยผังตัวอย่าง BYD (PDF) ?')) return
    blocks.map((b) => b.id).forEach(removeBlock)
    SAMPLE_LAYOUT.forEach((b) => addBlock(b))
    setSelId(null); toast('ok', 'โหลดผังตัวอย่าง BYD แล้ว')
  }
  // generate a grid of blocks from numbers, then drag the cluster onto the PDF
  const doGenerate = (cfg: GenConfig) => {
    let made = 0, lastId = ''
    for (let r = 0; r < cfg.bRows; r++) for (let c = 0; c < cfg.bCols; c++) {
      lastId = addBlock({
        name: `${cfg.prefix}${r * cfg.bCols + c + 1}`, kind: 'park', zone: cfg.zone,
        rows: cfg.slotRows, cols: cfg.slotCols,
        x: snap(cfg.startX + c * (cfg.w + cfg.gap)), y: snap(cfg.startY + r * (cfg.h + cfg.gap)),
        w: cfg.w, h: cfg.h,
      })
      made++
    }
    setGenOpen(false); setEdit(true); setSelId(lastId)
    toast('ok', `สร้าง ${made} บล็อก · รวม ${(made * cfg.slotRows * cfg.slotCols).toLocaleString()} ที่จอด`)
  }

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHead
        title={
          <span className="flex items-center gap-2.5">
            {t('yardTitle')}
            {siteName && (
              <span className="badge" style={{ color: 'var(--brand)', background: 'var(--brand-soft)', fontSize: 13, padding: '3px 10px' }}>
                <MapPin size={13} /> {siteName}
              </span>
            )}
            {totals.cap > 0 && (
              <span className="badge tabular" title="รถที่จอดในผัง / ความจุรวมทุกบล็อก" style={{ color: '#15803d', background: 'rgba(22,163,74,0.1)', fontSize: 13, padding: '3px 10px' }}>
                Total {totals.filled.toLocaleString()} / {totals.cap.toLocaleString()} · {totals.pct}%
              </span>
            )}
            {(inYardStats.unplaced + inYardStats.offMap) > 0 && (
              <button onClick={() => setShowUnplaced(true)}
                title={`In Yard ${inYardStats.inYard.toLocaleString()} คัน — บนผัง ${totals.filled.toLocaleString()} · ไม่แสดงบนผัง ${(inYardStats.unplaced + inYardStats.offMap).toLocaleString()} (บล็อกไม่ตรงผัง ${inYardStats.offMap.toLocaleString()} · ยังไม่จัดช่อง ${inYardStats.unplaced.toLocaleString()}) · คลิกเพื่อดู/คัดลอกรายการ VIN`}
                className="badge tabular" style={{ color: '#a16207', background: 'rgba(234,179,8,0.16)', fontSize: 13, padding: '3px 10px', cursor: 'pointer' }}>
                ไม่แสดงบนผัง {(inYardStats.unplaced + inYardStats.offMap).toLocaleString()} ›
              </button>
            )}
          </span>
        }
        sub={edit ? 'โหมดแก้ไขผัง · ลากเพื่อย้าย · ลากมุมขวาล่างเพื่อปรับขนาด · Alt+คลิก เปิดหน้าต่างช่องจอด' : 'คลิกบล็อกเพื่อเปิดหน้าต่างดูช่องจอด (เปิดได้หลายอัน)'}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            {/* find-car (ใบหารถ) — bulk VIN search over this yard, also opens with Ctrl+F */}
            <button className="btn" title="ค้นหารถในลาน (Ctrl+F) — วาง VIN เต็มหรือ 5 ตัวท้าย" onClick={() => setFindOpen(true)}>
              <Search size={14} /> ค้นหารถ
            </button>

            {/* VIEW: colour every occupied slot by Status / Model / Grouping / Final Status */}
            <div className="relative">
              <button onClick={() => setViewOpen((v) => !v)}
                className="btn" style={viewOpen ? { background: 'var(--brand-soft)', color: 'var(--brand)' } : undefined}>
                <Layers size={14} /> มุมมอง: {YARD_VIEW_OPTIONS.find((o) => o.id === viewMode)?.label}
                <ChevronDown size={13} style={{ transform: viewOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
              </button>
              {viewOpen && (
                <>
                  <div className="fixed inset-0 z-[55]" onClick={() => setViewOpen(false)} />
                  <div className="absolute top-full left-0 mt-1.5 rounded-xl overflow-hidden z-[56] panel-solid" style={{ minWidth: 200, boxShadow: '0 12px 32px -8px rgba(15,23,42,0.28)' }}>
                    {YARD_VIEW_OPTIONS.map((o) => (
                      <button key={o.id} onClick={() => { setViewMode(o.id); setViewOpen(false) }}
                        className="w-full flex items-center gap-2 px-3.5 py-2.5 text-[13px] text-left transition"
                        style={viewMode === o.id ? { background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 600 } : { color: 'var(--text)' }}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="inline-flex p-1 rounded-xl gap-1" style={{ background: 'var(--chip)', border: '1px solid var(--line)' }}>
              <button onClick={() => { setEdit(false); setSelId(null) }}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold flex items-center gap-1.5 transition"
                style={!edit ? { background: '#fff', color: 'var(--brand)', boxShadow: '0 0 0 1px var(--line-strong)' } : { color: 'var(--muted)' }}>
                <Eye size={14} /> ดูผัง
              </button>
              <button onClick={() => setEdit(true)}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold flex items-center gap-1.5 transition"
                style={edit ? { background: '#fff', color: 'var(--brand)', boxShadow: '0 0 0 1px var(--line-strong)' } : { color: 'var(--muted)' }}>
                <Pencil size={14} /> แก้ไขผัง
              </button>
            </div>

            {/* import a PDF / image plan as an exact underlay */}
            <input ref={fileRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={onImportFile} />
            <button className="btn" disabled={importing} title="นำเข้าแปลนจาก PDF หรือรูปภาพ" onClick={() => fileRef.current?.click()}>
              {importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} {importing ? 'กำลังนำเข้า…' : 'นำเข้า PDF'}
            </button>
            {bg && (
              <div className="panel px-2.5 py-1.5 flex items-center gap-2">
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>ความเข้ม</span>
                <input type="range" min={0.1} max={1} step={0.05} value={bgOpacity} onChange={(e) => setBgOpacity(Number(e.target.value))} style={{ width: 72 }} />
              </div>
            )}

            {!edit && (
              <button className="btn btn-primary" onClick={() => { const n = autoParkAll(); toast(n ? 'ok' : 'info', n ? `จัดจอดอัตโนมัติ ${n} คัน` : 'ไม่มีรถรอจอด') }}>
                <Zap size={15} /> {t('autoFill')}
              </button>
            )}
            {edit && (
              <>
                <button className="btn btn-primary" onClick={() => setGenOpen(true)}><Grid3x3 size={15} /> สร้างบล็อกจากตัวเลข</button>
                <button className="btn" onClick={() => doAdd('park')}><Plus size={15} /> เพิ่มบล็อก</button>
                <button className="btn" onClick={() => doAdd('area')}><Square size={15} /> เพิ่มพื้นที่</button>
                <button className="btn btn-ghost text-[12.5px]" title="โหลดผังตัวอย่างตาม PDF" onClick={doSeed}>ผังตัวอย่าง BYD</button>
                {bg && <button className="btn btn-ghost text-[12.5px]" title="ลบแปลนพื้นหลัง" onClick={() => { if (confirm('ลบแปลนพื้นหลัง?')) removeBg(bgKey) }}><ImageOff size={15} /> ลบพื้นหลัง</button>}
              </>
            )}
          </div>
        }
      />

      {findOpen && <FindCarPanel units={units} siteName={siteName ?? ''} onClose={() => setFindOpen(false)} />}

      {/* legend for the active VIEW mode — visible on the main board itself, no popup needed */}
      <div className="panel px-3.5 py-2 mb-3">
        <ViewLegend viewMode={viewMode} modelColors={modelColors} />
      </div>

      <div>
        {/* ── board ── */}
        <div className="panel p-0 overflow-auto" style={{ maxHeight: 'calc(100vh - 210px)', background: '#e7ebf1' }} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          <div
            className="relative"
            style={{
              width: BOARD_W, height: boardH, minWidth: '100%',
              backgroundColor: '#e7ebf1',
              backgroundImage: bg ? undefined : 'linear-gradient(rgba(15,23,42,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.05) 1px, transparent 1px)',
              backgroundSize: `${SNAP * 4}px ${SNAP * 4}px`,
            }}
            onPointerDown={() => edit && setSelId(null)}
          >
            {bg && (
              <img src={bg.img} alt="แปลนที่นำเข้า" draggable={false}
                className="absolute top-0 left-0 select-none pointer-events-none"
                style={{ width: BOARD_W, height: boardH, opacity: bgOpacity }} />
            )}
            {laid.map((b0) => {
              const b = geom(b0)
              const occ = occFor(b0)
              const fill = blockFill(b0)
              const isArea = b0.kind === 'area'
              const cap = b0.rows * b0.cols
              const filled = occ.length
              const pctFull = cap ? Math.round((filled / cap) * 100) : 0
              const selected = edit && selId === b.id
              const shp = (liveShape && liveShape.id === b.id ? liveShape.pts : b0.shape)
              const shaped = !!(shp && shp.length >= 3)
              const pts = shaped ? shp! : RECT_PTS
              const ct = centroidOf(pts)
              return (
                <div
                  key={b.id}
                  onPointerDown={(e) => onDown(e, b0, 'move')}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (edit && !e.altKey) { setSelId(b.id); setPanelId(b.id); return } // edit: select to move/resize
                    openOrFocus(b0.id) // left-click → floating slot popup (or raise it to front if already open)
                  }}
                  onDoubleClick={edit && selected ? (e) => { e.stopPropagation(); addVertex(b0, e) } : undefined}
                  className="absolute group"
                  style={{
                    left: b.x, top: b.y, width: b.w, height: b.h,
                    transform: b0.rot ? `rotate(${b0.rot}deg)` : undefined, transformOrigin: 'center',
                    cursor: edit ? (drag.current ? 'grabbing' : 'grab') : 'pointer',
                    userSelect: 'none', touchAction: 'none',
                  }}
                >
                  {/* content — clipped to the polygon (fill, grid, occupancy bar) */}
                  <div className={`absolute inset-0 overflow-hidden ${shaped ? '' : 'rounded-xl'}`}
                    style={{
                      clipPath: shaped ? clipPathOf(pts) : undefined,
                      border: shaped ? 'none' : (isArea ? `2px solid ${fill}` : '1.5px solid #7e8b9c'),
                      background: isArea ? `${fill}1f` : '#ffffff',
                      boxShadow: shaped ? undefined : (selected
                        ? `0 0 0 2px #fff, 0 0 0 4px ${fill}, 0 12px 28px -8px ${fill}99`
                        : '0 1px 3px rgba(16,24,40,0.13), 0 1px 2px rgba(16,24,40,0.07)'),
                      filter: shaped ? (selected ? `drop-shadow(0 0 5px ${fill}aa) drop-shadow(0 2px 4px rgba(16,24,40,0.22))` : 'drop-shadow(0 2px 4px rgba(16,24,40,0.18))') : undefined,
                      transition: drag.current ? 'none' : 'box-shadow .15s',
                    }}>
                    {/* mini colour grid — per-slot colours for the active VIEW mode, live, no popup needed */}
                    {!isArea && (
                      <MiniSlotGrid block={b0} occ={occ} viewMode={viewMode} vinCells={vinCells} modelColors={modelColors} />
                    )}
                    {/* faint slot grid (park blocks) */}
                    {!isArea && (
                      <div className="absolute inset-0 pointer-events-none" style={{
                        backgroundImage: `repeating-linear-gradient(90deg, rgba(15,23,42,0.05) 0 1px, transparent 1px ${100 / Math.max(1, b0.cols)}%), repeating-linear-gradient(0deg, rgba(15,23,42,0.04) 0 1px, transparent 1px ${100 / Math.max(1, b0.rows)}%)`,
                      }} />
                    )}
                    {/* occupancy progress bar (bottom edge) */}
                    {!isArea && (
                      <div className="absolute left-0 right-0 bottom-0 pointer-events-none" style={{ height: 5, background: 'rgba(15,23,42,0.07)' }}>
                        <div style={{ height: '100%', width: `${pctFull}%`, background: '#22c55e', transition: drag.current ? 'none' : 'width .3s' }} />
                      </div>
                    )}
                  </div>

                  {/* polygon outline (not clipped, crisp stroke) */}
                  {shaped && (
                    <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                      <polygon points={polyPoints(pts)} fill="none" stroke={selected ? fill : (isArea ? fill : '#7e8b9c')} strokeWidth={selected ? 2.5 : 1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                    </svg>
                  )}

                  {/* label + occupancy (at centroid) — white chip so text stays legible over the colour grid */}
                  <div className="absolute flex flex-col items-center justify-center text-center px-1 pointer-events-none"
                    style={{
                      left: `${ct.x * 100}%`, top: `${ct.y * 100}%`, transform: 'translate(-50%,-50%)', maxWidth: '100%',
                      background: isArea ? undefined : 'rgba(255,255,255,0.86)',
                      borderRadius: 8, padding: isArea ? undefined : '2px 7px',
                      boxShadow: isArea ? undefined : '0 1px 5px rgba(16,24,40,0.18)',
                    }}>
                    <div className="font-extrabold leading-tight" style={{ fontSize: Math.min(18, b.h / 5.5), color: '#0f172a' }}>{b0.name}</div>
                    {!isArea && (
                      <>
                        <div className="font-semibold mt-0.5" style={{ fontSize: 11 }}>
                          <span style={{ color: filled ? '#16a34a' : '#64748b' }}>{filled}</span>
                          <span style={{ color: '#94a3b8' }}> / {cap.toLocaleString()}</span>
                          <span style={{ color: '#94a3b8' }}>{'  '}{pctFull}%</span>
                        </div>
                        <div style={{ fontSize: 9.5, color: '#9aa6b4' }}>{b0.rows} × {b0.cols}</div>
                      </>
                    )}
                  </div>

                  {/* vertex handles (edit + selected + custom shape) */}
                  {edit && selected && shaped && pts.map((pt, vi) => (
                    <div key={vi}
                      onPointerDown={(e) => onVertexDown(e, b0, vi)}
                      onContextMenu={(e) => { e.preventDefault(); removeVertex(b0, vi) }}
                      title="ลากเพื่อปรับรูป · คลิกขวาเพื่อลบจุด"
                      className="absolute"
                      style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%`, width: 13, height: 13, transform: 'translate(-50%,-50%)', borderRadius: '50%', background: '#fff', border: `2.5px solid ${fill}`, cursor: 'grab', zIndex: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.35)', touchAction: 'none' }} />
                  ))}

                  {/* resize handle — rectangles only (custom shapes use vertex handles) */}
                  {selected && !shaped && (
                    <div onPointerDown={(e) => onDown(e, b0, 'resize')}
                      className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize flex items-center justify-center"
                      style={{ background: fill, borderTopLeftRadius: 6, zIndex: 6 }}>
                      <Maximize2 size={9} color="#fff" />
                    </div>
                  )}
                </div>
              )
            })}

            {blocks.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={{ color: 'var(--faint)' }}>
                <Square size={40} className="mb-3" />
                <div className="text-[15px] font-semibold">ยังไม่มีบล็อกในผัง</div>
                <div className="text-[13px] mt-1">กด “แก้ไขผัง” แล้ว “เพิ่มบล็อก” เพื่อเริ่มจัดวาง</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── floating slot popups (Alt+Click a block) ── */}
      {popups.map((id, i) => {
        const blk = laid.find((b) => b.id === id)
        return blk ? (
          <BlockPopup key={id} block={blk} units={units} index={i}
            viewMode={viewMode} vinCells={vinCells} modelColors={modelColors}
            onToggleTranspose={() => updateBlock(id, { transposed: !blk.transposed })}
            onFocus={() => openOrFocus(id)}
            onClose={() => setPopups((p) => p.filter((x) => x !== id))} />
        ) : null
      })}

      {/* ── generate-from-numbers popup ── */}
      {genOpen && <GenerateBlocksModal onGenerate={doGenerate} onClose={() => setGenOpen(false)} />}

      {/* ── edit popup (centered) ── */}
      {edit && panelBlock && (
        <BlockEditModal
          key={panelBlock.id}
          block={panelBlock}
          onChange={(patch) => updateBlock(panelBlock.id, patch)}
          onRenameId={(nid) => {
            const applied = renameBlockId(panelBlock.id, nid)
            if (!applied) { toast('err', `ใช้รหัส "${nid.trim().toUpperCase()}" ไม่ได้ — ว่างหรือซ้ำกับบล็อกอื่น`); return false }
            setPanelId(applied); setSelId(applied)
            toast('ok', `เปลี่ยนรหัสบล็อกเป็น ${applied} · รถที่จอดอยู่ย้ายตามแล้ว`)
            return true
          }}
          onDelete={() => { if (confirm(`ลบบล็อก "${panelBlock.name}" ?`)) { removeBlock(panelBlock.id); setPanelId(null); setSelId(null) } }}
          onDuplicate={() => { const id = addBlock({ ...panelBlock, id: undefined, name: `${panelBlock.name} (สำเนา)`, x: (panelBlock.x ?? 40) + 30, y: (panelBlock.y ?? 40) + 30 } as Partial<Block>); setSelId(id); setPanelId(id) }}
          onClose={() => setPanelId(null)}
        />
      )}

      {/* ── In-Yard cars not shown on the plan (off-map block + unplaced) ── */}
      {showUnplaced && (
        <UnplacedModal unplaced={inYardStats.unplacedRows} offMap={inYardStats.offMapRows} siteName={siteName ?? ''} onClose={() => setShowUnplaced(false)} toast={toast} />
      )}

      {/* legend */}
      {!edit && (
        <div className="panel p-4 mt-3">
          <div className="flex items-center gap-2 mb-3 text-[13px] font-semibold"><Layers size={15} style={{ color: 'var(--brand)' }} /> {t('legend')}</div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {MODELS.map((m) => (
              <span key={m.id} className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--muted)' }}>
                <span className="w-3 h-3 rounded-sm" style={{ background: m.color }} /> {m.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Lists the In-Yard cars that don't appear on the plan, split into two groups:
 *  (1) block tag not drawn on the plan ("บล็อกไม่ตรงกับผัง") and (2) no block at
 *  all ("ยังไม่จัดช่อง") — with search, "copy all VINs" and CSV export. */
function UnplacedModal({ unplaced, offMap, siteName, onClose, toast }: {
  unplaced: TrackRow[]
  offMap: { row: TrackRow; block: string }[]
  siteName: string; onClose: () => void; toast: (k: 'ok' | 'err' | 'info', m: string) => void
}) {
  const [q, setQ] = useState('')
  const s = q.trim().toUpperCase()
  const fOff = useMemo(() => s ? offMap.filter((x) => x.row.vin.toUpperCase().includes(s) || x.block.toUpperCase().includes(s)) : offMap, [offMap, s])
  const fUn  = useMemo(() => s ? unplaced.filter((r) => r.vin.toUpperCase().includes(s)) : unplaced, [unplaced, s])
  const total = unplaced.length + offMap.length
  const allVins = [...offMap.map((x) => x.row.vin), ...unplaced.map((r) => r.vin)]
  const copyAll = () => {
    navigator.clipboard?.writeText(allVins.join('\n'))
    toast('ok', `คัดลอก ${allVins.length.toLocaleString()} VIN แล้ว`)
  }
  const exportCsv = () => rowsToCsv(`off-plan-${siteName || 'site'}.csv`,
    [{ key: 'Vin', label: 'VIN' }, { key: 'Model', label: 'Model' }, { key: 'Color', label: 'Color' },
     { key: '__block', label: 'Block tag' }, { key: '__reason', label: 'Reason' }],
    [
      ...offMap.map((x) => ({ ...x.row, cells: { ...x.row.cells, __block: x.block, __reason: 'บล็อกไม่ตรงกับผัง' } })),
      ...unplaced.map((r) => ({ ...r, cells: { ...r.cells, __block: '', __reason: 'ยังไม่จัดช่อง' } })),
    ] as TrackRow[])

  const Row = ({ r, n, block }: { r: TrackRow; n: number; block?: string }) => {
    const st = deriveCarStatus(r.cells); const meta = CAR_STATUS_META[st]
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ background: '#fff', marginBottom: 4 }}>
        <span className="text-[11px] tabular w-8 shrink-0" style={{ color: 'var(--faint)' }}>{n}</span>
        <span className="vin text-[13px] font-bold flex-1 clip">{r.vin}</span>
        <span className="text-[12px] shrink-0" style={{ color: 'var(--muted)' }}>{r.cells['Model'] || '—'}</span>
        {block && <span className="gbadge shrink-0" style={{ color: '#a16207', background: 'rgba(234,179,8,0.18)' }} title="บล็อกที่ถูก tag ไว้ แต่ไม่มีบนผัง">🏷 {block}</span>}
        <span className="gbadge shrink-0" style={meta ? { color: meta.color, background: meta.bg } : { color: 'var(--muted)', background: 'var(--chip)' }}>{st}</span>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid pop w-full overflow-hidden flex flex-col" style={{ maxWidth: 560, maxHeight: '86vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-5 py-4 border-b hairline">
          <MapPin size={18} style={{ color: '#a16207' }} />
          <div className="min-w-0 flex-1">
            <div className="font-bold text-[16px] leading-tight">รถที่ไม่แสดงบนผัง</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{total.toLocaleString()} คัน · {siteName} · อยู่ในลานแต่ไม่ปรากฏบนแผนผัง</div>
          </div>
          <button className="btn btn-ghost p-2" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-b hairline">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl flex-1" style={{ background: 'var(--chip)' }}>
            <input className="bg-transparent outline-none text-[13px] w-full vin" placeholder="ค้นหา VIN / บล็อก…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn" onClick={copyAll}><Copy size={14} /> คัดลอก VIN</button>
          <button className="btn" onClick={exportCsv}><Upload size={14} /> CSV</button>
        </div>
        <div className="overflow-auto p-2" style={{ background: 'var(--app-bg)' }}>
          {fOff.length > 0 && (
            <div className="px-2 pt-1.5 pb-1 text-[12px] font-bold flex items-center gap-1.5" style={{ color: '#a16207' }}>
              บล็อกไม่ตรงกับผัง
              <span className="badge" style={{ color: '#a16207', background: 'rgba(234,179,8,0.18)' }}>{offMap.length.toLocaleString()}</span>
              <span className="font-normal" style={{ color: 'var(--muted)' }}>— จอดแล้ว แต่บล็อกนี้ไม่มีบนแผน</span>
            </div>
          )}
          {fOff.map((x, i) => <Row key={x.row.vin} r={x.row} n={i + 1} block={x.block} />)}

          {fUn.length > 0 && (
            <div className="px-2 pt-3 pb-1 text-[12px] font-bold flex items-center gap-1.5" style={{ color: '#a16207' }}>
              ยังไม่จัดช่อง
              <span className="badge" style={{ color: '#a16207', background: 'rgba(234,179,8,0.18)' }}>{unplaced.length.toLocaleString()}</span>
              <span className="font-normal" style={{ color: 'var(--muted)' }}>— ยังไม่มีบล็อก</span>
            </div>
          )}
          {fUn.map((r, i) => <Row key={r.vin} r={r} n={i + 1} />)}

          {fOff.length === 0 && fUn.length === 0 && <div className="text-center py-8 text-[13px]" style={{ color: 'var(--faint)' }}>ไม่พบ VIN</div>}
        </div>
      </div>
    </div>
  )
}

/** Yard Plan find-car panel (ใบหารถ): paste VIN full/last-5/many → matches in
 *  this yard with their location, exportable as Excel/PDF. Opens with Ctrl+F. */
function FindCarPanel({ units, siteName, onClose }: { units: Unit[]; siteName: string; onClose: () => void }) {
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const toast = useYard((s) => s.toast)
  const allRows = useTrackingRows()
  const [text, setText] = useState('')
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const scoped = useMemo(
    () => (currentSite ? allRows.filter((r) => rowInSite(r, currentSite, sites)) : allRows),
    [allRows, currentSite, sites],
  )
  const unitByVin = useMemo(() => { const m = new Map<string, Unit>(); for (const u of units) m.set(u.vin, u); return m }, [units])

  const { found, notFound, asked } = useMemo(() => matchVins(text, scoped), [text, scoped])
  const findRows = useMemo(() => toFindListRows(found, (vin) => unitByVin.get(vin), siteName), [found, unitByVin, siteName])

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const doPdf = () => { if (findRows.length) printFindList(findRows, today) }
  const doXlsx = async () => {
    if (!findRows.length) return
    try { await exportFindListXlsx(findRows, today) } catch (e) { console.error('[findlist] xlsx', e); toast('err', 'ออกไฟล์ Excel ไม่สำเร็จ') }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid pop w-full overflow-hidden flex flex-col" style={{ maxWidth: 640, maxHeight: '88vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-5 py-4 border-b hairline">
          <Search size={18} style={{ color: 'var(--brand)' }} />
          <div className="min-w-0 flex-1">
            <div className="font-bold text-[16px] leading-tight">ค้นหารถ — ใบหารถ</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{siteName || '—'} · วาง VIN เต็มหรือ 5 ตัวท้าย · พิมพ์แป้นไทยก็ได้ · ออกใบหารถ Excel/PDF</div>
          </div>
          <button className="btn btn-ghost p-2" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="px-4 py-3 border-b hairline">
          <textarea className="input w-full" autoFocus style={{ minHeight: 78, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
            placeholder={'วาง/พิมพ์ VIN — เต็มหรือ 5 ตัวท้าย\nLGXC74C41SG006806\n006806\n06414'} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex items-center gap-3 mt-2 text-[12px] flex-wrap">
            <span style={{ color: 'var(--muted)' }}>ค้นหา <b className="tabular">{asked}</b> รายการ</span>
            <span style={{ color: 'var(--st-yard)' }}>พบ <b className="tabular">{found.length}</b> คัน</span>
            {notFound.length > 0 && <span style={{ color: 'var(--st-damage)' }}>ไม่พบ <b className="tabular">{notFound.length}</b></span>}
            <div className="ml-auto flex items-center gap-1.5">
              <button className="btn btn-ghost py-1" disabled={!found.length} onClick={doXlsx}><Download size={13} /> ใบหารถ (Excel)</button>
              <button className="btn btn-ghost py-1" disabled={!found.length} onClick={doPdf}><Printer size={13} /> ใบหารถ (PDF)</button>
              {text && <button className="btn btn-ghost py-1" onClick={() => setText('')}><X size={13} /> ล้าง</button>}
            </div>
          </div>
          {notFound.length > 0 && <div className="text-[11px] mt-1 vin clip" style={{ color: 'var(--faint)' }}>ไม่พบ: {notFound.slice(0, 12).join(', ')}{notFound.length > 12 ? ` +${notFound.length - 12}` : ''}</div>}
        </div>

        <div className="overflow-auto p-2" style={{ background: 'var(--app-bg)' }}>
          {asked === 0 ? (
            <div className="text-center py-8 text-[13px]" style={{ color: 'var(--faint)' }}>วาง VIN ด้านบนเพื่อค้นหาตำแหน่งรถในลาน</div>
          ) : found.length === 0 ? (
            <div className="text-center py-8 text-[13px]" style={{ color: 'var(--faint)' }}>ไม่พบรถในลานนี้</div>
          ) : (
            <>
              <div className="grid items-center gap-2 px-3 py-1.5 text-[11px] font-bold" style={{ gridTemplateColumns: '30px 1fr 96px 78px 96px', color: 'var(--faint)' }}>
                <span>No</span><span>VIN</span><span>Model</span><span>Color</span><span>Location</span>
              </div>
              {findRows.map((r, i) => (
                <div key={r.vin} className="grid items-center gap-2 px-3 py-1.5 rounded-lg" style={{ gridTemplateColumns: '30px 1fr 96px 78px 96px', background: '#fff', marginBottom: 3 }}>
                  <span className="text-[11px] tabular" style={{ color: 'var(--faint)' }}>{i + 1}</span>
                  <span className="vin text-[12.5px] font-bold clip">{r.vin}</span>
                  <span className="text-[11.5px] clip" style={{ color: 'var(--muted)' }}>{r.model || '—'}</span>
                  <span className="text-[11.5px] clip" style={{ color: 'var(--muted)' }}>{r.color || '—'}</span>
                  <span className="gbadge tabular" style={{ color: r.location ? 'var(--brand)' : '#a16207', background: r.location ? 'var(--brand-soft)' : 'rgba(234,179,8,0.16)', justifySelf: 'start' }}>{r.location || 'ไม่พบตำแหน่ง'}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── centered popup to edit one block ──────────────────────────────────────────
function BlockEditModal({ block, onChange, onRenameId, onDelete, onDuplicate, onClose }: {
  block: Block & { x: number; y: number; w: number; h: number }
  onChange: (p: Partial<Block>) => void
  onRenameId: (newId: string) => boolean
  onDelete: () => void
  onDuplicate: () => void
  onClose: () => void
}) {
  // block-id edit is committed on blur/Enter (live rename would remount the panel per keystroke)
  const [idDraft, setIdDraft] = useState(block.id)
  // stacked label + full-width input so the value is always visible
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>{label}</div>
      {children}
    </div>
  )
  const NumIn = ({ value, on, step = 10, min }: { value: number; on: (n: number) => void; step?: number; min?: number }) => (
    <input type="number" step={step} min={min} className="input w-full text-[14px] py-2 text-center tabular"
      value={value} onChange={(e) => on(Number(e.target.value) || 0)} />
  )
  return (
    // docked on the right (no backdrop) so the board stays draggable while editing the shape
    <div className="fixed top-0 right-0 bottom-0 z-[70] flex flex-col panel-solid" style={{ width: 372, maxWidth: '92vw', borderRadius: 0, borderLeft: '1px solid var(--line-strong)', boxShadow: '-14px 0 44px -16px rgba(15,23,42,0.5)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b hairline shrink-0">
        <span className="font-bold text-[16px] flex items-center gap-1.5"><MousePointer2 size={16} style={{ color: 'var(--brand)' }} /> แก้ไขบล็อก {block.id}</span>
        <button className="btn btn-ghost p-1.5" onClick={onClose}><X size={17} /></button>
      </div>

      <div className="space-y-3.5 p-4 overflow-auto flex-1">
          <div className="grid grid-cols-[92px_1fr] gap-3">
            <Field label="รหัส (badge)">
              <input className="input w-full text-[14px] py-2 text-center font-bold" value={idDraft}
                onChange={(e) => setIdDraft(e.target.value.toUpperCase())}
                onBlur={() => { const v = idDraft.trim().toUpperCase(); if (!v || v === block.id || !onRenameId(v)) setIdDraft(block.id) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            </Field>
            <Field label="ชื่อบล็อก">
              <input className="input w-full text-[14px] py-2" value={block.name} onChange={(e) => onChange({ name: e.target.value })} />
            </Field>
          </div>

          <Field label="ชนิด">
            <div className="inline-flex p-0.5 rounded-xl gap-0.5 w-full" style={{ background: 'var(--chip)' }}>
              {([['park', 'บล็อกจอด'], ['area', 'พื้นที่']] as const).map(([k, l]) => (
                <button key={k} onClick={() => onChange({ kind: k })}
                  className="flex-1 py-2 rounded-lg text-[12.5px] font-semibold transition"
                  style={(block.kind ?? 'park') === k ? { background: '#fff', color: 'var(--brand)', boxShadow: '0 0 0 1px var(--line-strong)' } : { color: 'var(--muted)' }}>{l}</button>
              ))}
            </div>
          </Field>

          {(block.kind ?? 'park') === 'park' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="แถว (rows)"><NumIn value={block.rows} on={(n) => onChange({ rows: Math.max(1, Math.round(n)) })} step={1} min={1} /></Field>
              <Field label="ช่อง (slots)"><NumIn value={block.cols} on={(n) => onChange({ cols: Math.max(1, Math.round(n)) })} step={1} min={1} /></Field>
            </div>
          )}

          <Field label="สี">
            <div className="flex items-center gap-2 flex-wrap">
              {ZONES.map((z) => (
                <button key={z} title={ZONE_NAME[z]} onClick={() => onChange({ zone: z, color: undefined })}
                  className="w-8 h-8 rounded-lg border-2 transition" style={{ background: ZONE_COLOR[z], borderColor: (!block.color && block.zone === z) ? 'var(--text)' : 'transparent' }} />
              ))}
              <label className="w-8 h-8 rounded-lg border cursor-pointer overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--line-strong)' }} title="สีกำหนดเอง">
                <input type="color" className="w-10 h-10 cursor-pointer" value={block.color ?? ZONE_COLOR[block.zone]} onChange={(e) => onChange({ color: e.target.value })} />
              </label>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="กว้าง (px)"><NumIn value={block.w} on={(n) => onChange({ w: Math.max(60, n) })} min={60} /></Field>
            <Field label="สูง (px)"><NumIn value={block.h} on={(n) => onChange({ h: Math.max(44, n) })} min={44} /></Field>
          </div>

          <Field label={`หมุนบล็อก (0–360°) · ${block.rot ?? 0}°`}>
            <div className="flex items-center gap-2">
              <input type="range" min={0} max={360} step={1} value={block.rot ?? 0} className="flex-1" onChange={(e) => onChange({ rot: Number(e.target.value) })} />
              <input type="number" min={0} max={360} value={block.rot ?? 0} className="input tabular text-center" style={{ width: 60, padding: '6px 4px' }}
                onChange={(e) => { const v = Math.round(Number(e.target.value) || 0); onChange({ rot: ((v % 360) + 360) % 360 }) }} />
              <button className="btn btn-ghost p-1.5" title="รีเซ็ตการหมุน" onClick={() => onChange({ rot: 0 })}><RotateCw size={14} /></button>
            </div>
          </Field>

          <Field label="รูปทรงบล็อก (อิสระ)">
            <div className="flex flex-wrap gap-1.5">
              {SHAPE_PRESETS.map((s) => {
                const active = s.pts ? JSON.stringify(block.shape) === JSON.stringify(s.pts) : !block.shape
                return (
                  <button key={s.key} onClick={() => onChange({ shape: s.pts ? s.pts.map((p) => ({ ...p })) : undefined })}
                    className="text-[12px] px-2.5 py-1.5 rounded-lg font-semibold transition"
                    style={active ? { background: 'var(--brand)', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>{s.label}</button>
                )
              })}
            </div>
            <p className="text-[11px] mt-1.5 leading-snug" style={{ color: 'var(--faint)' }}>เลือกทรงแล้ว <b>ลากจุดมุม</b>บนผังเพื่อปรับอิสระ · ดับเบิลคลิกขอบ = เพิ่มจุด · คลิกขวาที่จุด = ลบจุด</p>
          </Field>

          {(block.kind ?? 'park') === 'park' && (
            <Field label="ทิศการจัดช่อง">
              <button className="btn w-full justify-center text-[12.5px]" onClick={() => onChange({ transposed: !block.transposed })}>
                <ArrowLeftRight size={14} /> {block.transposed ? 'แถวด้านบน · ช่องด้านซ้าย' : 'ช่องด้านบน · แถวด้านซ้าย'} — กดเพื่อสลับ
              </button>
            </Field>
          )}
        </div>

        <div className="flex gap-2 p-4 border-t hairline shrink-0">
          <button className="btn flex-1 py-2.5 text-[13px]" onClick={onDuplicate}><Copy size={15} /> ทำซ้ำ</button>
          <button className="btn flex-1 py-2.5 text-[13px] font-semibold" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)' }} onClick={onDelete}><Trash2 size={15} /> ลบบล็อก</button>
          <button className="btn btn-primary flex-1 py-2.5 text-[13px]" onClick={onClose}>เสร็จ</button>
        </div>
    </div>
  )
}

// ── generate a grid of blocks from numbers ────────────────────────────────────
type GenConfig = { bCols: number; bRows: number; slotRows: number; slotCols: number; w: number; h: number; gap: number; zone: Block['zone']; prefix: string; startX: number; startY: number }

function GenerateBlocksModal({ onGenerate, onClose }: { onGenerate: (c: GenConfig) => void; onClose: () => void }) {
  const [bCols, setBCols] = useState(3)
  const [bRows, setBRows] = useState(3)
  const [slotRows, setSlotRows] = useState(4)
  const [slotCols, setSlotCols] = useState(10)
  const [w, setW] = useState(240)
  const [h, setH] = useState(120)
  const [gap, setGap] = useState(24)
  const [zone, setZone] = useState<Block['zone']>('Y')
  const [prefix, setPrefix] = useState('B')
  const total = bCols * bRows
  const cap = total * slotRows * slotCols

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div><div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>{label}</div>{children}</div>
  )
  const NumIn = ({ value, on, min = 1 }: { value: number; on: (n: number) => void; min?: number }) => (
    <input type="number" min={min} className="input w-full text-[14px] py-2 text-center tabular" value={value}
      onChange={(e) => on(Math.max(min, Math.round(Number(e.target.value) || min)))} />
  )

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="panel-solid glow-ring pop w-full p-5" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-bold text-[16px] flex items-center gap-1.5"><Grid3x3 size={16} style={{ color: 'var(--brand)' }} /> สร้างบล็อกจากตัวเลข</span>
          <button className="btn btn-ghost p-1.5" onClick={onClose}><X size={17} /></button>
        </div>

        <div className="space-y-3.5">
          <Field label="จำนวนบล็อก (คอลัมน์ × แถว)">
            <div className="flex items-center gap-2">
              <NumIn value={bCols} on={setBCols} />
              <span className="text-[13px]" style={{ color: 'var(--muted)' }}>×</span>
              <NumIn value={bRows} on={setBRows} />
            </div>
          </Field>

          <Field label="ช่องจอดต่อบล็อก (แถว × ช่อง)">
            <div className="flex items-center gap-2">
              <NumIn value={slotRows} on={setSlotRows} />
              <span className="text-[13px]" style={{ color: 'var(--muted)' }}>×</span>
              <NumIn value={slotCols} on={setSlotCols} />
            </div>
          </Field>

          <div className="grid grid-cols-3 gap-2">
            <Field label="กว้าง (px)"><NumIn value={w} on={setW} min={60} /></Field>
            <Field label="สูง (px)"><NumIn value={h} on={setH} min={44} /></Field>
            <Field label="ระยะห่าง"><NumIn value={gap} on={setGap} min={0} /></Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="ชื่อนำหน้า"><input className="input w-full text-[14px] py-2" value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
            <Field label="สี">
              <div className="flex items-center gap-1.5 pt-1">
                {ZONES.map((z) => (
                  <button key={z} title={ZONE_NAME[z]} onClick={() => setZone(z)}
                    className="w-7 h-7 rounded-lg border-2 transition" style={{ background: ZONE_COLOR[z], borderColor: zone === z ? 'var(--text)' : 'transparent' }} />
                ))}
              </div>
            </Field>
          </div>

          <div className="panel p-3 flex items-center justify-around text-center" style={{ background: 'var(--brand-soft, #eef4ff)' }}>
            <div><div className="display text-[20px] font-black" style={{ color: 'var(--brand)' }}>{total}</div><div className="text-[11px]" style={{ color: 'var(--muted)' }}>บล็อก</div></div>
            <div className="w-px self-stretch" style={{ background: 'var(--line-strong)' }} />
            <div><div className="display text-[20px] font-black" style={{ color: 'var(--brand)' }}>{cap.toLocaleString()}</div><div className="text-[11px]" style={{ color: 'var(--muted)' }}>ที่จอดรวม</div></div>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button className="btn flex-1 py-2.5 text-[13px]" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary flex-1 py-2.5 text-[13px] font-semibold" onClick={() => onGenerate({ bCols, bRows, slotRows, slotCols, w, h, gap, zone, prefix, startX: 40, startY: 40 })}>
            <Grid3x3 size={15} /> สร้าง {total} บล็อก
          </button>
        </div>
      </div>
    </div>
  )
}

export type { Unit }
