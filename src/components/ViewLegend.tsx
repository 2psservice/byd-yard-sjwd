import { GROUPING_META, FINAL_STATUS_ORDER, finalStatusSlotColor, STATUS_META, type YardViewMode } from '../lib/yardView'

/** Legend swatches for the active Yard Plan VIEW mode — shared by the main
 *  board header (so colours are explained without opening a popup) and the
 *  BlockPopup footer, so both always show the identical legend. */
export function ViewLegend({ viewMode, modelColors }: { viewMode: YardViewMode; modelColors?: Map<string, string> }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1">
      {viewMode === 'status' && STATUS_META.map((m) => (
        <span key={m.key} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: m.c }} /> {m.label}
        </span>
      ))}
      {viewMode === 'model' && (
        modelColors && modelColors.size > 0
          ? [...modelColors.entries()].map(([name, color]) => (
              <span key={name} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} /> {name}
              </span>
            ))
          : <span className="text-[11px]" style={{ color: 'var(--faint)' }}>ไม่มีข้อมูลรุ่นรถ</span>
      )}
      {viewMode === 'grouping' && [GROUPING_META.grouped, GROUPING_META.ungrouped].map((m) => (
        <span key={m.label} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: m.color }} /> {m.label}
        </span>
      ))}
      {viewMode === 'finalStatus' && (
        <>
          {FINAL_STATUS_ORDER.map((label) => (
            <span key={label} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: finalStatusSlotColor(label).bg }} /> {label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: finalStatusSlotColor('').bg }} /> ไม่ระบุ
          </span>
        </>
      )}
    </div>
  )
}
