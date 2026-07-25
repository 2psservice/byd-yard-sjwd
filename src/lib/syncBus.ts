/**
 * syncBus — one shared Supabase Broadcast channel that tells every open client
 * "X changed, refetch it". Used for tables that aren't in the postgres_changes
 * publication (blocks / ops queues / trailers); units, damages, sites and
 * tracking_rows already stream row-level changes directly.
 *
 * Broadcast needs no DB DDL and no publication membership — clients just relay
 * small {event, payload} messages through the realtime server.
 */
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, isConfigured } from './supabase'

export type SyncEvent = 'blocks' | 'ops' | 'trailers' | 'viewdefault' | 'policies'
type Handler = (payload: any) => void

let channel: RealtimeChannel | null = null
const handlers = new Map<SyncEvent, Handler[]>()
const EVENTS: SyncEvent[] = ['blocks', 'ops', 'trailers', 'viewdefault', 'policies']

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

export function stopSyncBus(): void {
  if (channel) supabase.removeChannel(channel) // unsubscribe alone left the topic registered → duplicates on re-login
  channel = null
}

/** Tell every other open client that something changed (they refetch).
 *  channel.send RESOLVES with 'ok' | 'timed out' | 'error' (it doesn't reject),
 *  so check the status and retry once — a silently dropped broadcast meant
 *  other devices never refetched a layout/rule change. */
export function sendSync(event: SyncEvent, payload: object = {}): void {
  const c = channel
  if (!c) return
  c.send({ type: 'broadcast', event, payload }).then((status: string) => {
    if (status === 'ok') return
    console.warn(`[syncBus] send ${event} → ${status}; retrying once`)
    setTimeout(() => { c.send({ type: 'broadcast', event, payload }).catch(() => {}) }, 1000)
  }).catch((e: unknown) => console.error('[syncBus] send', e))
}
