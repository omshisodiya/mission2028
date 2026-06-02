import './pin-auth.css'

const PIN_KEY   = 'm2028_pin'
const PIN_SALT  = 'mission2028:Om:2028'
const PIN_LEN   = 6

// ── crypto ────────────────────────────────────────────────────────────────────

async function hashPIN(pin: string): Promise<string> {
  const buf  = new TextEncoder().encode(pin + PIN_SALT)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
}

export function hasPIN(): boolean {
  return !!localStorage.getItem(PIN_KEY)
}

export async function savePIN(pin: string): Promise<void> {
  localStorage.setItem(PIN_KEY, await hashPIN(pin))
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = localStorage.getItem(PIN_KEY)
  if (!stored) return false
  return (await hashPIN(pin)) === stored
}

export function clearPIN(): void {
  localStorage.removeItem(PIN_KEY)
}

// ── shared PIN input widget ───────────────────────────────────────────────────

function makePINWidget(
  containerId: string,
  label: string,
  onComplete: (pin: string) => void,
  autoFocus = true,
): void {
  const wrap = document.getElementById(containerId)
  if (!wrap) return

  wrap.innerHTML = `
    <p class="pin-sub" style="margin-bottom:16px;">${label}</p>
    <div class="pin-dots" id="${containerId}-dots">
      ${Array.from({ length: PIN_LEN }, (_, i) => `<div class="pin-dot" data-i="${i}"></div>`).join('')}
    </div>
    <input class="pin-input-hidden" id="${containerId}-inp" type="tel"
      inputmode="numeric" maxlength="${PIN_LEN}" autocomplete="one-time-code" />
  `

  const inp  = document.getElementById(`${containerId}-inp`) as HTMLInputElement
  const dots = wrap.querySelectorAll<HTMLElement>('.pin-dot')

  function refresh() {
    const val = inp.value.replace(/\D/g, '').slice(0, PIN_LEN)
    inp.value = val
    dots.forEach((d, i) => {
      d.classList.toggle('filled', i < val.length)
      d.classList.toggle('active', i === val.length && val.length < PIN_LEN)
    })
    if (val.length === PIN_LEN) onComplete(val)
  }

  inp.addEventListener('input', refresh)
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && inp.value.length === 0) e.preventDefault()
  })

  wrap.querySelector('.pin-dots')?.addEventListener('click', () => inp.focus())
  wrap.addEventListener('click', () => inp.focus())

  if (autoFocus) setTimeout(() => inp.focus(), 80)
  refresh()
}

// ── PIN entry (returning visitor) ─────────────────────────────────────────────

let _pinEl: HTMLElement | null = null

export function showPINEntry(
  onSuccess: () => void,
  onForgot: () => void,
): void {
  if (document.getElementById('pin-overlay')) return

  _pinEl = document.createElement('div')
  _pinEl.id = 'pin-overlay'
  _pinEl.innerHTML = `
    <div class="pin-panel panel panel-pad">
      <div class="pin-ring"></div>
      <h2 class="pin-title">Enter your PIN</h2>
      <div id="pin-entry-widget"></div>
      <p class="pin-msg" id="pin-entry-msg"></p>
      <div class="pin-btn-row">
        <button class="pin-link" id="pin-forgot">Forgot PIN? Send magic link instead</button>
      </div>
    </div>
  `
  document.body.appendChild(_pinEl)

  let attempts = 0

  makePINWidget('pin-entry-widget', 'Mission 2028 · Command Center', async (pin) => {
    const ok = await verifyPIN(pin)
    if (ok) {
      const msg = document.getElementById('pin-entry-msg')
      if (msg) { msg.textContent = 'Unlocking…'; msg.className = 'pin-msg ok' }
      setTimeout(() => { hidePINEntry(); onSuccess() }, 300)
    } else {
      attempts++
      const inp = document.getElementById('pin-entry-widget-inp') as HTMLInputElement | null
      if (inp) inp.value = ''
      const dots = document.querySelectorAll<HTMLElement>('#pin-entry-widget .pin-dot')
      dots.forEach(d => { d.classList.remove('filled', 'active') })
      dots[0]?.classList.add('active')
      inp?.focus()
      const msg = document.getElementById('pin-entry-msg')
      if (msg) {
        msg.textContent = attempts >= 5 ? 'Too many attempts. Try magic link.' : 'Wrong PIN — try again.'
        msg.className = 'pin-msg err'
      }
    }
  })

  document.getElementById('pin-forgot')?.addEventListener('click', () => {
    clearPIN()           // reset so magic link re-triggers PIN setup
    hidePINEntry()
    onForgot()
  })
}

export function hidePINEntry(): void {
  _pinEl?.remove()
  _pinEl = null
}

// ── PIN setup (first login) ───────────────────────────────────────────────────

let _setupEl: HTMLElement | null = null

export function showPINSetup(onDone: () => void): void {
  if (document.getElementById('pin-overlay')) return

  _setupEl = document.createElement('div')
  _setupEl.id = 'pin-overlay'
  _setupEl.innerHTML = `
    <div class="pin-panel panel panel-pad">
      <div class="pin-ring"></div>
      <h2 class="pin-title">Set your PIN</h2>
      <p class="pin-sub">Choose a ${PIN_LEN}-digit PIN. You'll use this every time you open Mission 2028 — no magic link needed after this.</p>
      <div class="pin-setup-steps">
        <div id="pin-step-1">
          <div id="pin-set-widget"></div>
          <p class="pin-msg" id="pin-set-msg"></p>
        </div>
        <div id="pin-step-2" style="display:none;">
          <div id="pin-confirm-widget"></div>
          <p class="pin-msg" id="pin-confirm-msg"></p>
        </div>
      </div>
      <div class="pin-btn-row" style="margin-top:16px;">
        <button class="pin-link" id="pin-skip">Skip — use magic link every time</button>
      </div>
    </div>
  `
  document.body.appendChild(_setupEl)

  let firstPIN = ''

  // Step 1: enter new PIN
  makePINWidget('pin-set-widget', 'Enter a new PIN', (pin) => {
    firstPIN = pin
    const s1 = document.getElementById('pin-step-1')
    const s2 = document.getElementById('pin-step-2')
    if (s1) s1.style.display = 'none'
    if (s2) {
      s2.style.display = 'block'
      // Step 2: confirm PIN — only mount the widget now so it auto-focuses correctly
      makePINWidget('pin-confirm-widget', 'Confirm your PIN', async (pin2) => {
        if (pin2 !== firstPIN) {
          const inp = document.getElementById('pin-confirm-widget-inp') as HTMLInputElement | null
          if (inp) inp.value = ''
          document.querySelectorAll<HTMLElement>('#pin-confirm-widget .pin-dot')
            .forEach(d => d.classList.remove('filled', 'active'))
          document.querySelectorAll<HTMLElement>('#pin-confirm-widget .pin-dot')[0]?.classList.add('active')
          inp?.focus()
          const msg = document.getElementById('pin-confirm-msg')
          if (msg) { msg.textContent = "PINs don't match — try again."; msg.className = 'pin-msg err' }
          return
        }
        await savePIN(pin2)
        _setupEl?.remove()
        _setupEl = null
        onDone()
      }, true)
    }
  }, true)

  document.getElementById('pin-skip')?.addEventListener('click', () => {
    _setupEl?.remove()
    _setupEl = null
    onDone()
  })
}
