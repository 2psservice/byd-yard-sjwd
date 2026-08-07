import { useMemo, useRef, useState } from 'react'
import { Layers, Upload, Printer, MapPin, Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, ListChecks, X } from 'lucide-react'
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

      // the Excel's Delivery Location is the LATEST dealer for these cars —
      // stamp it onto the tracking rows so Unit List, IR, DN and ใบหารถ all
      // read this file's value from now on ('Dealer Location' is the cell
      // every one of those surfaces prints)
      const byDealer = new Map<string, string[]>()
      for (const r of res.rows) {
        const dl = r.deliveryLocation.trim()
        if (!dl || !trackVins.has(r.vin)) continue
        const arr = byDealer.get(dl) ?? []
        arr.push(r.vin); byDealer.set(dl, arr)
      }
      for (const [dl, vins] of byDealer) bulkUpdate(vins, 'Dealer Location', dl)

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

  // ALWAYS the latest position: the imported rows snapshot the location at
  // upload time, but the yard keeps re-locating cars afterwards — the on-screen
  // table and every print (ใบ Grouping / ใบหารถ) must read the LIVE placement,
  // falling back to the import-time value for cars this device can't see.
  const liveRows = useMemo(() => rows?.map((r) => {
    const live = yardLocCode(unitByVin.get(r.vin))
    return live && live !== r.yardLocation ? { ...r, yardLocation: live } : r
  }) ?? null, [rows, unitByVin])

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
            <button className="btn" disabled={!canPrint} onClick={() => liveRows && meta && printGrouping(liveRows, meta)}>
              <Printer size={15} /> 2 · พิมพ์ Grouping
            </button>
            <button className="btn" disabled={!canPrint} onClick={() => liveRows && meta && printFindCar(liveRows, meta)}>
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
                {(liveRows ?? rows).map((r) => (
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

      {/* delivery runs already created — persists across visits (the imported
          table above is session-only, but the QUEUES live in the store/cloud),
          with add / remove VIN and cancel-run controls */}
      <SeqQueueManager />
    </div>
  )
}

/** Manage the site's Grouping-to-Dealer runs: expand to the car list, remove a
 *  car (also clears its Grouping cell so the run reconciler agrees), add VINs,
 *  or cancel the whole run. */
function SeqQueueManager() {
  const currentSite = useYard((s) => s.currentSite)
  const toast = useYard((s) => s.toast)
  const units = useUnits()
  const trackingRows = useTrackingRows()
  const updateCell = useTracking((s) => s.updateCell)
  const queues = useOps((s) => s.queues)
  const { addVins, removeVin, removeQueue } = useOps()
  const [openId, setOpenId] = useState<string | null>(null)
  const [addText, setAddText] = useState('')

  const seqQueues = useMemo(
    () => queues.filter((q) => q.kind === 'sequence' && (!currentSite || !q.site || q.site === currentSite)),
    [queues, currentSite],
  )
  const rowByVin = useMemo(() => new Map(trackingRows.map((r) => [r.vin, r])), [trackingRows])
  const unitByVin = useMemo(() => new Map(units.map((u) => [u.vin, u])), [units])
  if (!seqQueues.length) return null

  const doRemove = (qid: string, vin: string) => {
    if (!window.confirm(`เอา ${vin.slice(-8)} ออกจากคิวงานนี้?`)) return
    removeVin(qid, vin)
    // clearing the cell records the removal in the row's history, so the run
    // reconciler (which re-adds cars carrying the run's codes) agrees with it
    if (rowByVin.has(vin)) updateCell(vin, 'Grouping  Number', '')
    toast('ok', `เอา ${vin.slice(-8)} ออกจากคิวแล้ว`)
  }
  const doAdd = (qid: string) => {
    const vins = addText.toUpperCase().match(/[A-Z0-9]{11,20}/g) ?? []
    if (!vins.length) { toast('err', 'พิมพ์/วางเลขวินก่อน (เต็มตัวอย่างน้อย 11 หลัก)'); return }
    const { added, dup } = addVins(qid, vins)
    setAddText('')
    toast(added ? 'ok' : 'err', `เพิ่ม ${added} คัน${dup ? ` · ซ้ำ ${dup}` : ''}`)
  }

  return (
    <div className="mt-5 space-y-2.5">
      <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
        คิวงานส่งมอบ (Grouping to Dealer)
      </div>
      {seqQueues.map((q) => {
        const total = q.items.length
        const done = q.items.filter((i) => i.done || i.gatedOut).length
        const isOpen = openId === q.id
        return (
          <div key={q.id} className="panel overflow-hidden">
            <div className="w-full px-4 py-3 flex items-center gap-3">
              <button className="flex items-center gap-3 flex-1 min-w-0 text-left" onClick={() => setOpenId(isOpen ? null : q.id)}>
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--brand-soft,#eef4ff)', color: 'var(--brand)' }}>
                  <ListChecks size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-[13px] clip">{q.name}</div>
                  <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
                    <b style={{ color: 'var(--text)' }}>{done}/{total}</b> คัน · เหลือ <b style={{ color: '#d97706' }}>{total - done}</b>
                  </div>
                </div>
              </button>
              <button className="btn py-1.5 text-[12px]" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}
                onClick={() => { if (window.confirm(`ยกเลิกคิวงาน "${q.name}" ทั้งใบ?`)) { removeQueue(q.id); toast('ok', 'ยกเลิกคิวงานแล้ว') } }}>
                ยกเลิกคิว
              </button>
            </div>
            {isOpen && (
              <div className="border-t hairline">
                {/* add VINs */}
                <div className="px-4 py-2.5 flex items-center gap-2 border-b hairline" style={{ background: 'var(--chip)' }}>
                  <input className="input flex-1 text-[12.5px] vin" placeholder="วาง/พิมพ์เลขวินที่จะเพิ่ม (หลายคันคั่นด้วยเว้นวรรค)…"
                    value={addText} onChange={(e) => setAddText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doAdd(q.id)} />
                  <button className="btn btn-primary py-1.5 text-[12.5px]" onClick={() => doAdd(q.id)}>+ เพิ่ม</button>
                </div>
                <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
                  {q.items.map((i) => {
                    const r = rowByVin.get(i.vin)
                    const gone = i.done || i.gatedOut
                    return (
                      <div key={i.vin} className="px-4 py-2 flex items-center gap-3" style={gone ? { opacity: 0.55 } : undefined}>
                        <div className="min-w-0 flex-1">
                          <div className="vin text-[12.5px] font-bold clip">{i.vin}</div>
                          <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2" style={{ color: 'var(--muted)' }}>
                            <span>{r?.cells['Model'] || r?.cells['Model name'] || '—'}</span>
                            <span>· {r?.cells['Color'] || '—'}</span>
                            {i.group && <span>· {i.group}</span>}
                          </div>
                        </div>
                        <div className="tabular text-[12px] font-bold shrink-0">{yardLocCode(unitByVin.get(i.vin)) || '—'}</div>
                        {gone
                          ? <span className="badge shrink-0" style={{ background: 'rgba(22,163,74,0.12)', color: '#16a34a', fontSize: 10.5 }}>ออกแล้ว</span>
                          : (
                            <button className="btn p-1.5 shrink-0" title="เอาออกจากคิว"
                              style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}
                              onClick={() => doRemove(q.id, i.vin)}>
                              <X size={13} />
                            </button>
                          )}
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
  )
}
