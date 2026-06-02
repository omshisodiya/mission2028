import { supabase } from '../data/supabase'
import './auth.css'

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
      <p class="ag-sub">Enter your email — we'll send a magic sign-in link.</p>
      <form id="ag-form" class="ag-form">
        <input id="ag-email" class="ag-input" type="email" autocomplete="email"
          placeholder="your@email.com" value="omshisodiya2603@gmail.com" required />
        <button class="btn primary ag-btn" type="submit">Send magic link</button>
      </form>
      <p id="ag-msg" class="ag-msg"></p>
    </div>
  `
  document.body.appendChild(_el)

  const form = _el.querySelector('#ag-form') as HTMLFormElement
  const msg  = _el.querySelector('#ag-msg') as HTMLElement
  const btn  = _el.querySelector('.ag-btn') as HTMLButtonElement

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
