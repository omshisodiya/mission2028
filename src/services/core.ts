/**
 * services/core.ts — The single source of truth.
 * computeCoreState is pure, deterministic, and has no side effects.
 * Everything the user does writes an input; this function recomputes
 * the complete CoreState from all inputs; every widget reads only CoreState.
 */
import cfg from '../data/routine_config.json'
import type { RoutineDay } from '../data/repositories/routine'
import {
  todayIST as _todayIST,
  fullDayName, getSubject, getSchedule, getTopicLabel,
  getTargetQuestions, getMainsTarget, getComponentText,
  computeConsistency,
} from './routine'

// ── Input types ───────────────────────────────────────────────────────────────

export interface ScoreRow {
  date: string          // YYYY-MM-DD
  category: string      // prelims | csat | mains | optional | dpp | sectional | quiz
  subject?: string | null
  score: number         // raw score
  max_score: number     // max possible score
  label?: string | null
}

export interface SessionDay {
  day: string           // YYYY-MM-DD
  minutes: number       // total session minutes that day
}

export interface CoreInputs {
  routineDays: RoutineDay[]
  scores: ScoreRow[]
  sessionDays: SessionDay[]   // aggregated focus-session minutes per day
  lecturesDone: number
  lecturesTotal: number
  today: string               // YYYY-MM-DD IST (never inferred from device locale)
}

// ── Output type ───────────────────────────────────────────────────────────────

export interface CoreState {
  today: {
    date: string
    dayName: string
    dayType: string
    scheduleBlocks: string[]
    subject: string
    topicLabel: string
    targetQuestions: number
    mainsTarget: number
    componentText: string
  }
  hours: {
    today: number
    cumulative: number
    byDay: Record<string, number>
  }
  performance: {
    prelimsAvg:    number | null   // non-Maths accuracy avg (%)
    optionalAvg:   number | null   // Maths accuracy avg (%)
    mainsAvg:      number | null   // avg answers written / day
    accuracyToday: number | null
    testScoreAvg:  number | null
  }
  cumulative: {
    attempted:  number
    correct:    number
    marks:      number
    testsTaken: number
  }
  consistencyPct:          number | null
  selectionProbabilityPct: number | null
  rankProjection:          string
  approxRank:              string
  streak:                  number
  backlogRemaining:        number
  subjectAccuracy:         Record<string, number>   // keyword → avg accuracy %
  testScoreTrend:          number[]                  // last 8 event accuracies
  disclaimer:              string
}

// ── The one computation ───────────────────────────────────────────────────────

export function computeCoreState(inputs: CoreInputs): CoreState {
  const { routineDays, scores, sessionDays, lecturesDone, lecturesTotal, today } = inputs
  const minAtt = cfg.selection_probability.min_attempted_to_score

  // ── 1. Today's row + plan ─────────────────────────────────────────────────
  const todayRD = routineDays.find(d => d.day === today)
  const dayType = todayRD?.day_type ?? 'College'
  const subject = getSubject(today)
  const sched   = getSchedule(dayType)
  const priorDays = routineDays.filter(d => d.day < today)

  // ── 2. Hours (manual entry overrides focus-session sum) ───────────────────
  const sessionMap: Record<string, number> = {}
  sessionDays.forEach(s => { sessionMap[s.day] = (sessionMap[s.day] ?? 0) + s.minutes })

  const byDay: Record<string, number> = {}
  const allDates = new Set([
    ...routineDays.map(d => d.day),
    ...Object.keys(sessionMap),
  ])
  allDates.forEach(date => {
    const rd = routineDays.find(d => d.day === date)
    if (rd?.study_hours != null) {
      byDay[date] = Number(rd.study_hours)          // manual entry wins
    } else if (sessionMap[date]) {
      byDay[date] = sessionMap[date] / 60            // auto-fill from timer
    }
  })

  const hoursToday     = byDay[today] ?? 0
  const cumulativeHours = Object.values(byDay).reduce((s, v) => s + v, 0)

  // ── 3. Unified graded pool (routine + scores) ─────────────────────────────
  interface GradedEvent {
    date: string; isMaths: boolean
    attempted: number; correct: number
    accuracy: number; testScore: number
    mainsWritten: number
  }
  const pool: GradedEvent[] = []

  // From routine_days
  routineDays.forEach(rd => {
    const att = rd.attempted ?? 0
    const cor = rd.correct   ?? 0
    const wrg = rd.wrong     ?? 0
    if (att < minAtt) return
    const subj    = getSubject(rd.day)
    const isMaths = subj.includes('Mathematics') ||
                    subj === cfg.subject_rotation.biweekly_sectional.value
    const acc = att > 0 ? (cor / att) * 100 : 0
    const ts  = cor * cfg.scoring.marks_per_correct - wrg * cfg.scoring.negative_per_wrong
    pool.push({ date: rd.day, isMaths, attempted: att, correct: cor,
                accuracy: acc, testScore: ts, mainsWritten: rd.mains_written ?? 0 })
  })

  // From scores table (score/max_score → accuracy; category maps to isMaths)
  scores.forEach(sc => {
    if (!sc.max_score) return
    const MATHS_CATS = ['optional', 'sectional', 'csat']
    const isMaths = MATHS_CATS.includes(sc.category?.toLowerCase() ?? '') ||
                    (sc.subject?.toLowerCase().includes('math') ?? false)
    const acc = (sc.score / sc.max_score) * 100
    const att = Math.round(sc.max_score)   // proxy: treat max_score as attempted
    const cor = Math.round(sc.score)
    pool.push({ date: sc.date, isMaths, attempted: att, correct: cor,
                accuracy: acc, testScore: sc.score, mainsWritten: 0 })
  })

  // Sort pool chronologically
  pool.sort((a, b) => a.date < b.date ? -1 : 1)

  // ── 4. Running averages ───────────────────────────────────────────────────
  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null

  const prePool = pool.filter(e => !e.isMaths && e.accuracy > 0)
  const optPool = pool.filter(e => e.isMaths && e.accuracy > 0)

  const prelimsAvg  = avg(prePool.map(e => e.accuracy))
  const optionalAvg = avg(optPool.map(e => e.accuracy))

  // mains avg: routine days where mains_written > 0
  const mainsVals = routineDays.filter(d => d.mains_written && d.mains_written > 0)
                               .map(d => d.mains_written!)
  const mainsAvg = avg(mainsVals)

  // Cumulative
  const cumAttempted = pool.reduce((s, e) => s + e.attempted, 0)
  const cumCorrect   = pool.reduce((s, e) => s + e.correct, 0)
  const cumMarks     = pool.reduce((s, e) => s + e.testScore, 0)
  const testsTaken   = pool.length

  // Today
  const todayPool    = pool.filter(e => e.date === today)
  const accuracyToday = todayPool.length ? avg(todayPool.map(e => e.accuracy)) : null
  const testScoreAvg  = avg(pool.map(e => e.testScore).filter(v => v > 0))

  // ── 5. Consistency ────────────────────────────────────────────────────────
  const consistencyPct = todayRD ? computeConsistency(todayRD) : null
  const allCons = routineDays.map(rd => computeConsistency(rd)).filter(c => c !== null) as number[]
  const avgConsistency = avg(allCons)

  // ── 6. Selection probability + rank ──────────────────────────────────────
  let selectionProbabilityPct: number | null = null
  if (prelimsAvg !== null || optionalAvg !== null) {
    const w = cfg.selection_probability.weights
    selectionProbabilityPct =
      (prelimsAvg    ?? 0) * w.prelims    +
      (optionalAvg   ?? 0) * w.optional   +
      (mainsAvg      ?? 0) * w.mains      +
      (avgConsistency ?? 0) * w.consistency +
      (testScoreAvg  ?? 0) * w.test_score
  }

  const rankProjection = bandLookup(selectionProbabilityPct, cfg.rank_projection_bands)
  const approxRank     = bandLookup(selectionProbabilityPct, cfg.approx_rank_bands)

  // ── 7. Streak (consecutive days with hours > 0) ───────────────────────────
  let streak = 0
  const sortedDays = Object.keys(byDay).sort().reverse()
  let expectingDate = today
  for (const date of sortedDays) {
    if (date > today) continue
    if (date === expectingDate && byDay[date] > 0) {
      streak++
      // Step back one calendar day
      const d = new Date(date + 'T12:00:00Z')
      d.setUTCDate(d.getUTCDate() - 1)
      expectingDate = d.toISOString().slice(0, 10)
    } else if (date < expectingDate) {
      break  // gap found
    }
  }

  // ── 8. Subject accuracy for donuts ───────────────────────────────────────
  const KWS = ['SJS', 'Geography', 'Environment', 'Medieval', 'Economy', 'Mathematics']
  const subjectAccuracy: Record<string, number> = {}
  KWS.forEach(kw => {
    const evts = pool.filter(e => getSubject(e.date).includes(kw) && e.accuracy > 0)
    const a = avg(evts.map(e => e.accuracy))
    if (a !== null) subjectAccuracy[kw] = a
  })

  // ── 9. Test score trend (last 8 events) ──────────────────────────────────
  const testScoreTrend = pool.slice(-8).map(e => Math.round(e.accuracy))

  return {
    today: {
      date: today,
      dayName: fullDayName(today),
      dayType,
      scheduleBlocks: sched.blocks,
      subject,
      topicLabel: getTopicLabel(today, subject, priorDays),
      targetQuestions: getTargetQuestions(subject, dayType),
      mainsTarget: getMainsTarget(dayType),
      componentText: getComponentText(subject, dayType),
    },
    hours: { today: hoursToday, cumulative: cumulativeHours, byDay },
    performance: { prelimsAvg, optionalAvg, mainsAvg, accuracyToday, testScoreAvg },
    cumulative: {
      attempted: cumAttempted,
      correct: cumCorrect,
      marks: Math.round(cumMarks * 10) / 10,
      testsTaken,
    },
    consistencyPct,
    selectionProbabilityPct,
    rankProjection,
    approxRank,
    streak,
    backlogRemaining: Math.max(0, lecturesTotal - lecturesDone),
    subjectAccuracy,
    testScoreTrend,
    disclaimer: cfg.disclaimer,
  }
}

// ── Band lookup helper ────────────────────────────────────────────────────────

function bandLookup(sp: number | null, bands: { max: number; label: string }[]): string {
  if (sp === null || sp === 0) return bands[0].label
  for (const b of bands.slice(1)) { if (sp <= b.max) return b.label }
  return bands[bands.length - 1].label
}

export { _todayIST as todayIST }
