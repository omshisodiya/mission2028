/**
 * core-engine.ts — orchestration layer.
 * Loads all inputs → computeCoreState → caches in store → binds every widget.
 * No widget computes its own numbers. All reads go through CoreState.
 */
import { computeCoreState, todayIST, type CoreState, type CoreInputs } from '../services/core'
import { getSubject as getSubjectForDate, getEffectiveSubjectDate } from '../services/routine'
import type { RoutineDay } from '../data/repositories/routine'
import { computePlan, DEFAULT_SETTINGS, type PlannerLecture } from '../services/planner'
import { listRoutineDays } from '../data/repositories/routine'
import { listScores } from '../data/repositories/scores'
import { listSessionDays } from '../data/repositories/sessions'
import { listLectures } from '../data/repositories/lectures'
import { savePlan } from '../data/repositories/plan'
import { listDueRevisions, listUpcomingRevisions, rateRevision, type DueRevision } from '../data/repositories/revisions'
import { dueDateLabel, isDue, type Recall } from '../services/srs'
import type { FixedRevision } from '../services/planner'
import { bindAnswerTracker } from './answer-log'
import { bindCAFeed } from './ca-log'
import { loadSettings, showSettings } from './settings'
import { setPlannerSubjectContext } from './lectures-planner'
import { setLectureCompletionDates } from './routine-ui'

// ── Module state ──────────────────────────────────────────────────────────────

let _state: CoreState | null = null
let _recomputeTimer: ReturnType<typeof setTimeout> | null = null
let _visTimer: ReturnType<typeof setTimeout> | null = null
let _visListenerAttached = false
let _lastRoutineDays: RoutineDay[] = []          // kept in sync with each fetchInputs()
let _lastLectureCompletionDates: string[] = []   // IST dates where ≥1 lecture was completed

// ── Public API ────────────────────────────────────────────────────────────────

/** Load all inputs from DB, compute CoreState, bind widgets. Call on boot. */
export async function loadAndBind(): Promise<void> {
  const inputs = await fetchInputs()
  _state = computeCoreState(inputs)
  cacheInStore(_state)
  bindWidgets(_state)
  // Phase 5: answer tracker + CA feed + revision queue (independent DB calls)
  safeRun('revisions',     () => { void loadAndBindRevisions() })
  safeRun('answerTracker', () => { void bindAnswerTracker() })
  safeRun('caFeed',        () => { void bindCAFeed() })

  // Global visibility-change sync: recompute routine/scores/sessions/lectures
  // whenever the user switches back to this tab (cross-device sync catch-up).
  // Debounced 600ms so rapid focus/blur events don't fire multiple requests.
  // Guard ensures only one listener is ever registered even if loadAndBind() reruns.
  if (!_visListenerAttached) {
    _visListenerAttached = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (_visTimer) clearTimeout(_visTimer)
      _visTimer = setTimeout(() => { recompute() }, 600)
    })
  }
}

/** Re-run after any input write. Debounced 400ms so rapid inputs don't thrash. */
export function recompute(): void {
  if (_recomputeTimer) clearTimeout(_recomputeTimer)
  _recomputeTimer = setTimeout(async () => {
    const inputs = await fetchInputs()
    _state = computeCoreState(inputs)
    cacheInStore(_state)
    bindWidgets(_state)
  }, 400)
}

/** Called from focus-timer intercept when a session completes. */
export function onSessionComplete(minutes: number): void {
  // Hours auto-fill: punch the new session into _state optimistically,
  // then trigger a full recompute so the DB catches up.
  recompute()
  // Toast-style: update hours.today immediately in the routine card
  if (_state) {
    const today = todayIST()
    const prevByDay = _state.hours.byDay[today] ?? 0
    // Only optimistically update if no manual hours override exists
    const hasManualOverride = false  // detected during recompute from DB
    if (!hasManualOverride) {
      _state.hours.byDay[today] = prevByDay + minutes / 60
      _state.hours.today = _state.hours.byDay[today]
      _state.hours.cumulative += minutes / 60
    }
    patchHoursDisplay(_state)
  }
}

export function getCurrentState(): CoreState | null { return _state }

/** Compute subject for any date using the rotation rules. */
function nextDaySubject(dateStr: string): string {
  return getSubjectForDate(dateStr)
}

/** Convert a subject string to lecture-routing keywords. */
function subjectToKeywords(subject: string): string[] {
  const KEYWORD_MAP: Record<string, string> = {
    'SJS':         'Polity',
    'Geography':   'Geography',
    'Environment': 'Environment',
    'Medieval':    'History',
    'Economy':     'Economy',
    'Mathematics': 'Mathematics',
  }
  const found: string[] = []
  for (const [kw, label] of Object.entries(KEYWORD_MAP)) {
    if (subject.includes(kw)) { found.push(kw); if (label !== kw) found.push(label) }
  }
  return found
}

/** Extract subject keywords from today's subject string for lecture routing. */
export function todaySubjectKeywords(): string[] {
  const subject = _state?.today.subject ?? ''
  // Config subject_rotation weekday values contain + separated keywords
  const KEYWORD_MAP: Record<string, string> = {
    'SJS':         'Polity',
    'Geography':   'Geography',
    'Environment': 'Environment',
    'Medieval':    'History',
    'Economy':     'Economy',
    'Mathematics': 'Mathematics',
  }
  const found: string[] = []
  for (const [kw, label] of Object.entries(KEYWORD_MAP)) {
    if (subject.includes(kw)) {
      found.push(kw)
      if (label !== kw) found.push(label)  // match both "SJS" and "Polity"
    }
  }
  return found
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchInputs(): Promise<CoreInputs> {
  const today = todayIST()
  const [routineDays, scores, sessionDays, lectures] = await Promise.all([
    listRoutineDays().catch(() => []),
    listScores().catch(() => []),
    listSessionDays().catch(() => []),
    listLectures().catch(() => []),
  ])
  _lastRoutineDays = routineDays   // cache for plannerCtx effective-date lookup

  // Build IST dates for every day a lecture was completed
  // Used as the "productive day" signal for subject-date carry-forward
  _lastLectureCompletionDates = lectures
    .filter(l => l.done && l.done_at)
    .map(l => new Date(l.done_at!).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }))

  // Push completion dates to routine-ui so its today card uses the same signal
  setLectureCompletionDates(_lastLectureCompletionDates)

  const lecturesDone  = lectures.filter(l => l.done).length
  const lecturesTotal = lectures.length
  return { routineDays, scores, sessionDays, lecturesDone, lecturesTotal, today }
}

// ── Cache in store ────────────────────────────────────────────────────────────

function cacheInStore(state: CoreState): void {
  const mission = (window as { MISSION?: { store: { set(k: string, v: unknown): void; data: Record<string, unknown> } } }).MISSION
  if (!mission?.store) return
  // Cache the state so widgets can read synchronously next time
  mission.store.data['coreState'] = state
  // Also sync the keys that the engine reads natively
  mission.store.set('heatSeed', buildHeatSeed(state))
  mission.store.set('rankInputs', buildRankInputs(state))
}

// ── Widget bindings ───────────────────────────────────────────────────────────

/** Runs fn safely — logs any error but never lets one widget break another. */
function safeRun(label: string, fn: () => void): void {
  try { fn() } catch (e) { console.error(`[core-engine] ${label}:`, e) }
}

function bindWidgets(s: CoreState): void {
  safeRun('strip',        () => bindStrip(s))
  safeRun('rankSim',      () => bindRankSim(s))
  safeRun('barCharts',    () => bindBarCharts(s))
  safeRun('donuts',       () => bindDonuts(s))
  safeRun('heatmap',      () => bindHeatmap(s))
  safeRun('streak',       () => bindStreak(s))
  safeRun('countUps',     () => bindCountUps(s))
  safeRun('briefing',     () => bindBriefing(s))
  safeRun('autoTodos',    () => bindAutoTodos(s))
  safeRun('aiUpgrade',    () => upgradeAIPlannerInput(s))
  safeRun('plannerCtx',   () => {
    // Derive the carry-forward effective date from the cached routineDays.
    // If missed days exist, show the oldest missed day's subject in the planner.
    const { effectiveDate, missedDays } = getEffectiveSubjectDate(s.today.date, _lastRoutineDays, _lastLectureCompletionDates)

    if (missedDays > 0) {
      // Carry-forward: show oldest un-studied day's subject
      const effectiveSubj = getSubjectForDate(effectiveDate)
      const effectiveKws  = subjectToKeywords(effectiveSubj)
      setPlannerSubjectContext(effectiveSubj, effectiveKws, true, effectiveDate)
    } else {
      // No misses — always show today's subject regardless of hours logged
      setPlannerSubjectContext(s.today.subject, todaySubjectKeywords(), false, '')
    }
  })
}

// Headline metrics strip (in the routine section)
function bindStrip(s: CoreState): void {
  const sp = s.selectionProbabilityPct
  setText('rtn-sel-prob',    sp != null ? sp.toFixed(1) : '—')
  setText('rtn-rank-proj',   s.rankProjection)
  setText('rtn-approx-rank', s.approxRank)
  setText('rtn-pre-avg',     s.performance.prelimsAvg != null ? s.performance.prelimsAvg.toFixed(1) : '—')
  setText('rtn-opt-avg',     s.performance.optionalAvg != null ? s.performance.optionalAvg.toFixed(1) : '—')
  setText('rtn-mains-avg',   s.performance.mainsAvg != null ? s.performance.mainsAvg.toFixed(1) : '—')
  // Live metrics in today card
  setText('rtn-accuracy',    s.performance.accuracyToday != null ? s.performance.accuracyToday.toFixed(1) + '%' : '—')
  setText('rtn-consistency', s.consistencyPct != null ? s.consistencyPct + '%' : '—')
}

// rankSim — feed real CoreState values into the sliders so the engine's
// own compute() formula runs and updates #rank-num / #rank-band correctly.
function bindRankSim(s: CoreState): void {
  const preSlider   = document.getElementById('s-pre')   as HTMLInputElement | null
  const mainsSlider = document.getElementById('s-mains') as HTMLInputElement | null

  // Map accuracy % → slider ranges (pre: 60–200, mains: 30–100)
  if (preSlider && s.performance.prelimsAvg != null) {
    const val = Math.round(60 + (Math.min(s.performance.prelimsAvg, 100) / 100) * 140)
    preSlider.value = String(val)
    // Dispatch so the engine's rankSim compute() updates #rank-num / #rank-band
    preSlider.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (mainsSlider && s.performance.optionalAvg != null) {
    const val = Math.round(30 + (Math.min(s.performance.optionalAvg, 100) / 100) * 70)
    mainsSlider.value = String(val)
    mainsSlider.dispatchEvent(new Event('input', { bubbles: true }))
  }

  // Inject a CoreState sub-label below the band text (only once)
  const rankRoot = document.getElementById('rank')
  if (!rankRoot) return
  let lbl = document.getElementById('cs-rank-label')
  if (!lbl) {
    lbl = document.createElement('p')
    lbl.id = 'cs-rank-label'
    lbl.style.cssText =
      'margin:10px 0 0;font-size:11.5px;font-family:var(--font-mono);color:var(--muted);text-align:center;line-height:1.5;'
    const muted = rankRoot.querySelector('.muted')
    if (muted) muted.insertAdjacentElement('afterend', lbl)
  }

  if (s.selectionProbabilityPct != null) {
    lbl.innerHTML =
      `SP: <span style="color:var(--accent-ink)">${s.selectionProbabilityPct.toFixed(1)}%</span>` +
      ` · Projection: <span style="color:var(--accent-ink)">${s.rankProjection}</span>` +
      ` · Approx: <span style="color:var(--accent-ink)">${s.approxRank}</span>` +
      `<br><span style="opacity:.65">${s.disclaimer.slice(0, 70)}…</span>`
  } else {
    lbl.textContent = 'Add scores or complete routine rows to seed this rank.'
  }
}

// barCharts — last 8 test accuracies
function bindBarCharts(s: CoreState): void {
  const trend = s.testScoreTrend
  if (!trend.length) return
  const cols = document.querySelectorAll<HTMLElement>('#mock-bars .col')
  trend.forEach((v, i) => {
    if (i >= cols.length) return
    const col = cols[i]
    col.setAttribute('data-v', String(v))
    col.style.height = v + '%'
    const pv = col.querySelector('.pv')
    if (pv) pv.textContent = String(v)
  })
}

// donuts — subject accuracy
const DONUT_SUBJECT_MAP: { keyword: string; index: number }[] = [
  { keyword: 'SJS',         index: 0 },   // Polity
  { keyword: 'Medieval',    index: 1 },   // History
  { keyword: 'Geography',   index: 2 },   // Geo
  { keyword: 'Economy',     index: 3 },   // Economy
  { keyword: 'Environment', index: 4 },   // Env
  { keyword: 'Mathematics', index: 5 },   // CSAT / Optional
]

function bindDonuts(s: CoreState): void {
  const donuts = document.querySelectorAll<HTMLElement>('.donut')
  const accent  = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  const line    = 'rgba(120,168,255,0.13)'
  DONUT_SUBJECT_MAP.forEach(({ keyword, index }) => {
    const acc = s.subjectAccuracy[keyword]
    if (acc == null || index >= donuts.length) return
    const v    = Math.round(acc)
    const d    = donuts[index]
    d.setAttribute('data-v', String(v))
    const b = d.querySelector('.mid b')
    if (b) b.textContent = v + '%'
    const ring = d.querySelector<HTMLElement>('.ring')
    if (ring) ring.style.background = `conic-gradient(${accent} ${v}%, ${line} 0)`
  })
}

// heatmap — hours.byDay → 182-cell seed
function buildHeatSeed(s: CoreState): number[] {
  const today   = s.today.date
  const todayMs = utcMs(today)
  const dow     = new Date(todayMs).getUTCDay()
  const startMs = todayMs - (25 * 7 + dow) * 86_400_000
  const seed: number[] = []
  for (let w = 0; w < 26; w++) {
    for (let d = 0; d < 7; d++) {
      const ms  = startMs + (w * 7 + d) * 86_400_000
      const key = new Date(ms).toISOString().slice(0, 10)
      const hrs = s.hours.byDay[key] ?? 0
      seed.push(hrs >= 6 ? 4 : hrs >= 4 ? 3 : hrs >= 2 ? 2 : hrs > 0 ? 1 : 0)
    }
  }
  return seed
}

function bindHeatmap(s: CoreState): void {
  const root = document.getElementById('heat')
  if (!root) return
  const seed = buildHeatSeed(s)
  root.innerHTML = ''
  seed.forEach(l => {
    const c = document.createElement('div')
    c.className = 'c' + (l ? ' h' + l : '')
    root.appendChild(c)
  })
  const active = seed.filter(v => v > 0).length
  setText('heat-active', String(active))
}

// streak — update counter and re-render grid only when we have real hour data
function bindStreak(s: CoreState): void {
  // Always update the streak counter number
  const numEl = document.getElementById('streak-num')
  if (numEl && s.streak > 0) numEl.textContent = String(s.streak)

  // Only override the grid if we actually have hours data —
  // otherwise leave the engine's focusLog-based rendering intact.
  const hasHours = Object.values(s.hours.byDay).some(h => h > 0)
  if (!hasHours) return

  const grid = document.getElementById('streak')
  if (!grid) return

  const today  = s.today.date
  const [ty, tm, td] = today.split('-').map(Number)

  grid.innerHTML = ''
  for (let i = 13; i >= 0; i--) {
    const ms  = Date.UTC(ty, tm - 1, td - i)
    const key = new Date(ms).toISOString().slice(0, 10)
    const hrs = s.hours.byDay[key] ?? 0
    const lvl = hrs >= 6 ? 4 : hrs >= 4 ? 3 : hrs >= 2 ? 2 : hrs > 0 ? 1 : 0
    const cell = document.createElement('div')
    cell.className = 'streak-cell' + (lvl ? ` l${lvl}` : '')
    cell.title = `${key}: ${hrs.toFixed(1)}h`
    grid.appendChild(cell)
  }
}

// Intelligence stat row — wire to real CoreState numbers.
// The engine's count-up animation runs for 900ms after elements enter viewport.
// We override aggressively: immediately + every 150ms for 2s to win over it.
function bindCountUps(s: CoreState): void {
  const activeDays = Object.values(s.hours.byDay).filter(h => h > 0).length
  const avgPre     = s.performance.prelimsAvg
  const avgScore   = avgPre != null ? Math.round(avgPre * 2) : 0

  // If no real data yet, show placeholder dashes so user knows to add data
  const hasData = s.cumulative.testsTaken > 0 || avgPre != null

  const VALS: Record<string, string> = {
    mock:     hasData ? String(s.cumulative.testsTaken) : '—',
    score:    hasData && avgScore > 0 ? String(avgScore) : '—',
    accuracy: hasData && avgPre != null ? String(Math.round(avgPre)) : '—',
    study:    activeDays > 0 ? String(activeDays) : '0',
  }

  const FLOATS: Record<string, boolean> = { accuracy: true }

  function applyOnce(): void {
    document.querySelectorAll<HTMLElement>('#intel .stat').forEach(card => {
      const label = (card.querySelector('.k')?.textContent ?? '').toLowerCase()
      const cu    = card.querySelector<HTMLElement>('.count-up')
      if (!cu) return
      const key = Object.keys(VALS).find(k => label.includes(k))
      if (!key) return
      const val = VALS[key]
      cu.setAttribute('data-to', val === '—' ? '0' : val)
      cu.textContent = val
      // Hide float decoration when no data
      if (FLOATS[key] && val === '—') {
        const small = cu.nextElementSibling as HTMLElement | null
        if (small?.tagName === 'SMALL') small.style.display = 'none'
      }
    })
    const ha = document.getElementById('heat-active')
    if (ha) ha.textContent = activeDays > 0 ? String(activeDays) : '0'
  }

  // Apply immediately, then keep overriding every 150ms for 2s to beat animation
  applyOnce()
  let n = 0
  const iv = setInterval(() => { applyOnce(); if (++n >= 13) clearInterval(iv) }, 150)

  // Trend sub-labels — always set so hardcoded values are replaced
  const trendMap: Record<string, string> = {
    mock:     s.cumulative.testsTaken > 0
      ? `${s.cumulative.testsTaken} graded total`
      : 'Add scores via command menu',
    score:    avgPre != null
      ? `from ${s.cumulative.testsTaken} test${s.cumulative.testsTaken !== 1 ? 's' : ''}`
      : 'No scores yet',
    accuracy: avgPre != null
      ? avgPre >= 60 ? '≥ 60% prelims target' : 'Keep improving'
      : 'No MCQ data yet',
    study:    activeDays > 0
      ? `${s.hours.cumulative.toFixed(0)}h cumulative`
      : 'Start focus timer',
  }
  document.querySelectorAll<HTMLElement>('#intel .stat .trend').forEach(tr => {
    const label = (tr.closest('.stat')?.querySelector('.k')?.textContent ?? '').toLowerCase()
    const key   = Object.keys(trendMap).find(k => label.includes(k))
    if (!key) return
    tr.textContent = trendMap[key]
    tr.className = hasData ? 'trend up' : 'trend'
  })
}

// daily briefing — one accurate one-liner from live planner + SRS + test data
function bindBriefing(s: CoreState): void {
  const el = document.getElementById('rtn-briefing')
  if (!el) return
  const parts: string[] = []

  // Today's plan
  const mcqCount = s.today.targetQuestions
  if (mcqCount > 0)              parts.push(`${mcqCount} MCQ${mcqCount === 1 ? '' : 's'} target`)
  const ansCount = s.today.mainsTarget
  if (ansCount >= 1)             parts.push(`write ${ansCount} mains answer${ansCount > 1 ? 's' : ''}`)

  // Study hours
  if (s.hours.today > 0)        parts.push(`${s.hours.today.toFixed(1)}h logged today`)
  else                          parts.push('0h logged — use the focus timer to track study')

  // Consistency
  if (s.consistencyPct != null) parts.push(`${s.consistencyPct}% consistency`)

  // Test performance
  if (s.performance.prelimsAvg != null) parts.push(`prelims avg ${s.performance.prelimsAvg.toFixed(1)}%`)
  // Guard: only show rank projection if both values are present and non-null
  if (s.selectionProbabilityPct != null && s.rankProjection) {
    parts.push(`SP ${s.selectionProbabilityPct.toFixed(1)}% → ${s.rankProjection}`)
  } else if (s.selectionProbabilityPct != null) {
    parts.push(`SP ${s.selectionProbabilityPct.toFixed(1)}%`)
  }

  // Backlog
  if (s.backlogRemaining > 0)    parts.push(`${s.backlogRemaining} lectures in backlog`)
  else if (s.cumulative.testsTaken > 0) parts.push('all lectures cleared')

  el.textContent = parts.length
    ? parts.join(' · ')
    : `${s.today.subject || 'Study'} day — log your routine inputs to see your briefing.`
}

// routine card — patch hours display after focus timer fires
function patchHoursDisplay(s: CoreState): void {
  const el = document.getElementById('rtn-study-hours') as HTMLInputElement | null
  if (el && !el.value) el.value = s.hours.today.toFixed(1)
}

// Auto-populate today's command-menu todos from the routine plan
function bindAutoTodos(s: CoreState): void {
  type Todo = { t: string; done: boolean }
  const mission = (window as {
    MISSION?: { store: { data: Record<string, unknown>; set(k: string, v: unknown): void } }
  }).MISSION
  if (!mission?.store) return

  const today = s.today.date
  const rawMap = (mission.store.data['todos'] ?? {}) as Record<string, Todo[]>
  const list: Todo[] = [...(Array.isArray(rawMap[today]) ? rawMap[today] : [])]
  const existing = new Set(list.map(x => x.t))

  const suggestions: string[] = []
  const subj = s.today.subject

  if (subj.includes('PW Full Test'))     suggestions.push('Full Length Prelims Test + Analysis')
  else if (subj.includes('PW Optional')) suggestions.push('Maths Sectional Test + Error Log')
  else {
    if (s.today.topicLabel)              suggestions.push(s.today.topicLabel)
    if (subj.includes('Mathematics'))   suggestions.push('Maths Practice (DPP)')
    if (s.today.mainsTarget >= 1)       suggestions.push(`Mains Writing: ${s.today.mainsTarget} answer`)
  }
  if (s.today.targetQuestions > 0)      suggestions.push(`MCQ Target: ${s.today.targetQuestions} Qs`)

  let changed = false
  for (const t of suggestions) {
    if (!existing.has(t)) { list.push({ t, done: false }); existing.add(t); changed = true }
  }
  if (changed) {
    const updated = { ...rawMap, [today]: list }
    mission.store.set('todos', updated)
    const countEl = document.getElementById('cm-todo-count')
    if (countEl) countEl.textContent = String(list.filter(x => !x.done).length)
  }
}

// ── Phase 3: Master Planner wired to #plan section ────────────────────────────

let _plannerMounted = false
let _cachedLectures: PlannerLecture[] = []

function upgradeAIPlannerInput(s: CoreState): void {
  if (_plannerMounted) return
  _plannerMounted = true

  const rangeEl = document.getElementById('ai-hours') as HTMLInputElement | null
  if (!rangeEl) return

  // Hide original slider; add ±1 stepper (real hours/day from settings, not the range)
  rangeEl.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;'
  const settings = loadSettings()
  const avgCap   = Math.round(Object.values(settings.weekdayCapacity).reduce((a, b) => a + b, 0) / 7 / 60 * 10) / 10

  const stepper = document.createElement('div')
  stepper.style.cssText = 'display:flex;align-items:center;gap:8px;font-family:var(--font-display);'
  stepper.innerHTML =
    `<button id="ai-step-dn" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--line-2);` +
    `background:var(--panel-2);color:var(--ink);cursor:pointer;font-size:18px;transition:border-color .15s;">−</button>` +
    `<span id="ai-hrs-val" style="font-size:22px;font-weight:700;color:var(--accent);min-width:40px;text-align:center;">${rangeEl.value}</span>` +
    `<button id="ai-step-up" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--line-2);` +
    `background:var(--panel-2);color:var(--ink);cursor:pointer;font-size:18px;transition:border-color .15s;">+</button>` +
    `<span class="mono muted" style="font-size:11px;">hrs/day (avg ${avgCap}h from settings)</span>`
  rangeEl.insertAdjacentElement('afterend', stepper)

  const updateVal = (delta: number) => {
    const nv = Math.max(1, Math.min(20, parseInt(rangeEl.value) + delta))
    rangeEl.value = String(nv)
    const el = document.getElementById('ai-hrs-val')
    if (el) el.textContent = String(nv)
  }
  document.getElementById('ai-step-dn')?.addEventListener('click', () => updateVal(-1))
  document.getElementById('ai-step-up')?.addEventListener('click', () => updateVal(1))

  // Add "⚙ Settings" button next to Generate Plan
  const genBtn = document.getElementById('ai-gen')
  if (genBtn) {
    const settingsBtn = document.createElement('button')
    settingsBtn.className = 'btn ghost'
    settingsBtn.id = 'ai-settings-btn'
    settingsBtn.style.cssText = 'font-size:13px;'
    settingsBtn.textContent = '⚙ Settings'
    settingsBtn.addEventListener('click', () => {
      showSettings(() => {
        // Re-generate plan automatically after settings save
        document.getElementById('ai-gen')?.click()
      })
    })
    genBtn.insertAdjacentElement('beforebegin', settingsBtn)

    // Replace "Generate plan" with real planner
    const newBtn = genBtn.cloneNode(true) as HTMLElement
    genBtn.replaceWith(newBtn)
    newBtn.addEventListener('click', () => runPlanner(s))
  }
}

async function runPlanner(s: CoreState): Promise<void> {
  const out = document.getElementById('ai-out')
  if (!out) return
  out.innerHTML = `<span style="opacity:.6;font-size:13px;font-family:var(--font-mono);">Computing plan…</span>`

  try {
    // Load lectures if not cached
    if (_cachedLectures.length === 0) {
      const all = await listLectures()
      _cachedLectures = all.map(l => ({
        id: l.id, title: l.title,
        subject: l.subjects?.name ?? null,
        sequence: l.sequence, duration_min: l.duration_min, done: l.done,
      }))
    }

    const settings = loadSettings()
    const today    = todayIST()
    // Load upcoming revisions as fixed appointments (next 90 days)
    const addDays90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)
    const upcomingRevs = await listUpcomingRevisions(today, addDays90).catch(() => [])
    const fixedRevisions: FixedRevision[] = upcomingRevs.map(r => ({
      date:      r.due_date,
      lectureId: r.lecture_id ?? '',
      label:     'Revision',
      subject:   'Revision',
      minutes:   30,
    }))
    const result = computePlan(_cachedLectures, settings, today, fixedRevisions)

    // Save plan to Supabase (best-effort)
    savePlan(result.days, today).catch(e => console.error('[planner] savePlan failed:', e))

    // Render output
    renderPlanOutput(out, result, s)
  } catch (e) {
    console.error('[planner] runPlanner failed:', e)
    out.innerHTML = `<span style="color:var(--bad);font-size:13px;">Plan generation failed — check console.</span>`
  }
}

function renderPlanOutput(container: HTMLElement, result: ReturnType<typeof computePlan>, s: CoreState): void {
  const fmt = (m: number) => m >= 60 ? `${(m/60).toFixed(1)}h` : `${m}m`
  const lines: string[] = []

  // ── Metrics header ────────────────────────────────────────────────────────
  lines.push(`<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">` +
    metricChip('Backlog', `${result.metrics.backlogCount} lectures`) +
    metricChip('Coverage', `${result.metrics.coveragePct}%`) +
    (result.metrics.projectedCompletionDate
      ? metricChip('Completes by', result.metrics.projectedCompletionDate)
      : metricChip('Status', result.feasible ? 'Feasible' : '⚠ Deficit')) +
    metricChip('Avg load', fmt(result.metrics.avgDailyLoadMins) + '/day') +
  `</div>`)

  // ── Feasibility / Deficit ─────────────────────────────────────────────────
  if (!result.feasible && result.deficit) {
    const d = result.deficit
    const shortH = (d.shortfallMins / 60).toFixed(0)
    lines.push(`<div style="border:1px solid var(--bad);border-radius:var(--r-sm);padding:12px 16px;margin-bottom:16px;">`)
    lines.push(`<div style="color:var(--bad);font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;margin-bottom:8px;">⚠ BACKLOG DEFICIT — ${shortH}h short of capacity</div>`)
    lines.push(`<div style="font-size:13px;color:var(--ink-soft);margin-bottom:6px;">Three remedies:</div>`)
    lines.push(`<div style="font-size:13px;color:var(--ink-soft);margin-bottom:4px;">1. ${d.remedies.a}</div>`)
    lines.push(`<div style="font-size:13px;color:var(--ink-soft);margin-bottom:4px;">2. ${d.remedies.b}</div>`)
    lines.push(`<div style="font-size:13px;color:var(--ink-soft);margin-bottom:0;">3. ${d.remedies.c}</div>`)
    lines.push(`</div>`)
  }

  // ── Today's plan ─────────────────────────────────────────────────────────
  const todayDay = result.days.find(d => d.date === todayIST())
  if (todayDay && todayDay.blocks.length > 0) {
    lines.push(`<div style="margin-bottom:14px;">`)
    lines.push(`<div class="card-label" style="margin-bottom:8px;">Today · ${todayDay.dayName}</div>`)
    todayDay.blocks.forEach(b => {
      lines.push(
        `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);">` +
        `<span class="mono" style="color:var(--accent);font-size:11px;min-width:32px;">${fmt(b.minutes)}</span>` +
        `<span style="flex:1;font-size:13px;color:var(--ink-soft);">${esc(b.label)}</span>` +
        `<span class="mono muted" style="font-size:10px;">${esc(b.subject)}</span>` +
        `</div>`
      )
    })
    lines.push(`</div>`)
  }

  // ── Next 7 days ───────────────────────────────────────────────────────────
  const upcoming = result.days.filter(d => d.date > todayIST()).slice(0, 7)
  if (upcoming.length > 0) {
    lines.push(`<div class="card-label" style="margin-bottom:8px;margin-top:4px;">Next 7 days</div>`)
    lines.push(`<div style="display:flex;flex-direction:column;gap:4px;">`)
    upcoming.forEach(d => {
      const subjects = [...new Set(d.blocks.map(b => b.subject))].slice(0, 3).join(', ')
      lines.push(
        `<div style="display:flex;align-items:baseline;gap:10px;font-size:12.5px;color:var(--ink-soft);">` +
        `<span class="mono" style="color:var(--muted);min-width:70px;">${d.date.slice(5)} ${d.dayName.slice(0,3)}</span>` +
        `<span>${fmt(d.usedMins)} · ${subjects}</span>` +
        `</div>`
      )
    })
    lines.push(`</div>`)
  }

  // ── Disclaimer ────────────────────────────────────────────────────────────
  lines.push(`<p style="font-size:11px;color:var(--muted);margin-top:16px;font-family:var(--font-mono);">${s.disclaimer}</p>`)

  container.innerHTML = lines.join('')
}

function metricChip(label: string, value: string): string {
  return `<div style="display:flex;flex-direction:column;gap:3px;background:var(--panel);` +
    `border-radius:var(--r-sm);padding:8px 12px;">` +
    `<span style="font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.1em;">${label.toUpperCase()}</span>` +
    `<span style="font-family:var(--font-display);font-size:15px;font-weight:600;color:var(--accent-ink);">${value}</span>` +
    `</div>`
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── rank inputs for store ─────────────────────────────────────────────────────

function buildRankInputs(s: CoreState) {
  const pre   = s.performance.prelimsAvg  != null
    ? Math.round(60 + (Math.min(s.performance.prelimsAvg, 100) / 100) * 140)
    : 110
  const mains = s.performance.optionalAvg != null
    ? Math.round(30 + (Math.min(s.performance.optionalAvg, 100) / 100) * 70)
    : 52
  return { pre, mains, inter: 165 }
}

// ── Phase 4: Spaced-Repetition revision queue ─────────────────────────────────

async function loadAndBindRevisions(): Promise<void> {
  const today = todayIST()
  let due: DueRevision[] = []
  try {
    due = await listDueRevisions(today)
  } catch (e) {
    console.error('[srs] listDueRevisions failed:', e)
    return
  }
  renderRevisionQueue(due, today)
}

function renderRevisionQueue(due: DueRevision[], today: string): void {
  // Find the revision queue container in #plan section
  const queueWrap = findRevisionQueueEl()
  if (!queueWrap) return

  if (due.length === 0) {
    queueWrap.innerHTML = `<p class="mono muted" style="font-size:13px;padding:12px 0;">
      No revisions due today. Check back after completing some lectures.
    </p>`
    return
  }

  queueWrap.innerHTML = due.map(r => {
    const label = dueDateLabel(r.due_date, today)
    const isOverdue = isDue(r.due_date, today)
    const labelClass = isOverdue ? 'rev-due now mono' : 'rev-due soon mono'
    const title = r.lecture_title ?? `Lecture (${r.lecture_id?.slice(0, 8)})`
    const subj  = r.subject_name ?? ''
    return `
      <div class="rev-card" id="rc-${r.id}" style="flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-weight:600;font-size:14px;">${esc(title)}</div>
            <div class="mono muted" style="font-size:11px;margin-top:2px;">
              ${subj ? esc(subj) + ' · ' : ''}due ${r.due_date.slice(5)} · reps: ${r.reps}
            </div>
          </div>
          <span class="${labelClass}">${label}</span>
        </div>
        <div class="srs-rating" data-id="${r.id}" style="display:flex;gap:6px;flex-wrap:wrap;">
          ${['again','hard','good','easy'].map(rc => `
            <button class="srs-btn" data-recall="${rc}" style="
              padding:4px 10px;font-size:11px;letter-spacing:.06em;font-family:var(--font-mono);
              border-radius:20px;cursor:pointer;background:var(--panel-2);
              border:1px solid var(--line-2);color:var(--ink-soft);transition:all .15s;
              text-transform:uppercase;" onmouseover="this.style.borderColor='var(--accent)'"
              onmouseout="this.style.borderColor='var(--line-2)'"
            >${rc}</button>`).join('')}
        </div>
      </div>`
  }).join('')

  // Attach recall-rating handlers
  due.forEach(r => {
    const ratingEl = queueWrap.querySelector(`[data-id="${r.id}"]`)
    ratingEl?.querySelectorAll<HTMLButtonElement>('.srs-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const recall = btn.dataset.recall as Recall
        const card = document.getElementById(`rc-${r.id}`)
        if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none' }
        try {
          await rateRevision(r, recall, today)
        } catch (e) {
          console.error('[srs] rateRevision failed:', e)
        }
        // Reload queue after rating
        await loadAndBindRevisions()
        recompute()  // refresh CoreState (backlog / planner)
      })
    })
  })
}

/** Find the existing "Spaced revision · due queue" wrapper in #plan section. */
function findRevisionQueueEl(): HTMLElement | null {
  // Look for a .rev-card parent container or the card-label containing "revision"
  const labels = document.querySelectorAll<HTMLElement>('#plan .card-label')
  for (const lbl of labels) {
    if (lbl.textContent?.toLowerCase().includes('revision')) {
      const sibling = lbl.nextElementSibling as HTMLElement | null
      return sibling
    }
  }
  return null
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function setText(id: string, val: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = val
}

function utcMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
