import { supabase } from '../supabase'
import { buildInitialRevisions, updateAfterReview, type RevisionRow, type Recall } from '../../services/srs'

async function uid(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  return session.user.id
}

/** Insert revision schedule rows when a lecture is first completed. */
export async function createRevisionSchedule(lectureId: string, today: string): Promise<void> {
  const userId = await uid()

  // Only create if no existing revisions for this lecture
  const { data: existing } = await supabase
    .from('revisions')
    .select('id')
    .eq('user_id', userId)
    .eq('lecture_id', lectureId)
    .limit(1)
  if (existing && existing.length > 0) return  // already scheduled

  const rows = buildInitialRevisions(lectureId, today).map(r => ({
    user_id: userId, ...r,
  }))
  const { error } = await supabase.from('revisions').insert(rows)
  if (error) throw error
}

export interface DueRevision extends RevisionRow {
  id: string
  lecture_title?: string
  subject_name?:  string
}

/** Fetch all revisions due on or before today, joined with lecture title. */
export async function listDueRevisions(today: string): Promise<DueRevision[]> {
  const { data, error } = await supabase
    .from('revisions')
    .select('*, lectures(title, subjects(name))')
    .lte('due_date', today)
    .order('due_date', { ascending: true })
  if (error) throw error

  return (data ?? []).map(r => ({
    id:            r.id,
    lecture_id:    r.lecture_id,
    ease:          Number(r.ease),
    interval_days: r.interval_days,
    reps:          r.reps,
    due_date:      r.due_date,
    last_review:   r.last_review,
    lecture_title: r.lectures?.title,
    subject_name:  r.lectures?.subjects?.name,
  }))
}

/** Fetch all upcoming revisions (not yet due, for planner fixed appointments). */
export async function listUpcomingRevisions(fromDate: string, toDate: string): Promise<RevisionRow[]> {
  const { data, error } = await supabase
    .from('revisions')
    .select('id, lecture_id, due_date, interval_days, ease, reps, last_review')
    .gt('due_date', fromDate)
    .lte('due_date', toDate)
    .order('due_date', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => ({
    id: r.id, lecture_id: r.lecture_id, ease: Number(r.ease),
    interval_days: r.interval_days, reps: r.reps,
    due_date: r.due_date, last_review: r.last_review,
  }))
}

/** Apply a recall rating to a revision and persist the updated row. */
export async function rateRevision(row: DueRevision, recall: Recall, today: string): Promise<void> {
  const updated = updateAfterReview(row, recall, today)
  const { error } = await supabase
    .from('revisions')
    .update({
      ease:          updated.ease,
      interval_days: updated.interval_days,
      reps:          updated.reps,
      due_date:      updated.due_date,
      last_review:   updated.last_review,
    })
    .eq('id', row.id)
  if (error) throw error
}
