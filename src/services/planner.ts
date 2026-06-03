/**
 * services/planner.ts — deterministic Master Planner.
 * Pure functions only. No DOM, no network. Implements BLUEPRINT §4 exactly.
 * Re-running is idempotent: only future days are planned; done lectures are excluded.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlannerSettings {
  /** Minutes of study per weekday (key = 'Mon'…'Sun'). */
  weekdayCapacity: Record<string, number>
  /** YYYY-MM-DD — Prelims exam date. */
  examDate: string
  /** Days before examDate reserved for revisions + mocks only. */
  bufferDays: number
  /** Subject name → priority multiplier (higher = scheduled sooner). */
  subjectWeightage: Record<string, number>
  /** Hard cap: max minutes of same subject per day (interleaving). */
  maxMinsPerSubjectPerDay: number
}

export const DEFAULT_SETTINGS: PlannerSettings = {
  weekdayCapacity: { Mon: 180, Tue: 180, Wed: 180, Thu: 180, Fri: 180, Sat: 300, Sun: 120 },
  examDate: '2028-05-28',
  bufferDays: 60,
  subjectWeightage: {
    Polity: 1.5, 'Modern History': 1.3, Geography: 1.2, Economy: 1.3,
    Environment: 1.1, 'Science & Technology': 1.0, 'Art & Culture': 0.9,
    Mathematics: 1.2, CSAT: 0.8, 'Bridge Course': 0.6,
  },
  maxMinsPerSubjectPerDay: 150,
}

export interface PlannerLecture {
  id: string
  title: string
  subject: string | null     // from subjects.name join
  sequence: number | null
  duration_min: number
  done: boolean
}

export interface PlanBlock {
  lectureId: string
  label: string
  subject: string
  minutes: number
  kind: 'learn' | 'revise'
}

/** A revision due on a specific date — placed BEFORE greedy fill. */
export interface FixedRevision {
  date:      string   // YYYY-MM-DD when revision is due
  lectureId: string
  label:     string
  subject:   string
  minutes?:  number   // default 30
}

export interface PlanDay {
  date: string
  dayName: string
  capacityMins: number
  blocks: PlanBlock[]
  usedMins: number
  isBuffer: boolean
}

export interface DroppableSubject {
  subject: string
  lectures: number
  mins: number
  weight: number
}

export interface PlanResult {
  feasible: boolean
  deficit: {
    shortfallMins: number
    totalBacklogMins: number
    totalCapacityMins: number
    remedies: { a: string; b: string; c: string }
    droppable: DroppableSubject[]
  } | null
  /** Only days that have blocks (or today). */
  days: PlanDay[]
  metrics: {
    coveragePct: number
    projectedCompletionDate: string | null
    avgDailyLoadMins: number
    totalBacklogMins: number
    totalCapacityMins: number
    backlogCount: number
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

const DOW_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const DOW_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function ms(d: string): number {
  const [y, m, dd] = d.split('-').map(Number)
  return Date.UTC(y, m - 1, dd)
}

function addDays(d: string, n: number): string {
  return new Date(ms(d) + n * 86_400_000).toISOString().slice(0, 10)
}

function diffDays(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / 86_400_000)
}

function dowAbbr(d: string): string { return DOW_ABBR[new Date(ms(d)).getUTCDay()] }
function dowFull(d: string): string { return DOW_FULL[new Date(ms(d)).getUTCDay()] }

// ── Main computation ──────────────────────────────────────────────────────────

export function computePlan(
  allLectures: PlannerLecture[],
  settings: PlannerSettings,
  today: string,
  fixedRevisions: FixedRevision[] = [],
): PlanResult {
  // Guard: exam date must be in the future; if past, extend it 365 days from today
  const effectiveExamDate = settings.examDate > today
    ? settings.examDate
    : addDays(today, 365)  // graceful fallback — planner keeps working

  const resolvedSettings = { ...settings, examDate: effectiveExamDate }

  // Only undone lectures enter the backlog
  const backlog = allLectures
    .filter(l => !l.done)
    .sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999))

  const totalBacklogMins = backlog.reduce((s, l) => s + l.duration_min, 0)

  if (backlog.length === 0) {
    return {
      feasible: true, deficit: null, days: [],
      metrics: { coveragePct: 100, projectedCompletionDate: today,
                 avgDailyLoadMins: 0, totalBacklogMins: 0,
                 totalCapacityMins: 0, backlogCount: 0 },
    }
  }

  // ── 1. Build day calendar: today → examDate ─────────────────────────────────
  const bufferStart = addDays(resolvedSettings.examDate, -resolvedSettings.bufferDays)
  const totalDays   = diffDays(today, resolvedSettings.examDate)
  const calendar: PlanDay[] = []

  for (let i = 0; i <= totalDays; i++) {
    const date    = addDays(today, i)
    const isBuffer = date >= bufferStart
    const cap     = isBuffer ? 0 : (settings.weekdayCapacity[dowAbbr(date)] ?? 0)
    calendar.push({ date, dayName: dowFull(date), capacityMins: cap,
                    blocks: [], usedMins: 0, isBuffer })
  }

  // ── 2. Capacity before buffer ───────────────────────────────────────────────
  const totalCapacityMins = calendar
    .filter(d => !d.isBuffer)
    .reduce((s, d) => s + d.capacityMins, 0)

  // ── 3. Feasibility check (before fill) ─────────────────────────────────────
  let deficit: PlanResult['deficit'] = null
  if (totalBacklogMins > totalCapacityMins) {
    const shortfall = totalBacklogMins - totalCapacityMins
    const workDays  = calendar.filter(d => !d.isBuffer && d.capacityMins > 0)
    const extraPerDay = workDays.length > 0 ? Math.ceil(shortfall / workDays.length) : 0
    const extraMins   = Math.round(extraPerDay)
    const extraH      = (extraMins / 60).toFixed(1)

    // Droppable subjects (lowest-weight first)
    const grp = new Map<string, DroppableSubject>()
    for (const l of backlog) {
      const s = l.subject ?? 'Unassigned'
      const g = grp.get(s) ?? { subject: s, lectures: 0, mins: 0, weight: settings.subjectWeightage[s] ?? 1.0 }
      g.lectures++; g.mins += l.duration_min; grp.set(s, g)
    }
    const droppable = [...grp.values()]
      .sort((a, b) => a.weight - b.weight)
      .slice(0, 3)

    // Remedy (c): extend timeline by how many extra study days
    const avgCap = totalCapacityMins / Math.max(workDays.length, 1)
    const extraDays = avgCap > 0 ? Math.ceil(shortfall / avgCap) : 0
    const extendTo  = addDays(bufferStart, extraDays)

    const dropList = droppable.map(d =>
      `${d.subject} (${d.lectures} lectures, ${Math.round(d.mins/60)}h)`
    ).join('; ')

    deficit = {
      shortfallMins: shortfall, totalBacklogMins, totalCapacityMins, droppable,
      remedies: {
        a: `+${extraH}h/day (${extraMins} min) added to your daily targets clears the backlog`,
        b: droppable.length
          ? `Drop lowest-yield topics: ${dropList} — saves ${Math.round(droppable.reduce((s,d)=>s+d.mins,0)/60)}h`
          : 'No droppable topics identified',
        c: `Extend study window by ${extraDays} days — complete by ${extendTo} instead of ${bufferStart}`,
      },
    }
  }

  // ── 3b. Place fixed revision appointments FIRST on their due dates ─────────
  const revsByDate = new Map<string, FixedRevision[]>()
  for (const r of fixedRevisions) {
    const k = r.date >= today ? r.date : today   // overdue → place today
    const arr = revsByDate.get(k) ?? []; arr.push(r); revsByDate.set(k, arr)
  }
  for (const day of calendar) {
    const revs = revsByDate.get(day.date) ?? []
    for (const r of revs) {
      const mins = r.minutes ?? 30
      if (day.usedMins + mins > day.capacityMins) continue
      day.blocks.push({ lectureId: r.lectureId, label: `Revise: ${r.label}`,
                        subject: r.subject, minutes: mins, kind: 'revise' })
      day.usedMins += mins
    }
  }

  // ── 4. Subject queues — one per subject, sorted by sequence ────────────────
  const queues = new Map<string, PlannerLecture[]>()
  for (const l of backlog) {
    const s = l.subject ?? 'Unassigned'
    const q = queues.get(s) ?? []; q.push(l); queues.set(s, q)
  }

  // Subject rotation order: highest weight first (PYQ-weighted interleaving)
  const subjectOrder = [...queues.keys()].sort((a, b) => {
    const wa = settings.subjectWeightage[a] ?? 1.0
    const wb = settings.subjectWeightage[b] ?? 1.0
    return wb - wa
  })

  // ── 5. Greedy fill — day by day ─────────────────────────────────────────────
  let subIdx = 0
  let projectedCompletion: string | null = null
  let totalScheduledMins = 0
  const workingDays: PlanDay[] = []

  for (const day of calendar) {
    if (day.isBuffer || day.capacityMins === 0) continue
    workingDays.push(day)

    let remaining = day.capacityMins
    const todaySubjMins = new Map<string, number>()

    // Keep filling until capacity exhausted or all queues empty
    let passesWithoutProgress = 0
    while (remaining >= 15 && passesWithoutProgress < subjectOrder.length) {
      const subj = subjectOrder[subIdx % subjectOrder.length]
      subIdx++

      const queue = queues.get(subj)
      if (!queue || queue.length === 0) { passesWithoutProgress++; continue }

      const alreadyToday = todaySubjMins.get(subj) ?? 0
      if (alreadyToday >= settings.maxMinsPerSubjectPerDay) { passesWithoutProgress++; continue }

      const lecture    = queue[0]
      const canTake    = Math.min(lecture.duration_min, remaining, settings.maxMinsPerSubjectPerDay - alreadyToday)
      if (canTake < 15) { passesWithoutProgress++; continue }

      if (canTake >= lecture.duration_min) {
        queue.shift()   // fully scheduled this lecture
      } else {
        queue[0] = { ...lecture, duration_min: lecture.duration_min - canTake }  // partial
      }

      day.blocks.push({ lectureId: lecture.id, label: lecture.title, subject: subj, minutes: canTake, kind: 'learn' })
      day.usedMins    += canTake
      remaining       -= canTake
      totalScheduledMins += canTake
      todaySubjMins.set(subj, alreadyToday + canTake)
      passesWithoutProgress = 0

      // Check completion
      if ([...queues.values()].every(q => q.length === 0) && !projectedCompletion) {
        projectedCompletion = day.date
      }
    }

    if (projectedCompletion) break   // all scheduled — stop building calendar
  }

  // ── 6. Metrics ──────────────────────────────────────────────────────────────
  const scheduledCount = backlog.length - [...queues.values()].reduce((s, q) => s + q.length, 0)
  const coveragePct    = backlog.length > 0 ? Math.round(scheduledCount / backlog.length * 100) : 100
  const avgLoad        = workingDays.length > 0
    ? Math.round(totalScheduledMins / workingDays.length)
    : 0

  return {
    feasible: !deficit,
    deficit,
    days: calendar.filter(d => d.blocks.length > 0),
    metrics: {
      coveragePct,
      projectedCompletionDate: projectedCompletion,
      avgDailyLoadMins: avgLoad,
      totalBacklogMins,
      totalCapacityMins,
      backlogCount: backlog.length,
    },
  }
}
