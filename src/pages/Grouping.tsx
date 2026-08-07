import { useMemo, useRef, useState } from 'react'
import { Layers, Upload, Printer, MapPin, Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, ListChecks, X, Save, FileText } from 'lucide-react'
import { useYard, useUnits } from '../store/useYard'
import { useTracking, useTrackingRows } from '../store/useTracking'
import { useOps } from '../store/useOps'
import { PageHead } from '../components/ui'
import { parseGroupingWorkbook, siteGroupingConfig, yardLocCode } from '../lib/groupingImport'
import { printGrouping, printFindCar, exportGroupingXlsx, exportFindCarXlsx, type GroupPrintRow, type GroupPrintMeta } from '../lib/groupingPrint'
import { printIr, printDn, printIrPaper } from '../lib/dnir'
import type { TrackRow } from '../lib/excelTracking'

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
  const setLaneLoads = useOps((s) => s.setLaneLoads)
  const queues = useOps((s) => s.queues)

  const siteName = sites.find((s) => s.id === currentSite)?.name ?? ''
  const unitByVin = useMemo(() => new Map(units.map((u) => [u.vin, u])), [units])
  const trackVins = useMemo(() => new Set(trackingRows.map((r) => r.vin)), [trackingRows])
  const rowByVin = useMemo(() => new Map(trackingRows.map((r) => [r.vin, r])), [trackingRows])

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

  // ALWAYS the latest position: the imported rows snapshot the location at
  // upload time, but the yard keeps re-locating cars afterwards — the on-screen
  // table and every print (ใบ Grouping / ใบหารถ) must read the LIVE placement,
  // falling back to the import-time value for cars this device can't see.
  const liveRows = useMemo(() => rows?.map((r) => {
    const live = yardLocCode(unitByVin.get(r.vin))
    return live && live !== r.yardLocation ? { ...r, yardLocation: live } : r
  }) ?? null, [rows, unitByVin])

  // No fresh upload this session → rebuild the sheet from the newest delivery
  // run, so the page shows the sheet (and its editable Lane load) after any
  // reload, on any device — the queue in the cloud IS the plan of record.
  const queueSheet = useMemo(() => {
    if (rows) return null
    const q = queues
      .filter((x) => x.kind === 'sequence' && x.items.length > 0 && (!currentSite || !x.site || x.site === currentSite))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!q) return null
    const count = new Map<string, number>()
    for (const i of q.items) count.set(i.group ?? '', (count.get(i.group ?? '') ?? 0) + 1)
    const sheetRows: GroupPrintRow[] = q.items.map((i, idx) => {
      const r = rowByVin.get(i.vin)
      return {
        no: idx + 1, vin: i.vin,
        modelName: String(r?.cells['Model name'] ?? ''),
        model: String(r?.cells['Model'] || r?.cells['Model name'] || ''),
        color: String(r?.cells['Color'] ?? ''),
        deliveryLocation: i.dest || String(r?.cells['Dealer Location'] ?? ''),
        grouping: i.group ?? '', groupUnit: count.get(i.group ?? '') ?? 0,
        yardLocation: yardLocCode(unitByVin.get(i.vin)) || '',
        laneLoad: i.laneLoad ?? '', receiveDate: '', remark: '',
      }
    })
    const m: GroupPrintMeta = {
      siteLabel: siteLabel(siteName), date: todayLong(), totalUnits: sheetRows.length,
      groupCount: count.size, locPrefix: siteGroupingConfig(siteName).prefix,
    }
    return { name: q.name, rows: sheetRows, meta: m }
  }, [rows, queues, currentSite, rowByVin, unitByVin, siteName])

  // admin's Lane load edits (grouping code → lane), shown live in the sheet and
  // carried into prints/Create even before บันทึก writes them to the queues
  const [laneEdits, setLaneEdits] = useState<Record<string, string>>({})
  const baseRows = liveRows ?? queueSheet?.rows ?? null
  const sheetMeta = meta ?? queueSheet?.meta ?? null
  const fromQueue = !rows && !!queueSheet
  const sheetRows = useMemo(() => baseRows?.map((r) => {
    const l = laneEdits[r.grouping]
    return l != null && l !== r.laneLoad ? { ...r, laneLoad: l } : r
  }) ?? null, [baseRows, laneEdits])

  const canPrint = !!sheetRows && sheetRows.length > 0 && !!sheetMeta
  const hasLaneEdits = Object.keys(laneEdits).length > 0

  // DN / IR print straight off the tracking rows of the sheet's cars — the
  // import already stamped 'Grouping  Number' + 'Dealer Location' onto them,
  // so the manifests carry this plan's data
  const sheetTrackRows = useMemo(
    () => sheetRows?.map((r) => rowByVin.get(r.vin)).filter((r): r is TrackRow => !!r) ?? [],
    [sheetRows, rowByVin])
  const trackRowsOrWarn = (): TrackRow[] => {
    const missing = (sheetRows?.length ?? 0) - sheetTrackRows.length
    if (missing > 0) toast('err', `ไม่พบข้อมูล ${missing} คันในระบบ — พิมพ์เฉพาะคันที่พบ`)
    return sheetTrackRows
  }
  const doExport = (fn: () => Promise<void>) =>
    fn().catch((e) => { console.error('[grouping] export', e); toast('err', `Export ไม่สำเร็จ: ${(e as Error)?.message ?? e}`) })

  // rows flattened for the sheet-style table: merged (rowSpan) cells for
  // Grouping (Unit) / Lane load / วันที่ start on each group's first row, and
  // group stripes alternate like the printed sheet
  const renderRows = useMemo(() => {
    if (!sheetRows) return []
    const order: string[] = []
    const byG = new Map<string, GroupPrintRow[]>()
    for (const r of sheetRows) {
      if (!byG.has(r.grouping)) { byG.set(r.grouping, []); order.push(r.grouping) }
      byG.get(r.grouping)!.push(r)
    }
    let n = 0
    return order.flatMap((g, gi) => byG.get(g)!.map((r, ri) => ({
      r, n: ++n, first: ri === 0, span: byG.get(g)!.length, alt: gi % 2 === 1,
    })))
  }, [sheetRows])

  const saveLaneLoads = () => {
    if (!hasLaneEdits) return
    const updates: Record<string, string> = {}
    for (const [g, l] of Object.entries(laneEdits)) if (g) updates[g] = l.trim()
    // queue items carry the lane the field reads — updating them (and pushing to
    // cloud) is exactly what makes every device show the new lane automatically
    const changed = setLaneLoads(updates)
    if (rows) setRows(rows.map((r) => (updates[r.grouping] != null ? { ...r, laneLoad: updates[r.grouping] } : r)))
    setLaneEdits({})
    toast('ok', changed
      ? `บันทึก Lane load แล้ว · อัปเดตคิวงาน ${changed} คิว — หน้างานเห็น lane ใหม่ทันที`
      : 'บันทึก Lane load แล้ว')
  }

  const doCreateSequence = () => {
    if (!sheetRows || !sheetRows.length) return
    // never a silent return — a click on the green button must always answer
    const name = seqName.trim() || queueSheet?.name || `${siteLabel(siteName)} - Grouping to Dealer ( ${sheetRows.length} Units ) ${todayLong()}`
    try {
      // the grouping code travels with the item: the run keeps following it, so a
      // car whose number is cleared later drops out and a car stamped with it joins
      const items = sheetRows.map((r) => ({ vin: r.vin, laneLoad: r.laneLoad, dest: r.deliveryLocation, group: r.grouping }))
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
            <button className="btn" disabled={!canPrint} onClick={() => sheetRows && sheetMeta && printGrouping(sheetRows, sheetMeta)}>
              <Printer size={15} /> 2 · พิมพ์ Grouping
            </button>
            <button className="btn" disabled={!canPrint} onClick={() => sheetRows && sheetMeta && printFindCar(sheetRows, sheetMeta)}>
              <MapPin size={15} /> 3 · พิมพ์ใบหารถ
            </button>
            {hasLaneEdits && (
              <button className="btn" onClick={saveLaneLoads}
                style={{ background: '#2563eb', color: '#fff', borderColor: 'transparent' }}>
                <Save size={15} /> บันทึก Lane load
              </button>
            )}
            <button className="btn" disabled={!canPrint || fromQueue} onClick={doCreateSequence}
              title={fromQueue ? 'คิวงานของแผนนี้ถูกสร้างไว้แล้ว — จัดการได้ที่รายการคิวด้านล่าง' : undefined}
              style={canPrint && !fromQueue ? { background: '#16a34a', color: '#fff', borderColor: 'transparent' } : undefined}>
              <ListChecks size={15} /> Create Sequence
            </button>
          </div>
        }
      />

      {/* DN / IR manifests + Excel exports of the current plan */}
      {canPrint && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <button className="btn" onClick={() => printDn(trackRowsOrWarn())} disabled={!sheetTrackRows.length}
            title="พิมพ์ใบส่งมอบรถ (Delivery Note) — 1 ใบ ต่อ 1 Grouping">
            <FileText size={15} /> พิมพ์ DN
          </button>
          <button className="btn" onClick={() => printIr(trackRowsOrWarn(), siteName)} disabled={!sheetTrackRows.length}
            title="พิมพ์ใบตรวจรถ (Inspector Report) เต็มฟอร์ม — 1 หน้า ต่อ 1 คัน ลงกระดาษเปล่า">
            <Printer size={15} /> พิมพ์ IR
          </button>
          <button className="btn" onClick={() => printIrPaper(trackRowsOrWarn(), siteName)} disabled={!sheetTrackRows.length}
            title="พิมพ์เฉพาะข้อมูลลงบนกระดาษฟอร์ม IR ที่พิมพ์ไว้ล่วงหน้า (ตรงตำแหน่ง AMS 100%)">
            <Printer size={15} /> พิมพ์กระดาษ IR
          </button>
          <span aria-hidden style={{ width: 1, height: 22, background: 'var(--line-strong)' }} />
          <button className="btn" onClick={() => sheetRows && sheetMeta && doExport(() => exportGroupingXlsx(sheetRows, sheetMeta))}
            style={{ color: '#16a34a' }} title="ดาวน์โหลดใบ Grouping เป็นไฟล์ Excel (.xlsx)">
            <FileSpreadsheet size={15} /> Excel ใบ Grouping
          </button>
          <button className="btn" onClick={() => sheetRows && sheetMeta && doExport(() => exportFindCarXlsx(sheetRows, sheetMeta))}
            style={{ color: '#16a34a' }} title="ดาวน์โหลดใบหารถเป็นไฟล์ Excel (.xlsx) เรียงตามตำแหน่งในลาน">
            <FileSpreadsheet size={15} /> Excel ใบหารถ
          </button>
        </div>
      )}

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

      {!sheetRows || !sheetRows.length || !sheetMeta ? (
        <div className="panel p-12 text-center" style={{ color: 'var(--faint)' }}>
          <FileSpreadsheet size={40} className="mx-auto mb-3" style={{ color: 'var(--line-strong)' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--muted)' }}>ยังไม่ได้นำเข้าไฟล์ Grouping</div>
          <div className="text-[13px] mt-1.5 leading-relaxed">
            กดปุ่ม <b style={{ color: 'var(--brand)' }}>อัปโหลด Excel Grouping</b> — ระบบจะอ่าน sheet ตาม Site ปัจจุบัน
            {siteName ? <> (<b>{siteName}</b>)</> : ''} แล้วใส่เลข Grouping ให้รถ พร้อมเติมตำแหน่งในลาน + Lane load อัตโนมัติ
          </div>
        </div>
      ) : (
        /* on-screen replica of the printed Grouping-to-Dealer sheet — same
           columns, yellow header, merged group cells; Lane load is editable */
        <div className="panel overflow-hidden" style={{ background: '#fff' }}>
          <div className="px-4 pt-3 pb-1 text-center font-bold text-[13.5px]" style={{ color: '#111' }}>
            {(seqName.trim() || queueSheet?.name) ??
              `${sheetMeta.siteLabel} - Grouping to Dealer ( ${sheetMeta.totalUnits} Units / ${sheetMeta.groupCount} Group) Date ${sheetMeta.date}`}
          </div>
          {fromQueue && (
            <div className="text-center text-[11.5px] pb-1" style={{ color: 'var(--muted)' }}>
              แสดงจากคิวงานล่าสุด — แก้ Lane load แล้วกด <b style={{ color: '#2563eb' }}>บันทึก Lane load</b> หน้างานจะเห็นทันที
            </div>
          )}
          <div className="overflow-x-auto p-3">
            <table style={{ width: '100%', borderCollapse: 'collapse', color: '#111' }} className="text-[12px]">
              <thead>
                <tr>
                  {['No', 'Vin', 'Model', 'Color', 'Delivery Location', 'Groupping Number', 'Grouping (Unit)', 'Location', 'Lane load', 'วันที่ในการเข้ารับ', 'หมายเหตุ'].map((h) => (
                    <th key={h} className="whitespace-nowrap"
                      style={{ background: '#ffff00', border: '1px solid #000', padding: '4px 6px', fontWeight: 700, fontSize: 11, color: '#111', textAlign: 'center' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {renderRows.map(({ r, n, first, span, alt }) => {
                  const td = (extra?: React.CSSProperties): React.CSSProperties =>
                    ({ border: '1px solid #000', padding: '3px 6px', background: alt ? '#fff3d6' : '#fff', ...extra })
                  return (
                    <tr key={r.vin}>
                      <td style={td({ textAlign: 'center' })} className="tabular">{n}</td>
                      <td style={td()} className="vin whitespace-nowrap font-semibold">{r.vin}</td>
                      <td style={td({ textAlign: 'center' })} className="whitespace-nowrap">{r.model}</td>
                      <td style={td({ textAlign: 'center' })} className="whitespace-nowrap">{r.color}</td>
                      <td style={td({ maxWidth: 240 })} className="clip" title={r.deliveryLocation}>{r.deliveryLocation}</td>
                      <td style={td({ textAlign: 'center' })} className="tabular whitespace-nowrap">{r.grouping}</td>
                      {first && <td rowSpan={span} style={td({ textAlign: 'center', fontWeight: 700 })} className="tabular">{span}</td>}
                      <td style={td({ textAlign: 'center', color: r.yardLocation ? '#111' : '#d97706', fontWeight: 600 })} className="tabular whitespace-nowrap">
                        {r.yardLocation || 'ไม่พบ'}
                      </td>
                      {first && (
                        <td rowSpan={span} style={td({ textAlign: 'center', padding: 2 })}>
                          <input
                            value={r.laneLoad}
                            onChange={(e) => setLaneEdits((p) => ({ ...p, [r.grouping]: e.target.value.toUpperCase() }))}
                            className="tabular"
                            style={{ width: 52, textAlign: 'center', fontWeight: 700, fontSize: 12.5, color: '#2563eb',
                              border: '1.5px solid #2563eb55', borderRadius: 6, padding: '3px 2px', background: '#fff' }}
                          />
                        </td>
                      )}
                      {first && (
                        <td rowSpan={span} style={td({ textAlign: 'center' })} className="tabular whitespace-nowrap">
                          {r.receiveDate || sheetMeta.date}
                        </td>
                      )}
                      <td style={td({ minWidth: 60 })}>{r.remark}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} style={{ background: '#ffff00', border: '1px solid #000', padding: '4px 6px', fontWeight: 700, textAlign: 'center' }}>Total</td>
                  <td style={{ background: '#ffff00', border: '1px solid #000', padding: '4px 6px', fontWeight: 700, textAlign: 'center' }} className="tabular">{sheetMeta.totalUnits}</td>
                  <td style={{ background: '#ffff00', border: '1px solid #000', padding: '4px 6px', fontWeight: 700, textAlign: 'center' }}>Cars.</td>
                  <td colSpan={3} style={{ background: '#ffff00', border: '1px solid #000' }} />
                </tr>
              </tfoot>
            </table>
            <div className="text-center text-[11.5px] mt-1.5" style={{ color: '#111' }}>( {sheetMeta.groupCount} Group )</div>
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
