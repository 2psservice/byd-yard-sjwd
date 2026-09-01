/**
 * syncBus — one shared Supabase Broadcast channel that tells every open client
 * "X changed, refetch it". Used for tables that aren't in the postgres_changes
 * publication (blocks / ops queues / trailers).
 *
 * `moves` is different: it carries the new positions themselves, not a "go
 * refetch" hint. Car positions are the one thing every screen in the yard is
 * looking at, and relying on the units table's row-level stream means a plan
 * that silently stops updating whenever that stream is unavailable — nothing in
 * the app can tell. Broadcast needs no publication membership and no DDL, so a
 * move announced this way lands on every open screen the moment it happens.
 *
 * Broadcast needs no DB DDL and no publication membership — clients just relay
 * small {event, payload} messages through the realtime server.
 */
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, isConfigured } from './supabase'

export type SyncEvent = 'blocks' | 'ops' | 'trailers' | 'viewdefault' | 'policies' | 'moves' | 'status' | 'dmg' | 'master'

/** Defect data changed for these cars — receivers refetch JUST these VINs.
 *  Exists because a photo-bearing damage row is too big for the realtime row
 *  stream (its event arrives with the body stripped, so the receiver cannot
 *  even tell WHICH car changed) — the writer, who knows the VIN, announces it
 *  here instead. Only sent for photo-bearing writes: a photo-less damage rides
 *  the row stream intact, and announcing it too would just add requests. */
export interface DmgPayload { vins: string[] }

/** One car's new spot, as broadcast to every other open client. */
export interface MoveMsg { vin: string; block?: string; row?: number; slot?: number; status?: string; at: number }
export interface MovesPayload { siteId: string | null; moves: MoveMsg[] }

/**
 * One car's changed data, as broadcast to every other open client — the same
 * second path `moves` gives positions, for the cells every screen counts
 * (Car Status above all). Carries the row's full `cells` so the receiver ends
 * up byte-identical to the sender rather than half-merged; `history` is left
 * out because it is the bulky part and the row-level stream / reconcile carry
 * it. `at` is the sender's updatedAt, so newer-wins works on the far side.
 */
export interface RowMsg { vin: string; cells: Record<string, string>; at: number }
export interface RowsPayload { rows: RowMsg[] }
type Handler = (payload: any) => void

let channel: RealtimeChannel | null = null
const handlers = new Map<SyncEvent, Handler[]>()
const EVENTS: SyncEvent[] = ['blocks', 'ops', 'trailers', 'viewdefault', 'policies', 'moves', 'status', 'dmg', 'master']

/** Register a listener (module-scope, survives channel restarts). */
export function onSync(event: SyncEvent, h: Handler): void {
  const list = handlers.get(event) ?? []
  list.push(h)
  handlers.set(event, list)
}

export function startSyncBus(): void {
  if (!isConfigured() || channel) return
  channel = supabase.channel('sync_bus', { config: { broadcast: { self: false } } })
  for (const evt of EVENTS) {
    channel.on('broadcast', { event: evt }, ({ payload }) => {
      for (const h of handlers.get(evt) ?? []) {
        try { h(payload) } catch (e) { console.error(`[syncBus] ${evt} handler`, e) }
      }
    })
  }
  channel.subscribe()
}

/** Dev/test only: play the part of an incoming broadcast from another device,
 *  so a test can check that this client reacts without needing a real socket. */
export function __deliverForTest(event: SyncEvent, payload: unknown): void {
  if (!import.meta.env.DEV) return
  for (const h of handlers.get(event) ?? []) {
    try { h(payload) } catch (e) { console.error(`[syncBus] ${event} handler`, e) }
  }
}
// reachable from automated tests, which drive the app through the window only
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __syncDeliver?: typeof __deliverForTest }).__syncDeliver = __deliverForTest
}

export function stopSyncBus(): void {
  if (channel) supabase.removeChannel(channel) // unsubscribe alone left the topic registered → duplicates on re-login
  channel = null
}

/** Tell every other open client that something changed (they refetch).
 *  channel.send RESOLVES with 'ok' | 'timed out' | 'error' (it doesn't reject),
 *  so check the status and retry once — a silently dropped broadcast meant
 *  other devices never refetched a layout/rule change. */
export function sendSync(event: SyncEvent, payload: object = {}): void {
  // dev-only tap so automated tests can see what this client announced
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const w = window as unknown as { __syncSent?: { event: string; payload: unknown }[] }
    ;(w.__syncSent ??= []).push({ event, payload })
  }
  const c = channel
  if (!c) return
  c.send({ type: 'broadcast', event, payload }).then((status: string) => {
    if (status === 'ok') return
    console.warn(`[syncBus] send ${event} → ${status}; retrying once`)
    setTimeout(() => { c.send({ type: 'broadcast', event, payload }).catch(() => {}) }, 1000)
  }).catch((e: unknown) => console.error('[syncBus] send', e))
}
