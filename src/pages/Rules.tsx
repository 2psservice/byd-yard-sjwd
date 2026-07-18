import { Zap, Hand, Info, Layers, Lock } from 'lucide-react'
import { useMemo } from 'react'
import { useYard, useBlocks } from '../store/useYard'
import { useTrackingRows } from '../store/useTracking'
import { makeT } from '../i18n'
import { matchModel } from '../lib/sampleData'
import { getPolicy } from '../lib/parkingEngine'
import { PageHead, Segmented, Toggle, cx } from '../components/ui'
import type { ParkingPolicy, VehicleModel } from '../types'

export function Rules() {
  const lang = useYard((s) => s.lang)
  const blocks = useBlocks()
  const policies = useYard((s) => s.policies)
  const { planMode, setPlanMode, groupModelsInRow, setGroupModels, setPolicy } = useYard()
  const allRows = useTrackingRows()

  // Build model list from actual imported data, deduplicated by matched model ID
  const MODELS = useMemo<VehicleModel[]>(() => {
    const seen = new Map<string, VehicleModel>()
    for (const row of allRows) {
      const name = row.cells['Model name'] || row.cells['Model'] || ''
      if (!name.trim()) continue
      const m = matchModel(name)
      if (!seen.has(m.id)) seen.set(m.id, m)
    }
    return [...seen.values()]
  }, [allRows])
  const t = makeT(lang)

  const ruleText = (p: ParkingPolicy): string => {
    const where = p.allowedBlocks === 'ALL' ? (lang === 'th' ? 'ทุกบล็อก' : 'any block') : `${lang === 'th' ? 'บล็อก' : 'block'} ${(p.allowedBlocks as string[]).join(', ')}`
    const rows = p.rowFrom || p.rowTo ? ` · ${lang === 'th' ? 'แถว' : 'rows'} ${p.rowFrom ?? 1}–${p.rowTo ?? '∞'}` : ''
    const ex = p.exclusiveRow ? ` · ${lang === 'th' ? 'ห้ามปนรุ่น' : 'no mixing'}` : ''
    return `${where}${rows}${ex}`
  }

  return (
    <div className="max-w-[1200px] mx-auto">
      <PageHead title={t('rulesTitle')} sub={t('rulesIntro')} />

      {/* global */}
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <div className="panel p-4">
          <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--muted)' }}>{t('planMode')}</div>
          <Segmented value={planMode} onChange={setPlanMode}
            options={[
              { value: 'AUTO', label: <span className="flex items-center gap-1.5"><Zap size={13} /> {t('autoPlan')}</span> },
              { value: 'SEMI', label: <span className="flex items-center gap-1.5"><Hand size={13} /> {t('semiPlan')}</span> },
            ]} />
          <p className="text-[12px] mt-2.5" style={{ color: 'var(--faint)' }}>
            {planMode === 'AUTO'
              ? (lang === 'th' ? 'เครื่องเลือกบล็อก/แถว/ช่องให้อัตโนมัติเมื่อพนักงานสแกน' : 'Engine auto-picks block/row/slot on scan.')
              : (lang === 'th' ? 'เครื่องเสนอตำแหน่ง แต่พนักงานเลือกเองได้' : 'Engine suggests; operator may override.')}
          </p>
        </div>
        <div className="panel p-4 flex items-start gap-3">
          <div className="flex-1">
            <div className="text-[13.5px] font-semibold flex items-center gap-2"><Layers size={15} style={{ color: 'var(--brand)' }} /> {lang === 'th' ? 'จัดรุ่นเดียวกันต่อแถว' : 'Group one model per row'}</div>
            <p className="text-[12px] mt-1.5" style={{ color: 'var(--faint)' }}>
              {lang === 'th' ? 'เครื่องจะพยายามไม่ปนรุ่นในแถวเดียวกัน (เปิดแถวใหม่ก่อนแทรกรุ่นอื่น)' : 'Engine avoids mixing models in a row when possible.'}
            </p>
          </div>
          <Toggle checked={groupModelsInRow} onChange={setGroupModels} />
        </div>
      </div>

      {/* per-model */}
      {MODELS.length === 0 && (
        <div className="panel p-8 text-center" style={{ color: 'var(--faint)' }}>
          <div className="text-[13px]">{lang === 'th' ? 'ยังไม่มีข้อมูลรุ่นรถ — นำเข้าไฟล์ Excel ก่อนในหน้า Import' : 'No vehicle models found — import an Excel file first.'}</div>
        </div>
      )}
      <div className="space-y-2.5">
        {MODELS.map((m) => {
          const p = getPolicy(m.id, policies)
          const isAll = p.allowedBlocks === 'ALL'
          const list = isAll ? [] : (p.allowedBlocks as string[])

          const toggleBlock = (bid: string) => {
            let next: string[] | 'ALL'
            if (isAll) next = [bid]
            else {
              const set = new Set(list)
              set.has(bid) ? set.delete(bid) : set.add(bid)
              next = set.size === 0 ? 'ALL' : [...set].sort()
            }
            setPolicy(m.id, { allowedBlocks: next })
          }

          return (
            <div key={m.id} className={cx('panel p-4 transition', !p.enabled && 'opacity-55')}>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                {/* model */}
                <div className="flex items-center gap-3 min-w-[180px]">
                  <span className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${m.color}22` }}>
                    <span className="w-4 h-4 rounded" style={{ background: m.color }} />
                  </span>
                  <div>
                    <div className="font-semibold display text-[15px]">{m.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{m.segment}</div>
                  </div>
                </div>

                {/* blocks */}
                <div className="flex-1 min-w-[260px]">
                  <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>{t('allowedBlocks')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    <button onClick={() => setPolicy(m.id, { allowedBlocks: 'ALL' })}
                      className="text-[12px] px-2.5 py-1 rounded-lg font-semibold transition"
                      style={isAll ? { background: 'var(--brand)', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
                      {t('allBlocks')}
                    </button>
                    {blocks.map((b) => {
                      const on = !isAll && list.includes(b.id)
                      return (
                        <button key={b.id} onClick={() => toggleBlock(b.id)}
                          className="text-[12px] w-8 py-1 rounded-lg font-semibold transition"
                          style={on ? { background: 'var(--brand-2)', color: '#fff' } : { background: 'var(--chip)', color: 'var(--muted)' }}>
                          {b.id}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* row window */}
                <div>
                  <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>{t('rowWindow')}</div>
                  <div className="flex items-center gap-1.5">
                    <input type="number" min={1} className="input tabular text-center" style={{ width: 56, padding: '7px 6px' }} placeholder="1"
                      value={p.rowFrom ?? ''} onChange={(e) => setPolicy(m.id, { rowFrom: e.target.value ? Number(e.target.value) : undefined })} />
                    <span style={{ color: 'var(--faint)' }}>–</span>
                    <input type="number" min={1} className="input tabular text-center" style={{ width: 56, padding: '7px 6px' }} placeholder="∞"
                      value={p.rowTo ?? ''} onChange={(e) => setPolicy(m.id, { rowTo: e.target.value ? Number(e.target.value) : undefined })} />
                  </div>
                </div>

                {/* exclusive */}
                <div className="text-center">
                  <div className="text-[11px] font-semibold mb-1.5 flex items-center gap-1 justify-center" style={{ color: 'var(--muted)' }}><Lock size={11} /> {t('exclusiveRow')}</div>
                  <Toggle checked={p.exclusiveRow} onChange={(v) => setPolicy(m.id, { exclusiveRow: v })} />
                </div>

                {/* enabled */}
                <div className="text-center">
                  <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>{lang === 'th' ? 'ใช้งาน' : 'Enabled'}</div>
                  <Toggle checked={p.enabled} onChange={(v) => setPolicy(m.id, { enabled: v })} />
                </div>
              </div>

              <div className="mt-3 pt-2.5 border-t hairline text-[12px] flex items-center gap-1.5" style={{ color: 'var(--brand)' }}>
                <Info size={12} /> {ruleText(p)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
