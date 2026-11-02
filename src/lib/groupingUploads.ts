/**
 * ประวัติอัปโหลดไฟล์ Excel Grouping: ใครอัปโหลด · ชื่อไฟล์ · วันที่เวลา (หน้า Grouping ปุ่ม "ประวัติอัปโหลด")
 * 1 แถวต่ออัปโหลดใน app_config "grouping_upload:<ยาร์ด>:<เวลา ms>" — ทุกเครื่องเห็นเหมือนกัน
 * เก็บสำเนาในเครื่องด้วย (ยังไม่ขึ้นคลาวด์ / ออฟไลน์ ก็ยังเห็นของเครื่องนี้)
 */
import * as db from './db'

export interface GroupingUpload {
  at: number
  by: string
  file: string
  site: string
  sheet: string
  units: number
  groups: number
  /** กลุ่มที่ใช้ Lane load เดิมที่แก้ไว้ */
  keptLanes: number
  title: string
}

const LOCAL_KEY = 'sjwd-grouping-uploads'
const LOCAL_MAX = 50
const prefixOf = (site: string) => `grouping_upload:${site}:`

function readLocal(): GroupingUpload[] {
  try { const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** จดการอัปโหลด — คลาวด์ไม่ได้ก็ยังจดในเครื่อง ไม่ทำให้การนำเข้าล้ม */
export async function recordGroupingUpload(u: GroupingUpload): Promise<void> {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify([u, ...readLocal()].slice(0, LOCAL_MAX))) } catch { /* storage full / private mode */ }
  try { if (db.isConfigured()) await db.saveAppConfig(`${prefixOf(u.site)}${u.at}`, u) } catch (e) { console.error('[grouping] upload history', e) }
}

const merge = (...lists: GroupingUpload[][]): GroupingUpload[] => {
  const byKey = new Map<string, GroupingUpload>()
  for (const l of lists) for (const u of l) byKey.set(`${u.at}|${u.file}`, u)
  return [...byKey.values()].sort((a, b) => b.at - a.at)
}

/** ของเครื่องนี้ (ไม่ต้องรอเน็ต) — หน้าต่างประวัติโชว์อันนี้ก่อน */
export const localGroupingUploads = (site: string): GroupingUpload[] => merge(readLocal().filter((x) => x.site === site))

const CLOUD_WAIT_MS = 8000

/** ประวัติของยาร์ดนี้ ใหม่สุดก่อน: ของคลาวด์ + ของเครื่องนี้ที่ยังไม่ขึ้น · เน็ตช้าเกิน 8 วิ ได้ของเครื่องนี้ไปก่อน */
export async function loadGroupingUploads(site: string): Promise<GroupingUpload[]> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), CLOUD_WAIT_MS))
  const rows = await Promise.race([db.fetchAppConfigPrefix<GroupingUpload>(prefixOf(site)).catch(() => null), timeout])
  return merge(rows?.map((r) => r.value).filter(Boolean) ?? [], localGroupingUploads(site))
}
