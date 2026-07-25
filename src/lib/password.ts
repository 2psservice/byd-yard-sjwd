// ── password hashing (client-side, SHA-256 + per-user salt) ──────────────────
// Passwords were stored and synced as PLAINTEXT — readable from localStorage on
// every device and from the app_users table with the (public) anon key. Hashing
// stops the roster from disclosing everyone's real passwords (which people
// reuse elsewhere). NOTE: this is hardening, not full auth — true security
// needs server-side auth (Supabase Auth + RLS); see the audit report.

const PREFIX = 'sha256$'

export const isHashed = (v: string): boolean => v.startsWith(PREFIX)

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')

/** Hash a password → "sha256$<salt>$<hex>". Same salt in → deterministic out. */
export async function hashPassword(pw: string, salt?: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return pw // non-secure context (plain-http dev) — keep legacy behavior
  const s = salt ?? toHex(crypto.getRandomValues(new Uint8Array(8)).buffer)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${s}:${pw}`))
  return `${PREFIX}${s}$${toHex(digest)}`
}

/** Verify an entered password against a stored value (hashed OR legacy plaintext). */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (!isHashed(stored)) return stored === pw // legacy plaintext row — login() upgrades it after success
  const salt = stored.slice(PREFIX.length).split('$')[0]
  return (await hashPassword(pw, salt)) === stored
}
