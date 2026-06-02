/**
 * services/srs.ts — SM-2 lite spaced-repetition engine.
 * Pure functions only. No DOM, no network.
 *
 * Initial intervals on first completion: [1, 3, 7, 16, 35] days.
 * Recall rating adjusts ease factor + next interval per SM-2 algorithm.
 */

export type Recall = 'again' | 'hard' | 'good' | 'easy'

/** Intervals (days) created when a lecture is first marked done. */
export const INITIAL_INTERVALS = [1, 3, 7, 16, 35]

export interface RevisionRow {
  id?:           string
  lecture_id:    string | null
  topic_id?:     string | null
  ease:          number          // SM-2 ease factor, default 2.5
  interval_days: number
  reps:          number          // times successfully reviewed
  due_date:      string          // YYYY-MM-DD
  last_review:   string | null
}

// ── Date helper ───────────────────────────────────────────────────────────────

function addDays(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10)
}

// ── Create initial revision schedule ─────────────────────────────────────────

/**
 * Returns N revision rows to insert when a lecture is first completed.
 * Intervals: [1, 3, 7, 16, 35] days from completionDate.
 */
export function buildInitialRevisions(
  lectureId: string,
  completionDate: string,
): Omit<RevisionRow, 'id'>[] {
  return INITIAL_INTERVALS.map(days => ({
    lecture_id:    lectureId,
    ease:          2.5,
    interval_days: days,
    reps:          0,
    due_date:      addDays(completionDate, days),
    last_review:   null,
  }))
}

// ── SM-2 update after a review session ───────────────────────────────────────

/**
 * Returns an updated RevisionRow based on recall quality.
 * Mapping: again=q1, hard=q2, good=q4, easy=q5 (standard SM-2 scale).
 */
export function updateAfterReview(
  row: RevisionRow,
  recall: Recall,
  today: string,
): RevisionRow {
  let { ease, interval_days, reps } = row

  switch (recall) {
    case 'again':
      // Full reset: interval=1, ease drops
      reps = 0
      interval_days = 1
      ease = Math.max(1.3, ease - 0.20)
      break
    case 'hard':
      // Keep interval roughly same, ease drops slightly
      reps += 1
      interval_days = Math.max(1, Math.ceil(interval_days * 1.2))
      ease = Math.max(1.3, ease - 0.15)
      break
    case 'good':
      // Standard SM-2 advance
      reps += 1
      interval_days = reps === 1 ? 3 : reps === 2 ? 7 : Math.ceil(interval_days * ease)
      break
    case 'easy':
      // Accelerated advance, ease bonus
      reps += 1
      interval_days = reps === 1 ? 7 : Math.ceil(interval_days * ease * 1.3)
      ease = Math.min(3.0, ease + 0.10)
      break
  }

  return {
    ...row,
    ease,
    interval_days,
    reps,
    due_date:    addDays(today, interval_days),
    last_review: today,
  }
}

// ── Helpers for display ───────────────────────────────────────────────────────

/** Human-readable due-date label relative to today. */
export function dueDateLabel(dueDate: string, today: string): string {
  const [ty, tm, td] = today.split('-').map(Number)
  const [dy, dm, dd] = dueDate.split('-').map(Number)
  const todayMs = Date.UTC(ty, tm - 1, td)
  const dueMs   = Date.UTC(dy, dm - 1, dd)
  const diff    = Math.round((dueMs - todayMs) / 86_400_000)
  if (diff < 0)  return 'OVERDUE'
  if (diff === 0) return 'DUE NOW'
  if (diff === 1) return 'IN 1 DAY'
  return `IN ${diff} DAYS`
}

export function isDue(dueDate: string, today: string): boolean {
  return dueDate <= today
}
