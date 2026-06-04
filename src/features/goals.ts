/**
 * goals.ts — Daily & Weekly Goals with progress rings.
 * Stored in app_state KV (key: 'goals'). Never punitive — only encouraging.
 * Shows: study hours goal, lectures/day goal, sessions/week goal, MCQ target.
 */
import { todayIST } from '../services/core'

interface Goals {
  dailyHours:      number   // study hours target per day
  weeklyLectures:  number   // lectures to complete per week
  weeklyMocks:     number   // mock tests per week
  dailyMCQs:       number   // MCQ practice target per day
  dailyAnswers:    number   // mains answers per day
}

const DEFAULT_GOALS: Goals = {
  dailyHours:     6,
  weeklyLectures: 5,
  weeklyMocks:    1,
  dailyMCQs:      50,
  dailyAnswers:   1,
}

function loadGoals(): Goals {
  try {
    const store = (window as { MISSION?: { store: { data: Record<string, unknown> } } }).MISSION?.store
    const raw   = (store?.data['goals'] ?? JSON.parse(localStorage.getItem('goals') ?? 'null')) as Goals | null
    return raw ? { ...DEFAULT_GOALS, ...raw } : { ...DEFAULT_GOALS }
  } catch { return { ...DEFAULT_GOALS } }
}

function saveGoals(g: Goals): void {
  try {
    const store = (window as { MISSION?: { store: { set(k: string, v: unknown): void } } }).MISSION?.store
    if (store) store.set('goals', g)
    else localStorage.setItem('goals', JSON.stringify(g))
  } catch { /* ignore */ }
}

function getTodayActuals(): { hours: number; mcqs: number; answers: number; lectures: number } {
  const today = todayIST()
  let hours = 0, mcqs = 0, answers = 0, lectures = 0

  try {
    const focusLog = JSON.parse(localStorage.getItem('focusLog') ?? '[]') as Array<{ date: string; mins: number }>
    hours = focusLog.filter(e => e.date === today).reduce((s, e) => s + (e.mins ?? 0), 0) / 60
  } catch { /* ignore */ }

  // Lectures done count from DOM (planner section)
  lectures = document.querySelectorAll('#plan .plan-row.done').length

  return { hours, mcqs, answers, lectures }
}

function getWeekActuals(): { lectures: number; mocks: number } {
  const today = todayIST()
  const [y, m, d] = today.split('-').map(Number)
  const todayMs = Date.UTC(y, m - 1, d)
  const weekStart = todayMs - (new Date(todayMs).getUTCDay() * 86_400_000)

  let mocks = 0
  try {
    // Count scores logged this week from store
    const store = (window as { MISSION?: { store: { data: Record<string, unknown> } } }).MISSION?.store
    const scoresRaw = store?.data['weeklyMocks']
    if (typeof scoresRaw === 'number') mocks = scoresRaw
  } catch { /* ignore */ }

  const lectures = document.querySelectorAll('#plan .plan-row.done').length

  return { lectures, mocks }
}

function ring(pct: number, label: string, sub: string, color = 'var(--accent)'): string {
  const clamped  = Math.min(100, Math.max(0, pct))
  const r = 32, cx = 40, cy = 40
  const circ = 2 * Math.PI * r
  const dash  = (clamped / 100) * circ

  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
      <svg width="80" height="80" viewBox="0 0 80 80">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="5"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}"
          stroke-width="5" stroke-linecap="round"
          stroke-dasharray="${dash} ${circ}"
          transform="rotate(-90 ${cx} ${cy})"
          style="transition:stroke-dasharray .5s ease;"/>
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
          style="font-size:13px;font-weight:700;fill:${color};font-family:var(--font-display);">
          ${Math.round(clamped)}%
        </text>
      </svg>
      <span style="font-size:11px;color:var(--ink-soft);text-align:center;font-family:var(--font-mono);">${label}</span>
      <span style="font-size:10px;color:var(--muted);text-align:center;">${sub}</span>
    </div>
  `
}

function toast(msg: string, type: 'success' | 'info' = 'success') {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg, type } }))
}

// ── Goals Panel ───────────────────────────────────────────────────────────────

export function showGoals(): void {
  if (document.getElementById('goals-overlay')) return

  const goals   = loadGoals()
  const actuals = getTodayActuals()
  const weekly  = getWeekActuals()

  const overlay = document.createElement('div')
  overlay.id = 'goals-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(5,7,15,.92);backdrop-filter:blur(8px);padding:16px;overflow-y:auto;'

  const hoursRing     = ring(actuals.hours / goals.dailyHours * 100,
    'Study Hours', `${actuals.hours.toFixed(1)} / ${goals.dailyHours}h`)
  const mcqRing       = ring(actuals.mcqs  / Math.max(1, goals.dailyMCQs) * 100,
    'MCQ Practice', `${actuals.mcqs} / ${goals.dailyMCQs} Qs`, '#78a8ff')
  const ansRing       = ring(actuals.answers / Math.max(1, goals.dailyAnswers) * 100,
    'Mains Writing', `${actuals.answers} / ${goals.dailyAnswers} ans`, '#45e0a8')
  const lecRing       = ring(weekly.lectures / Math.max(1, goals.weeklyLectures) * 100,
    'Lectures (week)', `${weekly.lectures} / ${goals.weeklyLectures}`, '#e0a845')

  overlay.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:var(--r);
      padding:28px;width:100%;max-width:520px;display:flex;flex-direction:column;gap:22px;">

      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;color:var(--accent);">🎯 MY GOALS</span>
        <button id="goals-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
      </div>

      <!-- Progress Rings -->
      <div>
        <p style="font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.12em;margin:0 0 14px;">TODAY'S PROGRESS</p>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;justify-items:center;">
          ${hoursRing}${mcqRing}${ansRing}${lecRing}
        </div>
      </div>

      <!-- Encouragement -->
      <div id="goals-encourage" style="background:var(--panel-2);border-radius:var(--r-sm);padding:12px 14px;
        font-size:13px;color:var(--ink-soft);line-height:1.5;"></div>

      <!-- Settings Divider -->
      <div style="border-top:1px solid var(--line);padding-top:16px;">
        <p style="font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.12em;margin:0 0 14px;">SET YOUR TARGETS</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          ${[
            ['Daily study hours', 'g-hours', goals.dailyHours, 1, 16, 0.5],
            ['Daily MCQ target', 'g-mcqs', goals.dailyMCQs, 10, 200, 10],
            ['Daily mains answers', 'g-answers', goals.dailyAnswers, 0, 5, 1],
            ['Weekly lectures', 'g-lectures', goals.weeklyLectures, 1, 30, 1],
            ['Weekly mock tests', 'g-mocks', goals.weeklyMocks, 0, 7, 1],
          ].map(([label, id, val, min, max, step]) => `
            <div style="display:flex;flex-direction:column;gap:4px;">
              <span class="card-label">${label}</span>
              <input id="${id}" type="number" value="${val}" min="${min}" max="${max}" step="${step}"
                style="padding:8px 10px;background:var(--panel-2);border:1px solid var(--line-2);
                border-radius:var(--r-sm);color:var(--ink);font-size:14px;font-weight:600;
                text-align:center;outline:none;width:100%;box-sizing:border-box;" />
            </div>
          `).join('')}
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn ghost" id="goals-cancel">Close</button>
        <button class="btn primary" id="goals-save">Save Goals</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  // Encouragement message
  const enc = document.getElementById('goals-encourage')!
  const hrs = actuals.hours
  if (hrs >= goals.dailyHours) {
    enc.innerHTML = `<span style="color:var(--accent);">🔥 Daily goal achieved!</span> ${hrs.toFixed(1)}h studied today. Exceptional consistency, Om.`
  } else if (hrs >= goals.dailyHours * 0.6) {
    const rem = (goals.dailyHours - hrs).toFixed(1)
    enc.textContent = `${hrs.toFixed(1)}h done — only ${rem}h more to hit your target. You are close.`
  } else if (hrs > 0) {
    enc.textContent = `${hrs.toFixed(1)}h logged. Keep going — consistency over perfection. Every session counts.`
  } else {
    enc.textContent = `Day is fresh. Target: ${goals.dailyHours}h of focused study. Start the first session now.`
  }

  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('goals-x')?.addEventListener('click', close)
  document.getElementById('goals-cancel')?.addEventListener('click', close)

  const esc_h = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_h) } }
  document.addEventListener('keydown', esc_h)

  document.getElementById('goals-save')?.addEventListener('click', () => {
    const get = (id: string) => parseFloat((document.getElementById(id) as HTMLInputElement).value) || 0
    const g: Goals = {
      dailyHours:     get('g-hours'),
      weeklyLectures: get('g-lectures'),
      weeklyMocks:    get('g-mocks'),
      dailyMCQs:      get('g-mcqs'),
      dailyAnswers:   get('g-answers'),
    }
    saveGoals(g)
    toast('Goals saved! Keep them realistic — consistency wins.')
    close()
  })
}

// ── Command menu injection ────────────────────────────────────────────────────

export function injectGoalsToMenu(): void {
  const grid = document.querySelector('.cm-grid')
  if (!grid || document.getElementById('cm-goals')) return

  const card = document.createElement('a')
  card.className = 'cm-card'; card.id = 'cm-goals'; card.href = '#'
  card.innerHTML = `<span class="cm-no">🎯</span><span class="cm-t">Goals</span><span class="cm-d">Daily & weekly progress targets</span>`
  card.addEventListener('click', e => {
    e.preventDefault()
    document.getElementById('command-menu')?.classList.remove('open')
    document.getElementById('menu-backdrop')?.classList.remove('show')
    document.body.classList.remove('menu-open')
    showGoals()
  })
  grid.appendChild(card)
}
