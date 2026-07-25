import { Component, type ReactNode } from 'react'

/**
 * Global error boundary — without it, any render error unmounted the whole
 * tree to a blank #root, and because the current view is persisted the app
 * reopened straight into the same broken page: a permanent white screen with
 * no in-app recovery. This catches the error and offers a safe reset.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error)
  }

  private reset = () => {
    // send the persisted view back to the dashboard so the reload doesn't
    // reopen the page that crashed, then reload fresh
    try {
      const raw = localStorage.getItem('byd-yard-control')
      if (raw) {
        const data = JSON.parse(raw)
        if (data?.state) { data.state.view = 'dashboard'; localStorage.setItem('byd-yard-control', JSON.stringify(data)) }
      }
    } catch { /* best effort */ }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f1f5f9', fontFamily: 'inherit' }}>
        <div style={{ maxWidth: 420, width: '100%', background: '#fff', borderRadius: 20, padding: 28, textAlign: 'center', boxShadow: '0 8px 32px -8px rgba(0,0,0,0.15)' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6, color: '#0f172a' }}>เกิดข้อผิดพลาดในหน้านี้</div>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 4 }}>ข้อมูลของคุณยังอยู่ครบ — กดปุ่มด้านล่างเพื่อกลับหน้าหลัก</div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 18, wordBreak: 'break-all' }}>{String(this.state.error?.message ?? this.state.error)}</div>
          <button onClick={this.reset}
            style={{ width: '100%', padding: '12px 16px', borderRadius: 14, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
            กลับหน้าหลัก
          </button>
        </div>
      </div>
    )
  }
}
