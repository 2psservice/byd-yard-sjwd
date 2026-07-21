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

export type SyncEvent = 'blocks' | 'ops' | 'trailers' | 'viewdefault'
type Handler = (payload: any) => void

let channel: RealtimeChannel | null = null
const handlers = new Map<SyncEvent, Handler[]>()
const EVENTS: SyncEvent[] = ['blocks', 'ops', 'trailers', 'viewdefault']

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
  channel?.unsubscribe()
  channel = null
}

/** Tell every other open client that something changed (they refetch). */
export function sendSync(event: SyncEvent, payload: object = {}): void {
  channel?.send({ type: 'broadcast', event, payload }).catch((e: unknown) => console.error('[syncBus] send', e))
}
