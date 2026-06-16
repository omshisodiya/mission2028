import { supabase } from '../supabase'
import { effectiveUID } from '../effective-uid'

export interface Note {
  id: string
  lecture_id: string | null
  topic_id: string | null
  body: string
  created_at: string
}

export async function saveNote(
  body: string,
  lectureId?: string | null,
  topicId?: string | null,
): Promise<Note> {
  const userId = await effectiveUID()
  const { data, error } = await supabase
    .from('notes')
    .insert({ body, lecture_id: lectureId ?? null, topic_id: topicId ?? null, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data as Note
}

export async function listNotes(): Promise<Note[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Note[]
}

export async function deleteNote(id: string): Promise<void> {
  await supabase.from('notes').delete().eq('id', id)
}

export async function updateNote(id: string, body: string): Promise<void> {
  await supabase.from('notes').update({ body }).eq('id', id)
}
