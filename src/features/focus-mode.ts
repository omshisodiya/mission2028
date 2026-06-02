/**
 * Focus Mode — strips heavy VFX for daily use.
 * Toggled via a button injected into the nav.
 * Preference persisted in store('settings').
 */

const FOCUS_CSS = `
body.focus-mode #starfield           { opacity:0; pointer-events:none; }
body.focus-mode #warp                { opacity:0; pointer-events:none; }
body.focus-mode #cursor-aura         { display:none; }
body.focus-mode #const-particles     { opacity:0; }
body.focus-mode #chakra-watermark    { opacity:0; }
body.focus-mode .tilt                { transform:none!important; transition:none!important; }
body.focus-mode .orbit               { opacity:0; }
body.focus-mode #tricolor-progress   { opacity:0; }
body.focus-mode .aurora              { opacity:0; }
body.focus-mode .bharat-aura         { opacity:0; }
body.focus-mode #hero .hero-stage > * { opacity:0; }
`

let _active = false

type Store = { get(k: string, def: unknown): unknown; set(k: string, v: unknown): void }
function getStore(): Store | null {
  return (window as { MISSION?: { store: Store } }).MISSION?.store ?? null
}

export function initFocusMode(): void {
  // Inject CSS
  const style = document.createElement('style')
  style.textContent = FOCUS_CSS
  document.head.appendChild(style)

  // Restore saved preference
  const store = getStore()
  const settings = store?.get('settings', {}) as { focusMode?: boolean } | null
  if (settings?.focusMode) enableFocusMode(false)

  // Inject toggle button into nav
  const navLinks = document.querySelector<HTMLElement>('.nav-links')
  if (!navLinks) return

  const btn = document.createElement('button')
  btn.id = 'focus-mode-btn'
  btn.style.cssText =
    'background:none;border:1px solid var(--line-2);border-radius:20px;' +
    'color:var(--muted);font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;' +
    'padding:5px 12px;cursor:pointer;transition:all .2s;text-transform:uppercase;'
  btn.textContent = _active ? 'Cinematic' : 'Focus Mode'
  btn.title = 'Toggle Focus Mode — disables heavy VFX for daily use'
  btn.addEventListener('mouseover', () => (btn.style.borderColor = 'var(--accent)'))
  btn.addEventListener('mouseout',  () => (btn.style.borderColor = 'var(--line-2)'))
  btn.addEventListener('click', toggle)

  navLinks.insertBefore(btn, navLinks.querySelector('.nav-cta'))
}

function enableFocusMode(save = true): void {
  _active = true
  document.body.classList.add('focus-mode')
  const btn = document.getElementById('focus-mode-btn')
  if (btn) { btn.textContent = '✦ Cinematic'; btn.style.color = 'var(--accent-ink)' }
  if (save) {
    const store = getStore()
    const cur = (store?.get('settings', {}) ?? {}) as object
    store?.set('settings', { ...cur, focusMode: true })
  }
}

function disableFocusMode(save = true): void {
  _active = false
  document.body.classList.remove('focus-mode')
  const btn = document.getElementById('focus-mode-btn')
  if (btn) { btn.textContent = 'Focus Mode'; btn.style.color = 'var(--muted)' }
  if (save) {
    const store = getStore()
    const cur = (store?.get('settings', {}) ?? {}) as object
    store?.set('settings', { ...cur, focusMode: false })
  }
}

function toggle(): void {
  if (_active) disableFocusMode(); else enableFocusMode()
}
