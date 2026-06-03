/**
 * screen-lock.ts — PIN-protected screen lock.
 * Lock state persisted in localStorage so it survives tab close/reload.
 * checkStartupLock() runs immediately at page load — if locked, the PIN
 * screen appears before the app is interactive.
 */
import { hasPIN, verifyPIN } from './pin-auth'

const LOCK_KEY = 'mission2028_screen_locked'

let _lockEl: HTMLElement | null = null

// ── Called at the very start of main.ts (before auth) ────────────────────────

export function checkStartupLock(): void {
  if (localStorage.getItem(LOCK_KEY) === '1' && hasPIN()) {
    showLockScreen()
  }
}

// ── Called after engine boots (injects nav button) ────────────────────────────

export function initScreenLock(): void {
  const navLinks = document.querySelector<HTMLElement>('.nav-links')
  if (!navLinks || document.getElementById('lock-btn')) return

  const btn = document.createElement('button')
  btn.id = 'lock-btn'
  btn.title = 'Lock screen — unlock with your PIN (Ctrl+L)'
  btn.style.cssText =
    'background:none;border:1px solid var(--line-2);border-radius:20px;' +
    'color:var(--muted);font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;' +
    'padding:5px 12px;cursor:pointer;transition:all .2s;text-transform:uppercase;'
  btn.textContent = '🔒 Lock'
  btn.addEventListener('mouseover', () => (btn.style.borderColor = 'var(--accent)'))
  btn.addEventListener('mouseout',  () => (btn.style.borderColor = 'var(--line-2)'))
  btn.addEventListener('click', lock)

  navLinks.insertBefore(btn, navLinks.firstChild)

  // Keyboard shortcut
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); lock() }
  })
}

// ── Lock ──────────────────────────────────────────────────────────────────────

function lock(): void {
  if (_lockEl) return   // already showing lock screen
  if (!hasPIN()) {
    // No PIN set — guide the user
    const go = confirm('No PIN set yet.\n\nSign out and log in again via magic link to set your PIN on next login.\n\nSign out now?')
    if (go) {
      import('../data/supabase').then(({ supabase }) => {
        supabase.auth.signOut().then(() => window.location.reload())
      })
    }
    return
  }
  // Persist lock across reloads
  localStorage.setItem(LOCK_KEY, '1')
  showLockScreen()
}

// ── Lock screen UI ────────────────────────────────────────────────────────────

function showLockScreen(): void {
  if (_lockEl) return

  _lockEl = document.createElement('div')
  _lockEl.id = 'lock-overlay'
  _lockEl.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#05070f;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;'

  _lockEl.innerHTML = `
    <div style="text-align:center;">
      <div style="font-size:44px;margin-bottom:10px;">🔒</div>
      <div style="font-family:var(--font-display);font-size:22px;font-weight:600;color:var(--ink);">
        Mission 2028 · Locked
      </div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-top:6px;letter-spacing:.12em;">
        ENTER YOUR PIN TO UNLOCK
      </div>
    </div>

    <div id="lock-dots" style="display:flex;gap:10px;cursor:text;">
      ${Array.from({ length: 6 }, (_, i) =>
        `<div id="ld-${i}" style="width:46px;height:54px;border-radius:10px;
         border:1.5px solid var(--line-2);background:var(--panel-2);
         display:flex;align-items:center;justify-content:center;
         font-size:14px;color:var(--accent);transition:border-color .15s;"></div>`
      ).join('')}
    </div>

    <input id="lock-inp" type="tel" inputmode="numeric" maxlength="6"
      style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;"
      autocomplete="one-time-code" />

    <p id="lock-err" style="font-family:var(--font-mono);font-size:12.5px;
       color:var(--bad);min-height:18px;margin:0;text-align:center;"></p>

    <div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);">
      Forgot PIN?
      <button id="lock-signout" style="background:none;border:none;color:var(--accent);
        font-family:var(--font-mono);font-size:11px;cursor:pointer;text-decoration:underline;">
        Sign out &amp; reset
      </button>
    </div>
  `
  document.body.appendChild(_lockEl)

  const inp  = document.getElementById('lock-inp') as HTMLInputElement
  const dots = Array.from({ length: 6 }, (_, i) => document.getElementById(`ld-${i}`)!)
  const err  = document.getElementById('lock-err')!
  let attempts = 0

  function refresh(): void {
    const val = inp.value.replace(/\D/g, '').slice(0, 6)
    inp.value = val
    dots.forEach((d, i) => {
      d.textContent = i < val.length ? '●' : ''
      d.style.borderColor = i === val.length && val.length < 6
        ? 'var(--accent)' : 'var(--line-2)'
    })
  }

  async function tryUnlock(): Promise<void> {
    const val = inp.value.replace(/\D/g, '')
    if (val.length < 6) return
    const ok = await verifyPIN(val)
    if (ok) {
      localStorage.removeItem(LOCK_KEY)  // clear persisted lock
      _lockEl?.remove(); _lockEl = null
    } else {
      attempts++
      inp.value = ''; refresh()
      dots[0].style.borderColor = 'var(--accent)'
      err.textContent = attempts >= 5
        ? 'Too many attempts. Sign out to reset.'
        : `Wrong PIN — try again (${5 - attempts} left)`
      setTimeout(() => inp.focus(), 50)
    }
  }

  inp.addEventListener('input', () => { refresh(); if (inp.value.length >= 6) void tryUnlock() })

  // Click anywhere on overlay to focus the hidden input
  _lockEl.addEventListener('click', e => {
    if ((e.target as HTMLElement).id !== 'lock-signout') inp.focus()
  })

  document.getElementById('lock-signout')?.addEventListener('click', () => {
    localStorage.removeItem(LOCK_KEY)
    import('../data/supabase').then(({ supabase }) =>
      supabase.auth.signOut().then(() => window.location.reload())
    )
  })

  setTimeout(() => { inp.focus(); refresh() }, 80)
}
