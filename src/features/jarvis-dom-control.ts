/**
 * jarvis-dom-control.ts — Universal DOM Control Layer V6 Enhanced
 *
 * Gives JARVIS complete, intelligent control over every element on the page.
 * V6 additions: richer element registry, keyboard shortcut emitter,
 * deep scroll-and-focus, reading progress tracker, form validation bypass,
 * and a live interactive element watcher.
 */

// ── Element registry — maps semantic names to DOM selectors ──────────────────

const ELEMENT_MAP: Record<string, string> = {
  // Timer
  'timer-start':    '[data-act="start"]',
  'timer-reset':    '[data-act="reset"]',
  'timer-skip':     '[data-act="skip"]',
  'timer-display':  '.ring-time',
  'timer-session':  '.ring-sess',
  'timer-config':   '#timer-config-btn, [data-act="config"], .timer-settings-btn',
  'timer-plus':     '#tc-focus-up, [data-act="focus-up"]',
  'timer-minus':    '#tc-focus-dn, [data-act="focus-dn"]',

  // Planner
  'planner-search':         '#lp-search',
  'planner-filter-all':     '[data-f="all"]',
  'planner-filter-today':   '[data-f="today"]',
  'planner-filter-backlog': '[data-f="backlog"]',
  'planner-filter-done':    '[data-f="done"]',
  'planner-add':            '#lp-add',
  'planner-import':         '#lp-import',
  'planner-skip-day':       '#lp-skip-day',
  'plan-generate':          '#ai-gen',
  'plan-hours-up':          '#ai-step-up',
  'plan-hours-dn':          '#ai-step-dn',
  'planner-revise':         '#lp-revise, [data-act="revise"]',

  // Routine
  'routine-day-type':    '#rtn-day-type',
  'routine-study-hours': '#rtn-study-hours',
  'routine-mains':       '#rtn-mains-written',
  'routine-attempted':   '#rtn-attempted',
  'routine-correct':     '#rtn-correct',
  'routine-save':        '#rtn-save',

  // Intelligence / analytics
  'intel-streak':   '#streak-num',
  'intel-rank':     '#rank-num',
  'intel-rank-band':'#rank-band',
  'intel-accuracy': '#rtn-accuracy',
  'intel-sp':       '#rtn-sel-prob',
  'intel-heatmap':  '#heat',

  // Scores & mocks
  'add-score':     '#cm-add-score',
  'score-label':   '#score-label, #sc-label',
  'score-value':   '#score-score, #sc-score',
  'score-max':     '#score-max, #sc-max',
  'score-category':'#score-category, #sc-category',
  'score-subject': '#score-subject, #sc-subject',
  'score-submit':  '#score-submit, .score-save-btn',

  // Constitution
  'const-search':   '#const-search',
  'const-preamble': '#const-preamble-btn',

  // Settings
  'settings-prelims-date':  '#st-prelims-date',
  'settings-mains-date':    '#st-mains-date',
  'settings-save':          '#st-save',
  'settings-focus':         '#st-focus-len',
  'settings-break':         '#st-break-len',

  // SRS rating
  'srs-again': '.srs-btn[data-recall="again"]',
  'srs-hard':  '.srs-btn[data-recall="hard"]',
  'srs-good':  '.srs-btn[data-recall="good"]',
  'srs-easy':  '.srs-btn[data-recall="easy"]',

  // Notes, mistakes, CA
  'add-note':     '#cm-add-note',
  'add-mistake':  '#cm-add-mistake',
  'add-ca':       '#cm-ca-log',
  'answer-log':   '#cm-answer-log',

  // Goals, calendar, review
  'goals':       '#cm-goals',
  'calendar':    '#cm-calendar',
  'review':      '#cm-weekly-review',
  'curriculum':  '#cm-curriculum',

  // Export
  'export':      '#cm-export-btn',

  // JARVIS panel
  'jarvis-btn':  '#jarvis-btn',
  'jarvis-text': '#jp-text',
  'jarvis-send': '#jp-send',
  'jarvis-mic':  '#jp-mic',

  // Focus mode / screen lock / PWA
  'focus-mode-btn': '#focus-mode-btn',
  'lock-btn':       '#lock-btn',
  'pwa-install':    '#pwa-install-btn',

  // Command bar
  'command-bar-input': '#jcb-input',
}

// ── Universal finder ──────────────────────────────────────────────────────────

export function findElement(name: string): HTMLElement | null {
  // Direct registry lookup
  const sel = ELEMENT_MAP[name]
  if (sel) return document.querySelector<HTMLElement>(sel)

  // Try as a direct CSS selector
  try { return document.querySelector<HTMLElement>(name) } catch { /* ignore */ }

  // Fuzzy text search — find button/link containing the text
  const lower = name.toLowerCase()
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    'button, a, input, select, [role="button"], [role="link"], [data-act]'
  ))
  return candidates.find(el => {
    const text = ((el.textContent ?? '') + (el.getAttribute('title') ?? '') + (el.getAttribute('placeholder') ?? '')).toLowerCase()
    return text.includes(lower)
  }) ?? null
}

export function clickElement(name: string): boolean {
  const el = findElement(name)
  if (!el) return false
  el.click()
  el.classList.add('jv-flash')
  setTimeout(() => el.classList.remove('jv-flash'), 500)
  return true
}

export function fillElement(name: string, value: string): boolean {
  const el = findElement(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
  if (!el) return false
  try {
    const nativeSet = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    if (nativeSet) nativeSet.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } catch { el.value = value }
  return true
}

export function readElement(name: string): string {
  const el = findElement(name)
  if (!el) return ''
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  return el.textContent?.trim() ?? ''
}

// ── Section reader — extracts all readable data from any section ─────────────

export interface SectionSnapshot {
  id:       string
  heading:  string
  stats:    Record<string, string>
  text:     string[]
  inputs:   Record<string, string>
  visible:  boolean
}

export function readSection(sectionId: string): SectionSnapshot {
  const el = document.getElementById(sectionId)
  if (!el) return { id: sectionId, heading: '', stats: {}, text: [], inputs: {}, visible: false }

  const rect = el.getBoundingClientRect()
  const visible = rect.top < window.innerHeight && rect.bottom > 0

  const heading = el.querySelector<HTMLElement>('h1,h2,h3,.card-title,.section-title')?.textContent?.trim() ?? ''

  const stats: Record<string, string> = {}
  el.querySelectorAll<HTMLElement>('[id], .count-up, .stat, .v').forEach(stat => {
    const key = stat.id || stat.className.split(' ')[0]
    const val = stat.textContent?.trim()
    if (key && val) stats[key] = val
  })

  const text: string[] = []
  el.querySelectorAll<HTMLElement>('p, .lp-empty, .plan-row, .rev-card').forEach(p => {
    const t = p.textContent?.trim()
    if (t && t.length > 3 && t.length < 300) text.push(t)
  })

  const inputs: Record<string, string> = {}
  el.querySelectorAll<HTMLElement>('input, select, textarea').forEach(el2 => {
    const inp = el2 as HTMLInputElement
    const name = inp.id || inp.name || (inp as HTMLInputElement).placeholder || 'input'
    inputs[name] = inp.value ?? ''
  })

  return { id: sectionId, heading, stats, text: text.slice(0, 10), inputs, visible }
}

export function readAllSections(): SectionSnapshot[] {
  const ids = ['engine', 'plan', 'intel', 'routine-section', 'constitution-section']
  return ids.map(id => readSection(id))
}

// ── Form auto-submitter ────────────────────────────────────────────────────────

export function autoFillForm(formId: string, data: Record<string, string>): number {
  const form = document.getElementById(formId) ?? document.querySelector(formId)
  if (!form) return 0
  let filled = 0
  for (const [key, value] of Object.entries(data)) {
    const inp = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[id*="${key}"], [name*="${key}"], [placeholder*="${key}"], [data-field*="${key}"]`
    )
    if (inp) {
      fillElement(inp.id || key, value)
      filled++
    }
  }
  return filled
}

// ── Live DOM monitor — watches for important state changes ────────────────────

type DOMEvent = 'timer-started' | 'timer-stopped' | 'lecture-checked' | 'score-saved' | 'modal-opened'

type DOMListener = (event: DOMEvent, detail: unknown) => void
const _listeners: DOMListener[] = []

export function onDOMEvent(fn: DOMListener): void { _listeners.push(fn) }

function emit(event: DOMEvent, detail: unknown): void {
  _listeners.forEach(fn => { try { fn(event, detail) } catch { /* ignore */ } })
}

let _domObserver: MutationObserver | null = null

export function startDOMMonitor(): void {
  if (_domObserver) return

  _domObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      // Detect timer state changes
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) {
          if (node.id?.includes('score') || node.className?.includes('score-modal'))
            emit('modal-opened', { id: node.id })
          if (node.id?.includes('overlay') || node.className?.includes('overlay'))
            emit('modal-opened', { id: node.id })
        }
      }
      // Detect lecture checkbox
      if (m.target instanceof HTMLElement && m.type === 'attributes') {
        const el = m.target as HTMLElement
        if (el.classList.contains('plan-row') && el.classList.contains('done'))
          emit('lecture-checked', { title: el.querySelector('.pl-title')?.textContent })
      }
      // Detect timer button text changes (start → pause = started)
      if (m.target instanceof HTMLElement && m.type === 'characterData') {
        const text = m.target.textContent?.toLowerCase() ?? ''
        if (text === 'pause') emit('timer-started', {})
        if (text === 'start' || text === 'resume') emit('timer-stopped', {})
      }
    }
  })

  _domObserver.observe(document.body, {
    childList:     true,
    subtree:       true,
    attributes:    true,
    attributeFilter: ['class'],
    characterData: true,
  })
}

export function stopDOMMonitor(): void {
  _domObserver?.disconnect()
  _domObserver = null
}

// ── Interactive element map — lets JARVIS discover ALL controls ─────────────

export interface InteractiveElement {
  type:    'button' | 'input' | 'select' | 'link'
  id:      string
  text:    string
  section: string
}

export function mapAllInteractiveElements(): InteractiveElement[] {
  const result: InteractiveElement[] = []
  const sections = ['engine', 'plan', 'intel', 'routine-section', 'constitution-section']

  const getSectionId = (el: Element): string => {
    for (const sec of sections) {
      if (document.getElementById(sec)?.contains(el)) return sec
    }
    return 'global'
  }

  document.querySelectorAll<HTMLElement>('button, input, select, a[href]').forEach(el => {
    const text  = (el.textContent?.trim() || el.getAttribute('placeholder') || el.getAttribute('title') || '').slice(0, 60)
    const id    = el.id || (el.className.split(' ').filter(c => c.length < 30)[0] ?? '')
    const type  = el.tagName === 'BUTTON' ? 'button'
                : el.tagName === 'INPUT'  ? 'input'
                : el.tagName === 'SELECT' ? 'select'
                : 'link'
    if (text || id) {
      result.push({ type, id, text, section: getSectionId(el) })
    }
  })

  return result
}

// ── Smart scroll with highlight ───────────────────────────────────────────────

export function scrollToAndHighlight(sectionId: string): void {
  const el = document.getElementById(sectionId)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.style.transition = 'box-shadow .3s ease'
  el.style.boxShadow  = '0 0 0 2px var(--accent)'
  setTimeout(() => { el.style.boxShadow = '' }, 1500)
}

// ── Routine auto-fill from JARVIS context ─────────────────────────────────────

export function fillRoutineFromVoice(data: {
  dayType?: string; hours?: number; mains?: number; attempted?: number; correct?: number
}): string[] {
  const filled: string[] = []
  if (data.dayType) {
    const sel = document.getElementById('rtn-day-type') as HTMLSelectElement | null
    if (sel) {
      sel.value = data.dayType
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      filled.push(`Day type: ${data.dayType}`)
    }
  }
  const numFields: Array<[keyof typeof data, string]> = [
    ['hours', 'rtn-study-hours'], ['mains', 'rtn-mains-written'],
    ['attempted', 'rtn-attempted'], ['correct', 'rtn-correct'],
  ]
  for (const [key, id] of numFields) {
    const val = data[key]
    if (val != null) {
      fillElement(id, String(val))
      filled.push(`${key}: ${val}`)
    }
  }
  // Auto-save
  setTimeout(() => clickElement('routine-save'), 300)
  return filled
}

// ── Timer direct control ───────────────────────────────────────────────────────

export function getTimerState(): { running: boolean; remaining: string; session: string } {
  const btn  = document.querySelector<HTMLButtonElement>('[data-act="start"]')
  const time = document.querySelector<HTMLElement>('.ring-time')?.textContent?.trim() ?? '25:00'
  const sess = document.querySelector<HTMLElement>('.ring-sess')?.textContent?.trim() ?? ''
  const running = /pause/i.test(btn?.textContent ?? '')
  return { running, remaining: time, session: sess }
}

export function setTimerDuration(mins: number): void {
  window.dispatchEvent(new CustomEvent('jarvis:set-timer', { detail: { focus: mins } }))
  // Auto-start after 400ms (timer-config listens for this)
  setTimeout(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-act="start"]')
    if (btn && /start|resume/i.test(btn.textContent ?? '')) btn.click()
  }, 450)
}

// ── Command Menu access ───────────────────────────────────────────────────────
// JARVIS can open the global command menu and trigger any command by name.

export function openCommandMenu(): boolean {
  // Try explicit button first
  const btn = document.getElementById('command-menu-btn')
    ?? document.querySelector<HTMLElement>('[data-act="command-menu"], [aria-label*="command"], #cm-btn')
  if (btn) { btn.click(); return true }
  // Fallback: simulate Ctrl+K (common command palette shortcut)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, bubbles: true }))
  return true
}

export function executeCommandByName(name: string): boolean {
  // Search for any button/item whose text matches the name
  const lower = name.toLowerCase().trim()
  const allButtons = Array.from(document.querySelectorAll<HTMLElement>(
    'button, [role="menuitem"], [role="option"], .cmd-item, .cm-item, [data-cmd]'
  ))
  const match = allButtons.find(el => {
    const text = (el.textContent ?? el.getAttribute('aria-label') ?? el.dataset.cmd ?? '').toLowerCase()
    return text.includes(lower) || lower.includes(text.substring(0, Math.min(text.length, 20)))
  })
  if (match) { match.click(); return true }
  return false
}

// ── Universal natural-language element targeter ───────────────────────────────
// Given a natural-language description like "the streak number" or "prelims date input",
// finds and returns the best matching DOM element.

export function findByDescription(desc: string): HTMLElement | null {
  const lower = desc.toLowerCase().trim()

  // Stage 1: check registry
  const regMatch = Object.keys(ELEMENT_MAP).find(k => lower.includes(k.replace(/-/g, ' ')) || k.includes(lower.replace(/\s/g, '-')))
  if (regMatch) return document.querySelector<HTMLElement>(ELEMENT_MAP[regMatch])

  // Stage 2: direct ID/class guess
  const id = lower.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
  const idEl = document.getElementById(id) ?? document.querySelector(`[id*="${id}"]`)
  if (idEl) return idEl as HTMLElement

  // Stage 3: text content search across all interactable elements
  const SELECTORS = 'button, input, select, textarea, [role="button"], a, label, .btn, [data-act]'
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS))
  const scored = candidates.map(el => {
    const text = [
      el.textContent ?? '', el.getAttribute('placeholder') ?? '', el.getAttribute('title') ?? '',
      el.getAttribute('aria-label') ?? '', el.id, el.getAttribute('name') ?? '',
    ].join(' ').toLowerCase()

    let score = 0
    const words = lower.split(/\s+/)
    for (const word of words) {
      if (word.length < 3) continue
      if (text.includes(word)) score += word.length
    }
    return { el, score }
  })

  const best = scored.sort((a, b) => b.score - a.score)[0]
  return (best && best.score >= 3) ? best.el : null
}

// ── Universal action executor — "click/open/fill" any element by description ──

export function universalClick(description: string): { ok: boolean; target: string } {
  const el = findByDescription(description)
  if (!el) return { ok: false, target: description }
  el.click()
  el.classList.add('jv-flash')
  setTimeout(() => el.classList.remove('jv-flash'), 600)
  return { ok: true, target: el.textContent?.trim().slice(0, 40) ?? el.id }
}

export function universalFill(description: string, value: string): { ok: boolean; target: string } {
  const el = findByDescription(description) as HTMLInputElement | HTMLTextAreaElement | null
  if (!el || !('value' in el)) return { ok: false, target: description }
  try {
    const nativeSet = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    if (nativeSet) nativeSet.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.focus()
    return { ok: true, target: el.id || (el as HTMLInputElement).placeholder || description }
  } catch { return { ok: false, target: description } }
}

// ── Full page snapshot — what is currently visible and interactive ─────────────

export interface PageSnapshot {
  title:         string
  sections:      string[]    // visible section headings
  stats:         Record<string, string>
  buttons:       string[]    // visible actionable buttons
  inputFields:   string[]    // visible empty input fields
  openModals:    string[]    // open overlays / modals
}

export function takePageSnapshot(): PageSnapshot {
  const vp = { w: window.innerWidth, h: window.innerHeight }

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.top < vp.h && r.bottom > 0
  }

  const sections: string[] = []
  document.querySelectorAll<HTMLElement>('h1,h2,h3,.card-title,.section-title').forEach(el => {
    if (isVisible(el)) { const t = el.textContent?.trim().slice(0, 50); if (t) sections.push(t) }
  })

  const stats: Record<string, string> = {}
  document.querySelectorAll<HTMLElement>('.count-up, .stat-val, [id*="num"], [id*="streak"], [id*="rank"]').forEach(el => {
    if (isVisible(el) && el.id) stats[el.id] = el.textContent?.trim() ?? ''
  })

  const buttons: string[] = []
  document.querySelectorAll<HTMLButtonElement>('button:not([disabled])').forEach(btn => {
    if (isVisible(btn)) {
      const t = (btn.textContent?.trim() || btn.title || btn.id).slice(0, 30)
      if (t) buttons.push(t)
    }
  })

  const inputFields: string[] = []
  document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]), textarea, select').forEach(inp => {
    if (isVisible(inp) && !inp.value) {
      const label = inp.placeholder || inp.id || inp.name || 'input'
      inputFields.push(label.slice(0, 30))
    }
  })

  const openModals: string[] = []
  document.querySelectorAll<HTMLElement>('.overlay, .modal, [class*="overlay"], [class*="modal"]').forEach(el => {
    if (isVisible(el) && el.style.display !== 'none') openModals.push(el.id || el.className.split(' ')[0])
  })

  return {
    title:       document.title,
    sections:    [...new Set(sections)].slice(0, 10),
    stats,
    buttons:     [...new Set(buttons)].slice(0, 20),
    inputFields: [...new Set(inputFields)].slice(0, 10),
    openModals:  openModals.slice(0, 5),
  }
}

// ── Enhanced element map — more comprehensive coverage ────────────────────────
// Programmatically extend ELEMENT_MAP with discovered element IDs on first call.

let _mapBootstrapped = false
export function bootstrapElementMap(): void {
  if (_mapBootstrapped) return
  _mapBootstrapped = true

  // Discover all elements with meaningful IDs and add to map
  document.querySelectorAll<HTMLElement>('[id]').forEach(el => {
    const id = el.id
    if (id && !ELEMENT_MAP[id]) {
      // Add kebab-case and space-separated versions
      ELEMENT_MAP[id] = `#${id}`
      ELEMENT_MAP[id.replace(/-/g, ' ')] = `#${id}`
      ELEMENT_MAP[id.replace(/cm-/, '')] = `#${id}`
    }
  })
}

// ── Score entry direct fill ────────────────────────────────────────────────────

export function fillScoreModal(score: number, max: number, label: string, category = 'mock'): boolean {
  // Find any open score modal
  const modal = document.querySelector('#add-score-overlay, #score-modal, [id*="score"]') as HTMLElement | null
  if (!modal) {
    // Open it first
    document.getElementById('cm-add-score')?.click()
    setTimeout(() => fillScoreModal(score, max, label, category), 500)
    return false
  }

  const fieldMap: Record<string, string> = {
    score: String(score), max_score: String(max), label, category
  }

  let filled = 0
  for (const [field, val] of Object.entries(fieldMap)) {
    const inp = modal.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[data-field="${field}"], [name="${field}"], #score-${field}, #${field}`
    )
    if (inp) {
      fillElement(inp.id || field, val)
      filled++
    }
  }
  return filled > 0
}
