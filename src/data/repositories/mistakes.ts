import { supabase } from '../supabase'
import { todayIST } from '../../services/core'
import { effectiveUID } from '../effective-uid'

export interface Mistake {
  id: string
  subject: string | null
  question: string
  my_answer: string | null
  correct_note: string | null
  source: string | null
  created_at: string
}

export async function saveMistake(
  m: Pick<Mistake, 'subject' | 'question' | 'my_answer' | 'correct_note' | 'source'>
): Promise<Mistake> {
  const userId = await effectiveUID()
  const { data, error } = await supabase
    .from('mistakes')
    .insert({ ...m, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as Mistake
}

export async function listMistakes(): Promise<Mistake[]> {
  const { data, error } = await supabase
    .from('mistakes')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Mistake[]
}

export async function deleteMistake(id: string): Promise<void> {
  await supabase.from('mistakes').delete().eq('id', id)
}

export async function countMistakesBySubject(): Promise<Record<string, number>> {
  const { data } = await supabase.from('mistakes').select('subject')
  const counts: Record<string, number> = {}
  for (const row of data ?? []) {
    const s = row.subject ?? 'General'
    counts[s] = (counts[s] ?? 0) + 1
  }
  return counts
}
