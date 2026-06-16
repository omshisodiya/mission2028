/**
 * auth-master.ts — Owner auto-bypass + master key recovery.
 *
 * Owner device: after first PIN entry for omshisodiya2603@gmail.com, the device
 * is marked trusted and PIN is skipped on every subsequent load.
 *
 * Master key: either the passcode OR the master email unlocks PIN/lock/auth gate.
 * Used as a recovery mechanism when the normal PIN path isn't available.
 */

export const OWNER_EMAIL     = 'omshisodiya2603@gmail.com'
const MASTER_PASSCODE        = '170207'
const MASTER_EMAIL           = 'princee.aditisingh@gmail.com'

const TRUSTED_KEY   = 'm2028_trusted'
const OWNER_UID_KEY = 'm2028_owner_uid'

// ── Checks ────────────────────────────────────────────────────────────────────

export function isMasterKey(input: string): boolean {
  const v = input.trim()
  return v === MASTER_PASSCODE || v.toLowerCase() === MASTER_EMAIL.toLowerCase()
}

export function isOwnerEmail(email: string): boolean {
  return email.trim().toLowerCase() === OWNER_EMAIL.toLowerCase()
}

// ── Trusted device ────────────────────────────────────────────────────────────

export function setTrustedDevice(): void {
  localStorage.setItem(TRUSTED_KEY, '1')
}

export function isTrustedDevice(): boolean {
  return localStorage.getItem(TRUSTED_KEY) === '1'
}

export function clearTrust(): void {
  localStorage.removeItem(TRUSTED_KEY)
}

// ── Owner UID (for master key boot when session exists locally) ───────────────

export function storeOwnerUID(uid: string): void {
  localStorage.setItem(OWNER_UID_KEY, uid)
}

export function getOwnerUID(): string | null {
  return localStorage.getItem(OWNER_UID_KEY)
}

// ── Master key overlay ────────────────────────────────────────────────────────
// A simple text input that accepts the passcode OR the master email.
// Rendered on top of everything (z-index 99999).

let _mkEl: HTMLElement | null = null

/** Called with the email the user typed (if they entered an email), or undefined
 *  (if they entered the passcode). The caller uses this to know where to send the OTP. */
export function showMasterKeyOverlay(onSuccess: (enteredEmail?: string) => void): void {
  if (_mkEl) return
  _mkEl = document.createElement('div')
  _mkEl.style.cssText = [
    'position:fixed;inset:0;z-index:99999;',
    'background:rgba(5,7,15,.96);backdrop-filter:blur(14px);',
    'display:flex;align-items:center;justify-content:center;padding:20px;',
  ].join('')

  _mkEl.innerHTML = `
    <div style="background:var(--bg-2,#0d1117);border:1px solid var(--line-2,#1e2433);
                border-radius:16px;padding:36px 32px;width:100%;max-width:380px;text-align:center;">
      <div style="font-size:36px;margin-bottom:14px;">🔑</div>
      <div style="font-family:var(--font-display,sans-serif);font-size:18px;font-weight:600;
                  color:var(--ink,#e8eaf0);margin-bottom:8px;">Master Access</div>
      <div style="font-family:var(--font-mono,monospace);font-size:12px;color:var(--muted,#5a6480);
                  margin-bottom:26px;line-height:1.7;">
        Enter the master passcode<br>or the master recovery email.
      </div>
      <input id="mk-inp"
        type="text"
        placeholder="Passcode or email address…"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        style="width:100%;box-sizing:border-box;padding:13px 16px;
               background:var(--panel-2,#111827);border:1.5px solid var(--line-2,#1e2433);
               border-radius:10px;color:var(--ink,#e8eaf0);
               font-family:var(--font-mono,monospace);font-size:14px;
               outline:none;margin-bottom:10px;transition:border-color .15s;
               text-align:center;letter-spacing:.08em;" />
      <p id="mk-err"
         style="font-family:var(--font-mono,monospace);font-size:12px;
                color:var(--bad,#e05555);min-height:16px;margin:0 0 18px;"></p>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button id="mk-cancel"
          style="background:none;border:1px solid var(--line-2,#1e2433);border-radius:8px;
                 color:var(--muted,#5a6480);font-family:var(--font-mono,monospace);
                 font-size:12px;padding:9px 22px;cursor:pointer;transition:border-color .15s;">
          Cancel
        </button>
        <button id="mk-submit"
          style="background:var(--accent,#5080ff);border:none;border-radius:8px;
                 color:#fff;font-family:var(--font-mono,monospace);font-size:12px;
                 padding:9px 22px;cursor:pointer;font-weight:600;letter-spacing:.04em;">
          Unlock
        </button>
      </div>
    </div>
  `
  document.body.appendChild(_mkEl)

  const inp = _mkEl.querySelector('#mk-inp') as HTMLInputElement
  const err = _mkEl.querySelector('#mk-err') as HTMLElement

  inp.addEventListener('focus', () => {
    inp.style.borderColor = 'var(--accent,#5080ff)'
  })
  inp.addEventListener('blur', () => {
    inp.style.borderColor = 'var(--line-2,#1e2433)'
  })

  function tryMaster(): void {
    if (isMasterKey(inp.value)) {
      _mkEl?.remove()
      _mkEl = null
      // Pass the email if the user typed an email address; undefined for passcode
      const v = inp.value.trim()
      onSuccess(v.includes('@') ? v : undefined)
    } else {
      err.textContent = 'Invalid master credentials — try again.'
      inp.style.borderColor = 'var(--bad,#e05555)'
      inp.select()
    }
  }

  inp.addEventListener('keydown', e => { if (e.key === 'Enter') tryMaster() })
  _mkEl.querySelector('#mk-submit')?.addEventListener('click', tryMaster)
  _mkEl.querySelector('#mk-cancel')?.addEventListener('click', () => {
    _mkEl?.remove()
    _mkEl = null
  })

  setTimeout(() => inp.focus(), 80)
}
