// Engine and UI shells boot immediately — auth + data sync happen in background.
import './engine/image-slot.js'
import './engine/engine.js'

import { type Session } from '@supabase/supabase-js'
import { supabase } from './data/supabase'
import { pull, queuePush } from './sync/store-sync'
import { showAuthGate, hideAuthGate } from './features/auth'
import { hasPIN, showPINEntry, hidePINEntry, showPINSetup, clearPIN } from './features/pin-auth'
import { mountPlannerUI, loadLectures } from './features/lectures-planner'
import { mountRoutineSection, initRoutine } from './features/routine-ui'

// UI shells mount synchronously — data loads after auth.
mountPlannerUI()
mountRoutineSection()

async function init(): Promise<void> {
  let handled = false   // true once we've started booting for a valid session

  // ── handle a valid session ──────────────────────────────────────────────────
  function handleSession(sess: Session, isFreshLogin: boolean): void {
    if (handled) return
    handled = true

    if (isFreshLogin && !hasPIN()) {
      // First magic-link login — offer PIN setup
      showPINSetup(() => boot(sess.user.id))
    } else if (hasPIN() && !isFreshLogin) {
      // Returning visitor with PIN set — show PIN entry
      showPINEntry(
        () => boot(sess.user.id),       // PIN correct
        () => { clearPIN(); showAuthGate() }, // forgot PIN → magic link
      )
    } else {
      // No PIN (skipped setup) or already booting after PIN verified
      boot(sess.user.id)
    }
  }

  // ── no session ─────────────────────────────────────────────────────────────
  function requireLogin(): void {
    handled = false
    hideAuthGate()      // in case it was already shown
    hidePINEntry()
    showAuthGate()
  }

  // ── 1. Subscribe to auth state changes ─────────────────────────────────────
  supabase.auth.onAuthStateChange((evt, sess) => {
    if (sess) {
      handleSession(sess, evt === 'SIGNED_IN')
    } else {
      requireLogin()
    }
  })

  // ── 2. Also check immediately via getSession() ──────────────────────────────
  // onAuthStateChange can be slow on some networks; getSession() reads from
  // localStorage instantly and is the reliable fallback.
  const { data: { session } } = await supabase.auth.getSession()
  if (session) {
    handleSession(session, false)
  } else if (!handled) {
    requireLogin()
  }
}

// ── boot engine after auth ──────────────────────────────────────────────────

function boot(userId: string): void {
  hideAuthGate()
  hidePINEntry()
  if (window.location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname)
  }
  syncWithSupabase(userId).catch(err => console.error('[main] boot failed:', err))
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
