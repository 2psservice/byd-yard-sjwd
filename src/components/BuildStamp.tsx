/**
 * เลข build ของแอปที่เครื่องนี้กำลังรัน (เวลาไทย · รหัส commit) — ไว้เช็กรายเครื่องว่าอัปเดตเป็นเวอร์ชันล่าสุดแล้วหรือยัง
 * เดิมเห็นได้แค่ในแถบ "มีเวอร์ชันใหม่" กับหน้า Import (แอดมิน) มือถือหน้างานเช็กไม่ได้ พนักงานถ่ายหน้าจอส่งมาได้เลย
 */
export function BuildStamp({ className = '' }: { className?: string }) {
  return (
    <div data-testid="build-stamp" className={`text-[11px] font-mono select-all break-words ${className}`} style={{ color: 'var(--faint)' }}>
      build {__BUILD__}
    </div>
  )
}
