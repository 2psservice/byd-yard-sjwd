/**
 * เสียง "ปี๊บ" เมื่อกล้องสแกนโค้ดติด — แบบเครื่องยิงบาร์โค้ดมือถือ คนยิงรู้ทันทีว่าอ่านได้แล้ว
 * โดยไม่ต้องก้มดูจอ
 *
 * เสียงสร้างสด ๆ ด้วย Web Audio (ไม่มีไฟล์เสียงให้โหลด) · iPhone ยอมให้หน้าเว็บเริ่มเสียงได้
 * เฉพาะ "ระหว่างที่ผู้ใช้แตะ" เท่านั้น ส่วนการสแกนติดเกิดในลูปกล้อง ไม่ใช่ตอนแตะ จึงต้อง
 * primeScanBeep() ตอนแตะปุ่มเปิดกล้องก่อน แล้ว scanBeep() ตอนอ่านติดจะดังได้ · Android สั่นด้วย
 */

type AudioCtor = typeof AudioContext
let ctx: AudioContext | null = null

/** สร้าง / ปลุกเสียงของหน้าเว็บ — เรียกในตัวจัดการการแตะ (เปิดกล้อง ถ่ายรูปบาร์โค้ด) */
export function primeScanBeep(): void {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
      if (!Ctor) return
      ctx = new Ctor()
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  } catch { /* no audio on this device — scanning still works */ }
}

/** ปี๊บสั้น ๆ 0.12 วินาที โทนเดียวกับเครื่องยิงบาร์โค้ด + สั่นสั้น ๆ ที่เครื่องรองรับ */
export function scanBeep(): void {
  try { navigator.vibrate?.(60) } catch { /* unsupported */ }
  try {
    primeScanBeep()
    if (!ctx) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 2400 // small phone speakers are loudest around 2–3 kHz
    // short fade in / out — a hard start or stop clicks
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.005)
    gain.gain.setValueAtTime(0.18, t + 0.1)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.13)
  } catch { /* a failed beep never blocks the scan */ }
}
