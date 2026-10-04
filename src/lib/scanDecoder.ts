/**
 * ตัวถอดรหัสบาร์โค้ดในแอป — ZXing WebAssembly ไม่พึ่ง Google Play Services
 *
 * ของเดิมบน Android ใช้ BarcodeDetector ของ Chrome ซึ่งส่งทุกเฟรมข้าม process ไปให้
 * ML Kit ใน Google Play Services อ่าน บนมือถือ RAM 2-3 GB (Helio G35) แต่ละรอบใช้
 * 200-600 ms, Play Services ถูกเตะออกจากหน่วยความจำแล้วต้องเริ่มใหม่เป็นวินาที และ
 * เป็นต้นเหตุหนึ่งของอาการจอค้าง/ภาพดำ ตัวถอดรหัสนี้ทำงานในแอปเองทั้งหมด:
 *
 *  1. Web Worker (เธรดแยก) — หน้าจอและพรีวิวกล้องไม่กระตุกขณะถอดรหัส
 *  2. wasm บนเธรดหลัก — เมื่อสร้าง worker ไม่ได้ (เบราว์เซอร์เก่า / CSP)
 *  3. @zxing/library (JS ล้วน) — เมื่อโหลด wasm ไม่ได้เลย
 *
 * ทุกแบบมีสัญญาเดียวกัน: decode(ImageData) → ข้อความ หรือ null
 */
export interface ScanDecoder {
  kind: 'worker' | 'wasm' | 'js'
  decode: (img: ImageData) => Promise<string | null>
  dispose: () => void
}

const OPTS = { formats: ['QRCode', 'Code128', 'Code39', 'EAN13', 'DataMatrix'], tryHarder: true, maxNumberOfSymbols: 1 } as const
const WORKER_READY_MS = 8000

async function createWorkerDecoder(): Promise<ScanDecoder | null> {
  if (typeof Worker === 'undefined') return null
  let worker: Worker
  try {
    worker = new Worker(new URL('./scanDecoder.worker.ts', import.meta.url), { type: 'module' })
  } catch { return null }
  const pending = new Map<number, (text: string | null) => void>()
  let seq = 0
  const ready = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), WORKER_READY_MS)
    worker.onmessage = (e: MessageEvent<{ type: string; id?: number; text?: string | null }>) => {
      if (e.data?.type === 'ready') { clearTimeout(t); resolve(true); return }
      if (e.data?.type === 'result' && e.data.id != null) { pending.get(e.data.id)?.(e.data.text ?? null); pending.delete(e.data.id) }
    }
    worker.onerror = () => { clearTimeout(t); resolve(false) }
  })
  if (!ready) { worker.terminate(); return null }
  return {
    kind: 'worker',
    decode: (img) => new Promise<string | null>((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      // โอนบัฟเฟอร์ไปเลย (ไม่คัดลอก) — ผู้เรียกไม่ใช้ ImageData นี้ต่อ
      const buf = img.data.buffer as ArrayBuffer
      worker.postMessage({ id, width: img.width, height: img.height, buf }, [buf])
    }),
    dispose: () => { worker.terminate(); for (const r of pending.values()) r(null); pending.clear() },
  }
}

async function createWasmDecoder(): Promise<ScanDecoder | null> {
  try {
    const [{ readBarcodes, prepareZXingModule }, wasmUrlMod] = await Promise.all([
      import('zxing-wasm/reader'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ])
    const wasmUrl = (wasmUrlMod as { default: string }).default
    prepareZXingModule({ overrides: { locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? wasmUrl : prefix + p) } })
    await readBarcodes(new ImageData(2, 2), OPTS as never).catch(() => {}) // warm the module
    return {
      kind: 'wasm',
      decode: async (img) => (await readBarcodes(img, OPTS as never))[0]?.text ?? null,
      dispose: () => {},
    }
  } catch (e) {
    console.warn('[scan] wasm decoder unavailable — JS fallback', e)
    return null
  }
}

async function createJsDecoder(): Promise<ScanDecoder> {
  const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ])
  const hints = new Map<number, unknown>()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
    BarcodeFormat.EAN_13, BarcodeFormat.DATA_MATRIX,
  ])
  hints.set(DecodeHintType.TRY_HARDER, true)
  const reader = new BrowserMultiFormatReader(hints as never)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  return {
    kind: 'js',
    decode: async (img) => {
      canvas.width = img.width; canvas.height = img.height
      ctx.putImageData(img, 0, 0)
      try { return reader.decodeFromCanvas(canvas).getText() } catch { return null }
    },
    dispose: () => {},
  }
}

/** สร้างตัวถอดรหัสที่ดีที่สุดที่เครื่องนี้ทำได้ (worker → wasm → js) */
export async function createScanDecoder(): Promise<ScanDecoder> {
  return (await createWorkerDecoder()) ?? (await createWasmDecoder()) ?? (await createJsDecoder())
}
