/**
 * jarvis-dom-control.ts — Universal DOM Control Layer
 *
 * Gives JARVIS complete control over every interactive element on the page.
 * JARVIS can read, write, click, fill, submit, and monitor anything.
 */

// ── Element registry — maps semantic names to DOM selectors ──────────────────

const ELEMENT_MAP: Record<string, string> = {
  // Timer
  'timer-start':    '[data-act="start"]',
  'timer-reset':    '[data-act="reset"]',
  'timer-skip':     '[data-act="skip"]',
  'timer-display':  '.ring-time',
  'timer-session':  '.ring-sess',

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

  // Constitution
  'const-search':   '#const-search',
  'const-preamble': '#const-preamble-btn',

  // Settings
  'settings-prelims-date': '#st-prelims-date',
  'settings-save':         '#st-save',

  // SRS rating
  'srs-again': '.srs-btn[data-recall="again"]',
  'srs-hard':  '.srs-btn[data-recall="hard"]',
  'srs-good':  '.srs-btn[data-recall="good"]',
  'srs-easy':  '.srs-btn[data-recall="easy"]',

  // JARVIS panel
  'jarvis-btn':  '#jarvis-btn',
  'jarvis-text': '#jp-text',
  'jarvis-send': '#jp-send',
  'jarvis-mic':  '#jp-mic',

  // Focus mode
  'focus-mode-btn': '#focus-mode-btn',

  // Screen lock
  'lock-btn': '#lock-btn',

  // Command menu
  'cmd-menu-btn': '#command-menu-btn',
  'cmd-menu':     '#command-menu',
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
