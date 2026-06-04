/**
 * jarvis-proactive.ts — Autonomous Proactive Intelligence Engine
 *
 * JARVIS doesn't wait to be asked. It monitors everything and speaks up
 * at exactly the right moment with exactly the right information.
 *
 * Intelligence layers:
 * 1. Event triggers    — reacts to timer, planner, score events
 * 2. Time awareness    — optimal intervention times (morning, pre-exam, idle)
 * 3. Context analysis  — understands what section is visible and relevant
 * 4. Silence engine    — knows when NOT to speak (focused, already answering)
 * 5. Fatigue detection — detects study fatigue from behaviour patterns
 * 6. Insight generator — surfaces data patterns Om hasn't noticed
 * 7. Smart scheduling  — sends reminders at cognitively optimal moments
 */

import { todayIST } from '../services/core'

export type ProactiveCallback = (msg: string, priority: 'low' | 'normal' | 'high') => void

// ── State ─────────────────────────────────────────────────────────────────────

const _PROACTIVE_KEY = 'jarvis_proactive_v1'
const _INSIGHT_KEY   = 'jarvis_insights_v1'

interface ProactiveState {
  lastMorningBrief:   string
  lastInsight:        string
  lastFatigueWarning: string
  nudgeCount:         number
  silencedUntil:      number   // ms timestamp
  sessionStartMs:     number   // when current study session began
  peakHoursHit:       boolean  // has JARVIS suggested peak hours today
}

function loadState(): ProactiveState {
  try { return { ...defaultState(), ...JSON.parse(localStorage.getItem(_PROACTIVE_KEY) ?? '{}') } }
  catch { return defaultState() }
}

function defaultState(): ProactiveState {
  return { lastMorningBrief: '', lastInsight: '', lastFatigueWarning: '', nudgeCount: 0,
    silencedUntil: 0, sessionStartMs: 0, peakHoursHit: false }
}

function saveState(s: ProactiveState): void {
  localStorage.setItem(_PROACTIVE_KEY, JSON.stringify(s))
}

interface InsightRecord {
  text:      string
  type:      string
  shownAt:   string
  dismissed: boolean
}

function loadInsights(): InsightRecord[] {
  try { return JSON.parse(localStorage.getItem(_INSIGHT_KEY) ?? '[]') }
  catch { return [] }
}

function saveInsights(i: InsightRecord[]): void {
  localStorage.setItem(_INSIGHT_KEY, JSON.stringify(i.slice(0, 50)))
}

// ── Silence guard — don't spam ────────────────────────────────────────────────

let _isSpeaking     = false
let _isListening    = false
let _panelOpen      = false
let _lastNudgeMs    = 0
const MIN_NUDGE_GAP = 3 * 60_000  // minimum 3 min between proactive nudges

export function setProactiveContext(speaking: boolean, listening: boolean, panelOpen: boolean): void {
  _isSpeaking  = speaking
  _isListening = listening
  _panelOpen   = panelOpen
}

function canSpeak(): boolean {
  if (_isSpeaking || _isListening) return false
  if (Date.now() - _lastNudgeMs < MIN_NUDGE_GAP) return false
  if (loadState().silencedUntil > Date.now()) return false
  return true
}

export function silenceFor(minutes: number): void {
  const s = loadState()
  s.silencedUntil = Date.now() + minutes * 60_000
  saveState(s)
}

// ── 1. Morning brief generator ─────────────────────────────────────────────────

export function getMorningBrief(coreState: {
  streak?: number; today?: { subject?: string; topicLabel?: string; targetQuestions?: number }
  backlogRemaining?: number; performance?: { prelimsAvg?: number | null }
} | null): string {
  const now  = new Date()
  const hour = now.getHours()
  if (hour < 5 || hour >= 11) return ''

  const s = loadState()
  const today = todayIST()
  if (s.lastMorningBrief === today) return ''  // only once per day

  s.lastMorningBrief = today; saveState(s)

  const parts: string[] = []
  const streakPart = coreState?.streak ? `${coreState.streak}-day streak to protect.` : 'Start your streak today.'
  const subjectPart = coreState?.today?.subject ? `Today: ${coreState.today.subject}.` : ''
  const topicPart = coreState?.today?.topicLabel ? `Lecture: ${coreState.today.topicLabel}.` : ''
  const mcqPart = (coreState?.today?.targetQuestions ?? 0) > 0 ? `Target: ${coreState?.today?.targetQuestions ?? 0} MCQs.` : ''
  const backlogPart = (coreState?.backlogRemaining ?? 0) > 30 ? `Backlog: ${coreState?.backlogRemaining} lectures — stay consistent.` : ''
  const avgPart = coreState?.performance?.prelimsAvg != null ? `Prelims avg: ${coreState.performance.prelimsAvg.toFixed(1)}%.` : ''

  parts.push('Good morning, Om.', streakPart, subjectPart, topicPart, mcqPart, backlogPart, avgPart)
  parts.push('What are we starting with?')

  return parts.filter(Boolean).join(' ')
}

// ── 2. Peak hours reminder ──────────────────────────────────────────────────────

export function getPeakHoursNudge(minutesStudiedToday: number): string {
  const s    = loadState()
  const hour = new Date().getHours()
  if (s.peakHoursHit) return ''

  if (hour >= 8 && hour <= 10 && minutesStudiedToday < 15) {
    s.peakHoursHit = true; saveState(s)
    return 'Peak cognitive window: 8–11 AM. Your brain is at maximum capacity right now. Start the hardest subject — this hour is worth 2 normal hours.'
  }
  if (hour >= 16 && hour <= 18 && minutesStudiedToday < 60) {
    s.peakHoursHit = true; saveState(s)
    return 'Second peak window: 4–7 PM. Ideal for revision and practice tests. Your recall is strongest right now.'
  }
  return ''
}

// ── 3. Fatigue detector ────────────────────────────────────────────────────────

interface ActivityRecord {
  ms:   number
  type: 'keydown' | 'mousedown' | 'query'
}

const _activity: ActivityRecord[] = []

export function recordActivity(type: ActivityRecord['type']): void {
  _activity.push({ ms: Date.now(), type })
  if (_activity.length > 200) _activity.splice(0, 100)
}

export function detectFatigue(): 'none' | 'mild' | 'significant' {
  if (_activity.length < 20) return 'none'
  const now     = Date.now()
  const last5m  = _activity.filter(a => a.ms > now - 5 * 60_000).length
  const last30m = _activity.filter(a => a.ms > now - 30 * 60_000).length

  // Very slow activity in last 5 min vs last 30 min
  if (last5m < 3 && last30m > 50) return 'significant'
  if (last5m < 8 && last30m > 30) return 'mild'
  return 'none'
}

export function getFatigueNudge(): string {
  const s       = loadState()
  const fatigue = detectFatigue()
  if (fatigue === 'none') return ''
  if (Date.now() - new Date(s.lastFatigueWarning || '2000-01-01').getTime() < 30 * 60_000) return ''

  s.lastFatigueWarning = new Date().toISOString(); saveState(s)

  if (fatigue === 'significant') {
    return 'You seem to have slowed significantly. That is completely normal — your brain needs rest to consolidate what you learned. Take a 15-minute break: walk, drink water, stretch. Come back sharper.'
  }
  return 'Activity slowing down — a short 5-minute break will actually make the next session more productive. Rest is part of the training.'
}

// ── 4. Data insight generator ─────────────────────────────────────────────────

export function generateDataInsight(coreState: {
  streak?: number
  performance?: { prelimsAvg?: number | null; accuracyToday?: number | null }
  testScoreTrend?: number[]
  selectionProbabilityPct?: number | null
  backlogRemaining?: number
  hours?: { today: number; cumulative: number }
} | null): string {
  if (!coreState) return ''

  const s     = loadState()
  const today = todayIST()
  if (s.lastInsight === today) return ''  // one insight per day

  const insights: string[] = []

  // Score trend analysis
  const trend = coreState.testScoreTrend ?? []
  if (trend.length >= 3) {
    const recent3Avg = trend.slice(-3).reduce((a, b) => a + b, 0) / 3
    const first3Avg  = trend.slice(0, 3).reduce((a, b) => a + b, 0) / 3
    if (recent3Avg > first3Avg + 5) insights.push(`Your score trend is strongly UP — last 3 tests averaged ${recent3Avg.toFixed(0)}% vs first 3 at ${first3Avg.toFixed(0)}%. You are in improvement mode.`)
    else if (recent3Avg < first3Avg - 5) insights.push(`Your scores have dipped slightly. This is normal — you are probably covering harder material. Stay consistent, the curve will recover.`)
  }

  // Streak power
  if ((coreState.streak ?? 0) >= 7 && (coreState.streak ?? 0) % 7 === 0) {
    insights.push(`${coreState.streak}-day streak! Research shows habits become automatic at 21 days — you are ${Math.round(((coreState.streak ?? 7) / 21) * 100)}% there.`)
  }

  // Cumulative hours milestone
  const cumH = Math.floor(coreState.hours?.cumulative ?? 0)
  if (cumH >= 100 && cumH % 100 < 2) {
    insights.push(`${cumH} total study hours logged! At this rate you will have 1,000 hours before the 2028 exam. Quality consistent work is what separates selections from near-misses.`)
  }

  const chosen = insights[0]
  if (chosen) { s.lastInsight = today; saveState(s) }
  return chosen ?? ''
}

// ── 5. Pre-exam eve protocol ───────────────────────────────────────────────────

export function getPreExamProtocol(daysToExam: number): string {
  if (daysToExam <= 0 || daysToExam > 7) return ''

  const protocols: Record<number, string> = {
    7: 'One week to exam. Final week protocol: NO new topics. Only revision of your own notes. 2 full mock tests this week, analyse every wrong answer.',
    3: 'Three days to exam. Wind down new learning. Revise weak areas only. 10 PYQs per subject. Sleep 8 hours every night — sleep literally makes you smarter.',
    2: 'Two days out. Today: light revision of key formulas, articles, dates. Tomorrow: light, only glance at notes. Full rest by 10 PM.',
    1: 'Exam tomorrow. Stop studying at 9 PM tonight. Lay out everything tonight — ID, admit card, pens. Light meal. Sleep by 10:30 PM. You are prepared. Trust your preparation.',
  }

  return protocols[daysToExam] ?? (daysToExam <= 7 ? `${daysToExam} days to exam. Consolidate, do not learn new content.` : '')
}

// ── 6. Streak risk alert ───────────────────────────────────────────────────────

export function getStreakRiskAlert(streak: number, minutesToday: number): string {
  const hour = new Date().getHours()
  if (hour < 18 || minutesToday >= 25) return ''  // too early or already safe
  if (streak < 3) return ''  // no streak to protect

  return `Streak alert: ${streak}-day streak at risk. It is ${new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })} and you have ${minutesToday} minutes logged. One 25-minute session will keep your streak alive. Start now.`
}

// ── 7. Smart insight surface ───────────────────────────────────────────────────

export function getTimedInsight(context: {
  coreState: Parameters<typeof generateDataInsight>[0]
  minutesToday: number
  streak: number
  daysToExam?: number
}): string | null {
  if (!canSpeak()) return null

  const { coreState, minutesToday, streak, daysToExam } = context
  const hour = new Date().getHours()

  // Priority order: exam protocol > morning brief > streak risk > peak hours > fatigue > data insight
  if (daysToExam !== undefined && daysToExam <= 7) {
    const proto = getPreExamProtocol(daysToExam)
    if (proto) { _lastNudgeMs = Date.now(); return proto }
  }

  if (hour >= 5 && hour < 11) {
    const brief = getMorningBrief(coreState)
    if (brief) { _lastNudgeMs = Date.now(); return brief }
  }

  if (hour >= 18) {
    const risk = getStreakRiskAlert(streak, minutesToday)
    if (risk) { _lastNudgeMs = Date.now(); return risk }
  }

  const peak = getPeakHoursNudge(minutesToday)
  if (peak) { _lastNudgeMs = Date.now(); return peak }

  const fatigue = getFatigueNudge()
  if (fatigue) { _lastNudgeMs = Date.now(); return fatigue }

  const insight = generateDataInsight(coreState)
  if (insight) { _lastNudgeMs = Date.now(); return insight }

  return null
}

// ── 8. Proactive engine runner ────────────────────────────────────────────────

let _proactiveLoopId = 0

export function startProactiveEngine(
  getMinutesToday: () => number,
  getStreak:       () => number,
  getDaysToExam:   () => number | undefined,
  getCoreState:    () => Parameters<typeof generateDataInsight>[0],
  onInsight:       ProactiveCallback,
): void {
  if (_proactiveLoopId) return

  _proactiveLoopId = window.setInterval(() => {
    const insight = getTimedInsight({
      coreState:    getCoreState(),
      minutesToday: getMinutesToday(),
      streak:       getStreak(),
      daysToExam:   getDaysToExam(),
    })
    if (insight) onInsight(insight, 'normal')
  }, 90_000)  // check every 90 seconds
}

export function stopProactiveEngine(): void {
  if (_proactiveLoopId) { clearInterval(_proactiveLoopId); _proactiveLoopId = 0 }
}
