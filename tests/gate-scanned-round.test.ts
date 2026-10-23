import { describe, expect, it } from 'vitest'
import { gateScannedThisRound } from '../src/lib/carStatus'

/** "ยิงเข้าลานรอบนี้แล้วหรือยัง" — ชีตบอก Pre Gate-in ต้องชนะวันที่ Gate In ที่ค้าง/มาจากไฟล์
 *  (3D THUNGKRAT: ประตูขึ้น "รถเข้าลานแล้ว" ไม่มีปุ่ม Confirm · Walk Around ไม่มีการ์ดรถ/ตรวจของประจำรถ) */
describe('gateScannedThisRound', () => {
  it('Pre Gate-in + วันที่ Gate In จากไฟล์/ยาร์ดเดิม → ยังไม่ได้ยิงเข้า (ไปการ์ดรับรถ)', () => {
    expect(gateScannedThisRound({ 'Car Status': 'Pre Gate-in', 'Gate In (Rayong yard)': '05/10/2026' })).toBe(false)
  })
  it('Pre Gate-in + รอยยิงประตู → ยังไม่ได้ยิงเข้า (ชีตบอกว่ารถรออยู่หน้าประตู)', () => {
    expect(gateScannedThisRound({ 'Car Status': 'Pre Gate-in', 'Gate In Time': String(Date.now()) })).toBe(false)
    expect(gateScannedThisRound({ 'Car Status': ' pre gate-in ', 'Gate In Time': '1792570000000' })).toBe(false)
    expect(gateScannedThisRound({ 'Car Status': 'EXPECTED', 'Gate In (Rayong yard)': '05/10/2026' })).toBe(false)
  })
  it('In Yard + รอยยิงประตู → ยิงเข้าแล้ว (เหมือนเดิม)', () => {
    expect(gateScannedThisRound({ 'Car Status': 'In Yard', 'Gate In Time': '1792570000000' })).toBe(true)
  })
  it('In Yard + มีแค่คอลัมน์ Gate In (รอยยิงหลุด) → ยิงเข้าแล้ว (ทางสำรองเดิมยังใช้ได้)', () => {
    expect(gateScannedThisRound({ 'Car Status': 'In Yard', 'Gate In (Rayong yard)': '05/10/2026' })).toBe(true)
  })
  it('สถานะว่าง + มีวันที่ Gate In → ยิงเข้าแล้ว (เหมือนเดิม)', () => {
    expect(gateScannedThisRound({ 'Gate In (Rayong yard)': '05/10/2026' })).toBe(true)
  })
  it('ไม่มีหลักฐานการยิงเลย → ยังไม่ได้ยิงเข้า', () => {
    expect(gateScannedThisRound({ 'Car Status': 'In Yard' })).toBe(false)
    expect(gateScannedThisRound(undefined)).toBe(false)
  })
  it('รถ Gate-out ไปแล้ว → ไม่นับว่าอยู่ในลาน (เหมือนเดิม)', () => {
    expect(gateScannedThisRound({ 'Car Status': 'Gate-out', 'Gate In Time': '1792570000000' })).toBe(false)
  })
})
