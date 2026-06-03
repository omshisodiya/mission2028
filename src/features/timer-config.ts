/**
 * timer-config.ts — Configurable Focus Timer (v3-C spec).
 * Clones the engine's buttons to remove hardcoded listeners, then drives the
 * ring/display with our own loop using user-configured durations.
 * Config persisted in store('timerConfig'). Logs actual configured minutes.
 */

export interface TimerConfig {
  focus:          number   // minutes
  shortBreak:     number
  longBreak:      number
  sessionsPerLong: number
}

const DEFAULT: TimerConfig = { focus: 25, shortBreak: 5, longBreak: 20, sessionsPerLong: 4 }

type Store = { get(k: string, def: unknown): unknown; set(k: string, v: unknown): void }

function store(): Store | null {
  return (window as { MISSION?: { store: Store } }).MISSION?.store ?? null
}

export function loadTimerConfig(): TimerConfig {
  const s = store()?.get('timerConfig', null) as Partial<TimerConfig> | null
  return s ? { ...DEFAULT, ...s } : { ...DEFAULT }
}

export function initConfigurableTimer(): void {
  // Run after engine's focusTimer() has registered its handlers
  setTimeout(setup, 400)
}

function setup(): void {
  const card    = document.getElementById('focus')
  if (!card) return

  const fg      = card.querySelector<SVGCircleElement>('.ring-fg')
  const timeEl  = card.querySelector<HTMLElement>('.ring-time')
  const modeEl  = card.querySelector<HTMLElement>('.ring-mode')
  const startBtn = card.querySelector<HTMLButtonElement>('[data-act="start"]')
  const resetBtn = card.querySelector<HTMLButtonElement>('[data-act="reset"]')
  const skipBtn  = card.querySelector<HTMLButtonElement>('[data-act="skip"]')
  const sessEl  = document.getElementById('sess-count')
  const minEl   = document.getElementById('focus-mins')
  if (!fg || !timeEl || !startBtn) return

  const R = 116, C = 2 * Math.PI * R
  fg.style.strokeDasharray = String(C)

  // ── State ─────────────────────────────────────────────────────────────────
  let cfg: TimerConfig = loadTimerConfig()
  type Mode = 'focus' | 'shortBreak' | 'longBreak'
  let mode: Mode = 'focus', total = 0, remaining = 0
  let running = false, iv: ReturnType<typeof setInterval> | null = null
  let focusDone = 0   // sessions this run (for long-break trigger)

  // ── Render ────────────────────────────────────────────────────────────────
  function render(): void {
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0')
    const ss = String(remaining % 60).padStart(2, '0')
    if (timeEl) timeEl.textContent = `${mm}:${ss}`
    if (modeEl) modeEl.textContent = mode === 'focus' ? 'Deep Focus' : mode === 'shortBreak' ? 'Short Break' : 'Long Break'
    if (fg)     fg.style.strokeDashoffset = String(C * (1 - (total - remaining) / total))
    // startBtn was replaced by a clone — find the ACTUAL visible button via live DOM query
    const liveStart = card?.querySelector<HTMLButtonElement>('[data-act="start"]')
    if (liveStart) liveStart.textContent = running ? 'Pause' : remaining < total ? 'Resume' : 'Start'
    if (running) emblemShowTimer(mm, ss); else emblemRestore()
  }

  function applyMode(m: Mode): void {
    mode = m
    total = (m === 'focus' ? cfg.focus : m === 'shortBreak' ? cfg.shortBreak : cfg.longBreak) * 60
    remaining = total; render()
  }

  function logFocusSession(): void {
    const s = store(); if (!s) return
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    const log = (s.get('focusLog', {}) as Record<string, number>)
    log[today] = (log[today] || 0) + 1; s.set('focusLog', log)
    const tot = (s.get('sessTotal', 0) as number) + 1; s.set('sessTotal', tot)
    const mins = (s.get('focusMins', 0) as number) + cfg.focus; s.set('focusMins', mins)
    if (sessEl) sessEl.textContent = String(tot)
    if (minEl)  minEl.textContent  = String(mins)
    focusDone++
  }

  function tickDown(): void {
    remaining--
    if (remaining < 0) {
      clearInterval(iv!); iv = null; running = false
      card?.animate([
        { boxShadow: '0 0 0 0 rgba(240,181,74,.5)' },
        { boxShadow: '0 0 0 28px rgba(240,181,74,0)' }
      ], { duration: 800 })
      if (mode === 'focus') {
        logFocusSession()
        applyMode(focusDone % cfg.sessionsPerLong === 0 ? 'longBreak' : 'shortBreak')
      } else {
        applyMode('focus')
      }
      return
    }
    render()
  }

  function toggle(): void {
    running = !running
    if (running) iv = setInterval(tickDown, 1000)
    else { clearInterval(iv!); iv = null }
    render()
  }

  function reset(): void {
    if (iv) { clearInterval(iv!); iv = null }
    running = false; applyMode(mode)
  }

  function skip(): void {
    if (iv) { clearInterval(iv!); iv = null }
    running = false
    if (mode === 'focus') {
      logFocusSession()
      applyMode(focusDone % cfg.sessionsPerLong === 0 ? 'longBreak' : 'shortBreak')
    } else applyMode('focus')
  }

  // Clone buttons to remove engine's hardcoded handlers
  function repl(btn: HTMLButtonElement | null, fn: () => void): void {
    if (!btn) return
    const nb = btn.cloneNode(true) as HTMLButtonElement
    btn.replaceWith(nb); nb.addEventListener('click', fn)
  }
  repl(startBtn, toggle)
  repl(resetBtn, reset)
  repl(skipBtn, skip)

  // ── Emblem stamp: fade to running time while timer is active ─────────────
  const emblem  = document.getElementById('emblem-stamp')
  const esCore  = emblem?.querySelector<HTMLElement>('.es-core')
  const esRing  = emblem?.querySelector<HTMLElement>('.es-ring')
  const esMotto = emblem?.querySelector<HTMLElement>('.es-motto')
  let emblemDisplay: HTMLElement | null = null

  if (emblem && esCore) {
    // Inject time overlay inside the emblem stamp
    emblemDisplay = document.createElement('div')
    emblemDisplay.id = 'emblem-timer-val'
    emblemDisplay.style.cssText =
      'position:absolute;top:44%;left:50%;transform:translate(-50%,-50%);' +
      'font-family:var(--font-display);font-size:15px;font-weight:700;' +
      'color:var(--accent);letter-spacing:.1em;pointer-events:none;opacity:0;' +
      'transition:opacity .35s;z-index:2;text-align:center;'
    emblem.appendChild(emblemDisplay)
    ;[esCore, esRing, esMotto].forEach(el => {
      if (el) el.style.transition = 'opacity .35s'
    })
    // Hover: temporarily restore emblem while hovering
    emblem.addEventListener('mouseenter', () => {
      if (!running) return
      if (esCore)  esCore.style.opacity  = '1'
      if (esRing)  esRing.style.opacity  = '1'
      if (esMotto) esMotto.style.opacity = '1'
      if (emblemDisplay) emblemDisplay.style.opacity = '0'
    })
    emblem.addEventListener('mouseleave', () => {
      if (!running) return
      if (esCore)  esCore.style.opacity  = '0'
      if (esRing)  esRing.style.opacity  = '0.35'
      if (esMotto) esMotto.style.opacity = '0'
      if (emblemDisplay) emblemDisplay.style.opacity = '1'
    })
  }

  function emblemShowTimer(mm: string, ss: string): void {
    if (!emblemDisplay) return
    emblemDisplay.textContent = `${mm}:${ss}`
    emblemDisplay.style.opacity = '1'
    if (esCore)  esCore.style.opacity  = '0'      // photo completely gone
    if (esRing)  esRing.style.opacity  = '0.35'   // ring faintly visible
    if (esMotto) esMotto.style.opacity = '0'
  }

  function emblemRestore(): void {
    if (emblemDisplay) emblemDisplay.style.opacity = '0'
    if (esCore)  esCore.style.opacity  = '1'
    if (esRing)  esRing.style.opacity  = '1'
    if (esMotto) esMotto.style.opacity = '1'
  }

  // ── Config UI ─────────────────────────────────────────────────────────────
  if (!document.getElementById('tcfg-ui')) {
    const ui = document.createElement('div')
    ui.id = 'tcfg-ui'
    ui.style.cssText =
      'width:100%;margin-top:14px;border-top:1px solid var(--line);padding-top:10px;' +
      'display:flex;flex-direction:column;gap:6px;'
    ui.innerHTML =
      `<div style="text-align:center;font-family:var(--font-mono);font-size:9px;color:var(--muted);letter-spacing:.14em;margin-bottom:2px;">TIMER SETTINGS</div>` +
      row('focus',      'FOCUS',       cfg.focus,       5, 120) +
      row('shortBreak', 'SHORT BREAK', cfg.shortBreak,  1, 30)  +
      row('longBreak',  'LONG BREAK',  cfg.longBreak,   5, 60)

    card?.querySelector('.timer-actions')?.insertAdjacentElement('afterend', ui)

    // Bind +/− handlers
    ui.querySelectorAll<HTMLButtonElement>('.tc-btn').forEach(btn => {
      btn.addEventListener('mouseover', () => (btn.style.borderColor = 'var(--accent)'))
      btn.addEventListener('mouseout',  () => (btn.style.borderColor = 'var(--line-2)'))
      btn.addEventListener('click', () => {
        const k = btn.dataset.k as keyof TimerConfig
        const d = parseInt(btn.dataset.d!)
        const MINS: Record<string, number> = { focus: 5, shortBreak: 1, longBreak: 5 }
        const MAXS: Record<string, number> = { focus: 120, shortBreak: 30, longBreak: 60 }
        cfg[k] = Math.max(MINS[k], Math.min(MAXS[k], cfg[k] + d))
        const vEl = ui.querySelector<HTMLElement>(`.tc-val[data-k="${k}"]`)
        if (vEl) vEl.textContent = String(cfg[k])
        store()?.set('timerConfig', cfg)
        // Apply immediately if in that mode and not running
        if (k === mode && !running) applyMode(mode)
      })
    })
  }

  applyMode('focus')   // initial render with configured time

  // JARVIS can set a custom focus duration and start immediately
  window.addEventListener('jarvis:set-timer', (e: Event) => {
    const detail = (e as CustomEvent<{ focus: number }>).detail
    if (!detail?.focus) return
    cfg.focus = detail.focus
    store()?.set('timerConfig', cfg)
    // Stop current timer, reset to new duration
    if (iv) { clearInterval(iv!); iv = null }
    running = false
    applyMode('focus')
    // Auto-start after a short render delay
    setTimeout(() => {
      if (!running) { running = true; iv = setInterval(tickDown, 1000); render() }
    }, 200)
  })
}

function row(k: string, label: string, val: number, _min: number, _max: number): string {
  const btn = (d: number, symbol: string) =>
    `<button class="tc-btn" data-k="${k}" data-d="${d}"
      style="width:22px;height:22px;border-radius:50%;border:1px solid var(--line-2);
      background:var(--panel-2);color:var(--ink);cursor:pointer;font-size:13px;
      display:flex;align-items:center;justify-content:center;transition:border-color .15s;">
      ${symbol}</button>`
  return `
    <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
      <span style="font-family:var(--font-mono);font-size:9px;color:var(--muted);letter-spacing:.1em;min-width:74px;text-align:right;">${label}</span>
      ${btn(-1, '−')}
      <span class="tc-val" data-k="${k}" style="font-family:var(--font-display);font-size:17px;font-weight:700;color:var(--accent);min-width:28px;text-align:center;">${val}</span>
      <span style="font-family:var(--font-mono);font-size:9px;color:var(--muted);">min</span>
      ${btn(1, '+')}
    </div>`
}
