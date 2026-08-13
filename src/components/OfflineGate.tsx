/**
 * ONLINE 100% — no-connection gate.
 * With the local cache off, the device has nothing of its own to fall back on,
 * so losing the network must show THIS instead of stale numbers that would
 * disagree with every other screen. It lifts by itself when the link returns.
 */
import { useEffect, useState } from 'react'
import { CloudOff, RefreshCw } from 'lucide-react'
import { isOnlineOnly } from '../lib/onlineMode'

export function OfflineGate() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)

  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  if (!offline || !isOnlineOnly()) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,23,42,0.72)', backdropFilter: 'blur(3px)' }}>
      <div className="panel max-w-md w-full text-center p-7">
        <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center"
          style={{ background: 'rgba(234,179,8,0.14)', color: '#a16207' }}>
          <CloudOff size={26} />
        </div>
        <div className="mt-4 text-[17px] font-bold">ไม่มีการเชื่อมต่ออินเทอร์เน็ต</div>
        <div className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          ระบบตั้งค่าเป็น <b>โหมดออนไลน์ 100%</b> — ทุกเครื่องแสดงข้อมูลจากคลาวด์โดยตรง
          จึงไม่แสดงข้อมูลเก่าที่ค้างในเครื่อง (ซึ่งจะทำให้ยอดไม่ตรงกัน)
          <br />กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่อีกครั้ง
        </div>
        <button className="btn btn-primary px-4 py-2 mt-5 mx-auto" onClick={() => window.location.reload()}>
          <RefreshCw size={15} /> ลองใหม่
        </button>
        <div className="mt-3 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          ลานที่สัญญาณไม่เสถียร: ปิดโหมดนี้ได้ที่ ตั้งค่า → โหมดข้อมูล
        </div>
      </div>
    </div>
  )
}
