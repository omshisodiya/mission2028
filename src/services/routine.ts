/**
 * services/routine.ts — pure functions only. No DOM, no network.
 * All logic mirrors routine_config.json exactly.
 */
import cfg from '../data/routine_config.json'
import type { RoutineDay } from '../data/repositories/routine'

// ── date helpers ──────────────────────────────────────────────────────────────

/** Current date in IST as YYYY-MM-DD. Never uses device locale. */
export function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: cfg.timezone })
}

function utcMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function dowNum(dateStr: string): number {
  return utcMidnight(dateStr).getUTCDay() // 0=Sun … 6=Sat
}

const FULL_DAY  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const ABBR_DAY  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const

export function fullDayName(dateStr: string): string { return FULL_DAY[dowNum(dateStr)] }

export function formatDateDisplay(dateStr: string): string {
  return utcMidnight(dateStr).toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

// ── subject rotation (exact rules from config) ────────────────────────────────

export function getSubject(dateStr: string): string {
  const dow = dowNum(dateStr)

  // Rule 1: Sunday → Full Test
  if (dow === 0) return cfg.subject_rotation.sunday_is_full_test

  // Rule 2: Biweekly sectional anchored to 2026-03-02
  const anchorMs = utcMidnight(cfg.subject_rotation.biweekly_sectional.anchored_to).getTime()
  const diff     = Math.round((utcMidnight(dateStr).getTime() - anchorMs) / 86_400_000)
  if (diff >= 0 && diff % cfg.subject_rotation.biweekly_sectional.every_n_days === 0) {
    return cfg.subject_rotation.biweekly_sectional.value
  }

  // Rule 3: Weekday map
  const abbr = ABBR_DAY[dow] as keyof typeof cfg.subject_rotation.weekday_choose
  return cfg.subject_rotation.weekday_choose[abbr] ?? 'Mathematics Practice (Current Module)'
}

// ── topic label (COUNTIF-style running counter) ───────────────────────────────

export function getTopicLabel(dateStr: string, subject: string, priorDays: RoutineDay[]): string {
  if (subject === cfg.subject_rotation.sunday_is_full_test) return cfg.topic_counter.full_test
  if (subject === cfg.subject_rotation.biweekly_sectional.value) return cfg.topic_counter.sectional
  if (subject.includes('Mathematics Intensive') ||
      !cfg.topic_counter.match_keywords.some(k => subject.includes(k))) {
    return cfg.topic_counter.default
  }

  const keyword = cfg.topic_counter.match_keywords.find(k => subject.includes(k))!
  const n = priorDays.filter(d => d.day < dateStr && getSubject(d.day).includes(keyword)).length + 1
  const tpl = (cfg.topic_counter.labels as Record<string, string>)[keyword]
  return tpl ? tpl.replace('{n}', String(n)) : cfg.topic_counter.default
}

// ── schedule, targets, component ─────────────────────────────────────────────

type ScheduleEntry = { start_time: string; end_time: string; blocks: string[] }

export function getSchedule(dayType: string): ScheduleEntry {
  return dayType === 'College' ? cfg.schedules.College : cfg.schedules.Holiday
}

export function getTargetQuestions(subject: string, dayType: string): number {
  const tq = cfg.target_questions
  if (subject === 'PW Full Test') return tq['PW Full Test']
  if (subject === 'PW Optional Sectional') return tq['PW Optional Sectional']
  if (dayType === 'Holiday' || dayType === 'Leave') return tq.Holiday
  if (dayType === 'Test Day') return tq.Holiday      // Test Day gets full-session targets
  return tq.default
}

export function getMainsTarget(dayType: string): number {
  return (dayType === 'Holiday' || dayType === 'Leave' || dayType === 'Test Day')
    ? cfg.mains_written_target.Holiday
    : cfg.mains_written_target.default
}

export function getComponentText(subject: string, dayType: string): string {
  const ct = cfg.component_text
  if (subject === 'PW Full Test' || dayType === 'Test Day') return ct.full_test
  if (subject === 'PW Optional Sectional') return ct.sectional
  if (dayType === 'Holiday' || dayType === 'Leave') return ct.holiday
  return ct.college
}

// ── core metrics (mirror spreadsheet formulas exactly) ────────────────────────

export function computeAccuracy(correct: number | null, attempted: number | null): number | null {
  if (!attempted || attempted === 0 || correct == null) return null
  return (correct / attempted) * 100
}

export function computeTestScore(correct: number | null, wrong: number | null): number | null {
  if (correct == null && wrong == null) return null
  return (correct ?? 0) * cfg.scoring.marks_per_correct
       - (wrong   ?? 0) * cfg.scoring.negative_per_wrong
}

type ConsistencyRule = { if?: string; else?: boolean; value: number }

export function computeConsistency(day: RoutineDay): number | null {
  if (day.study_hours == null) return null  // blank_if: study_hours is empty
  const h = Number(day.study_hours)
  const m = day.mains_written ?? 0
  const a = day.attempted ?? 0
  const isHolidayType = ['Holiday', 'Leave', 'Test Day'].includes(day.day_type)
  const rules = (isHolidayType ? cfg.consistency_percent.Holiday : cfg.consistency_percent.College) as ConsistencyRule[]
  for (const rule of rules) {
    if (rule.else) return rule.value
    if (rule.if && evalCondition(rule.if, h, m, a)) return rule.value
  }
  return null
}

function evalCondition(expr: string, h: number, m: number, a: number): boolean {
  return expr.split(' AND ').every(clause => {
    const g = clause.trim().match(/(\w+)(>=|<=|>|<)(\d+\.?\d*)/)
    if (!g) return false
    const actual = g[1] === 'study_hours' ? h : g[1] === 'mains_written' ? m : a
    const val = parseFloat(g[3])
    return g[2] === '>=' ? actual >= val : g[2] === '<=' ? actual <= val
         : g[2] === '>' ? actual > val   : actual < val
  })
}

// ── aggregate / running averages ──────────────────────────────────────────────

export interface Aggregates {
  prelimsAvg:     number | null
  optionalAvg:    number | null
  mainsAvg:       number | null
  avgTestScore:   number | null
  avgConsistency: number | null
}

export function computeAggregates(allDays: RoutineDay[]): Aggregates {
  const pre: number[] = [], opt: number[] = [], mains: number[] = []
  const scores: number[] = [], cons: number[] = []
  const minAtt = cfg.selection_probability.min_attempted_to_score

  for (const d of allDays) {
    const subj  = getSubject(d.day)
    const isMath = subj.includes('Mathematics') || subj === cfg.subject_rotation.biweekly_sectional.value
    const acc   = computeAccuracy(d.correct, d.attempted)
    const score = computeTestScore(d.correct, d.wrong)
    const c     = computeConsistency(d)

    // Accuracy only counts when attempted >= min threshold
    if (acc !== null && (d.attempted ?? 0) >= minAtt) {
      isMath ? opt.push(acc) : pre.push(acc)
    }
    if (d.mains_written && d.mains_written > 0) mains.push(d.mains_written)
    if (score !== null && score > 0) scores.push(score)
    if (c !== null) cons.push(c)
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null
  return {
    prelimsAvg:     avg(pre),
    optionalAvg:    avg(opt),
    mainsAvg:       avg(mains),
    avgTestScore:   avg(scores),
    avgConsistency: avg(cons),
  }
}

export function computeSelectionProbability(agg: Aggregates): number | null {
  if (agg.prelimsAvg === null && agg.optionalAvg === null) return null
  const w = cfg.selection_probability.weights
  return (agg.prelimsAvg    ?? 0) * w.prelims    +
         (agg.optionalAvg   ?? 0) * w.optional   +
         (agg.mainsAvg      ?? 0) * w.mains      +
         (agg.avgConsistency ?? 0) * w.consistency +
         (agg.avgTestScore  ?? 0) * w.test_score
}

function bandLookup(sp: number | null, bands: { max: number; label: string }[]): string {
  if (sp === null || sp === 0) return bands[0].label
  for (const b of bands.slice(1)) { if (sp <= b.max) return b.label }
  return bands[bands.length - 1].label
}

export function getRankProjection(sp: number | null): string {
  return bandLookup(sp, cfg.rank_projection_bands)
}

export function getApproxRank(sp: number | null): string {
  return bandLookup(sp, cfg.approx_rank_bands)
}

// ── heatmap seed (182 ints, levels 0–4, from study_hours) ────────────────────

export function buildHeatSeed(allDays: RoutineDay[], today: string): number[] {
  const dayMap = new Map(allDays.map(d => [d.day, Number(d.study_hours ?? 0)]))
  const todayMs  = utcMidnight(today).getTime()
  const todayDow = dowNum(today)
  // Start from the Sunday 25 weeks back
  const startMs  = todayMs - (25 * 7 + todayDow) * 86_400_000
  const seed: number[] = []
  for (let w = 0; w < 26; w++) {
    for (let dow = 0; dow < 7; dow++) {
      const ms  = startMs + (w * 7 + dow) * 86_400_000
      const key = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'UTC' })
      const hrs = dayMap.get(key) ?? 0
      seed.push(hrs >= 6 ? 4 : hrs >= 4 ? 3 : hrs >= 2 ? 2 : hrs > 0 ? 1 : 0)
    }
  }
  return seed
}

// ── per-subject accuracy (for donut feeds) ────────────────────────────────────

export function subjectAccuracy(
  allDays: RoutineDay[],
  keyword: string,
  minAttempted = 10,
): number {
  const rows = allDays.filter(d => {
    const s = getSubject(d.day)
    return s.includes(keyword) && (d.attempted ?? 0) >= minAttempted
  })
  if (!rows.length) return 0
  const accs = rows.map(d => computeAccuracy(d.correct, d.attempted) ?? 0)
  return accs.reduce((s, v) => s + v, 0) / accs.length
}

// ── test scores for bar chart (last N test days) ──────────────────────────────

export function lastNTestAccuracies(allDays: RoutineDay[], n = 8): number[] {
  return allDays
    .filter(d => (d.attempted ?? 0) > 0 && d.correct != null)
    .slice(-n)
    .map(d => computeAccuracy(d.correct, d.attempted) ?? 0)
}

export const disclaimer = cfg.disclaimer

// ── Routine date carry-forward (missed-day cascade) ───────────────────────────

/**
 * Returns the calendar date whose subject should be shown today.
 *
 * A day is "productive" when EITHER:
 *   • study_hours > 0 in routine_days, OR
 *   • at least one lecture was marked done (lectureCompletionDates contains the date)
 *
 * Rule: walk backwards from yesterday in consecutive steps. Every day that
 * was NOT productive is a "missed" day. Stop at the first productive day.
 * The oldest missed day in that chain becomes the effective date.
 *
 * Example:
 *   Productive: June 14. Missed: June 15, 16. Today: June 17 (not yet logged).
 *   → chain = [June 16, June 15] → effectiveDate = June 15.
 *   → Show June 15's subject on June 17.
 *
 * After completing a lecture on June 17, tomorrow's chain will be:
 *   i=1 (June 17: productive via lecture) → break → effectiveDate = June 18.
 *
 * maxLookback caps the search (30 days covers any realistic backlog).
 */
export function getEffectiveSubjectDate(
  today: string,
  routineDays: RoutineDay[],
  lectureCompletionDates: string[] = [],
  maxLookback = 30,
): { effectiveDate: string; missedDays: number } {
  // Days productive via study hours logged in the routine
  const studiedViaHours = new Set(
    routineDays.filter(d => (d.study_hours ?? 0) > 0).map(d => d.day),
  )
  // Days productive via at least one lecture completed (IST dates)
  const studiedViaLectures = new Set(lectureCompletionDates)

  // Union: either signal marks the day as done
  const productive = new Set([...studiedViaHours, ...studiedViaLectures])

  const [ty, tm, td] = today.split('-').map(Number)
  const todayMs = Date.UTC(ty, tm - 1, td)

  let missedDays = 0
  for (let i = 1; i <= maxLookback; i++) {
    const ms = todayMs - i * 86_400_000
    const d  = new Date(ms).toISOString().slice(0, 10)
    if (productive.has(d)) break   // consecutive chain broken — stop
    missedDays++
  }

  const effectiveMs   = todayMs - missedDays * 86_400_000
  const effectiveDate = new Date(effectiveMs).toISOString().slice(0, 10)
  return { effectiveDate, missedDays }
}
