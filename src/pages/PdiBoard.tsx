/**
 * PDI board — the three tables the office keeps for PDI, built LIVE from what
 * the field records instead of being keyed into Excel by hand:
 *
 *  1. PDI          — one row per car the PDI station checked off that day
 *  2. PDI DEFECT   — every defect those cars carry, with its repair ladder
 *  3. ตาราง PDI     — the shift matrix (P1–P5) the operations workbook uses
 *
 * The tables themselves live in components/StationTables — the PM board shows
 * the same three, and one implementation means the two can never drift. All of
 * them read the SAME source as the Operation report (opsReport.ts), so a number
 * here can never disagree with the number on that page.
 */
import { useState } from 'react'
import { ClipboardCheck, Download } from 'lucide-react'
import { useYard } from '../store/useYard'
import { PageHead, cx } from '../components/ui'
import { DayPicker, dayKeyOf } from './Grouping'
import { StationTables, useStationCtx, type StationTab } from '../components/StationTables'
import { exportStationReport } from '../lib/opsReport'

const TABS: { id: StationTab; label: string }[] = [
  { id: 'list', label: 'PDI' },
  { id: 'defect', label: 'PDI DEFECT' },
  { id: 'time', label: 'ตาราง PDI' },
]

export function PdiBoard() {
  const lang = useYard((s) => s.lang)
  const toast = useYard((s) => s.toast)
  const [tab, setTab] = useState<StationTab>('list')
  const [day, setDay] = useState<string | 'all'>(dayKeyOf(new Date()))
  const [exporting, setExporting] = useState(false)
  const { ctx, dayCounts, site, dayLabel } = useStationCtx(day)

  // One workbook, one sheet per tab — the office sends the PDI day on its own,
  // so it should not have to dig the PDI sheets out of the 13-sheet operation
  // report. Always all three tabs, whichever one is open: they are one day's
  // record and get sent together.
  const doExport = async () => {
    setExporting(true)
    try {
      await exportStationReport(ctx, 'PDI')
      toast('ok', `ออกไฟล์ PDI (${dayLabel}) แล้ว`)
    } catch (e) { console.error('[pdi] export', e); toast('err', 'ออกไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง') }
    finally { setExporting(false) }
  }

  return (
    <div>
      <PageHead
        title={<span className="flex items-center gap-2">
          <ClipboardCheck size={20} style={{ color: 'var(--brand)' }} /> PDI
        </span>}
        sub={lang === 'th'
          ? `ตาราง PDI ประจำวัน — ขึ้นเองจากที่หน้างานบันทึก ไม่ต้องคีย์ซ้ำ${site?.name ? ` — ${site.name}` : ''}`
          : `Daily PDI tables, built live from what the stations record${site?.name ? ` — ${site.name}` : ''}`}
        right={<div className="flex items-center gap-2">
          <DayPicker days={dayCounts} value={day} onChange={setDay} />
          <button className="btn btn-primary px-3 py-1.5 text-[12.5px]" onClick={doExport} disabled={exporting}
            title="ออกไฟล์ Excel ของวันนี้ — 3 ชีท: PDI · PDI DEFECT · ตาราง PDI">
            <Download size={14} /> {exporting ? 'กำลังสร้างไฟล์…' : 'Export Excel'}
          </button>
        </div>}
      />

      <div className="flex flex-wrap gap-1.5 mb-3">
        {TABS.map((t, i) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cx('btn px-3 py-1.5 text-[12.5px]', tab === t.id && 'btn-primary')}>
            {i + 1}. {t.label}
          </button>
        ))}
      </div>

      <StationTables ctx={ctx} tab={tab} kind="PDI" />
    </div>
  )
}
