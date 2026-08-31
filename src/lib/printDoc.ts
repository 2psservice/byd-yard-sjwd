/**
 * Naming a printed sheet.
 *
 * Every sheet in the app prints from a hidden iframe, and Chrome/Edge name the
 * "Save as PDF" file after the TOP document's title — not the iframe's. So a
 * driver saving the car-finding sheet got
 * "SJWD Yard Control — ระบบบริหารลานจอดรถ.pdf", the same name as every other
 * sheet, and a folder of them told you nothing.
 *
 * The fix is to lend the page the sheet's own name for the length of the print
 * job and hand it back afterwards.
 */

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** "31 AUG26" — the date stamp the yard already writes on its paperwork.
 *  English month + 2-digit Gregorian year: the Thai locale prints "31 ส.ค. 69",
 *  whose Buddhist year reads as a different date against a shipping document. */
export function fileStamp(when?: Date | string): string {
  const d = when instanceof Date ? when : when ? new Date(when) : new Date()
  const ok = !isNaN(d.getTime()) ? d : new Date()
  return `${String(ok.getDate()).padStart(2, '0')} ${MON[ok.getMonth()]}${String(ok.getFullYear() % 100).padStart(2, '0')}`
}

/** Characters Windows/macOS refuse in a filename, plus runs of blanks. */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

/**
 * Give the page the printed sheet's name until the print job is done.
 *
 * Returns a restore function — safe to call more than once. It also restores on
 * `afterprint` (from either window) and, whatever happens, after a minute, so a
 * cancelled dialog can never leave the app wearing a sheet's name.
 */
/** The app's own title, remembered while any sheet is borrowing it. Two prints
 *  overlapping must not let the second one take the FIRST SHEET's name for "the
 *  original" and leave the app wearing a sheet's name for good. */
let appTitle: string | null = null
let borrowed = 0

export function borrowDocTitle(name: string, frameWin?: Window | null): () => void {
  const clean = safeName(name)
  if (!clean || typeof document === 'undefined') return () => {}
  if (borrowed === 0) appTitle = document.title
  borrowed++
  document.title = clean
  let done = false
  const restore = () => {
    if (done) return
    done = true
    borrowed = Math.max(0, borrowed - 1)
    if (borrowed === 0 && appTitle !== null) { document.title = appTitle; appTitle = null }
    window.removeEventListener('afterprint', restore)
    try { frameWin?.removeEventListener?.('afterprint', restore) } catch { /* cross-doc */ }
  }
  window.addEventListener('afterprint', restore)
  try { frameWin?.addEventListener?.('afterprint', restore) } catch { /* cross-doc */ }
  setTimeout(restore, 60_000)
  return restore
}
