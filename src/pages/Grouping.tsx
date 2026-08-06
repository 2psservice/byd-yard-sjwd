import { useMemo, useRef, useState } from 'react'
import { Layers, Upload, Printer, MapPin, Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, ListChecks } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { PageHead } from '../components/ui'
import { parseGroupingWorkbook, siteGroupingConfig, yardLocCode } from '../lib/groupingImport'
import { printGrouping, printFindCar, type GroupPrintRow, type GroupPrintMeta } from '../lib/groupingPrint'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function todayLong(): string {
  const d = new Date()
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
/** short label for the sheet title: NYB2 / Rayong / else the site name */
function siteLabel(siteName: string): string {
  const n = siteName.toLowerCase()
  if (n.includes('nyb')) return 'NYB2'
  if (n.includes('rayong')) return 'Rayong'
  return siteName
}

export function Grouping() {
  const currentSite = useYard((s) => s.currentSite)
  const sites = useYard((s) => s.sites)
  const openSiteModal = useYard((s) => s.openSiteModal)
  const toast = useYard((s) => s.toast)
  const currentUser = useYard((s) => s.currentUser)
  const setView = useYard((s) => s.setView)
  const units = useUnits()
  const trackingRows = useTrackingRows()
  const bulkUpdate = useTracking((s) => s.bulkUpdate)
  const createSequence = useOps((s) => s.createSequence)

  const siteName = sites.find((s) => s.id === currentSite)?.name ?? ''
  const unitByVin = useMemo(() => new Map(units.map((u) => [u.vin, u])), [units])
  const trackVins = useMemo(() => new Set(trackingRows.map((r) => r.vin)), [trackingRows])

  const [rows, setRows] = useState<GroupPrintRow[] | null>(null)
  const [meta, setMeta] = useState<GroupPrintMeta | null>(null)
  const [seqName, setSeqName] = useState('') // queue name = the uploaded sheet title
  const [stats, setStats] = useState<{ found: number; notFound: number; placed: number; assigned: number } | null>(null)
  const [shortRead, setShortRead] = useState<
    { got: number; want: number; noGrouping: number; sheet: string; others: { sheet: string; vins: number }[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastFile, setLastFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void importFile(file)
  }

  /** @param sheet read this sheet instead of the site-matched one — a plan
   *  continued on a second sheet is imported by picking it here. */
  const importFile = async (file: File, sheet?: string) => {
    if (!currentSite) { toast('err', 'กรุณาเลือก Site ก่อน'); openSiteModal(); return }
    setBusy(true)
    setLastFile(file)
    try {
      const res = await parseGroupingWorkbook(file, siteName, sheet)

      // group order (first-seen) → Lane load O1, O2, …
      const order: string[] = []
      const unitCount = new Map<string, number>()
      for (const r of res.rows) {
        if (!order.includes(r.grouping)) order.push(r.grouping)
        unitCount.set(r.grouping, (unitCount.get(r.grouping) ?? 0) + 1)
      }
      const laneOf = new Map(order.map((g, i) => [g, `O${i + 1}`]))

      let found = 0, notFound = 0, placed = 0
      const printRows: GroupPrintRow[] = res.rows.map((r, i) => {
        const u = unitByVin.get(r.vin)
        const inSystem = trackVins.has(r.vin) || !!u
        inSystem ? found++ : notFound++
        const loc = yardLocCode(u)
        if (loc) placed++
        return {
          no: i + 1, vin: r.vin, modelName: r.modelName, model: r.model, color: r.color,
          deliveryLocation: r.deliveryLocation, grouping: r.grouping, groupUnit: unitCount.get(r.grouping) ?? 0,
          yardLocation: loc, laneLoad: laneOf.get(r.grouping) ?? '', receiveDate: r.receiveDate || res.headerDate, remark: '',
        }
      })

      // stamp the grouping number onto every VIN that exists in the yard system
      const byGroup = new Map<string, string[]>()
      for (const r of res.rows) {
        if (!trackVins.has(r.vin)) continue
        const arr = byGroup.get(r.grouping) ?? []
        arr.push(r.vin); byGroup.set(r.grouping, arr)
      }
      let assigned = 0
      for (const [g, vins] of byGroup) { bulkUpdate(vins, 'Grouping  Number', g); assigned += vins.length }

      const m: GroupPrintMeta = {
        siteLabel: siteLabel(siteName),
        date: res.headerDate || todayLong(),
        totalUnits: printRows.length,
        groupCount: order.length,
        locPrefix: siteGroupingConfig(siteName).prefix, // find-car prints "N-P38"
      }
      setMeta(m)
      // queue name = the sheet title, else a constructed one
      setSeqName(res.title.trim() || `${m.siteLabel} - Grouping to Dealer ( ${m.totalUnits} Units / ${m.groupCount} Group) Date ${m.date}`)
      setRows(printRows)
      setStats({ found, notFound, placed, assigned })
      // the sheet's own title states how many units it carries — if fewer rows
      // were read, say so loudly instead of quietly building a short queue
      const short = res.titleUnits > 0 && printRows.length < res.titleUnits
      setShortRead(short
        ? { got: printRows.length, want: res.titleUnits, noGrouping: res.skipped.noGrouping,
            sheet: res.sheetName, others: res.sheetVinCounts.filter((x) => x.sheet !== res.sheetName && x.vins > 0) }
        : null)
      if (short) toast('err', `อ่านได้ ${printRows.length} คัน แต่หัวไฟล์ระบุ ${res.titleUnits} คัน — ดูรายละเอียดด้านล่าง`)
      else toast('ok', `นำเข้า ${printRows.length} คัน · ${order.length} group · ใส่เลข grouping ${assigned} คัน`)
    } catch (err) {
      console.error('[grouping] import', err)
      toast('err', (err as Error)?.message ?? 'อ่านไฟล์ไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  const canPrint = !!rows && rows.length > 0 && !!meta

  const doCreateSequence = () => {
    if (!rows || !rows.length) return
    // never a silent return — a click on the green button must always answer
    const name = seqName.trim() || `${siteLabel(siteName)} - Grouping to Dealer ( ${rows.length} Units ) ${todayLong()}`
    try {
      // the grouping code travels with the item: the run keeps following it, so a
      // car whose number is cleared later drops out and a car stamped with it joins
      const items = rows.map((r) => ({ vin: r.vin, laneLoad: r.laneLoad, dest: r.deliveryLocation, group: r.grouping }))
      const id = createSequence(name, currentUser, items)
      if (!id) { toast('err', 'สร้างลำดับงานไม่สำเร็จ — ชื่อคิวว่าง'); return }
      toast('ok', `สร้างลำดับงาน "${name}" · ${items.length} คัน — ไปที่ Operation / Yard Ops ได้เลย`)
      setView('operation')
    } catch (e) {
      // an old queue with broken data used to throw HERE, eating the click with
      // no feedback at all — surface it so the operator can report what happened
      console.error('[grouping] createSequence', e)
      toast('err', `สร้างลำดับงานไม่สำเร็จ: ${(e as Error)?.message ?? e}`)
    }
  }

  return (
    <div className="max-w-[1200px] mx-auto">
      <PageHead
        title={<span className="flex items-center gap-2"><Layers size={20} style={{ color: 'var(--brand)' }} /> Grouping</span>}
        sub={`นำเข้าแผน Grouping ต่อ Site · ใส่เลข Grouping ให้รถอัตโนมัติ · พิมพ์ใบ Grouping / ใบหารถ${siteName ? ` — ${siteName}` : ''}`}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
            <button className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} 1 · อัปโหลด Excel Grouping
            </button>
            <button className="btn" disabled={!canPrint} onClick={() => rows && meta && printGrouping(rows, meta)}>
              <Printer size={15} /> 2 · พิมพ์ Grouping
            </button>
            <button className="btn" disabled={!canPrint} onClick={() => rows && meta && printFindCar(rows, meta)}>
              <MapPin size={15} /> 3 · พิมพ์ใบหารถ
            </button>
            <button className="btn" disabled={!canPrint} onClick={doCreateSequence}
              style={canPrint ? { background: '#16a34a', color: '#fff', borderColor: 'transparent' } : undefined}>
              <ListChecks size={15} /> Create Sequence
            </button>
          </div>
        }
      />

      {/* the read came up short of what the sheet says it holds */}
      {shortRead && (
        <div className="panel p-3.5 mb-3 flex items-start gap-2.5" style={{ background: '#fff7ed', border: '1px solid rgba(217,119,6,0.35)' }}>
          <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: '#d97706' }} />
          <div className="text-[12.5px] leading-relaxed">
            <b style={{ color: '#b45309' }}>อ่านได้ {shortRead.got} คัน แต่หัวไฟล์ระบุ {shortRead.want} คัน</b>
            <div style={{ color: 'var(--muted)' }}>
              อ่านจาก sheet <b>{shortRead.sheet}</b>
              {shortRead.noGrouping > 0 && <> · ข้าม {shortRead.noGrouping} แถวที่ยังไม่มีเลข grouping ก่อนเลขแรกของไฟล์</>}
            </div>
            {shortRead.others.length > 0 && (
              <div className="mt-1.5">
                <div style={{ color: 'var(--muted)' }}>แผนถูกแบ่งหลาย sheet — กดเพื่ออ่าน sheet อื่นในไฟล์เดิม:</div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {shortRead.others.map((o) => (
                    <button key={o.sheet} className="btn py-1 text-[12px]" disabled={busy || !lastFile}
                      onClick={() => lastFile && importFile(lastFile, o.sheet)}>
                      {o.sheet} · {o.vins} คัน
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* summary after import */}
      {stats && meta && (
        <div className="flex flex-wrap items-center gap-2 mb-4 text-[12.5px]">
          <span className="badge" style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>{meta.totalUnits} คัน · {meta.groupCount} group</span>
          <span className="badge" style={{ background: 'rgba(22,163,74,0.1)', color: '#16a34a' }}><CheckCircle2 size={12} /> ใส่เลข grouping {stats.assigned} คัน</span>
          <span className="badge" style={{ background: 'rgba(37,99,235,0.08)', color: 'var(--brand)' }}><MapPin size={12} /> มีตำแหน่งในลาน {stats.placed} คัน</span>
          {stats.notFound > 0 && <span className="badge" style={{ background: 'rgba(217,119,6,0.1)', color: '#d97706' }}><AlertTriangle size={12} /> ไม่พบในระบบ {stats.notFound} คัน</span>}
        </div>
      )}

      {!rows ? (
        <div className="panel p-12 text-center" style={{ color: 'var(--faint)' }}>
          <FileSpreadsheet size={40} className="mx-auto mb-3" style={{ color: 'var(--line-strong)' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--muted)' }}>ยังไม่ได้นำเข้าไฟล์ Grouping</div>
          <div className="text-[13px] mt-1.5 leading-relaxed">
            กดปุ่ม <b style={{ color: 'var(--brand)' }}>อัปโหลด Excel Grouping</b> — ระบบจะอ่าน sheet ตาม Site ปัจจุบัน
            {siteName ? <> (<b>{siteName}</b>)</> : ''} แล้วใส่เลข Grouping ให้รถ พร้อมเติมตำแหน่งในลาน + Lane load อัตโนมัติ
          </div>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b hairline" style={{ background: 'var(--chip)' }}>
                  {['No', 'Vin', 'Model', 'Color', 'Delivery Location', 'Grouping', 'Unit', 'Location', 'Lane', 'Date'].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] font-bold whitespace-nowrap" style={{ color: 'var(--muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}>
                {rows.map((r) => (
                  <tr key={r.vin} className="hover:bg-chip transition-colors" style={!r.yardLocation ? { background: 'rgba(217,119,6,0.06)' } : undefined}>
                    <td className="px-3 py-2 tabular" style={{ color: 'var(--muted)' }}>{r.no}</td>
                    <td className="px-3 py-2 vin font-semibold whitespace-nowrap" style={{ color: 'var(--brand)' }}>{r.vin}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.model}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.color}</td>
                    <td className="px-3 py-2 clip" style={{ maxWidth: 260 }} title={r.deliveryLocation}>{r.deliveryLocation}</td>
                    <td className="px-3 py-2 tabular whitespace-nowrap">{r.grouping}</td>
                    <td className="px-3 py-2 tabular text-center">{r.groupUnit}</td>
                    <td className="px-3 py-2 tabular font-semibold whitespace-nowrap" style={{ color: r.yardLocation ? 'var(--text)' : '#d97706' }}>
                      {r.yardLocation || 'ไม่พบตำแหน่ง'}
                    </td>
                    <td className="px-3 py-2 tabular font-bold text-center" style={{ color: 'var(--brand)' }}>{r.laneLoad}</td>
                    <td className="px-3 py-2 tabular whitespace-nowrap" style={{ color: 'var(--muted)' }}>{r.receiveDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
