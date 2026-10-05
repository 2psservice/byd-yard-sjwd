import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { IN_APP_BROWSER, IS_LINE_BROWSER, IS_ANDROID, openExternal, openChromeIntent, copyLink } from '../lib/inAppBrowser'

const DISMISS_KEY = 'inapp-banner-dismissed'
const readDismissed = () => { try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false } }

/** แถบเตือนบนสุด เมื่อเปิดเว็บในเบราว์เซอร์ในตัวของ LINE/โซเชียล (สแกนกล้องไม่ได้) —
 *  เปิดใน Chrome / Chrome / คัดลอกลิงก์ ได้จากแถบนี้เลย ไม่ต้องรอกดกล้องแล้วเจอ error */
export function InAppBrowserBanner() {
  const [hidden, setHidden] = useState(readDismissed)
  const [copied, setCopied] = useState(false)
  if (!IN_APP_BROWSER || hidden) return null

  const dismiss = () => { try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ } setHidden(true) }
  const onCopy = async () => { if (await copyLink()) { setCopied(true); setTimeout(() => setCopied(false), 2500) } }

  return (
    <div data-testid="inapp-banner" role="alert" className="shrink-0 flex items-center gap-2 px-3 py-2"
      style={{ background: '#fef3c7', color: '#78350f', borderBottom: '1px solid #fcd34d' }}>
      <AlertTriangle size={18} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-bold leading-tight">เปิดอยู่ในเบราว์เซอร์ของแอป — สแกนกล้องไม่ได้</div>
        <div className="flex gap-2 mt-1.5">
          {IS_LINE_BROWSER && (
            <button onClick={openExternal} className="px-3 py-1.5 rounded-lg text-[12.5px] font-bold text-white" style={{ background: '#16a34a' }}>
              เปิดใน Chrome
            </button>
          )}
          {IS_ANDROID && (
            <button data-testid="open-intent" onClick={openChromeIntent} className="px-3 py-1.5 rounded-lg text-[12.5px] font-bold text-white" style={{ background: '#2563eb' }}>
              Chrome (intent)
            </button>
          )}
          <button onClick={() => void onCopy()} className="px-3 py-1.5 rounded-lg text-[12.5px] font-bold" style={{ background: 'rgba(120,53,15,0.12)' }}>
            {copied ? 'คัดลอกแล้ว ✓' : 'คัดลอกลิงก์'}
          </button>
        </div>
      </div>
      <button onClick={dismiss} aria-label="ปิด" className="p-2 shrink-0"><X size={18} /></button>
    </div>
  )
}
