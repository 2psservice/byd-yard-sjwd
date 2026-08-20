/**
 * หุบแป้นพิมพ์มือถือเมื่อมีกล่องเต็มจอเด้งขึ้นมา
 *
 * On a handset the scan field keeps focus after a scan, so the on-screen
 * keyboard stays up — and the result box that opens on top of it ("Pre Gate-out
 * สำเร็จ!") ends up half-hidden behind the keys, with its ตกลง button out of
 * reach. The worker has to dismiss the keyboard by hand before every single
 * confirmation.
 *
 * A field only holds focus because the user was typing into THAT screen; the
 * moment a full-screen box takes over, that field is no longer what they are
 * working on. So: when an overlay is added to the page, blur whatever field
 * still holds focus — unless the focused field belongs to the overlay itself
 * (a dialog with its own input must keep its keyboard).
 *
 * Watching the DOM rather than each dialog's own state means every box gets
 * this — the ones on screen today and the ones added later.
 */
const OVERLAY = 'div.fixed.inset-0'

/**
 * A full-screen element is only a DIALOG if it has something in it.
 *
 * An empty one is a click-catcher — the transparent sheet a dropdown lays over
 * the page to notice a tap outside itself (MasterCombo's suggestion list uses
 * one). Those open BECAUSE a field was focused, and treating them as dialogs
 * closed the keyboard the instant the worker tapped ตำแหน่ง / รายละเอียด DEFECT,
 * so the field could never be typed in at all.
 */
export function isDialog(el: Element): boolean {
  return el.childElementCount > 0
}

/** Is a real dialog on screen right now? */
export function hasDialogOpen(): boolean {
  return [...document.querySelectorAll(OVERLAY)].some(isDialog)
}

function blurOutside(overlay: Element): void {
  const el = document.activeElement
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  if (overlay.contains(el)) return // the box owns this field — leave its keyboard up
  el.blur()
}

/** Start watching; returns the stop function. No-op outside the browser. */
export function startKeyboardGuard(): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {}
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue
        const overlay = [n, ...n.querySelectorAll(OVERLAY)].find((e) => e.matches(OVERLAY) && isDialog(e))
        if (overlay) { blurOutside(overlay); return }
      }
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
  return () => obs.disconnect()
}
