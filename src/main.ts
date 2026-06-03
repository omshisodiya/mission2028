// Check screen lock FIRST — before engine, before auth, before anything.
// If locked, PIN screen appears immediately on every load/reload.
import { checkStartupLock } from './features/screen-lock'
checkStartupLock()

// ── Voice overlay + JARVIS toggle: mount before auth ─────────────────────────
// Pure CSS/canvas — no auth, no network, no data needed.
// The aurora is visible from the very first frame of the page.
import { initVAOverlay, VA } from './features/va-overlay'
initVAOverlay()

// Inject the master toggle button immediately so user can see ⬡ JARVIS toggle
// before the full JARVIS init (which waits for auth + sync).
;(function mountToggleEarly() {
  if (document.getElementById('jarvis-master-toggle')) return
  const tog = document.createElement('button')
  tog.id = 'jarvis-master-toggle'
  tog.title = 'Toggle JARVIS voice assistant on / off'
  const enabled = localStorage.getItem('jarvis_enabled') !== 'false'
  tog.className = enabled ? 'on' : ''
  if (!enabled) document.body.classList.add('va-disabled')
  tog.innerHTML = `<span class="jmt-dot"></span><span>${enabled ? 'JARVIS' : 'OFF'}</span>`
  tog.addEventListener('click', () => {
    // Delegate to full toggleJarvis() once JARVIS is initialised; otherwise just update UI
    const w = window as Window & { __jarvisToggle?: () => void }
    if (w.__jarvisToggle) { w.__jarvisToggle(); return }
    const on = !tog.classList.contains('on')
    tog.classList.toggle('on', on)
    localStorage.setItem('jarvis_enabled', String(on))
    document.body.classList.toggle('va-disabled', !on)
    const lbl = tog.querySelector<HTMLElement>('span:last-child')
    if (lbl) lbl.textContent = on ? 'JARVIS' : 'OFF'
    const dot = tog.querySelector<HTMLElement>('.jmt-dot')
    if (dot) dot.style.background = on ? 'var(--accent,#f0b54a)' : ''
    if (!on) VA.setState('idle')
  })
  document.body.appendChild(tog)
})()

// Brief splash: show aurora in 'thinking' state for 1s so user sees the design
setTimeout(() => {
  if (VA.state === 'idle' && localStorage.getItem('jarvis_enabled') !== 'false') {
    VA.setState('thinking')
    setTimeout(() => { if (VA.state === 'thinking') VA.setState('idle') }, 1800)
  }
}, 800)

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
import { loadAndBind, recompute, onSessionComplete } from './features/core-engine'
import { insertSession } from './data/repositories/sessions'
import { todayIST } from './services/core'
import { initConstitution } from './features/constitution'
import { initFocusMode } from './features/focus-mode'
import { injectExportButton } from './features/export'
import { initConfigurableTimer } from './features/timer-config'
import { initScreenLock } from './features/screen-lock'
import { initJarvis } from './features/jarvis'
// checkStartupLock already imported at the top

// UI shells mount synchronously so sections are always visible.
mountPlannerUI()
mountRoutineSection()

// Limit command menu height — engine default covers 100% of the screen.
// Inject override so it opens to at most 72vh (shows content, not full screen).
;(function injectMenuFix() {
  const s = document.createElement('style')
  s.textContent = `
    #command-menu {
      max-height: 72vh !important;
      overflow-y: auto !important;
    }
    #command-menu .cm-inner {
      padding-bottom: 24px !important;
    }
  `
  document.head.appendChild(s)
})()

// Focus Mode inits immediately (reads saved preference from store on first boot)
// — called before auth so it's active as soon as the engine runs
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initFocusMode(); initScreenLock() })
} else {
  initFocusMode(); initScreenLock()
}

// Register service worker for PWA / offline
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  let handled = false

  function handleSession(sess: Session, isFreshLogin: boolean): void {
    if (handled) return
    handled = true
    if (isFreshLogin && !hasPIN()) {
      showPINSetup(() => boot(sess.user.id))
    } else if (hasPIN() && !isFreshLogin) {
      showPINEntry(() => boot(sess.user.id), () => { clearPIN(); showAuthGate() })
    } else {
      boot(sess.user.id)
    }
  }

  function requireLogin(): void {
    handled = false
    hidePINEntry()
    hideAuthGate()
    showAuthGate()
  }

  supabase.auth.onAuthStateChange((evt, sess) => {
    if (sess) handleSession(sess, evt === 'SIGNED_IN')
    else requireLogin()
  })

  const { data: { session } } = await supabase.auth.getSession()
  if (session) handleSession(session, false)
  else if (!handled) requireLogin()
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot(userId: string): void {
  hideAuthGate()
  hidePINEntry()
  if (window.location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname)
  }
  syncAndBoot(userId).catch(err => console.error('[main] boot failed:', err))
}

async function syncAndBoot(userId: string): Promise<void> {
  // 1. Pull KV state from Supabase → hydrate engine's store
  try { await pull(userId) } catch { /* proceed from cache */ }

  const store = window.MISSION?.store
  if (store) {
    const merged = JSON.parse(localStorage.getItem('mission2028') || '{}') as Record<string, unknown>
    Object.assign(store.data, merged)

    // Patch store.set: write-through to Supabase + intercept focus-timer events
    if (!(store as { _patched?: boolean })._patched) {
      let _prevFocusMins = Number(store.data['focusMins'] ?? 0)
      const orig = store.set.bind(store)

      store.set = (k: string, v: unknown) => {
        orig(k, v)
        queuePush(k, v)

        // Focus timer completed a session → record it + update CoreState
        if (k === 'focusMins') {
          const newMins = Number(v)
          const delta   = newMins - _prevFocusMins
          if (delta > 0) {
            _prevFocusMins = newMins
            const today = todayIST()
            void insertSession(delta, today) // persist to study_sessions
            onSessionComplete(delta)          // optimistic CoreState update
          }
        }
      }
      ;(store as { _patched?: boolean })._patched = true
    }
  }

  // 2. Load lectures + routine UI (existing features)
  await loadLectures().catch(e => console.error('[main] loadLectures failed:', e))
  await initRoutine().catch(e => console.error('[main] initRoutine failed:', e))

  // 3. Load all inputs → computeCoreState → bind every widget
  await loadAndBind().catch(e => console.error('[main] loadAndBind failed:', e))

  // Phase 5-6: inject command menu actions
  injectAddScoreToMenu()
  injectExportButton()

  // Phase 6: Constitution + configurable timer + JARVIS
  void initConstitution()
  initConfigurableTimer()
  initJarvis()
}

// ── Add Score in command menu ─────────────────────────────────────────────────

function injectAddScoreToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-add-score')) return

  const card = document.createElement('a')
  card.className = 'cm-card'
  card.id = 'cm-add-score'
  card.setAttribute('href', '#')
  card.innerHTML = `
    <span class="cm-no">+</span>
    <span class="cm-t">Add Score</span>
    <span class="cm-d">Log any test, mock, or DPP</span>
  `
  card.addEventListener('click', async e => {
    e.preventDefault()
    // Close the command menu first
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')

    const { showAddScore } = await import('./features/add-score')
    showAddScore(() => recompute())
  })
  grid.appendChild(card)
}

init()
