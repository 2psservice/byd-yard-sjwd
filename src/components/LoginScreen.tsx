import { useState } from 'react'
import { Eye, EyeOff, AlertCircle } from 'lucide-react'
import { useYard } from '../store/useYard'
import { LogoLoaderOverlay } from './LogoLoader'

const BRAND = '#1B4FA8'
const BRAND2 = '#E85D1E'

export function LoginScreen() {
  const login = useYard((s) => s.login)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [remember, setRemember] = useState(false)
  const [err, setErr]           = useState('')
  const [loading, setLoading]   = useState(false)

  const doLogin = () => {
    if (!username.trim()) { setErr('กรุณาใส่ชื่อผู้ใช้'); return }
    setLoading(true)
    setTimeout(() => {
      const ok = login(username.trim(), password)
      if (!ok) { setLoading(false); setErr('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง') }
      // on success: keep the loader up — App takes over with the same brand overlay
    }, 700)
  }

  // branded fill loader while signing in
  if (loading) return <LogoLoaderOverlay label="กำลังเข้าสู่ระบบ" />

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(160deg, #f0f4fb 0%, #e6ecf7 60%, #dce5f3 100%)',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      overflow: 'hidden',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>

      {/* ── Faint car watermark (background) ── */}
      <img
        src="/side.png"
        alt=""
        aria-hidden
        style={{
          position: 'absolute', bottom: -30, right: -70,
          width: 'min(72vw, 940px)', height: 'auto',
          opacity: 0.12, pointerEvents: 'none', zIndex: 0,
          filter: 'grayscale(0.5) brightness(0.82)',
          WebkitMaskImage: 'linear-gradient(110deg, transparent 0%, #000 42%)',
          maskImage: 'linear-gradient(110deg, transparent 0%, #000 42%)',
        }}
        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
      />

      {/* ── Center panel ── */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 16px', position: 'relative', zIndex: 1 }}>
        <div style={{ width: '100%', maxWidth: 460 }}>

          {/* Logo */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
            <img
              src="/2ps-logo.png"
              alt="2PS Services Co.,Ltd"
              style={{ height: 80, objectFit: 'contain', filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.10))' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>

          {/* Welcome heading */}
          <div style={{ marginBottom: 28, textAlign: 'center' }}>
            <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.5px', margin: 0, lineHeight: 1.2, color: '#111' }}>
              Welcome To&nbsp;<span style={{ color: BRAND }}>2PS YMS</span>
            </h1>
            <p style={{ margin: '8px 0 0', fontSize: 14, color: '#555', fontWeight: 400 }}>
              Automotive Yard Management System
            </p>
          </div>

          {/* Card */}
          <div style={{
            background: '#fff',
            borderRadius: 16,
            padding: '32px 32px 28px',
            boxShadow: '0 8px 40px -8px rgba(27,79,168,0.18), 0 2px 8px rgba(0,0,0,0.06)',
          }}>

            {/* Error banner */}
            {err && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: '#fef2f2', color: '#dc2626',
                borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 20,
              }}>
                <AlertCircle size={15} style={{ flexShrink: 0 }} /> {err}
              </div>
            )}

            {/* Username */}
            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 7 }}>
                Email or Username
              </label>
              <input
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: '#EEF2FB', border: '1.5px solid transparent',
                  borderRadius: 9, padding: '11px 14px', fontSize: 14, color: '#111',
                  outline: 'none', transition: 'border-color .15s',
                }}
                placeholder="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={e => { setUsername(e.target.value); setErr('') }}
                onKeyDown={e => e.key === 'Enter' && doLogin()}
                onFocus={e => (e.target.style.borderColor = BRAND)}
                onBlur={e => (e.target.style.borderColor = 'transparent')}
              />
            </div>

            {/* Password */}
            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 7 }}>
                Password <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#EEF2FB', border: '1.5px solid transparent',
                    borderRadius: 9, padding: '11px 42px 11px 14px', fontSize: 14, color: '#111',
                    outline: 'none', transition: 'border-color .15s',
                  }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setErr('') }}
                  onKeyDown={e => e.key === 'Enter' && doLogin()}
                  onFocus={e => (e.target.style.borderColor = BRAND)}
                  onBlur={e => (e.target.style.borderColor = 'transparent')}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2,
                  }}
                >
                  {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            {/* Remember me */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#555', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={e => setRemember(e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: BRAND, cursor: 'pointer' }}
                />
                Remember me
              </label>
            </div>

            {/* Submit */}
            <button
              onClick={doLogin}
              disabled={loading}
              style={{
                width: '100%', padding: '12px 0', fontSize: 15, fontWeight: 700,
                background: loading ? '#6b8fd4' : BRAND,
                color: '#fff', border: 'none', borderRadius: 10, cursor: loading ? 'not-allowed' : 'pointer',
                letterSpacing: '0.3px', transition: 'background .15s, transform .1s',
                boxShadow: `0 4px 16px -4px ${BRAND}66`,
              }}
              onMouseEnter={e => { if (!loading) (e.currentTarget.style.background = '#163d8a') }}
              onMouseLeave={e => { if (!loading) (e.currentTarget.style.background = BRAND) }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
