// Shared photo-capture helpers: downscale + compress a File to a JPEG data-URL,
// then push it to R2 (short URL) via photoStore. Kept in lib/ so both the
// Yard-Ops forms and the PDI checklist can reuse them without a circular import.
import { storePhoto } from './photoStore'

/** Read an image File, downscale to maxW, and return a compressed JPEG dataURL. */
export function compressToDataUrl(file: File, maxW = 900): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width)
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.7))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

/** Compress, then push to R2 — every photo-capture path funnels through here.
 *  Returns the short R2 URL, or the data-URL itself when upload isn't possible. */
export async function compressImage(file: File, maxW = 900): Promise<string> {
  return storePhoto(await compressToDataUrl(file, maxW))
}
