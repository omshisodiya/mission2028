import { supabase } from '../supabase'
import { upsertByNames } from './subjects'

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

export async function markDone(id: string, done: boolean): Promise<void> {
  const { error } = await supabase
    .from('lectures')
    .update({
      done,
      done_at: done ? new Date().toISOString() : null,
      status: done ? 'done' : 'backlog',
    })
    .eq('id', id)
  if (error) throw error
}

export async function insertLectures(rows: LectureInsert[]): Promise<void> {
  const userId = await uid()

  // Auto-create subjects from free-text names
  const subjectNames = rows.map(r => r.subject ?? '').filter(Boolean)
  const subjectMap = await upsertByNames(subjectNames)

  const records = rows.map(r => ({
    user_id: userId,
    title: r.title,
    source: r.source ?? 'PW · Prarambh',
    sequence: r.sequence ?? null,
    duration_min: r.duration_min ?? 60,
    week: r.week ?? null,
    status: r.status ?? 'backlog',
    subject_id: r.subject ? (subjectMap.get(r.subject.toLowerCase()) ?? null) : null,
  }))

  const { error } = await supabase.from('lectures').insert(records)
  if (error) throw error
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
