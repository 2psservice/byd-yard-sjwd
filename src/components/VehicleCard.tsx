import { CheckCircle2, AlertTriangle } from 'lucide-react'
import type { Unit } from '../types'
import { CarTopView } from './CarTopView'
import { StatusBadge } from './ui'
import { clock, pos } from '../lib/format'
import { useYard } from '../store/useYard'

/** Dark vehicle detail card — inspired by the BYD scan card. */
export function VehicleCard({ unit }: { unit: Unit }) {
  const lang = useYard((s) => s.lang)
  const hasDamage = unit.damages.length > 0
  return (
    <div
      className="rounded-2xl p-5 relative overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, #fbfcfe, #ffffff)',
        border: '1px solid var(--line-strong)',
        boxShadow: '0 1px 3px rgba(16,24,40,0.05)',
      }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-bold tracking-[0.18em]" style={{ color: 'var(--muted)' }}>VEHICLE</div>
          <div className="vin text-[19px] font-bold mt-1" style={{ color: 'var(--text)' }}>{unit.vin}</div>
        </div>
        {unit.inspected ? (
          <span className="badge" style={{ color: 'var(--st-yard)', background: 'rgba(34,197,94,0.14)', borderColor: 'rgba(34,197,94,0.3)' }}>
            <CheckCircle2 size={13} /> {lang === 'th' ? 'ตรวจแล้ว' : 'Inspected'}
          </span>
        ) : (
          <StatusBadge status={unit.status} />
        )}
      </div>

      <div className="flex items-center justify-center my-3" style={{ minHeight: 150 }}>
        <CarTopView color={unit.colorHex ?? '#cfd6dd'} width={132} />
      </div>

      <div className="grid grid-cols-2 gap-y-3 gap-x-4">
        <Field label={lang === 'th' ? 'รุ่น' : 'Model'} value={`${unit.modelName}${unit.variant ? ` (${unit.variant})` : ''}`} />
        <Field label={lang === 'th' ? 'สี' : 'Color'} value={unit.color} swatch={unit.colorHex} />
        <Field label={lang === 'th' ? 'ตำแหน่ง' : 'Position'} value={pos(unit)} mono />
        <Field label={lang === 'th' ? 'หาง / ล็อต' : 'Trailer / Lot'} value={`#${unit.trailer}${unit.lot ? ` · ${unit.lot}` : ''}`} />
        <Field label={lang === 'th' ? 'เข้าลาน' : 'Gate-in'} value={clock(unit.gateInAt)} />
        <Field label={lang === 'th' ? 'คนขับ' : 'Driver'} value={unit.driver ?? '—'} />
      </div>

      {hasDamage && (
        <div className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <AlertTriangle size={15} style={{ color: 'var(--st-damage)' }} />
          <span className="text-[13px] font-medium" style={{ color: '#ffc4c4' }}>
            {unit.damages.length} {lang === 'th' ? 'รายการ Defect' : 'damage(s) recorded'}
          </span>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, mono, swatch }: { label: string; value: string; mono?: boolean; swatch?: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold mb-0.5" style={{ color: 'var(--faint)' }}>{label}</div>
      <div className={`text-[14px] font-semibold flex items-center gap-1.5 ${mono ? 'mono' : ''}`} style={{ color: 'var(--text)' }}>
        {swatch && <span className="w-3 h-3 rounded-full border" style={{ background: swatch, borderColor: 'rgba(0,0,0,0.18)' }} />}
        {value}
      </div>
    </div>
  )
}
