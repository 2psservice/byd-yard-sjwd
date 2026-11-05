/**
 * The Mechanic station runs the yard's own repair app ("งานซ่อม + รูป · Repair Photo Logger"):
 * a single HTML file served unchanged from public/repair/, shown here in a frame that fills the
 * rest of the screen under the station header.
 *
 * It is a whole app of its own — its own sign-in, its own cloud project and photo store — so it is
 * framed rather than rebuilt. It shares this origin's browser storage only under its own `rpl_*`
 * keys, which never meet the yard app's `sjwd-*` ones. A new version of the file is a new deploy:
 * replace public/repair/index.html.
 */
import { useLayoutEffect, useRef, useState } from 'react'

export const REPAIR_APP_URL = '/repair/index.html'

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
      <iframe src={REPAIR_APP_URL} title="งานซ่อม + รูป" onLoad={() => setLoaded(true)}
        allow="camera; microphone; clipboard-read; clipboard-write; fullscreen" />
    </div>
  )
}
