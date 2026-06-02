// Engine boots immediately so the cinematic design is always visible.
// Auth + Supabase sync work in the background / as an overlay.
import './engine/image-slot.js'
import './engine/engine.js'

import { supabase } from './data/supabase'
import { pull, queuePush } from './sync/store-sync'
import { showAuthGate, hideAuthGate } from './features/auth'
import { initLecturesPlanner } from './features/lectures-planner'

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
      // No session — show auth gate as overlay over the running cinematic page
      showAuthGate()
    }
  })
}

async function syncWithSupabase(userId: string): Promise<void> {
  // Pull Supabase data into localStorage
  await pull(userId)

  // Merge pulled data into the engine's already-running in-memory store
  const store = window.MISSION?.store
  if (store) {
    const merged = JSON.parse(localStorage.getItem('mission2028') || '{}') as Record<string, unknown>
    Object.assign(store.data, merged)

    // Patch store.set for write-through on every future write
    if (!(store as { _patched?: boolean })._patched) {
      const orig = store.set.bind(store)
      store.set = (k: string, v: unknown) => { orig(k, v); queuePush(k, v) }
      ;(store as { _patched?: boolean })._patched = true
    }
  }

  // Replace engine's hardcoded PLAN[] with real lectures from Supabase
  await initLecturesPlanner()
}

init()
