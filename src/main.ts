import { supabase } from './data/supabase'
import { pull, queuePush } from './sync/store-sync'
import { showAuthGate, hideAuthGate } from './features/auth'

async function init(): Promise<void> {
  let booted = false

  // onAuthStateChange is the single source of truth for both:
  //   • existing sessions (INITIAL_SESSION fires immediately)
  //   • magic-link callbacks (SIGNED_IN fires after Supabase processes URL hash)
  supabase.auth.onAuthStateChange(async (evt, sess) => {
    if (booted) return

    if (sess) {
      booted = true
      hideAuthGate()
      // Clean the access_token from the URL after magic-link landing
      if (window.location.hash.includes('access_token')) {
        history.replaceState(null, '', window.location.pathname)
      }
      await bootEngine(sess.user.id)
    } else if (evt === 'INITIAL_SESSION') {
      // Confirmed: no existing session → show login
      showAuthGate()
    }
  })
}

async function bootEngine(userId: string): Promise<void> {
  // 1. Hydrate localStorage from Supabase BEFORE engine.js reads it
  await pull(userId)

  // 2. Boot engine (reads the now-hydrated localStorage on init)
  await import('./engine/image-slot.js')
  await import('./engine/engine.js')

  // 3. Patch store.set so every future write also queues a Supabase upsert
  const store = window.MISSION?.store
  if (store) {
    const orig = store.set.bind(store)
    store.set = (k: string, v: unknown) => {
      orig(k, v)
      queuePush(k, v)
    }
  }
}

init()
