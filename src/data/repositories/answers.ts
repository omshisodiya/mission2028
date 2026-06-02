import { supabase } from '../supabase'

export interface AnswerEntry {
  id?:         string
  question:    string
  word_count?: number | null
  time_min?:   number | null
  score?:      number | null
  written_on:  string   // YYYY-MM-DD
}

async function uid(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  return session.user.id
}

export async function listAnswerEntries(limit = 50): Promise<AnswerEntry[]> {
  const { data, error } = await supabase
    .from('answer_practice')
    .select('id, question, word_count, time_min, score, written_on')
    .order('written_on', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map(r => ({
    id: r.id, question: r.question,
    word_count: r.word_count, time_min: r.time_min,
    score: r.score, written_on: r.written_on,
  }))
}

/** Returns weekly answer counts for the last N weeks. */
export async function weeklyAnswerCounts(weeks = 6): Promise<number[]> {
  const all = await listAnswerEntries(500)
  const counts = Array(weeks).fill(0)
  const now = Date.now()
  all.forEach(a => {
    const [y, m, d] = a.written_on.split('-').map(Number)
    const ms = Date.UTC(y, m - 1, d)
    const weeksAgo = Math.floor((now - ms) / (7 * 86_400_000))
    if (weeksAgo >= 0 && weeksAgo < weeks) counts[weeks - 1 - weeksAgo]++
  })
  return counts
}

export async function insertAnswerEntry(e: Omit<AnswerEntry, 'id'>): Promise<void> {
  const userId = await uid()
  const { error } = await supabase.from('answer_practice').insert({
    user_id:    userId,
    question:   e.question,
    word_count: e.word_count ?? null,
    time_min:   e.time_min  ?? null,
    score:      e.score     ?? null,
    written_on: e.written_on,
  })
  if (error) throw error
}
