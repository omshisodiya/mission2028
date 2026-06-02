// Engine and UI shells boot immediately — auth + data sync happen in background.
import './engine/image-slot.js'
import './engine/engine.js'

import { supabase } from './data/supabase'
import { pull, queuePush } from './sync/store-sync'
import { showAuthGate, hideAuthGate } from './features/auth'
import { mountPlannerUI, loadLectures } from './features/lectures-planner'
import { mountRoutineSection, initRoutine } from './features/routine-ui'

// Both UI shells mount synchronously so the section structure is always visible.
// Data loads separately after auth completes.
mountPlannerUI()
mountRoutineSection()

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
    } else if (!sess) {
      // Show gate for INITIAL_SESSION, SIGNED_OUT, TOKEN_REFRESHED failures —
      // any state where there is no valid session.
      showAuthGate()
    }
  })
}

async function syncWithSupabase(userId: string): Promise<void> {
  try {
    await pull(userId)

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

    await loadLectures()
    await initRoutine()
  } catch (err) {
    console.error('[main] syncWithSupabase failed:', err)
    await loadLectures().catch(e => console.error('[main] loadLectures failed:', e))
    await initRoutine().catch(e => console.error('[main] initRoutine failed:', e))
  }
}

init()
