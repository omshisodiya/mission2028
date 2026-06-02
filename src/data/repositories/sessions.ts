import { supabase } from '../supabase'
import type { SessionDay } from '../../services/core'

async function uid(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  return session.user.id
}

/** Returns total session minutes aggregated per day. */
export async function listSessionDays(): Promise<SessionDay[]> {
  const { data, error } = await supabase
    .from('study_sessions')
    .select('day, minutes')
    .order('day', { ascending: true })
  if (error) throw error

  // Aggregate client-side (< 1000 rows for 2 years of data)
  const map: Record<string, number> = {}
  for (const r of data ?? []) {
    map[r.day] = (map[r.day] ?? 0) + Number(r.minutes)
  }
  return Object.entries(map).map(([day, minutes]) => ({ day, minutes }))
}

export async function insertSession(minutes: number, day: string): Promise<void> {
  const userId = await uid()
  const { error } = await supabase.from('study_sessions').insert({
    user_id:    userId,
    minutes:    Math.round(minutes),
    kind:       'focus',
    day,
    started_at: new Date().toISOString(),
  })
  if (error) console.error('[sessions] insertSession failed:', error)
  // Non-fatal: hours auto-fill is best-effort
}
