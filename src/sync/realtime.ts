import { supabase } from '../data/supabase'
import { pullAgain } from './store-sync'

/**
 * Set up Supabase Realtime subscriptions for all tables not covered by
 * lectures-planner.ts (which already handles lectures, routine_days, study_sessions).
 *
 * All table changes dispatch `app:sync-needed` so core-engine's recompute()
 * re-fetches the affected data.  app_state changes additionally call pullAgain()
 * to merge the remote KV values into the in-memory store before recomputing.
 */
export function initRealtimeSync(): void {
  // Tables whose changes feed into recompute() via repositories
  const tables = [
    'scores',
    'revisions',
    'answer_practice',
    'current_affairs',
    'mistakes',
    'notes',
  ]

  tables.forEach(table => {
    function subscribe(): void {
      supabase
        .channel(`${table}-rt-${Date.now()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table }, () => {
          window.dispatchEvent(new CustomEvent('app:sync-needed'))
        })
        .subscribe(status => {
          if (status === 'CHANNEL_ERROR') setTimeout(subscribe, 5_000)
        })
    }
    subscribe()
  })

  // app_state (KV store) — pull the remote values first, then recompute
  ;(function subscribeAppState(): void {
    supabase
      .channel(`app_state-rt-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state' }, async () => {
        await pullAgain().catch(() => {})
        const mission = (window as { MISSION?: { store: { data: Record<string, unknown> } } }).MISSION
        if (mission?.store) {
          const remote = JSON.parse(localStorage.getItem('mission2028') || '{}') as Record<string, unknown>
          Object.assign(mission.store.data, remote)
        }
        window.dispatchEvent(new CustomEvent('app:sync-needed'))
      })
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR') setTimeout(subscribeAppState, 5_000)
      })
  })()
}
