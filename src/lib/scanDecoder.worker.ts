/**
 * ตัวถอดรหัสบาร์โค้ด (ZXing WebAssembly) ที่ทำงานใน Web Worker — คนละเธรดกับหน้าจอ
 * ภาพพรีวิวกล้องและปุ่มไม่กระตุกขณะถอดรหัสเฟรม (ดู lib/scanDecoder.ts)
 *
 * รับ: { id, width, height, buf } (พิกเซล RGBA ของเฟรมที่ครอปแล้ว โอนกรรมสิทธิ์มา)
 * ตอบ: { type: 'result', id, text | null } · ตอนพร้อม: { type: 'ready' }
 */
import { readBarcodes, prepareZXingModule } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

prepareZXingModule({ overrides: { locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? wasmUrl : prefix + p) } })
const OPTS = { formats: ['QRCode', 'Code128', 'Code39', 'EAN13', 'DataMatrix'], tryHarder: true, maxNumberOfSymbols: 1 } as const

const port = self as unknown as { postMessage: (msg: unknown) => void; onmessage: ((e: MessageEvent) => void) | null }

;(async () => {
  // อุ่นโมดูลตั้งแต่ตอนเปิด worker — เฟรมแรกจริงจะได้ไม่ต้องรอโหลด wasm
  try { await readBarcodes(new ImageData(2, 2), OPTS as never) } catch { /* reported on first decode */ }
  port.postMessage({ type: 'ready' })
})()

port.onmessage = async (e: MessageEvent<{ id: number; width: number; height: number; buf: ArrayBuffer }>) => {
  const { id, width, height, buf } = e.data
  let text: string | null = null
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), width, height)
    text = (await readBarcodes(img, OPTS as never))[0]?.text ?? null
  } catch { /* decoder hiccup — caller tries the next frame */ }
  port.postMessage({ type: 'result', id, text })
}
