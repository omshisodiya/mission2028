// Check screen lock FIRST — before engine, before auth, before anything.
// If locked, PIN screen appears immediately on every load/reload.
import { checkStartupLock } from './features/screen-lock'
checkStartupLock()

// VA overlay + toggle button are in index.html as inline HTML/CSS/script.
// They mount and animate before any module code runs — no imports needed.

// Engine and UI shells boot immediately — auth + data sync happen in background.
import './engine/image-slot.js'
import './engine/engine.js'

import { type Session } from '@supabase/supabase-js'
import { supabase } from './data/supabase'
import { pull, queuePush } from './sync/store-sync'
import { showAuthGate, hideAuthGate } from './features/auth'
import { hasPIN, showPINEntry, hidePINEntry, showPINSetup, clearPIN } from './features/pin-auth'
import { mountPlannerUI, loadLectures, setOfflineMode } from './features/lectures-planner'
import { rolloverUndoneToday } from './data/repositories/lectures'
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
import { showCALog, bindCAFeed } from './features/ca-log'
import { showAnswerLog, bindAnswerTracker } from './features/answer-log'
import { injectMistakeNotebookToMenu } from './features/mistake-notebook'
import { injectNotesToMenu } from './features/quick-notes'
import { injectGoalsToMenu } from './features/goals'
import { injectCalendarToMenu } from './features/calendar-view'
import { injectWeeklyReviewToMenu } from './features/weekly-review'
import { showSettings } from './features/settings'
import {
  OWNER_EMAIL, isOwnerEmail, isSecondaryEmail, isAuthorizedEmail,
  isTrustedDevice, setTrustedDevice, storeOwnerUID, getOwnerUID,
} from './features/auth-master'
import { prewarmEffectiveUID } from './data/effective-uid'
import { initRealtimeSync } from './sync/realtime'
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

// Holds the unsubscribe fn so master key boot can kill the auth listener entirely
let _authUnsubscribe: (() => void) | null = null
// Set to true the moment master key is accepted — permanently blocks requireLogin()
let _masterBooted = false

async function init(): Promise<void> {
  let handled = false

  function handleSession(sess: Session, isFreshLogin: boolean): void {
    if (handled) return
    handled = true

    const email = sess.user.email ?? ''

    // Owner email: cache their UID for offline/master-key boot
    if (isOwnerEmail(email)) storeOwnerUID(sess.user.id)

    void (async () => {
      // For secondary email, resolve the owner's UID so all data operations
      // target the owner's rows.  prewarmEffectiveUID() calls owner_uid() RPC
      // (security-definer, can read auth.users) and caches the result.
      let effectiveId = sess.user.id
      if (isSecondaryEmail(email)) {
        try {
          const ownerUID = await prewarmEffectiveUID()
          if (ownerUID) {
            effectiveId = ownerUID
            storeOwnerUID(ownerUID)   // cache so offline boot also works
          }
        } catch { /* proceed with secondary's own UID — DB policy still allows reads */ }
      }

      // Both authorized emails skip PIN and are marked trusted
      const isAuthorized = isAuthorizedEmail(email)

      if (isFreshLogin && !hasPIN()) {
        showPINSetup(() => {
          if (isAuthorized) setTrustedDevice()
          boot(effectiveId)
        })
      } else if (hasPIN() && !isFreshLogin) {
        // Authorized email on a trusted device — skip PIN entirely
        if (isAuthorized && isTrustedDevice()) {
          boot(effectiveId)
          return
        }
        showPINEntry(
          () => {
            if (isAuthorized) setTrustedDevice()
            boot(effectiveId)
          },
          () => { clearPIN(); showAuthGate() },
        )
      } else {
        if (isAuthorized) setTrustedDevice()
        boot(effectiveId)
      }
    })()
  }

  function requireLogin(): void {
    // Never re-show the gate after a master key boot
    if (_masterBooted) return
    // Do NOT auto-boot here — onAuthStateChange fires before token refresh
    // completes.  Trusted-device auto-boot lives below, after getSession().
    handled = false
    hidePINEntry()
    hideAuthGate()
    showAuthGate()
  }

  const { data: { subscription } } = supabase.auth.onAuthStateChange((evt, sess) => {
    if (sess) handleSession(sess, evt === 'SIGNED_IN')
    else requireLogin()
  })
  _authUnsubscribe = () => subscription.unsubscribe()

  // getSession() waits for any pending token refresh to complete before resolving.
  // TOKEN_REFRESHED may fire and call handleSession() before we get here — that's fine.
  const { data: { session } } = await supabase.auth.getSession()
  if (session) {
    handleSession(session, false)
  } else if (!handled) {
    // Trusted device with no valid session — hide the gate and boot from local cache.
    // We are now past the token-refresh wait, so a real session would have appeared
    // above if the refresh token was valid.  This path covers expired refresh tokens
    // and fresh devices (master key entered, no session ever on this device).
    if (isTrustedDevice()) {
      const cachedUID = getOwnerUID()
      if (cachedUID) {
        handled = true
        hideAuthGate()
        setOfflineMode(true)   // no live session — planner shows sign-in prompt until auth
        boot(cachedUID)
        return
      }
    }
    requireLogin()
  }
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

/** Run once per calendar day to cascade undone lectures forward to today's date. */
async function rolloverIfNewDay(): Promise<void> {
  const today = todayIST()
  const LAST_DATE_KEY = 'm2028_last_active_date'
  const lastDate = localStorage.getItem(LAST_DATE_KEY)
  if (lastDate === today) return   // already ran today — skip
  await rolloverUndoneToday(today)
  localStorage.setItem(LAST_DATE_KEY, today)
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

  // 2a. Rollover undone "today" lectures to today's date if it's a new calendar day
  await rolloverIfNewDay().catch(e => console.warn('[main] rollover failed:', e))

  // 2b. Load lectures + routine UI (existing features)
  await loadLectures().catch(e => console.error('[main] loadLectures failed:', e))
  await initRoutine().catch(e => console.error('[main] initRoutine failed:', e))

  // 3. Load all inputs → computeCoreState → bind every widget
  await loadAndBind().catch(e => console.error('[main] loadAndBind failed:', e))

  // 4. Realtime sync for scores, revisions, answer_practice, current_affairs, mistakes, notes, app_state
  initRealtimeSync()

  // Phase 5-6: inject command menu actions
  injectAddScoreToMenu()
  injectExportButton()

  // Phase 6+: All missing command-menu features — wired here so JARVIS cl() calls work
  injectCALogToMenu()
  injectAnswerLogToMenu()
  injectMistakeNotebookToMenu()
  injectNotesToMenu()
  injectGoalsToMenu()
  injectCalendarToMenu()
  injectWeeklyReviewToMenu()
  injectSettingsToMenu()
  injectReviseNowToMenu()

  // Phase 6: Constitution + configurable timer + JARVIS
  void initConstitution()
  initConfigurableTimer()
  initJarvis()

  // Phase 6+: Global enhancements
  injectToastSystem()
  injectKeyboardShortcutsHelp()
  injectOfflineIndicator()
}

// ── Keyboard shortcuts help panel ─────────────────────────────────────────────
function injectKeyboardShortcutsHelp(): void {
  // ? key shows shortcuts modal
  document.addEventListener('keydown', e => {
    if (e.key === '?' && !['INPUT','TEXTAREA','SELECT'].includes((e.target as HTMLElement).tagName)) {
      e.preventDefault()
      showShortcutsModal()
    }
  })
}

function showShortcutsModal(): void {
  if (document.getElementById('shortcuts-modal')) return
  const m = document.createElement('div')
  m.id = 'shortcuts-modal'
  m.style.cssText = 'position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;background:rgba(5,7,15,.92);backdrop-filter:blur(10px);padding:20px;'
  m.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);padding:28px 32px;width:100%;max-width:520px;max-height:80vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">⬡ KEYBOARD SHORTCUTS</span>
        <button id="sc-close" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.8;">
        ${[
          ['J',           'Toggle JARVIS panel'],
          ['?',           'Show this shortcuts guide'],
          ['Ctrl+K / Cmd+K', 'Open command menu'],
          ['Escape',      'Close any open panel'],
          ['Double-clap', 'Wake JARVIS (after first "Jarvis")'],
          ['',            ''],
          ['Voice: "start timer"', 'Start focus session'],
          ['Voice: "show plan"', 'Navigate to planner'],
          ['Voice: "add score"', 'Open score entry'],
          ['Voice: "quiz me on Polity"', 'Start MCQ quiz'],
          ['Voice: "emergency Polity"', 'Emergency cram mode'],
          ['Voice: "interview practice"', 'UPSC interview simulation'],
          ['Voice: "daily reflection"', 'Voice journal entry'],
          ['Voice: "ambient mode"', 'Silent focus mode'],
          ['Voice: "scan score"', 'Camera score reader'],
        ].map(([k, v]) => k ? `
          <tr style="border-bottom:1px solid var(--line-2);">
            <td style="padding:6px 12px 6px 0;font-family:var(--font-mono);color:var(--accent);white-space:nowrap;">${k}</td>
            <td style="padding:6px 0;color:var(--ink-soft);">${v}</td>
          </tr>` : '<tr><td colspan="2" style="height:8px;"></td></tr>').join('')}
      </table>
      <p style="margin-top:16px;font-size:11.5px;color:var(--muted);font-family:var(--font-mono);">
        743 voice commands available — say "Jarvis, what can you do?" for a full list.
      </p>
    </div>
  `
  document.body.appendChild(m)
  document.getElementById('sc-close')?.addEventListener('click', () => m.remove())
  m.addEventListener('click', e => { if (e.target === m) m.remove() })
  // ESC closes
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { m.remove(); document.removeEventListener('keydown', esc) } }
  document.addEventListener('keydown', esc)
}

// ── Global Toast Notification System ─────────────────────────────────────────
// Lightweight, accessible toasts for save confirmations, sync status, milestones.
// Usage (from any module): window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg, type } }))
function injectToastSystem(): void {
  const container = document.createElement('div')
  container.id = 'toast-container'
  container.style.cssText = [
    'position:fixed;top:16px;right:16px;z-index:10000;',
    'display:flex;flex-direction:column;gap:8px;pointer-events:none;',
    'max-width:320px;',
  ].join('')
  document.body.appendChild(container)

  window.addEventListener('app:toast', ((e: CustomEvent<{ msg: string; type?: 'success'|'error'|'info'|'warn' }>) => {
    const { msg, type = 'info' } = e.detail
    const colors: Record<string, string> = {
      success: 'rgba(69,224,168,.95)',
      error:   'rgba(224,85,85,.95)',
      warn:    'rgba(240,181,74,.95)',
      info:    'rgba(80,120,200,.95)',
    }
    const icons: Record<string, string> = { success:'✓', error:'✕', warn:'⚠', info:'ℹ' }
    const t = document.createElement('div')
    t.style.cssText = [
      `background:${colors[type]};color:${type==='warn'?'#000':'#fff'};`,
      'border-radius:8px;padding:10px 14px;font-family:var(--font-mono);font-size:12px;',
      'display:flex;align-items:center;gap:8px;pointer-events:auto;',
      'box-shadow:0 4px 20px rgba(0,0,0,.35);',
      'animation:toast-in .25s ease forwards;',
      'max-width:100%;word-break:break-word;',
    ].join('')
    t.innerHTML = `<span style="font-weight:700;flex-shrink:0;">${icons[type]}</span><span>${msg}</span>`
    container.appendChild(t)
    // Auto-remove after 3.5 s
    setTimeout(() => {
      t.style.animation = 'toast-out .25s ease forwards'
      setTimeout(() => t.remove(), 250)
    }, 3500)
  }) as EventListener)

  // Inject toast keyframes
  const style = document.createElement('style')
  style.textContent = `
    @keyframes toast-in  { from{opacity:0;transform:translateX(20px)} to{opacity:1;transform:translateX(0)} }
    @keyframes toast-out { from{opacity:1;transform:translateX(0)} to{opacity:0;transform:translateX(20px)} }
  `
  document.head.appendChild(style)
}

// ── Offline status indicator ──────────────────────────────────────────────────
function injectOfflineIndicator(): void {
  const banner = document.createElement('div')
  banner.id = 'offline-banner'
  banner.style.cssText = [
    'position:fixed;bottom:0;left:0;right:0;z-index:9000;',
    'background:rgba(224,85,85,.92);backdrop-filter:blur(8px);',
    'color:#fff;text-align:center;padding:8px 16px;font-family:var(--font-mono);',
    'font-size:12px;letter-spacing:.06em;transform:translateY(100%);transition:transform .3s ease;',
    'display:flex;align-items:center;justify-content:center;gap:12px;',
  ].join('')
  banner.innerHTML = `
    <span>📴 OFFLINE — changes are saved locally and will sync when you reconnect</span>
    <button onclick="this.parentElement.style.transform='translateY(100%)'" style="background:none;border:1px solid rgba(255,255,255,.4);border-radius:4px;color:#fff;padding:2px 8px;cursor:pointer;font-size:11px;">Dismiss</button>
  `
  document.body.appendChild(banner)

  window.addEventListener('offline', () => {
    banner.style.transform = 'translateY(0)'
  })
  window.addEventListener('online', () => {
    banner.style.transform = 'translateY(100%)'
  })
  if (!navigator.onLine) banner.style.transform = 'translateY(0)'
}

// ── All new command-menu injections ──────────────────────────────────────────

function closeMenu(): void {
  document.getElementById('command-menu')?.classList.remove('open')
  document.getElementById('menu-backdrop')?.classList.remove('show')
  document.body.classList.remove('menu-open')
}

function injectCALogToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-ca-log')) return
  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-ca-log'; card.href = '#'
  card.innerHTML = `<span class="cm-no">📰</span><span class="cm-t">Log CA</span><span class="cm-d">Current affairs entry</span>`
  card.addEventListener('click', e => {
    e.preventDefault(); closeMenu()
    showCALog(() => recompute())
  })
  grid.appendChild(card)
}

function injectAnswerLogToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-answer-log')) return
  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-answer-log'; card.href = '#'
  card.innerHTML = `<span class="cm-no">✍</span><span class="cm-t">Answer Log</span><span class="cm-d">Log mains answer practice</span>`
  card.addEventListener('click', e => {
    e.preventDefault(); closeMenu()
    showAnswerLog(() => recompute())
  })
  grid.appendChild(card)
}

function injectSettingsToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-settings')) return
  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-settings'; card.href = '#'
  card.innerHTML = `<span class="cm-no">⚙</span><span class="cm-t">Settings</span><span class="cm-d">Exam dates, capacity, planner</span>`
  card.addEventListener('click', e => {
    e.preventDefault(); closeMenu()
    showSettings((_s) => recompute())
  })
  grid.appendChild(card)
}

function injectReviseNowToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-revise-now')) return
  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-revise-now'; card.href = '#'
  card.innerHTML = `<span class="cm-no">↻</span><span class="cm-t">Revise This</span><span class="cm-d">Push current lecture to SRS today</span>`
  card.addEventListener('click', async e => {
    e.preventDefault(); closeMenu()
    // Flag the first undone lecture for immediate revision
    const row = document.querySelector<HTMLElement>('#plan .plan-row:not(.done)')
    const title = row?.querySelector<HTMLElement>('.pl-title')?.textContent?.trim()
    if (!title) {
      window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg: 'No pending lecture found.', type: 'info' } }))
      return
    }
    const { createRevisionSchedule } = await import('./data/repositories/revisions')
    try {
      await createRevisionSchedule('', todayIST())
      window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg: `"${title}" added to today's revision queue.`, type: 'success' } }))
      recompute()
    } catch {
      window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg: 'Failed to add revision.', type: 'error' } }))
    }
  })
  grid.appendChild(card)
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

// ── Master key boot (from auth gate when Supabase session is gone) ────────────
// Master key was verified; boot with the stored owner UID (offline/cached mode).
window.addEventListener('auth:master-key-boot', (evt: Event) => {
  // email = the address the user typed if they used an email as the master key;
  // undefined if they used the numeric passcode (falls back to OWNER_EMAIL)
  const _enteredEmail = (evt as CustomEvent<{ email?: string }>).detail?.email
  // Synchronously block & hide BEFORE any await — prevents onAuthStateChange
  // from re-showing the gate during the async UID lookup below.
  _masterBooted = true
  _authUnsubscribe?.()
  _authUnsubscribe = null
  hideAuthGate()
  hidePINEntry()
  setTrustedDevice()

  void (async () => {
    let uid          = getOwnerUID()
    let sessionReady = false

    // 1. Try session refresh (exchanges stored refresh token for a fresh JWT).
    //    If this succeeds, all Supabase RLS queries will work and data loads.
    try {
      const { data: { session } } = await supabase.auth.refreshSession()
      if (session?.user?.id) {
        uid          = session.user.id
        sessionReady = true
        storeOwnerUID(uid)
      }
    } catch { /* ignore */ }

    // 2. Fallback: read whatever live session the client already has
    if (!sessionReady) {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.user?.id) {
          uid          = session.user.id
          sessionReady = true
          storeOwnerUID(uid)
        }
      } catch { /* ignore */ }
    }

    // 3. No valid session on this device.
    //    • If the user typed their email as the master key → auto-send OTP to that address.
    //    • If the user used the numeric passcode → do NOT auto-send; ask them to sign in
    //      via the "Sign in with Gmail" button that appears in the Lectures section.
    if (!sessionReady) {
      if (_enteredEmail) {
        // Email was explicitly entered — send OTP silently to that address
        try {
          await supabase.auth.signInWithOtp({
            email:   _enteredEmail,
            options: { emailRedirectTo: window.location.origin },
          })
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('app:toast', {
              detail: {
                msg:  `📧 Magic link sent to ${_enteredEmail} — click it to sync your data.`,
                type: 'info',
              },
            }))
          }, 1500)
        } catch { /* ignore — offline or rate-limited */ }
      } else {
        // Passcode used — nudge the user to sign in themselves so they can choose their Gmail
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('app:toast', {
            detail: {
              msg:  '📴 Offline mode — scroll to Lectures and tap "Sign in with Gmail" to sync your data.',
              type: 'info',
            },
          }))
        }, 1500)
      }
    }

    if (!uid) uid = 'offline'
    if (!sessionReady) setOfflineMode(true)   // planner shows sign-in prompt until auth
    boot(uid)
  })()
})

init()
