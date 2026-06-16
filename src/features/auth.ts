import { supabase } from '../data/supabase'
import './auth.css'
import { showMasterKeyOverlay } from './auth-master'

let _el: HTMLElement | null = null

export function showAuthGate(): void {
  if (_el) return
  _el = document.createElement('div')
  _el.id = 'auth-gate'
  _el.innerHTML = `
    <div class="ag-panel panel panel-pad">
      <div class="ag-ring"></div>
      <span class="eyebrow" style="justify-content:center;margin-bottom:14px;">
        Mission 2028 · Command Center
      </span>
      <h2 class="ag-title">Welcome back, Om.</h2>
      <p class="ag-sub">Enter your email — we'll send a magic sign-in link to access your command center.</p>
      <form id="ag-form" class="ag-form">
        <input id="ag-email" class="ag-input" type="email" autocomplete="email"
          placeholder="your@email.com" value="omshisodiya2603@gmail.com" required />
        <button class="btn primary ag-btn" type="submit">Send magic link</button>
      </form>
      <p id="ag-msg" class="ag-msg"></p>
      <div style="margin-top:20px;border-top:1px solid var(--line-2);padding-top:16px;">
        <button id="ag-master"
          style="background:none;border:none;color:var(--muted);font-family:var(--font-mono);
                 font-size:11.5px;cursor:pointer;text-decoration:underline;
                 text-underline-offset:3px;letter-spacing:.04em;transition:color .15s;"
          onmouseover="this.style.color='var(--accent)'"
          onmouseout="this.style.color='var(--muted)'">
          Use master key instead →
        </button>
      </div>
    </div>
  `
  document.body.appendChild(_el)

  const form = _el.querySelector('#ag-form') as HTMLFormElement
  const msg  = _el.querySelector('#ag-msg') as HTMLElement
  const btn  = _el.querySelector('.ag-btn') as HTMLButtonElement

  _el.querySelector('#ag-master')?.addEventListener('click', () => {
    showMasterKeyOverlay((enteredEmail?: string) => {
      // Pass whichever email was typed so main.ts sends the OTP to the right address
      window.dispatchEvent(new CustomEvent('auth:master-key-boot', {
        detail: { email: enteredEmail },
      }))
    })
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = (_el!.querySelector('#ag-email') as HTMLInputElement).value.trim()
    btn.disabled = true
    btn.textContent = 'Sending…'
    msg.textContent = ''
    msg.className = 'ag-msg'

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })

    if (error) {
      msg.textContent = error.message
      msg.className = 'ag-msg err'
      btn.disabled = false
      btn.textContent = 'Send magic link'
    } else {
      msg.textContent = 'Magic link sent — check your inbox (and spam).'
      msg.className = 'ag-msg ok'
      btn.textContent = 'Link sent ✓'
    }
  })
}

export function hideAuthGate(): void {
  _el?.remove()
  _el = null
}
