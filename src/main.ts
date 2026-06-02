// Engine and UI shell boot immediately — auth + data sync happen in background.
import './engine/image-slot.js'
import './engine/engine.js'

import { supabase } from './data/supabase'
import { pull, queuePush } from './sync/store-sync'
import { showAuthGate, hideAuthGate } from './features/auth'
import { mountPlannerUI, loadLectures } from './features/lectures-planner'
import { initRoutine } from './features/routine-ui'

// Mount the planner toolbar (filter tabs + Import Excel + Add) immediately.
// This is synchronous and needs no auth — lectures load separately after login.
mountPlannerUI()

async function init(): Promise<void> {
  let synced = false

  supabase.auth.onAuthStateChange(async (evt, sess) => {
    if (synced) return

    if (sess) {
      synced = true
      hideAuthGate()
      if (window.location.hash.includes('access_token')) {
        history.replaceState(null, '', window.location.pathname)
      }
      await syncWithSupabase(sess.user.id)
    } else if (evt === 'INITIAL_SESSION') {
      showAuthGate()
    }
  })
}

async function syncWithSupabase(userId: string): Promise<void> {
  try {
    await pull(userId)

    // Merge pulled data into the engine's already-running in-memory store
    const store = window.MISSION?.store
    if (store) {
      const merged = JSON.parse(localStorage.getItem('mission2028') || '{}') as Record<string, unknown>
      Object.assign(store.data, merged)

      if (!(store as { _patched?: boolean })._patched) {
        const orig = store.set.bind(store)
        store.set = (k: string, v: unknown) => { orig(k, v); queuePush(k, v) }
        ;(store as { _patched?: boolean })._patched = true
      }
    }

    // Load real lectures into the already-mounted planner UI
    await loadLectures()
    // Routine tracker: auto-creates today's row, feeds rankSim/heatmap/donuts/barCharts
    await initRoutine()
  } catch (err) {
    console.error('[main] syncWithSupabase failed:', err)
    // Still try to load lectures even if pull/store patch failed
    await loadLectures().catch(e => console.error('[main] loadLectures failed:', e))
    await initRoutine().catch(e => console.error('[main] initRoutine failed:', e))
  }
}

init()
