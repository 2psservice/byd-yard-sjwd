import { useMemo, useState } from 'react'
import { Truck, ChevronDown, CheckCircle2, MapPin, AlertTriangle } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { makeT } from '../i18n'
import { modelById, TRAILER_CAPACITY } from '../lib/sampleData'
import { clock, STATUS_META } from '../lib/format'
import { PageHead, ProgressBar, StatusBadge, cx } from '../components/ui'

export function Trailers() {
  const lang = useYard((s) => s.lang)
  const units = useUnits()
  const trailers = useYard((s) => s.trailers)
  const { markTrailerArrived, setFocus, setView, toast } = useYard()
  const t = makeT(lang)
  const [open, setOpen] = useState<number | null>(null)

  const byTrailer = useMemo(() => {
    const m = new Map<number, typeof units>()
    for (const u of units) {
      const arr = m.get(u.trailer) ?? []
      arr.push(u)
      m.set(u.trailer, arr)
    }
    return m
  }, [units])

  const arrived = trailers.filter((x) => x.arrived).length

  return (
    <div className="max-w-[1300px] mx-auto">
      <PageHead title={t('trailersTitle')} sub={lang === 'th' ? 'แต่ละหาง = 1 Grouping ตามที่ขึ้นจากโรงงาน' : 'Each trailer = one grouping loaded at the factory'}
        right={
          <div className="panel px-4 py-2.5 flex items-center gap-4">
            <div className="text-center"><div className="display text-[22px] font-bold tabular" style={{ color: 'var(--brand)' }}>{arrived}</div><div className="text-[10px]" style={{ color: 'var(--muted)' }}>{t('arrived')}</div></div>
            <div className="text-center"><div className="display text-[22px] font-bold tabular">{trailers.length}</div><div className="text-[10px]" style={{ color: 'var(--muted)' }}>{t('total')}</div></div>
            <div className="w-28"><ProgressBar value={arrived} max={trailers.length || 1} /></div>
          </div>
        }
      />

      {trailers.length === 0 && (
        <div className="panel p-12 text-center" style={{ color: 'var(--faint)' }}>— ยังไม่มีหาง · นำเข้าข้อมูลที่หน้า Import —</div>
      )}

      <div className="flex flex-col gap-2">
        {trailers.map((tr) => {
          const us = byTrailer.get(tr.no) ?? []
          const models = [...new Set(us.map((u) => u.model))]
          const inYard = us.filter((u) => u.status !== 'EXPECTED').length
          const over = us.length > TRAILER_CAPACITY
          const isOpen = open === tr.no
          return (
            <div key={tr.no} className={cx('panel overflow-hidden transition', isOpen && 'glow-ring')}>
              {/* ── row header ── */}
              <div className="flex items-center gap-4 px-4 py-3 cursor-pointer" onClick={() => setOpen(isOpen ? null : tr.no)}>
                {/* icon */}
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: tr.arrived ? 'rgba(34,197,94,0.14)' : 'rgba(234,179,8,0.12)', border: `1px solid ${tr.arrived ? 'rgba(34,197,94,0.3)' : 'rgba(234,179,8,0.3)'}` }}>
                  <Truck size={16} style={{ color: tr.arrived ? 'var(--st-yard)' : 'var(--st-pending)' }} />
                </div>

                {/* trailer number + status */}
                <div className="shrink-0 w-36">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="display font-bold text-[14px]">{lang === 'th' ? 'หาง' : 'Trailer'} #{tr.no}</span>
                    {tr.arrived
                      ? <span className="badge" style={{ color: 'var(--st-yard)', background: 'rgba(34,197,94,0.12)' }}><CheckCircle2 size={11} /> {t('arrived')}</span>
                      : <span className="badge" style={{ color: 'var(--st-pending)', background: 'rgba(234,179,8,0.12)' }}>{t('pending')}</span>}
                    {over && <span className="badge" style={{ color: 'var(--st-damage)', background: 'rgba(239,68,68,0.14)' }}><AlertTriangle size={10} /> {lang === 'th' ? 'เกินความจุ' : 'over'}</span>}
                  </div>
                  <div className="text-[11px] mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
                    <span className="mono">{tr.plate ?? '—'}</span>
                    {tr.arrivedAt && <><span>·</span><span>{clock(tr.arrivedAt)}</span></>}
                  </div>
                </div>

                {/* model chips */}
                <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
                  {models.map((m) => {
                    const md = modelById(m)
                    const n = us.filter((u) => u.model === m).length
                    return (
                      <span key={m} className="text-[11px] px-2 py-0.5 rounded-md flex items-center gap-1 shrink-0"
                        style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                        <span className="w-2 h-2 rounded-sm" style={{ background: md?.color }} />
                        {md?.name.replace('BYD ', '')} ×{n}
                      </span>
                    )
                  })}
                </div>

                {/* count + progress */}
                <div className="shrink-0 flex items-center gap-3 w-40">
                  <div className="text-[12px] tabular font-semibold shrink-0" style={{ color: over ? 'var(--st-damage)' : 'var(--text)' }}>
                    {us.length}/{TRAILER_CAPACITY}
                  </div>
                  <div className="flex-1">
                    {tr.arrived
                      ? <ProgressBar value={inYard} max={us.length || 1} color="var(--st-yard)" />
                      : <ProgressBar value={0} max={1} />}
                    <div className="text-[10px] mt-0.5 text-right tabular" style={{ color: 'var(--faint)' }}>
                      {tr.arrived ? `${inYard}/${us.length}` : '—'}
                    </div>
                  </div>
                </div>

                <ChevronDown size={16} className="transition shrink-0" style={{ color: 'var(--muted)', transform: isOpen ? 'rotate(180deg)' : '' }} />
              </div>

              {/* ── expand: vin list ── */}
              {isOpen && (
                <div className="border-t hairline">
                  {!tr.arrived && (
                    <div className="p-3 border-b hairline">
                      <button className="btn btn-primary" onClick={() => { markTrailerArrived(tr.no); toast('ok', `บันทึกหาง #${tr.no} มาถึงแล้ว`) }}>
                        <CheckCircle2 size={14} /> {t('markArrived')}
                      </button>
                    </div>
                  )}
                  <div className="max-h-[260px] overflow-auto">
                    {us.map((u) => {
                      const m = STATUS_META[u.status]
                      return (
                        <div key={u.vin} className="flex items-center gap-2 px-4 py-2 border-b hairline row-hover cursor-pointer"
                          onClick={() => { setFocus(u.vin); setView('units') }}>
                          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: modelById(u.model)?.color }} />
                          <span className="vin text-[12px]">{u.vin}</span>
                          <span className="badge ml-auto" style={{ color: m.color, background: m.bg }}>{lang === 'th' ? m.th : m.en}</span>
                          {u.block && <span className="mono text-[11px] flex items-center gap-0.5" style={{ color: 'var(--muted)' }}><MapPin size={10} />{u.block}-{u.row}-{u.slot}</span>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
