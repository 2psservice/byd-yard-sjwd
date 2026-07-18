import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowLeftRight } from 'lucide-react'
import type { Block, Unit } from '../types'
import { CarTopView } from './CarTopView'
import { StatusBadge } from './ui'
import { ViewLegend } from './ViewLegend'
import { blockTag, pos, unitInBlock } from '../lib/format'
import { resolveSlotColor, type YardViewMode } from '../lib/yardView'

const CELL = 18, GUTTER = 26, HEADER = 18

export function BlockPopup({
  block, units, onClose, onToggleTranspose, onFocus, index = 0,
  viewMode = 'status', vinCells, modelColors,
}: {
  block: Block; units: Unit[]; onClose: () => void; onToggleTranspose?: () => void; onFocus?: () => void; index?: number
  viewMode?: YardViewMode; vinCells?: Map<string, Record<string, string>>; modelColors?: Map<string, string>
}) {
  const [p, setP] = useState({ x: 60 + (index % 5) * 46, y: 84 + (index % 5) * 54 })
  const drag = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null)
  const [sel, setSel] = useState<Unit | null>(null)
  const [region, setRegion] = useState<null | { r1: number; c1: number; r2: number; c2: number }>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const selStart = useRef<null | { r: number; c: number }>(null)

  // ── orientation: transposed = rows run across the top, slots down the left ──
  const transposed = !!block.transposed
  const dRows = transposed ? block.cols : block.rows // rows in the displayed grid
  const dCols = transposed ? block.rows : block.cols // columns in the displayed grid
  const toActual = (dr: number, dc: number) => (transposed ? { r: dc, c: dr } : { r: dr, c: dc })

  const grid = useMemo(() => {
    const m = new Map<string, Unit>()
    for (const u of units) {
      if (unitInBlock(u, block) && u.row && u.slot && (u.status === 'PARKED' || u.status === 'ASSIGNED' || u.status === 'LOADED'))
        m.set(`${u.row}-${u.slot}`, u)
    }
    return m
  }, [units, block.id, block.name])
  const unitAt = (dr: number, dc: number) => { const a = toActual(dr, dc); return grid.get(`${a.r + 1}-${a.c + 1}`) }
  const filled = grid.size, cap = block.rows * block.cols, pct = cap ? Math.round((filled / cap) * 100) : 0
  const resolveColor = (u: Unit): string => resolveSlotColor(u, viewMode, vinCells, modelColors)

  // ── drag the popup by its title bar ──
  const onTitleDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y }
  }
  const onTitleMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return
    setP({ x: Math.max(0, d.ox + (e.clientX - d.sx)), y: Math.max(0, d.oy + (e.clientY - d.sy)) })
  }
  const onTitleUp = () => { drag.current = null }

  // ── drag-select a rectangle of slots (display coords) ──
  const cellAt = (e: React.PointerEvent) => {
    const el = gridRef.current; if (!el) return null
    const r = el.getBoundingClientRect()
    const c = Math.floor((e.clientX - r.left - GUTTER) / CELL) // cells start after the row-number gutter
    const row = Math.floor((e.clientY - r.top) / CELL)
    return { r: Math.max(0, Math.min(dRows - 1, row)), c: Math.max(0, Math.min(dCols - 1, c)) }
  }
  const onGridDown = (e: React.PointerEvent) => {
    const hit = cellAt(e); if (!hit) return
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    selStart.current = hit
    setRegion({ r1: hit.r, c1: hit.c, r2: hit.r, c2: hit.c })
  }
  const onGridMove = (e: React.PointerEvent) => {
    if (!selStart.current) return
    const hit = cellAt(e); if (!hit) return
    const s = selStart.current
    setRegion({ r1: Math.min(s.r, hit.r), c1: Math.min(s.c, hit.c), r2: Math.max(s.r, hit.r), c2: Math.max(s.c, hit.c) })
  }
  const onGridUp = (e: React.PointerEvent) => {
    const s = selStart.current; selStart.current = null
    const hit = cellAt(e)
    // a click (no drag) on an occupied slot → show its detail, clear selection
    if (s && hit && s.r === hit.r && s.c === hit.c) {
      const u = unitAt(hit.r, hit.c)
      if (u) { setSel(u); setRegion(null) }
    }
  }
  const inRegion = (r: number, c: number) => region && r >= region.r1 && r <= region.r2 && c >= region.c1 && c <= region.c2
  const regionCount = region ? (region.r2 - region.r1 + 1) * (region.c2 - region.c1 + 1) : 0

  return createPortal(
    <div className="fixed pop" onPointerDownCapture={onFocus} style={{ left: p.x, top: p.y, zIndex: 60 + index, boxShadow: '0 24px 60px -12px rgba(0,0,0,0.5)', borderRadius: 12, overflow: 'hidden', background: '#fff', border: '1px solid var(--line-strong)' }}>
      {/* ── title bar (drag handle) ── */}
      <div className="flex items-center gap-2.5 px-3 py-2 select-none" style={{ background: 'linear-gradient(135deg,#0d1726,#1b2c45)', cursor: 'grab' }}
        onPointerDown={onTitleDown} onPointerMove={onTitleMove} onPointerUp={onTitleUp}>
        <div className="min-w-0">
          <div className="font-bold text-[14px] text-white leading-tight">{block.name}</div>
          <div className="text-[10.5px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
            {transposed ? 'แถวด้านบน · ช่องด้านซ้าย' : 'ช่องด้านบน · แถวด้านซ้าย'} · ลากเพื่อคลุมเลือก
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <div className="text-right">
            <div className="text-[14px] font-bold tabular" style={{ color: '#4ade80' }}>{pct}%</div>
            <div className="h-1 w-16 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.18)' }}><div style={{ height: '100%', width: `${pct}%`, background: '#22c55e' }} /></div>
          </div>
          {onToggleTranspose && (
            <button onClick={onToggleTranspose} title="สลับแกน row ↔ ช่อง" onPointerDown={(e) => e.stopPropagation()}
              className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: transposed ? 'var(--brand)' : 'rgba(255,255,255,0.12)', color: '#fff' }}><ArrowLeftRight size={15} /></button>
          )}
          <button onClick={onClose} onPointerDown={(e) => e.stopPropagation()} className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.12)', color: '#fff' }}><X size={15} /></button>
        </div>
      </div>

      {/* ── grid ── */}
      <div className="p-3 overflow-auto" style={{ maxWidth: '88vw', maxHeight: '62vh' }}>
        <div className="inline-block">
          {/* column-number header */}
          <div className="flex" style={{ paddingLeft: GUTTER, height: HEADER }}>
            {Array.from({ length: dCols }, (_, c) => (
              <div key={c} className="text-center tabular font-semibold flex items-center justify-center" style={{ width: CELL, fontSize: 9.5, color: 'var(--muted)' }}>{c + 1}</div>
            ))}
          </div>
          {/* rows with drag-select */}
          <div ref={gridRef} className="relative" style={{ touchAction: 'none' }}
            onPointerDown={onGridDown} onPointerMove={onGridMove} onPointerUp={onGridUp}>
            {Array.from({ length: dRows }, (_, r) => (
              <div key={r} className="flex items-center" style={{ height: CELL }}>
                <div className="tabular text-right pr-1.5 font-semibold" style={{ width: GUTTER, fontSize: 9.5, color: 'var(--muted)' }}>{r + 1}</div>
                {Array.from({ length: dCols }, (_, c) => {
                  const u = unitAt(r, c)
                  const picked = inRegion(r, c)
                  return (
                    <div key={c} title={u ? `${u.vin} · ${u.modelName}` : pos({ block: blockTag(block), row: toActual(r, c).r + 1, slot: toActual(r, c).c + 1 })}
                      style={{
                        width: CELL - 2, height: CELL - 2, margin: 1, borderRadius: 3,
                        background: u ? resolveColor(u) : '#eef1f5',
                        border: u ? 'none' : '1px solid #dde3ea',
                        opacity: u && viewMode === 'status' && u.status === 'ASSIGNED' ? 0.7 : 1,
                        boxShadow: picked ? 'inset 0 0 0 2px #0f172a' : sel && u && sel.vin === u.vin ? '0 0 0 2px #fff, 0 0 0 3px var(--brand)' : undefined,
                      }} />
                  )
                })}
              </div>
            ))}
            {/* dark selection overlay */}
            {region && (
              <div className="absolute pointer-events-none" style={{
                left: GUTTER + region.c1 * CELL, top: region.r1 * CELL,
                width: (region.c2 - region.c1 + 1) * CELL, height: (region.r2 - region.r1 + 1) * CELL,
                background: 'rgba(15,23,42,0.28)', border: '1.5px solid #0f172a', borderRadius: 4,
              }} />
            )}
          </div>
        </div>
      </div>

      {/* ── footer: legend (matches the active VIEW mode) + selection / detail ── */}
      <div className="px-3 py-2 border-t hairline overflow-auto" style={{ background: 'var(--app-bg)', maxHeight: 90 }}>
        <ViewLegend viewMode={viewMode} modelColors={modelColors} />
        {regionCount > 1 && (
          <div className="text-[11.5px] mt-1.5 font-semibold" style={{ color: '#0f172a' }}>เลือก {regionCount} ช่อง ({region!.c2 - region!.c1 + 1}×{region!.r2 - region!.r1 + 1})</div>
        )}
      </div>

      {/* slot click → rich vehicle detail card (with car .png) */}
      {sel && <SlotDetailCard u={sel} label={sel.block ? pos(sel) : sel.vin} onClose={() => setSel(null)} />}
    </div>,
    document.body,
  )
}

// ── vehicle detail card shown when a slot is clicked (BYD scan-card style) ──
function SlotDetailCard({ u, label, onClose }: { u: Unit; label: string; onClose: () => void }) {
  const ts = u.gateInAt ?? u.parkedAt ?? u.importedAt
  const days = ts ? Math.max(0, Math.floor((Date.now() - ts) / 86400000)) : null
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: 'rgba(8,15,28,0.55)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="rounded-2xl overflow-hidden pop" style={{ width: 300, maxWidth: '92vw', background: '#0c1a2e', boxShadow: '0 30px 70px -18px rgba(0,0,0,0.7)' }} onClick={(e) => e.stopPropagation()}>
        {/* header: position + dwell days + close */}
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: 'linear-gradient(135deg,#0c1a2e,#1e3a5f)' }}>
          <span className="font-extrabold text-[15px] text-white tracking-wide">{label}</span>
          {days != null && <span className="text-[11px] font-bold px-2 py-0.5 rounded-md" style={{ background: 'rgba(255,255,255,0.14)', color: '#fff' }}>{days} Days</span>}
          <button onClick={onClose} className="ml-auto w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.12)', color: '#fff' }}><X size={15} /></button>
        </div>
        {/* VIN + status + model */}
        <div className="px-4 pt-3" style={{ background: '#0c1a2e' }}>
          <div className="vin font-bold text-[16px] text-white break-all leading-tight">{u.vin}</div>
          <div className="flex items-center gap-2 mt-1.5 min-w-0">
            <StatusBadge status={u.status} />
            <span className="text-[12.5px] truncate" style={{ color: 'rgba(255,255,255,0.5)' }}>{u.modelName}</span>
          </div>
        </div>
        {/* car .png on gradient */}
        <div className="flex items-center justify-center pt-1 pb-3" style={{ background: 'linear-gradient(180deg,#0c1a2e,#16324e)' }}>
          <CarTopView color={u.colorHex ?? '#cfd6dd'} width={120} />
        </div>
        {/* bottom strip: colour + gate-in */}
        <div className="px-4 py-2.5 flex items-center justify-between text-[11.5px]" style={{ background: '#0a1422', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <span className="flex items-center gap-1.5" style={{ color: 'rgba(255,255,255,0.72)' }}>
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: u.colorHex ?? '#888', boxShadow: '0 0 0 1px rgba(255,255,255,0.25)' }} /> {u.color}
          </span>
          {u.gateInAt && <span style={{ color: 'rgba(255,255,255,0.5)' }}>เข้าลาน {new Date(u.gateInAt).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
