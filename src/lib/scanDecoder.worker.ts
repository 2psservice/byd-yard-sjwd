/**
 * ตัวถอดรหัสบาร์โค้ด (ZXing WebAssembly) ที่ทำงานใน Web Worker — คนละเธรดกับหน้าจอ
 * ภาพพรีวิวกล้องและปุ่มไม่กระตุกขณะถอดรหัสเฟรม (ดู lib/scanDecoder.ts)
 *
 * รับได้ 2 แบบ:
 *  - { id, width, height, buf }  พิกเซล RGBA ของเฟรมที่ครอปแล้ว (โอนกรรมสิทธิ์มา)
 *  - { id, bitmap }              ImageBitmap ของเฟรมที่ครอป/ย่อแล้ว (โอนกรรมสิทธิ์มา) —
 *                                worker วาดลง OffscreenCanvas แล้วอ่านพิกเซลเองที่นี่ เธรดหลัก
 *                                ไม่ต้อง drawImage/getImageData (บนมือถือช้าสองอย่างนี้กิน
 *                                ~100-150 ms ต่อเฟรม = ต้นเหตุพรีวิวค้าง/จอดำ)
 *  - { id, frame, sx, sy, cw, ch, outW, outH }  VideoFrame (WebCodecs) ของเฟรมสด — แค่ "ตัวชี้"
 *                                ไปที่เฟรม ไม่คัดลอกพิกเซลบนเธรดหลักเลย worker ครอป/ย่อเองด้วย
 *                                createImageBitmap(frame, …) แล้วอ่านพิกเซล (วัด: เธรดหลัก ~16 ms/
 *                                เฟรม เทียบ bitmap 86 / canvas 213 บนซีพียูช้า 6 เท่า)
 * ตอบ: { type: 'result', id, text | null } · ตอนพร้อม: { type: 'ready', offscreen }
 */
import { readBarcodes, prepareZXingModule } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

prepareZXingModule({ overrides: { locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? wasmUrl : prefix + p) } })
const OPTS = { formats: ['QRCode', 'Code128', 'Code39', 'EAN13', 'DataMatrix'], tryHarder: true, maxNumberOfSymbols: 1 } as const

const port = self as unknown as { postMessage: (msg: unknown) => void; onmessage: ((e: MessageEvent) => void) | null }
const hasOffscreen = typeof OffscreenCanvas !== 'undefined'
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

;(async () => {
  // อุ่นโมดูลตั้งแต่ตอนเปิด worker — เฟรมแรกจริงจะได้ไม่ต้องรอโหลด wasm
  try { await readBarcodes(new ImageData(2, 2), OPTS as never) } catch { /* reported on first decode */ }
  port.postMessage({ type: 'ready', offscreen: hasOffscreen })
})()

type Msg = { id: number; width: number; height: number; buf: ArrayBuffer } | { id: number; bitmap: ImageBitmap }
  | { id: number; frame: VideoFrame; sx: number; sy: number; cw: number; ch: number; outW: number; outH: number }

port.onmessage = async (e: MessageEvent<Msg>) => {
  const { id } = e.data
  let text: string | null = null
  try {
    let img: ImageData
    if ('frame' in e.data) {
      const { frame, sx, sy, cw, ch, outW, outH } = e.data
      let bmp: ImageBitmap
      try { bmp = await createImageBitmap(frame, sx, sy, cw, ch, { resizeWidth: outW, resizeHeight: outH, resizeQuality: 'low' }) }
      finally { frame.close() }
      try {
        if (!canvas || !ctx) { canvas = new OffscreenCanvas(bmp.width, bmp.height); ctx = canvas.getContext('2d', { willReadFrequently: true }) }
        if (!ctx) throw new Error('no 2d context')
        if (canvas!.width !== bmp.width || canvas!.height !== bmp.height) { canvas!.width = bmp.width; canvas!.height = bmp.height }
        ctx.drawImage(bmp, 0, 0)
        img = ctx.getImageData(0, 0, bmp.width, bmp.height)
      } finally { bmp.close() }
    } else if ('bitmap' in e.data) {
      const bmp = e.data.bitmap
      try {
        if (!canvas || !ctx) { canvas = new OffscreenCanvas(bmp.width, bmp.height); ctx = canvas.getContext('2d', { willReadFrequently: true }) }
        if (!ctx) throw new Error('no 2d context')
        if (canvas!.width !== bmp.width || canvas!.height !== bmp.height) { canvas!.width = bmp.width; canvas!.height = bmp.height }
        ctx.drawImage(bmp, 0, 0)
        img = ctx.getImageData(0, 0, bmp.width, bmp.height)
      } finally { bmp.close() }
    } else {
      img = new ImageData(new Uint8ClampedArray(e.data.buf), e.data.width, e.data.height)
    }
    text = (await readBarcodes(img, OPTS as never))[0]?.text ?? null
  } catch { /* decoder hiccup — caller tries the next frame */ }
  port.postMessage({ type: 'result', id, text })
}
