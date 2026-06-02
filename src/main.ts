// Engine and UI shells boot immediately — auth + data sync happen in background.
import './engine/image-slot.js'
import './engine/engine.js'

import { supabase } from './data/supabase'
import { pull, queuePush } from './sync/store-sync'
import { showAuthGate, hideAuthGate } from './features/auth'
import { hasPIN, showPINEntry, hidePINEntry, showPINSetup } from './features/pin-auth'
import { mountPlannerUI, loadLectures } from './features/lectures-planner'
import { mountRoutineSection, initRoutine } from './features/routine-ui'

// UI shells mount synchronously — data loads after auth.
mountPlannerUI()
mountRoutineSection()

async function init(): Promise<void> {
  let synced = false

  supabase.auth.onAuthStateChange(async (evt, sess) => {
    if (synced) return

    if (sess) {
      if (hasPIN() && evt !== 'SIGNED_IN') {
        // Returning visitor with PIN set — show PIN entry instead of auto-login
        showPINEntry(
          async () => {
            // PIN verified → proceed
            synced = true
            hidePINEntry()
            await syncWithSupabase(sess.user.id)
          },
          () => {
            // Forgot PIN → reset and send magic link
            hidePINEntry()
            showAuthGate()
          },
        )
      } else if (evt === 'SIGNED_IN' && !hasPIN()) {
        // Fresh magic-link login, no PIN yet → prompt to set one
        showPINSetup(async () => {
          synced = true
          hideAuthGate()
          await syncWithSupabase(sess.user.id)
        })
      } else {
        // Session exists, PIN already set (SIGNED_IN after forgot-PIN flow),
        // or user skipped PIN setup — proceed directly.
        synced = true
        hideAuthGate()
        if (window.location.hash.includes('access_token')) {
          history.replaceState(null, '', window.location.pathname)
        }
        await syncWithSupabase(sess.user.id)
      }
    } else if (!sess) {
      // No session — show magic-link gate (catches INITIAL_SESSION, SIGNED_OUT, etc.)
      showAuthGate()
    }
  })
}

async function syncWithSupabase(userId: string): Promise<void> {
  if (window.location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname)
  }
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
