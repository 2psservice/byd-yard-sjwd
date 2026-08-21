import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowLeftRight, Layers, Wand2 } from 'lucide-react'
import type { Block, Unit } from '../types'
import { CarTopView } from './CarTopView'
import { StatusBadge } from './ui'
import { ViewLegend } from './ViewLegend'
import { blockTag, pos, unitInBlock } from '../lib/format'
import { laneFromCloud } from '../lib/laneCloud'
import { resolveSlotColor, type YardViewMode } from '../lib/yardView'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'

const CELL = 18, GUTTER = 26, HEADER = 18

export function BlockPopup({
  block, units, onClose, onToggleTranspose, onFocus, index = 0,
  viewMode = 'status', vinCells, modelColors,
}: {
  block: Block; units: Unit[]; onClose: () => void; onToggleTranspose?: () => void; onFocus?: () => void; index?: number
  viewMode?: YardViewMode; vinCells?: Map<string, Record<string, string>>; modelColors?: Map<string, string>
}) {
  const { currentUser, updateLocations, toast } = useYard()
  const appendHistory = useTracking((s) => s.appendHistory)
  const [p, setP] = useState({ x: 60 + (index % 5) * 46, y: 84 + (index % 5) * 54 })
  const drag = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null)
  const [sel, setSel] = useState<Unit | null>(null)
  // a square claimed by several cars → list them all rather than pick one
  const [stack, setStack] = useState<null | { label: string; list: Unit[] }>(null)
  const [region, setRegion] = useState<null | { r1: number; c1: number; r2: number; c2: number }>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const selStart = useRef<null | { r: number; c: number }>(null)

  // ── orientation: transposed = rows run across the top, slots down the left ──
  const transposed = !!block.transposed
  const dRows = transposed ? block.cols : block.rows // rows in the displayed grid
  const dCols = transposed ? block.rows : block.cols // columns in the displayed grid
  const toActual = (dr: number, dc: number) => (transposed ? { r: dc, c: dr } : { r: dr, c: dc })

  // A square can legitimately end up claimed by MORE THAN ONE car: depth down a
  // lane ("คันที่ N") is handed out as the first free number, computed from a
  // units cache that fills page by page, so two devices could both hand out
  // คันที่ 1. This map used to keep one car per square, which meant the extra
  // car vanished from the plan entirely — N1 held 5 cars and the plan drew 4.
  // Keep every car: the square shows the first and flags the clash, and the
  // occupancy count counts them all, so the plan and the lane list agree.
  const grid = useMemo(() => {
    const m = new Map<string, Unit[]>()
    for (const u of units) {
      if (unitInBlock(u, block) && u.row && u.slot && (u.status === 'PARKED' || u.status === 'ASSIGNED' || u.status === 'LOADED')) {
        const k = `${u.row}-${u.slot}`
        const at = m.get(k)
        if (at) at.push(u); else m.set(k, [u])
      }
    }
    for (const list of m.values()) if (list.length > 1) list.sort((a, b) => (a.parkedAt ?? a.importedAt ?? 0) - (b.parkedAt ?? b.importedAt ?? 0))
    return m
  }, [units, block.id, block.name])
  const unitsAt = (dr: number, dc: number) => { const a = toActual(dr, dc); return grid.get(`${a.r + 1}-${a.c + 1}`) }
  const unitAt = (dr: number, dc: number) => unitsAt(dr, dc)?.[0]
  let filled = 0
  let clashes = 0
  for (const list of grid.values()) { filled += list.length; if (list.length > 1) clashes += list.length - 1 }
  const cap = block.rows * block.cols, pct = cap ? Math.round((filled / cap) * 100) : 0
  const resolveColor = (u: Unit): string => resolveSlotColor(u, viewMode, vinCells, modelColors)

  /**
   * Give every car on one square its own depth — run by a person, never by
   * itself. The car that has stood there longest keeps the square; the others
   * take the shallowest free depths left in the SAME lane, so nothing that
   * already has a square of its own is touched and no car changes lane.
   */
  const fixStack = async (list: Unit[]) => {
    const slot = list[0]?.slot
    if (!slot || list.length < 2) return
    // Which depths are free is decided from the CLOUD, not from this browser's
    // copy of the yard. Handing out a depth from a stale copy is how a car that
    // moved away kept holding its old square — and how a car nobody here had
    // loaded yet got landed on. Offline this falls back to the local view.
    const fresh = await laneFromCloud(units, useYard.getState().currentSite, blockTag(block), slot)
    const lane = fresh.filter((u) => unitInBlock(u, block) && u.slot === slot && u.row
      && (u.status === 'PARKED' || u.status === 'ASSIGNED' || u.status === 'LOADED'))
    const taken = new Set(lane.map((u) => u.row!))
    // …and the clash itself is re-checked against the cloud. A car this browser
    // draws on the square may have been driven elsewhere since; it is not part
    // of the pile any more, and re-parking it here would undo a real move.
    const byVin = new Map(fresh.map((u) => [u.vin, u] as const))
    const stacked = list.filter((u) => {
      const now = byVin.get(u.vin) ?? u
      return unitInBlock(now, block) && now.slot === slot
    })
    if (stacked.length < 2) {
      setStack(null)
      toast('info', 'ตรวจกับระบบกลางแล้ว — รถไม่ได้ซ้อนช่องกันจริง (มีคันที่ถูกย้ายไปแล้ว)')
      return
    }
    const updates: {
      vin: string; block: string; row: number; slot: number; modelName?: string; color?: string
      from?: { block?: string; row?: number; slot?: number }
    }[] = []
    for (const u of stacked.slice(1)) { // [0] is the longest-standing car — it stays put
      let depth = 0
      for (let r = 1; r <= block.rows; r++) if (!taken.has(r)) { depth = r; break }
      if (!depth) break // lane genuinely full — leave the rest for a human to move
      taken.add(depth)
      const seenAt = byVin.get(u.vin) ?? u
      updates.push({ vin: u.vin, block: blockTag(block), row: depth, slot, modelName: u.modelName, color: u.color,
        from: { block: seenAt.block, row: seenAt.row, slot: seenAt.slot } })
      appendHistory(u.vin, { at: Date.now(), by: currentUser, field: 'Location',
        from: pos(u), to: pos({ block: blockTag(block), row: depth, slot }) })
    }
    if (!updates.length) { toast('err', `แถวนี้เต็ม — ย้ายรถออกก่อนจึงจะแยกช่องได้`); return }
    updateLocations(updates)
    setStack(null)
    toast('ok', `แยกช่องให้ ${updates.length} คันแล้ว — ${updates.map((u) => pos(u)).join(', ')}`)
  }

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
      const list = unitsAt(hit.r, hit.c)
      if (!list?.length) return
      setRegion(null)
      if (list.length > 1) setStack({ label: pos({ block: blockTag(block), row: toActual(hit.r, hit.c).r + 1, slot: toActual(hit.r, hit.c).c + 1 }), list })
      else setSel(list[0])
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
          <div className="font-bold text-[14px] text-white leading-tight">{blockTag(block)}</div>
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
                  const list = unitsAt(r, c)
                  const u = list?.[0]
                  const many = (list?.length ?? 0) > 1
                  const picked = inRegion(r, c)
                  const label = pos({ block: blockTag(block), row: toActual(r, c).r + 1, slot: toActual(r, c).c + 1 })
                  return (
                    <div key={c} className="relative"
                      title={many ? `${label} · มีรถซ้อนกัน ${list!.length} คัน — ${list!.map((x) => x.vin.slice(-6)).join(', ')}`
                        : u ? `${u.vin} · ${u.modelName}` : label}
                      style={{
                        width: CELL - 2, height: CELL - 2, margin: 1, borderRadius: 3,
                        background: u ? resolveColor(u) : '#eef1f5',
                        border: u ? 'none' : '1px solid #dde3ea',
                        opacity: u && viewMode === 'status' && u.status === 'ASSIGNED' ? 0.7 : 1,
                        boxShadow: picked ? 'inset 0 0 0 2px #0f172a'
                          : many ? 'inset 0 0 0 2px #dc2626'
                          : sel && u && sel.vin === u.vin ? '0 0 0 2px #fff, 0 0 0 3px var(--brand)' : undefined,
                      }}>
                      {many && (
                        <span className="absolute tabular font-bold pointer-events-none"
                          style={{ right: -1, bottom: -3, fontSize: 8, lineHeight: 1, color: '#fff', textShadow: '0 0 2px #dc2626, 0 0 2px #dc2626' }}>
                          {list!.length}
                        </span>
                      )}
                    </div>
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
        {clashes > 0 && (
          <div className="text-[11.5px] mt-1.5 font-semibold" style={{ color: '#dc2626' }}>
            มีรถซ้อนช่องกัน {clashes} คัน — ช่องที่ขอบแดงมีรถมากกว่า 1 คัน แตะเพื่อดู
          </div>
        )}
        {regionCount > 1 && (
          <div className="text-[11.5px] mt-1.5 font-semibold" style={{ color: '#0f172a' }}>เลือก {regionCount} ช่อง ({region!.c2 - region!.c1 + 1}×{region!.r2 - region!.r1 + 1})</div>
        )}
      </div>

      {/* slot click → rich vehicle detail card (with car .png) */}
      {stack && <StackCard label={stack.label} list={stack.list} onPick={(u) => { setStack(null); setSel(u) }}
        onFix={() => fixStack(stack.list)} onClose={() => setStack(null)} />}
      {sel && <SlotDetailCard u={sel} label={sel.block ? pos(sel) : sel.vin} onClose={() => setSel(null)} />}
    </div>,
    document.body,
  )
}

/**
 * One square, several cars. The plan can only paint one car per square, so the
 * rest would simply not be on the plan — the lane list said 5 and the plan drew
 * 4. Everything on the square is listed here, and the operator can hand the
 * extras their own depth in the same lane (a person's decision, logged like any
 * other move — the system never re-numbers anything on its own).
 */
function StackCard({ label, list, onPick, onFix, onClose }: {
  label: string; list: Unit[]; onPick: (u: Unit) => void; onFix: () => void; onClose: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: 'rgba(8,15,28,0.55)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <div className="rounded-2xl overflow-hidden pop" style={{ width: 340, maxWidth: '92vw', background: '#fff', boxShadow: '0 30px 70px -18px rgba(0,0,0,0.7)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: '#dc2626' }}>
          <Layers size={16} color="#fff" />
          <span className="font-extrabold text-[15px] text-white tracking-wide">{label}</span>
          <span className="text-[11.5px] font-bold px-2 py-0.5 rounded-md" style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}>{list.length} คัน</span>
          <button onClick={onClose} className="ml-auto w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.18)', color: '#fff' }}><X size={15} /></button>
        </div>
        <div className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--muted)', background: '#fef2f2' }}>
          รถหลายคันถูกบันทึกเป็น <b>คันที่เดียวกัน</b> ในแถวนี้ ผังจึงวาดได้ช่องเดียว — แยกช่องให้เพื่อให้เห็นครบทุกคัน
        </div>
        <div className="divide-y hairline" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
          {list.map((u, i) => (
            <button key={u.vin} onClick={() => onPick(u)} className="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50">
              <span className="badge tabular shrink-0" style={{ background: i === 0 ? 'rgba(22,163,74,0.12)' : 'var(--chip)', color: i === 0 ? '#16a34a' : 'var(--muted)' }}>
                {i === 0 ? 'อยู่ก่อน' : `ซ้อน ${i}`}
              </span>
              <span className="min-w-0">
                <span className="vin font-bold text-[13px] block truncate">{u.vin}</span>
                <span className="text-[11.5px] block truncate" style={{ color: 'var(--muted)' }}>{u.modelName} · {u.color}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="p-3" style={{ background: 'var(--app-bg)' }}>
          <button onClick={onFix} className="w-full py-2.5 rounded-xl text-[13.5px] font-bold text-white flex items-center justify-center gap-2" style={{ background: '#0ea5e9' }}>
            <Wand2 size={15} /> แยกช่องให้อยู่คนละคันที่
          </button>
          <div className="text-[11px] text-center mt-1.5" style={{ color: 'var(--faint)' }}>
            คันที่อยู่ก่อนอยู่ที่เดิม · คันที่ซ้อนย้ายไปคันที่ว่างในแถวเดียวกัน
          </div>
        </div>
      </div>
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
