import { supabase } from '../supabase'
import type { ScoreRow } from '../../services/core'
import { effectiveUID } from '../effective-uid'

const uid = effectiveUID

export async function listScores(): Promise<ScoreRow[]> {
  const { data, error } = await supabase
    .from('scores')
    .select('taken_on, category, subject, score, max_score, label, attempted, correct, wrong')
    .order('taken_on', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => ({
    date:      r.taken_on,
    category:  r.category ?? 'mock',
    subject:   r.subject,
    score:     Number(r.score),
    max_score: Number(r.max_score),
    label:     r.label,
    attempted: r.attempted ?? null,
    correct:   r.correct   ?? null,
    wrong:     r.wrong     ?? null,
  }))
}

export async function insertScore(row: ScoreRow): Promise<void> {
  const userId = await uid()
  const { error } = await supabase.from('scores').insert({
    user_id:   userId,
    taken_on:  row.date,
    category:  row.category,
    subject:   row.subject ?? null,
    score:     row.score,
    max_score: row.max_score,
    label:     row.label ?? null,
    attempted: row.attempted ?? null,
    correct:   row.correct   ?? null,
    wrong:     row.wrong     ?? null,
  })
  if (error) throw error
}
