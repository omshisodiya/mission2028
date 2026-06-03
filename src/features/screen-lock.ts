/**
 * screen-lock.ts — Lock button in the nav.
 * Clicking it locks the screen (black overlay).
 * Unlock requires the PIN set during first login.
 * If no PIN is set, show a reminder to set one first.
 */
import { hasPIN, verifyPIN } from './pin-auth'

let _lockEl: HTMLElement | null = null
let _locked = false

export function initScreenLock(): void {
  // Inject lock button into the nav (before Focus Mode button)
  const navLinks = document.querySelector<HTMLElement>('.nav-links')
  if (!navLinks || document.getElementById('lock-btn')) return

  const btn = document.createElement('button')
  btn.id = 'lock-btn'
  btn.title = 'Lock screen (unlock with your PIN)'
  btn.style.cssText =
    'background:none;border:1px solid var(--line-2);border-radius:20px;' +
    'color:var(--muted);font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;' +
    'padding:5px 12px;cursor:pointer;transition:all .2s;text-transform:uppercase;'
  btn.textContent = '🔒 Lock'
  btn.addEventListener('mouseover', () => (btn.style.borderColor = 'var(--accent)'))
  btn.addEventListener('mouseout',  () => (btn.style.borderColor = 'var(--line-2)'))
  btn.addEventListener('click', lock)

  // Insert before the first link
  navLinks.insertBefore(btn, navLinks.firstChild)

  // Lock on keyboard shortcut: Ctrl+L
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); lock() }
  })
}

function lock(): void {
  if (_locked) return
  if (!hasPIN()) {
    alert('Set a PIN first — click "Start Focus" to use the timer, then use the PIN you set at first login.')
    return
  }
  _locked = true
  showLockScreen()
}

function showLockScreen(): void {
  _lockEl = document.createElement('div')
  _lockEl.id = 'lock-overlay'
  _lockEl.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#05070f;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;'

  _lockEl.innerHTML = `
    <div style="text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🔒</div>
      <div style="font-family:var(--font-display);font-size:22px;font-weight:600;color:var(--ink);">
        Mission 2028 — Locked
      </div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--muted);margin-top:8px;letter-spacing:.1em;">
        ENTER YOUR PIN TO CONTINUE
      </div>
    </div>
    <div class="pin-dots" id="lock-dots" style="display:flex;gap:12px;cursor:text;">
      ${Array.from({length:6},()=>`<div class="pin-dot" style="width:48px;height:56px;border-radius:10px;border:1.5px solid var(--line-2);background:var(--panel-2);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--accent);"></div>`).join('')}
    </div>
    <input id="lock-pin-inp" type="tel" inputmode="numeric" maxlength="6"
      style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;" />
    <p id="lock-err" style="font-family:var(--font-mono);font-size:13px;color:var(--bad);min-height:18px;"></p>
    <div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-top:8px;">
      Forgot PIN? <a href="/" style="color:var(--accent);cursor:pointer;" id="lock-reset">Sign out & reset</a>
    </div>
  `
  document.body.appendChild(_lockEl)

  const inp  = document.getElementById('lock-pin-inp') as HTMLInputElement
  const dots = _lockEl.querySelectorAll<HTMLElement>('.pin-dot')
  const err  = document.getElementById('lock-err')!
  let attempts = 0

  function refreshDots(): void {
    const val = inp.value.replace(/\D/g, '').slice(0, 6)
    inp.value = val
    dots.forEach((d, i) => {
      d.textContent = i < val.length ? '●' : ''
      d.style.borderColor = i === val.length && val.length < 6 ? 'var(--accent)' : 'var(--line-2)'
    })
  }

  inp.addEventListener('input', async () => {
    refreshDots()
    const val = inp.value.replace(/\D/g, '')
    if (val.length === 6) {
      const ok = await verifyPIN(val)
      if (ok) {
        _locked = false
        _lockEl?.remove(); _lockEl = null
      } else {
        attempts++
        inp.value = ''
        dots.forEach(d => { d.textContent = ''; d.style.borderColor = 'var(--line-2)' })
        dots[0].style.borderColor = 'var(--accent)'
        err.textContent = attempts >= 5
          ? 'Too many wrong attempts. Try again or reset.'
          : `Wrong PIN — ${6 - attempts} attempts left`
        setTimeout(() => inp.focus(), 50)
      }
    }
  })

  // Click anywhere on the dots to focus the hidden input
  _lockEl.querySelector('#lock-dots')?.addEventListener('click', () => inp.focus())
  _lockEl.addEventListener('click', () => inp.focus())

  // Reset link — sign out
  document.getElementById('lock-reset')?.addEventListener('click', async (e) => {
    e.preventDefault()
    const { supabase } = await import('../data/supabase')
    await supabase.auth.signOut()
    window.location.reload()
  })

  setTimeout(() => { inp.focus(); refreshDots() }, 80)
}
