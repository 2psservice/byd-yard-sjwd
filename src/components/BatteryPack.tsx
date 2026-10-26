/**
 * ก้อนแบต EV แบบแอป BYD — ใช้ทั้งหน้าสถานี EV Charging (Ops Scan) และหน้าแอดมิน EV Charging
 * หน้าตา/แสงวิ่งอยู่ใน index.css (.ev-pack …)
 */
import { Zap } from 'lucide-react'
import { cx } from './ui'

export const EV_ACCENT = '#16a34a'
/** สีของรอบที่หยุดพัก */
export const EV_PAUSE = '#d97706'

const PACK_CELLS = 20

/** ก้อนแบตแบบแอป BYD — 20 ก้อน ก้อนละ 5% เติมเขียวตาม % ที่บันทึกไว้จริง
 *  (ระหว่างชาร์จไม่มีใครรู้ % ปัจจุบัน จึงไม่เดา) · charging = แสงเขียววิ่งผ่านก้อนจากซ้ายไปขวา */
export function BatteryPack({ pct, charging, label, height = 26 }: {
  pct: number | null; charging?: boolean; label: string; height?: number
}) {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const lit = pct == null ? 0 : Math.min(PACK_CELLS, Math.max(p > 0 ? 1 : 0, Math.round(p / (100 / PACK_CELLS))))
  return (
    <div className="flex items-center gap-2.5" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={label}
      data-ev-batt={pct ?? ''} data-ev-lit={lit} data-ev-charging={charging ? '1' : undefined}>
      {/* the top band is one slanted strip over the front band, so each cell's seam runs from its front face up the top */}
      <div className="ev-pack flex-1" style={{ height, maxWidth: 260 }}>
        {(['top', 'front'] as const).map((face) => (
          <div key={face} className={`ev-pack-${face}`}>
            {Array.from({ length: PACK_CELLS }, (_, i) => <div key={i} className={cx('ev-cell', i < lit && 'on')} />)}
          </div>
        ))}
        {charging && <div className="ev-pack-clip"><div className="ev-pack-sweep" /></div>}
      </div>
      <div className="flex items-center gap-1 shrink-0 text-[12.5px] font-bold tabular" style={{ color: 'var(--text)' }}>
        {charging && <Zap size={14} className="ev-bolt" style={{ color: EV_ACCENT }} />}
        {label}
      </div>
    </div>
  )
}
