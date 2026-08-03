/**
 * What kind of device is this? Decided once at load — a phone that rotates or a
 * window that is resized must not swap the whole app out from under the user.
 */

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
const uaData = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & {
  userAgentData?: { mobile?: boolean }
}).userAgentData

/** Shortest screen edge in CSS px — orientation-independent. */
const shortSide = typeof screen === 'undefined' ? 1024 : Math.min(screen.width, screen.height)

/**
 * Touch-first device: a phone or a tablet, not a laptop that happens to have a
 * touchscreen. `pointer: coarse` reports the *primary* pointer, so a Windows
 * laptop with both a trackpad and a touch display stays "fine" and keeps the
 * hover chrome; maxTouchPoints is only the fallback where matchMedia is absent.
 */
export const isTouch = typeof matchMedia === 'function'
  ? matchMedia('(pointer: coarse)').matches
  : (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)

/**
 * A phone — NOT a tablet or a desktop.
 *
 * Matched by the mobile UA tokens (an Android tablet has no "Mobile" token, and
 * an iPad reports as a Mac), with a screen-size fallback for phones running in
 * desktop-UA mode. Phones only ever get the Yard Ops station, whatever the
 * account's role, because the admin screens are tables that need a real screen.
 */
export const isPhone = (() => {
  if (/iPhone|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return true
  // desktop-mode UA on a phone: coarse pointer on a screen no wider than a phone
  if (uaData?.mobile === true) return true
  return isTouch && shortSide < 600
})()
