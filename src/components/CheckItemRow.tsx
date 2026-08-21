/**
 * One inspection line — label, OK / NG / NG Heavy, and (once NG) a note plus the
 * photos that evidence it. Shared by the PDI checklist and the FINAL CHECK sheet
 * so both stations answer an item exactly the same way.
 */
import { Camera, Images, X } from 'lucide-react'
import type { CheckItem, CheckItemState, CheckResult } from '../lib/checkSheet'

const RESULTS: CheckResult[] = ['OK', 'NG', 'NG Heavy']

const resultStyle = (r: CheckResult, active: boolean) => {
  if (!active) return { background: 'var(--chip)', color: 'var(--muted)' }
  if (r === 'OK') return { background: '#16a34a', color: '#fff' }
  if (r === 'NG') return { background: '#f59e0b', color: '#fff' }
  return { background: '#dc2626', color: '#fff' } // NG Heavy
}

export function CheckItemRow({ n, item, state, onChange, onPickPhoto, onPickAlbum }: {
  n: number
  item: CheckItem
  state: CheckItemState
  onChange: (patch: Partial<CheckItemState>) => void
  onPickPhoto: () => void
  /** open the OS gallery picker instead of the camera (a photo taken earlier) */
  onPickAlbum?: () => void
}) {
  const isNg = state.result === 'NG' || state.result === 'NG Heavy'
  const photos = state.photos ?? []
  return (
    <div className="rounded-xl p-2.5" style={{ border: '1px solid var(--line)', background: isNg ? '#fff8f5' : 'var(--panel)' }}>
      <div className="flex items-start gap-2">
        <span className="text-[11px] font-bold tabular mt-1 shrink-0" style={{ color: 'var(--faint)', minWidth: 18 }}>{n}</span>
        {/* English leads when the item has both wordings (Thai underneath), the
            same order the defect cards use; Thai-only items read as-is */}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[12.5px] leading-snug">{item.en ?? item.th}</div>
          {item.en && item.th && <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{item.th}</div>}
        </div>
      </div>

      <div className="flex gap-1.5 mt-2">
        {RESULTS.map(r => (
          <button key={r} onClick={() => onChange({ result: r })}
            className="flex-1 py-1.5 rounded-lg text-[11.5px] font-bold transition active:scale-95"
            style={resultStyle(r, state.result === r)}>
            {r}
          </button>
        ))}
      </div>

      {item.spec && (
        <input value={state.spec ?? ''} onChange={e => onChange({ spec: e.target.value })} placeholder={`ระบุ ${item.spec}…`}
          className="w-full mt-2 rounded-lg px-2.5 py-2 text-[12px] outline-none"
          style={{ background: 'var(--chip)', border: '1px solid var(--line)' }} />
      )}

      {isNg && (
        <div className="mt-2 space-y-2">
          <input value={state.note ?? ''} onChange={e => onChange({ note: e.target.value })} placeholder="หมายเหตุ…"
            className="w-full rounded-lg px-2.5 py-2 text-[12px] outline-none"
            style={{ background: '#fff', border: '1px solid var(--line)' }} />
          <div className="flex items-center gap-2 flex-wrap">
            {photos.map((p, pi) => (
              <div key={pi} className="relative">
                <img src={p} className="w-12 h-12 rounded-lg object-cover" alt="" />
                <button onClick={() => onChange({ photos: photos.filter((_, x) => x !== pi) })}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: '#dc2626', color: '#fff' }}>
                  <X size={11} />
                </button>
              </div>
            ))}
            <button onClick={onPickPhoto} title="ถ่ายรูป"
              className="w-12 h-12 rounded-lg flex items-center justify-center"
              style={{ border: '1px dashed var(--line)', color: 'var(--muted)' }}>
              <Camera size={16} />
            </button>
            {onPickAlbum && (
              <button onClick={onPickAlbum} title="เลือกจากอัลบั้ม"
                className="w-12 h-12 rounded-lg flex items-center justify-center"
                style={{ border: '1px dashed var(--line)', color: 'var(--muted)' }}>
                <Images size={16} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
