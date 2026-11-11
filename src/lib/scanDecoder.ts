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
  /** ทางลัดสำหรับกล้องสด (เฉพาะ worker ที่มี OffscreenCanvas): รับ ImageBitmap ที่ครอป/ย่อแล้ว
   *  โอนไปให้ worker อ่านพิกเซลเอง — เธรดหลักไม่ต้อง drawImage/getImageData ต่อเฟรม */
  decodeBitmap?: (bmp: ImageBitmap) => Promise<string | null>
  /** ทางที่เบาที่สุด (worker + OffscreenCanvas + WebCodecs): โอน VideoFrame ของเฟรมสดไปให้ worker
   *  ครอป/ย่อ/อ่านพิกเซลเองทั้งหมด — เธรดหลักไม่คัดลอกพิกเซลเลย */
  decodeVideoFrame?: (frame: VideoFrame, crop: { sx: number; sy: number; cw: number; ch: number; outW: number; outH: number }) => Promise<string | null>
  dispose: () => void
}

const OPTS = { formats: ['QRCode', 'Code128', 'Code39', 'EAN13', 'DataMatrix'], tryHarder: true, maxNumberOfSymbols: 1 } as const
const WORKER_READY_MS = 8000

/** sim hook (dev เท่านั้น): window.__scanFailPaths = ['videoframe', 'bitmap'] → worker แกล้งพังขั้นเตรียมภาพ
 *  ของทางนั้น (จำลอง iPhone/WebKit ที่ createImageBitmap จาก VideoFrame/ตัวเลือกย่อขนาดไม่ทำงาน) */
function testFail(path: string): { __fail?: string } {
  if (!import.meta.env.DEV || typeof window === 'undefined') return {}
  const f = (window as unknown as { __scanFailPaths?: string[] }).__scanFailPaths
  return f?.includes(path) ? { __fail: path } : {}
}

/** iPhone/iPad — ทุกเบราว์เซอร์บน iOS คือ WebKit (รวม Chrome/LINE) ซึ่งมี VideoFrame/OffscreenCanvas
 *  แต่ createImageBitmap จากเฟรม + ตัวเลือกย่อขนาดทำงานไม่ครบ → ใช้ทางดึงภาพเดิม (canvas) ที่พิสูจน์แล้ว */
export const IS_IOS = typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1))

async function createWorkerDecoder(): Promise<ScanDecoder | null> {
  if (typeof Worker === 'undefined') return null
  let worker: Worker
  try {
    worker = new Worker(new URL('./scanDecoder.worker.ts', import.meta.url), { type: 'module' })
  } catch { return null }
  // reject = ขั้นเตรียมภาพใน worker พัง (ดู scanDecoder.worker.ts err) — ผู้เรียกต้องถอยทางดึงภาพ
  const pending = new Map<number, { resolve: (text: string | null) => void; reject: (e: Error) => void }>()
  let seq = 0
  let offscreen = false
  const ready = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), WORKER_READY_MS)
    worker.onmessage = (e: MessageEvent<{ type: string; id?: number; text?: string | null; offscreen?: boolean; err?: string }>) => {
      if (e.data?.type === 'ready') { clearTimeout(t); offscreen = !!e.data.offscreen; resolve(true); return }
      if (e.data?.type === 'result' && e.data.id != null) {
        const p = pending.get(e.data.id); pending.delete(e.data.id)
        if (!p) return
        if (e.data.err) p.reject(new Error(e.data.err)); else p.resolve(e.data.text ?? null)
      }
    }
    worker.onerror = () => { clearTimeout(t); resolve(false) }
  })
  if (!ready) { worker.terminate(); return null }
  return {
    kind: 'worker',
    decode: (img) => new Promise<string | null>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      // โอนบัฟเฟอร์ไปเลย (ไม่คัดลอก) — ผู้เรียกไม่ใช้ ImageData นี้ต่อ
      const buf = img.data.buffer as ArrayBuffer
      worker.postMessage({ id, width: img.width, height: img.height, buf }, [buf])
    }),
    ...(offscreen && typeof createImageBitmap === 'function' ? {
      decodeBitmap: (bmp: ImageBitmap) => new Promise<string | null>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, bitmap: bmp, ...testFail('bitmap') }, [bmp]) // โอนกรรมสิทธิ์ ไม่คัดลอกพิกเซล
      }),
      ...(typeof VideoFrame !== 'undefined' ? {
        decodeVideoFrame: (frame: VideoFrame, crop: { sx: number; sy: number; cw: number; ch: number; outW: number; outH: number }) => new Promise<string | null>((resolve, reject) => {
          const id = ++seq
          pending.set(id, { resolve, reject })
          worker.postMessage({ id, frame, ...crop, ...testFail('videoframe') }, [frame])
        }),
      } : {}),
    } : {}),
    dispose: () => { worker.terminate(); for (const r of pending.values()) r.resolve(null); pending.clear() },
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

async function loadBitmap(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(file)
      return { src: b, w: b.width, h: b.height, close: () => b.close?.() }
    } catch { /* เบราว์เซอร์บางรุ่นอ่าน blob ตรง ๆ ไม่ได้ — ใช้ <img> แทน */ }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} }
  } finally { URL.revokeObjectURL(url) }
}

/**
 * ถอดรหัสบาร์โค้ดจาก "รูปถ่าย" (โหมดสำรองเมื่อเปิดกล้องสดไม่ได้ — ถ่ายด้วยกล้องระบบผ่าน
 * <input capture>) ลองหลายขนาด/หลายครอปเพราะรูปจากกล้องมือถือใหญ่ 8-13 MP แต่โค้ดอาจเล็ก
 */
export async function decodeImageFile(file: Blob, decoder: ScanDecoder): Promise<string | null> {
  const bmp = await loadBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || !bmp.w || !bmp.h) return null
    for (const maxW of [1600, 1000, 2400]) {
      for (const crop of [1, 0.6]) {
        const cw = Math.round(bmp.w * crop), ch = Math.round(bmp.h * crop)
        const scale = Math.min(1, maxW / cw)
        canvas.width = Math.max(2, Math.round(cw * scale))
        canvas.height = Math.max(2, Math.round(ch * scale))
        ctx.drawImage(bmp.src, (bmp.w - cw) >> 1, (bmp.h - ch) >> 1, cw, ch, 0, 0, canvas.width, canvas.height)
        const text = await decoder.decode(ctx.getImageData(0, 0, canvas.width, canvas.height))
        if (text) return text
      }
    }
    return null
  } finally { bmp.close() }
}

/** สร้างตัวถอดรหัสที่ดีที่สุดที่เครื่องนี้ทำได้ (worker → wasm → js)
 *  `skip`: ชนิดที่ใช้แล้วพัง (ลูปสแกนถอยลงตัวถัดไปเมื่อตัวถอดรหัสโยน error ติดกัน) */
export async function createScanDecoder(skip: readonly ScanDecoder['kind'][] = []): Promise<ScanDecoder> {
  return (!skip.includes('worker') ? await createWorkerDecoder() : null)
    ?? (!skip.includes('wasm') ? await createWasmDecoder() : null)
    ?? (await createJsDecoder())
}

// ── ตัวตรวจภาพที่ส่งไปถอดรหัส ────────────────────────────────────────────────
// 11 พ.ย.: มือถือ Android ที่อัปเดตเป็น Chrome 157 ภาพกล้องขึ้นจอปกติ แต่สแกนไม่ติดเลย ทั้งที่
// เครื่องอื่นอ่านสติกเกอร์เดียวกันได้ — ลูปเดิมนับ "ภาพว่าง/ภาพค้าง" และ error ของตัวถอดรหัส
// เป็น "ไม่เจอโค้ด" เงียบ ๆ ไปตลอด ตอนนี้ลูปดูสภาพภาพทุกรอบ แล้วถอยทางเมื่อเห็นว่าพัง

/** ภาพที่ได้มาใช้ได้ไหม: ช่วงความสว่าง (ต่ำ = ภาพว่าง/ดำทั้งภาพ) + ลายเซ็นสั้น ๆ (ซ้ำทุกรอบ = ภาพค้าง) */
export interface FrameSample { range: number; sig: number }

/** สุ่มอ่าน ~600 จุดของภาพ RGBA (ช่องสีเขียว — ใกล้ความสว่างที่สุด) */
export function sampleFrame(data: ArrayLike<number>): FrameSample {
  const px = data.length >> 2
  if (!px) return { range: 0, sig: 0 }
  const step = Math.max(1, Math.floor(px / 600))
  let mn = 255, mx = 0, sig = 0
  for (let p = 0; p < px; p += step) {
    const g = data[(p << 2) + 1]
    if (g < mn) mn = g
    if (g > mx) mx = g
    sig = (Math.imul(sig, 31) + g) | 0
  }
  return { range: mx - mn, sig }
}

/** ต่ำกว่านี้ = ภาพค่าเดียวทั้งภาพ (ดึงภาพพัง — ดำ/ขาวสนิท) · ตั้งเข้มไว้: กระจกมืดตอนกลางคืนหลังกล้องลด
 *  noise ช่วงความสว่างยังได้ 3-5 ซึ่งเป็นภาพจริง ห้ามนับเป็นภาพว่าง (จะพาเครื่องดีไปใช้ทางสำรองโดยไม่จำเป็น) */
export const BLANK_RANGE = 2
/** ภาพว่าง / ภาพค้าง / ตัวถอดรหัส error "ติดกัน" กี่รอบถึงถอยทาง (~2-3 วินาที) */
export const BAD_STREAK = 12

/** ทางดึงภาพจากกล้อง: canvas (drawImage+getImageData) → luma (VideoFrame.copyTo อ่านช่องความสว่างตรง ๆ ไม่ผ่าน GPU canvas) */
export type FramePath = 'canvas' | 'luma'

export type ScanFault = 'blank' | 'frozen' | 'error'

/**
 * ตัดสินใจหลังแต่ละรอบ — คืนสิ่งที่ต้องเปลี่ยน (ถ้ามี) และตัวนับใหม่
 *  - ภาพว่าง/ภาพค้างติดกัน BAD_STREAK รอบ → เปลี่ยนทางดึงภาพ (ถ้ายังมี)
 *  - error ติดกัน BAD_STREAK รอบ → เปลี่ยนตัวถอดรหัส (ถ้ายังมี)
 *  - หมดทางแล้ว → 'exhausted' (ผู้เรียกแสดงปุ่มถ่ายรูป แต่ยังสแกนต่อ — ภาพว่างอาจแค่เล็งไปที่ผนังเรียบ ๆ)
 */
export function nextScanStep(
  streak: { fault: ScanFault | null; n: number },
  fault: ScanFault | null,
  can: { path: boolean; decoder: boolean },
): { streak: { fault: ScanFault | null; n: number }; action: 'none' | 'switch-path' | 'switch-decoder' | 'exhausted' } {
  if (!fault) return { streak: { fault: null, n: 0 }, action: 'none' }
  // ภาพว่างกับภาพค้างนับรวมกัน (ทั้งคู่แก้ด้วยการเปลี่ยนทางดึงภาพ) · error นับแยก
  const sameKind = streak.fault != null && (streak.fault === 'error') === (fault === 'error')
  const n = sameKind ? streak.n + 1 : 1
  if (n < BAD_STREAK) return { streak: { fault, n }, action: 'none' }
  const reset = { fault: null, n: 0 }
  // แก้ให้ตรงอาการ: ภาพเสีย → เปลี่ยนทางดึงภาพ · ตัวถอดรหัสพัง → เปลี่ยนตัวถอดรหัส (สลับกันไม่ช่วย)
  if (fault === 'error') return { streak: reset, action: can.decoder ? 'switch-decoder' : 'exhausted' }
  return { streak: reset, action: can.path ? 'switch-path' : 'exhausted' }
}

/**
 * ทางดึงภาพสำรอง: อ่าน "ช่องความสว่าง" ของเฟรมกล้องตรง ๆ ด้วย VideoFrame.copyTo แล้วทำเป็นภาพเทา
 * ไม่ผ่าน canvas/GPU เลย (บาร์โค้ดใช้แค่ความสว่างอยู่แล้ว) · ปิดเฟรมทันทีที่คัดลอกเสร็จ — ไม่ยืม
 * บัฟเฟอร์กล้องค้างแบบทาง videoframe ที่ปิดไป (#566)
 * คืน null เมื่อเครื่องไม่รองรับ / รูปแบบพิกเซลไม่รู้จัก
 */
export async function grabLuma(
  video: HTMLVideoElement,
  crop: { sx: number; sy: number; cw: number; ch: number },
  outW: number, outH: number,
): Promise<ImageData | null> {
  if (typeof VideoFrame === 'undefined') return null
  const frame = new VideoFrame(video)
  try {
    const fmt = frame.format ?? ''
    const yuv = /^(I4|NV)/.test(fmt)
    const rgb = /^(RGB|BGR)/.test(fmt)
    if (!yuv && !rgb) return null
    // YUV ต้องเริ่มที่พิกัดคู่ (ช่องสีย่อยครึ่งหนึ่ง)
    const rect = { x: crop.sx & ~1, y: crop.sy & ~1, width: Math.max(2, crop.cw & ~1), height: Math.max(2, crop.ch & ~1) }
    const buf = new Uint8Array(frame.allocationSize({ rect }))
    const layout = await frame.copyTo(buf, { rect })
    frame.close()
    const { offset, stride } = layout[0]
    const out = new ImageData(outW, outH)
    const d = out.data
    const bgr = fmt.startsWith('BGR')
    for (let y = 0; y < outH; y++) {
      const ry = Math.min(rect.height - 1, Math.floor((y * rect.height) / outH))
      for (let x = 0; x < outW; x++) {
        const rx = Math.min(rect.width - 1, Math.floor((x * rect.width) / outW))
        let l: number
        if (yuv) l = buf[offset + ry * stride + rx]
        else {
          const i = offset + ry * stride + rx * 4
          const r = buf[i + (bgr ? 2 : 0)], g = buf[i + 1], b = buf[i + (bgr ? 0 : 2)]
          l = (r + 2 * g + b) >> 2
        }
        const o = (y * outW + x) << 2
        d[o] = d[o + 1] = d[o + 2] = l; d[o + 3] = 255
      }
    }
    return out
  } finally {
    try { frame.close() } catch { /* ปิดแล้ว */ }
  }
}
