/**
 * core-engine.ts — orchestration layer.
 * Loads all inputs → computeCoreState → caches in store → binds every widget.
 * No widget computes its own numbers. All reads go through CoreState.
 */
import { computeCoreState, todayIST, type CoreState, type CoreInputs } from '../services/core'
import { listRoutineDays } from '../data/repositories/routine'
import { listScores } from '../data/repositories/scores'
import { listSessionDays } from '../data/repositories/sessions'
import { listLectures } from '../data/repositories/lectures'
import { setPlannerSubjectContext } from './lectures-planner'

// ── Module state ──────────────────────────────────────────────────────────────

let _state: CoreState | null = null
let _recomputeTimer: ReturnType<typeof setTimeout> | null = null

// ── Public API ────────────────────────────────────────────────────────────────

/** Load all inputs from DB, compute CoreState, bind widgets. Call on boot. */
export async function loadAndBind(): Promise<void> {
  const inputs = await fetchInputs()
  _state = computeCoreState(inputs)
  cacheInStore(_state)
  bindWidgets(_state)
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

function bindWidgets(s: CoreState): void {
  bindStrip(s)
  bindRankSim(s)
  bindBarCharts(s)
  bindDonuts(s)
  bindHeatmap(s)
  bindStreak(s)
  bindCountUps(s)
  bindBriefing(s)
  // Push subject context into the planner so today's lectures surface first
  setPlannerSubjectContext(s.today.subject, todaySubjectKeywords())
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

// count-ups in the Intelligence stat row
function bindCountUps(s: CoreState): void {
  // Mocks attempted
  updateCountUp('[data-to]', '.stat:nth-child(1) .count-up', s.cumulative.testsTaken)
  // Avg prelims score (as accuracy %, capped at 200)
  const avgPre = s.performance.prelimsAvg
  updateCountUp('[data-to]', '.stat:nth-child(2) .count-up',
    avgPre != null ? Math.round(avgPre * 2) : 0)   // map 0-100% → 0-200 scale
  // Accuracy %
  updateCountUp('[data-to]', '.stat:nth-child(3) .count-up',
    avgPre != null ? Math.round(avgPre) : 0)
  // Active study days (from heatmap active count)
  const activeDays = Object.values(s.hours.byDay).filter(h => h > 0).length
  const heatActiveEl = document.getElementById('heat-active')
  if (heatActiveEl) heatActiveEl.textContent = String(activeDays)
  // Also update data-to on all stat count-ups for engine's countUp animation
  const statEls = document.querySelectorAll<HTMLElement>('.grid.g-4 .stat')
  const vals = [s.cumulative.testsTaken,
    avgPre != null ? Math.round(avgPre * 2) : 0,
    avgPre != null ? Math.round(avgPre) : 0,
    activeDays]
  statEls.forEach((el, i) => {
    const cu = el.querySelector<HTMLElement>('.count-up')
    if (cu && vals[i] != null) {
      cu.setAttribute('data-to', String(vals[i]))
      cu.textContent = String(vals[i])
    }
  })
}

function updateCountUp(selector: string, containerSel: string, value: number): void {
  const el = document.querySelector<HTMLElement>(containerSel)
  if (!el) return
  el.setAttribute('data-to', String(value))
  el.textContent = String(value)
}

// daily briefing — one-line summary
function bindBriefing(s: CoreState): void {
  const el = document.getElementById('rtn-briefing')
  if (!el) return

  const parts: string[] = []
  if (s.hours.today > 0) parts.push(`${s.hours.today.toFixed(1)}h studied today`)
  if (s.consistencyPct != null) parts.push(`consistency ${s.consistencyPct}%`)
  if (s.performance.prelimsAvg != null) parts.push(`prelims avg ${s.performance.prelimsAvg.toFixed(1)}%`)
  if (s.selectionProbabilityPct != null) parts.push(`SP ${s.selectionProbabilityPct.toFixed(1)}%`)
  if (s.backlogRemaining > 0) parts.push(`${s.backlogRemaining} lectures remaining`)

  el.textContent = parts.length
    ? parts.join(' · ')
    : 'Log today\'s inputs to see your briefing.'
}

// routine card — patch hours display after optimistic update
function patchHoursDisplay(s: CoreState): void {
  const el = document.getElementById('rtn-study-hours') as HTMLInputElement | null
  if (el && !el.value) el.value = s.hours.today.toFixed(1)
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

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function setText(id: string, val: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = val
}

function utcMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
