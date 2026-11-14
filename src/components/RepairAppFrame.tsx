/**
 * The Mechanic station runs the yard's own repair app ("งานซ่อม + รูป · Repair Photo Logger"):
 * a single HTML file served unchanged from public/repair/, shown here in a frame that fills the
 * rest of the screen under the station header.
 *
 * It is a whole app of its own — its own sign-in, its own cloud project and photo store — so it is
 * framed rather than rebuilt. It shares this origin's browser storage only under its own `rpl_*`
 * keys, which never meet the yard app's `sjwd-*` ones. A new version of the file is a new deploy:
 * replace public/repair/index.html.
 *
 * On every load (the repair app reloads itself on sign-out) the frame links it to the yard's own
 * defects — see lib/repairBridge: SJWD's live defects feed its defect search, and a repair saved
 * there closes the matching SJWD defect.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { useYard } from '../store/useYard'
import { useTracking } from '../store/useTracking'
import { attachRepairBridge } from '../lib/repairBridge'

export const REPAIR_APP_URL = '/repair/index.html'

/** Hand the framed repair app the yard's defects and take its repairs back (same origin). */
function linkYard(frame: HTMLIFrameElement) {
  let win: Window | null = null
  try { win = frame.contentWindow } catch { return }
  if (!win) return
  const linked = attachRepairBridge(win, {
    units: () => useYard.getState().units,
    rows: () => useTracking.getState().rows,
    siteName: (id) => useYard.getState().sites.find((x) => x.id === id)?.name ?? '',
    updateDamage: (vin, id, patch) => useYard.getState().updateDamage(vin, id, patch),
    onWriteBack: (n) => useYard.getState().toast('ok', `อัปเดตสถานะ Defect ใน SJWD จากงานซ่อมแล้ว ${n} จุด`),
  })
  if (!linked.defects || !linked.writeBack) console.warn('[repair] link to SJWD defects', linked)
}

export function RepairAppFrame() {
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [loaded, setLoaded] = useState(false)

  // fill from where the frame starts down to the bottom of the screen (the shell scrolls, the frame must not)
  useLayoutEffect(() => {
    const measure = () => setTop(Math.max(0, box.current?.getBoundingClientRect().top ?? 0))
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('orientationchange', measure) }
  }, [])

  return (
    <div ref={box} className="repair-frame" data-repair-frame
      style={{ height: `calc(100dvh - ${top}px - env(safe-area-inset-bottom, 0px) - 10px)` }}>
      {!loaded && <div className="repair-frame-wait">กำลังเปิดระบบงานซ่อม…</div>}
      <iframe src={REPAIR_APP_URL} title="งานซ่อม + รูป" onLoad={(e) => { setLoaded(true); linkYard(e.currentTarget) }}
        allow="camera; microphone; clipboard-read; clipboard-write; fullscreen" />
    </div>
  )
}
