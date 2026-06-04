/**
 * calendar-view.ts — Week/Month Agenda overlaying:
 * - Planner blocks (plan_days/plan_blocks)
 * - SRS revisions due (from DOM)
 * - Scheduled mocks
 * No new DB reads — all data pulled from existing live DOM + store.
 */
import { todayIST } from '../services/core'
import { getCurrentState } from './core-engine'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return `${DAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`
}

function getWeekStart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow  = date.getUTCDay()
  return new Date(date.getTime() - dow * 86_400_000).toISOString().slice(0, 10)
}

interface AgendaDay {
  date:     string
  label:    string
  isToday:  boolean
  subject:  string
  items:    { text: string; type: 'study' | 'revision' | 'mock' | 'exam' }[]
}

function buildWeekAgenda(weekStart: string): AgendaDay[] {
  const today = todayIST()
  const cs    = getCurrentState()

  // Get revision due dates from DOM
  const revDueDates = new Set<string>()
  document.querySelectorAll<HTMLElement>('.rev-card, [data-due]').forEach(el => {
    const due = el.dataset.due ?? el.querySelector('[data-due]')?.getAttribute('data-due')
    if (due) revDueDates.add(due)
  })

  // Subject rotation map (same as core-engine)
  const SUBJ_MAP: Record<string, string> = {
    Mon: 'SJS + Polity', Tue: 'Geography', Wed: 'Environment',
    Thu: 'Medieval History + Mathematics', Fri: 'Economy', Sat: 'Mathematics', Sun: 'Revision',
  }

  return Array.from({ length: 7 }, (_, i) => {
    const date    = addDays(weekStart, i)
    const [y, mo, d] = date.split('-').map(Number)
    const dow     = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
    const isToday = date === today
    const subject = (isToday && cs?.today?.subject) ? cs.today.subject : (SUBJ_MAP[DAYS[dow]] ?? '')

    const items: AgendaDay['items'] = []

    // Today: use CoreState data
    if (isToday && cs) {
      if (cs.today?.topicLabel) items.push({ text: cs.today.topicLabel, type: 'study' })
      if (cs.today?.targetQuestions > 0) items.push({ text: `${cs.today.targetQuestions} MCQs`, type: 'study' })
      if (cs.today?.mainsTarget > 0) items.push({ text: `${cs.today.mainsTarget} mains answer`, type: 'study' })
    } else if (subject) {
      items.push({ text: subject, type: 'study' })
    }

    // Revisions
    if (revDueDates.has(date)) items.push({ text: 'SRS Revisions due', type: 'revision' })

    return { date, label: formatDate(date), isToday, subject, items }
  })
}

function buildMonthView(monthStart: string): string {
  const today = todayIST()
  const [y, m] = monthStart.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const firstDow    = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const cs = getCurrentState()

  let html = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:8px;">`
  // Day headers
  DAYS.forEach(d => {
    html += `<div style="font-family:var(--font-mono);font-size:10px;color:var(--muted);
      text-align:center;padding:4px 0;">${d}</div>`
  })

  // Empty cells before first day
  for (let i = 0; i < firstDow; i++) {
    html += `<div style="height:44px;"></div>`
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    const isToday = dateStr === today
    const isFuture = dateStr > today

    // Determine dot color: green = study day (has sessions), gold = future, grey = past
    const hasSessions = !isFuture  // simplified: past days might have sessions
    const dotColor = isToday ? 'var(--accent)' : isFuture ? 'var(--line-2)' : 'var(--muted)'
    const bg = isToday ? 'var(--accent)' : 'transparent'
    const textColor = isToday ? '#000' : 'var(--ink-soft)'

    html += `
      <div style="height:44px;display:flex;flex-direction:column;align-items:center;
        justify-content:center;border-radius:var(--r-sm);cursor:pointer;
        background:${bg};${isToday ? '' : 'border:1px solid var(--line);'}
        transition:background .15s;" class="cal-day" data-date="${dateStr}">
        <span style="font-size:13px;font-weight:${isToday ? '700' : '400'};color:${textColor};">${day}</span>
        ${!isFuture && hasSessions && !isToday ? `<div style="width:4px;height:4px;border-radius:50%;background:${dotColor};margin-top:2px;"></div>` : ''}
      </div>`
  }

  html += `</div>`
  return html
}

// ── Calendar Panel ────────────────────────────────────────────────────────────

export function showCalendar(): void {
  if (document.getElementById('cal-overlay')) return

  const today  = todayIST()
  let _mode: 'week' | 'month' = 'week'
  let _weekStart = getWeekStart(today)
  let _monthStart = today.slice(0, 7) + '-01'

  const overlay = document.createElement('div')
  overlay.id = 'cal-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(8px);padding:16px;overflow-y:auto;'

  const panel = document.createElement('div')
  panel.style.cssText =
    'background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);' +
    'padding:24px 28px;width:100%;max-width:600px;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:16px;'
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  const esc_h = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_h) } }
  document.addEventListener('keydown', esc_h)

  const render = () => {
    const cs     = getCurrentState()
    const streak = cs?.streak ?? 0
    const [y, m] = _monthStart.split('-').map(Number)

    panel.innerHTML = `
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">📅 CALENDAR</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <button id="cal-week-btn" class="btn ${_mode==='week'?'primary':'ghost'}" style="font-size:11px;padding:5px 10px;">Week</button>
          <button id="cal-month-btn" class="btn ${_mode==='month'?'primary':'ghost'}" style="font-size:11px;padding:5px 10px;">Month</button>
          <button id="cal-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
        </div>
      </div>

      <!-- Streak badge -->
      ${streak > 0 ? `
        <div style="background:var(--panel-2);border-radius:var(--r-sm);padding:8px 14px;
          font-size:12px;color:var(--accent);font-family:var(--font-mono);display:inline-flex;
          align-items:center;gap:6px;align-self:flex-start;">
          🔥 ${streak}-day streak — keep it alive
        </div>` : ''}

      <!-- Navigation -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <button id="cal-prev" class="btn ghost" style="font-size:13px;padding:6px 12px;">← Prev</button>
        <span id="cal-period" style="font-family:var(--font-display);font-size:15px;font-weight:600;color:var(--ink);">
          ${_mode === 'week'
            ? `${formatDate(_weekStart)} — ${formatDate(addDays(_weekStart, 6))}`
            : `${MONTHS[m-1]} ${y}`}
        </span>
        <button id="cal-next" class="btn ghost" style="font-size:13px;padding:6px 12px;">Next →</button>
      </div>

      <!-- Content -->
      <div id="cal-content" style="flex:1;">
        ${_mode === 'week' ? renderWeekView() : buildMonthView(_monthStart)}
      </div>

      <!-- Legend -->
      <div style="display:flex;gap:16px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--line);">
        <span style="font-size:11px;color:var(--muted);font-family:var(--font-mono);">
          🟡 Today &nbsp;|&nbsp; 🔵 Revision &nbsp;|&nbsp; 🟢 Study
        </span>
      </div>
    `

    // Wire buttons
    document.getElementById('cal-x')?.addEventListener('click', close)
    document.getElementById('cal-week-btn')?.addEventListener('click', () => { _mode = 'week'; render() })
    document.getElementById('cal-month-btn')?.addEventListener('click', () => { _mode = 'month'; render() })
    document.getElementById('cal-prev')?.addEventListener('click', () => {
      if (_mode === 'week') _weekStart = addDays(_weekStart, -7)
      else {
        const [y, m] = _monthStart.split('-').map(Number)
        const prev = new Date(Date.UTC(y, m - 2, 1))
        _monthStart = prev.toISOString().slice(0, 10)
      }
      render()
    })
    document.getElementById('cal-next')?.addEventListener('click', () => {
      if (_mode === 'week') _weekStart = addDays(_weekStart, 7)
      else {
        const [y, m] = _monthStart.split('-').map(Number)
        const next = new Date(Date.UTC(y, m, 1))
        _monthStart = next.toISOString().slice(0, 10)
      }
      render()
    })
  }

  const renderWeekView = (): string => {
    const days = buildWeekAgenda(_weekStart)
    return days.map(day => `
      <div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);">
        <div style="min-width:72px;flex-shrink:0;">
          <div style="font-family:var(--font-mono);font-size:10px;color:${day.isToday ? 'var(--accent)' : 'var(--muted)'};
            letter-spacing:.08em;font-weight:${day.isToday ? '700' : '400'};">${day.label}</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:3px;">
          ${day.subject ? `<span style="font-size:11px;color:var(--ink-soft);font-family:var(--font-mono);">${day.subject}</span>` : ''}
          ${day.items.map(item => `
            <span style="font-size:12px;color:${
              item.type === 'revision' ? '#78a8ff' :
              item.type === 'mock'     ? '#e0a845' :
              item.type === 'exam'     ? 'var(--bad)' :
              'var(--ink-soft)'};">
              ${item.type === 'revision' ? '↻' : item.type === 'mock' ? '📝' : '•'} ${item.text}
            </span>`).join('')}
          ${!day.items.length ? '<span style="font-size:11px;color:var(--line-2);">—</span>' : ''}
        </div>
      </div>`).join('')
  }

  render()
}

// ── Command menu injection ────────────────────────────────────────────────────

export function injectCalendarToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-calendar')) return

  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-calendar'; card.href = '#'
  card.innerHTML = `<span class="cm-no">📅</span><span class="cm-t">Calendar</span><span class="cm-d">Week & month agenda view</span>`
  card.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showCalendar()
  })
  grid.appendChild(card)
}
