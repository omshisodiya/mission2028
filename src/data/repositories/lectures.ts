import { supabase } from '../supabase'
import { upsertByNames } from './subjects'
import { todayIST } from '../../services/core'

export type LectureStatus = 'backlog' | 'upcoming' | 'today' | 'done'

export interface Lecture {
  id: string
  user_id: string
  subject_id: string | null
  topic_id: string | null
  title: string
  source: string
  sequence: number | null
  duration_min: number
  week: number | null
  status: LectureStatus
  done: boolean
  done_at: string | null
  /** IST date this lecture was explicitly assigned for (YYYY-MM-DD).
   *  Set on import when status='today', and updated by rolloverUndoneToday()
   *  each new day so undone "today" lectures cascade forward automatically. */
  planned_date: string | null
  created_at: string
  updated_at: string
}

export interface LectureWithSubject extends Lecture {
  subjects: { name: string } | null
}

export interface LectureInsert {
  title: string
  subject?: string       // free-text; auto-resolved to subject_id
  source?: string
  sequence?: number | null
  duration_min?: number
  week?: number | null
  status?: LectureStatus
}

async function uid(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  return session.user.id
}

const STATUS_ORDER: Record<string, number> = { today: 0, backlog: 1, upcoming: 2, done: 3 }

export async function listLectures(): Promise<LectureWithSubject[]> {
  const { data, error } = await supabase
    .from('lectures')
    .select('*, subjects(name)')
    .order('sequence', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) throw error

  const rows = (data as LectureWithSubject[]) ?? []

  // Sort client-side: today → backlog → upcoming → done
  return rows.sort((a, b) => {
    const ao = STATUS_ORDER[a.done ? 'done' : a.status] ?? 99
    const bo = STATUS_ORDER[b.done ? 'done' : b.status] ?? 99
    if (ao !== bo) return ao - bo
    return (a.sequence ?? 9999) - (b.sequence ?? 9999)
  })
}

/**
 * @param plannedDate  Pass the lecture's planned_date when un-ticking so the
 *                     lecture restores to status='today' rather than 'backlog'.
 *                     This keeps it visible in the Today filter and eligible for
 *                     the next-day rollover.
 */
export async function markDone(id: string, done: boolean, plannedDate?: string | null): Promise<void> {
  const { error } = await supabase
    .from('lectures')
    .update({
      done,
      done_at: done ? new Date().toISOString() : null,
      // Un-ticking a lecture that had a planned_date should go back to 'today'
      // (so rolloverUndoneToday() cascades it forward tomorrow).
      // A lecture with no planned_date was never in the Today list → restore to backlog.
      status: done ? 'done' : (plannedDate ? 'today' : 'backlog'),
    })
    .eq('id', id)
  if (error) throw error
}

const INSERT_BATCH = 150   // safe Supabase request size for free tier

export async function insertLectures(
  rows: LectureInsert[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const userId = await uid()

  // Resolve / auto-create subjects in one round-trip
  const subjectNames = rows.map(r => r.subject ?? '').filter(Boolean)
  const subjectMap = await upsertByNames(subjectNames)

  const today = todayIST()
  const records = rows.map(r => ({
    user_id:      userId,
    title:        r.title,
    source:       r.source ?? 'PW · Prarambh',
    sequence:     r.sequence ?? null,
    duration_min: r.duration_min ?? 60,
    week:         r.week ?? null,
    status:       r.status ?? 'backlog',
    subject_id:   r.subject ? (subjectMap.get(r.subject.toLowerCase()) ?? null) : null,
    // Stamp planned_date for lectures explicitly imported as 'today'
    planned_date: (r.status === 'today') ? today : null,
  }))

  // Batch insert — avoids Supabase request-size limits and shows progress
  for (let i = 0; i < records.length; i += INSERT_BATCH) {
    const batch = records.slice(i, i + INSERT_BATCH)
    const { error } = await supabase.from('lectures').insert(batch)
    if (error) throw error
    onProgress?.(Math.min(i + INSERT_BATCH, records.length), records.length)
  }
}

export async function insertOneLecture(row: LectureInsert): Promise<void> {
  return insertLectures([row])
}

export async function countLectures(): Promise<number> {
  const { count } = await supabase
    .from('lectures')
    .select('id', { count: 'exact', head: true })
  return count ?? 0
}

/**
 * Day-rollover: called once per calendar day on boot.
 * Shifts undone "today" lectures to the new date so they stay in
 * the Today list instead of silently falling into the backlog.
 *
 * Two passes:
 *  1. Lectures with a past planned_date (missed from a prior day)
 *  2. Lectures with status='today' but no planned_date yet (legacy)
 */
export async function rolloverUndoneToday(today: string): Promise<void> {
  // Pass 1: shift lectures whose planned_date is an earlier date
  await supabase
    .from('lectures')
    .update({ planned_date: today })
    .eq('done', false)
    .eq('status', 'today')
    .lt('planned_date', today)

  // Pass 2: stamp 'today'-status lectures that never had a planned_date
  await supabase
    .from('lectures')
    .update({ planned_date: today })
    .eq('done', false)
    .eq('status', 'today')
    .is('planned_date', null)
}

/**
 * Explicitly assign a lecture to a specific date (and mark status='today').
 * Called when the user manually flags a lecture for today.
 */
export async function assignToDate(id: string, date: string): Promise<void> {
  const { error } = await supabase
    .from('lectures')
    .update({ status: 'today', planned_date: date })
    .eq('id', id)
  if (error) throw error
}
