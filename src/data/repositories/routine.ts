import { supabase } from '../supabase'
import { effectiveUID } from '../effective-uid'

export interface RoutineDay {
  day: string           // YYYY-MM-DD in IST
  day_type: string      // College | Holiday | Leave | Test Day
  study_hours: number | null
  mains_written: number | null
  attempted: number | null
  correct: number | null
  wrong: number | null
  notes: string | null
  updated_at?: string
}

const uid = effectiveUID

export async function listRoutineDays(): Promise<RoutineDay[]> {
  const { data, error } = await supabase
    .from('routine_days')
    .select('day, day_type, study_hours, mains_written, attempted, correct, wrong, notes, updated_at')
    .order('day', { ascending: true })
  if (error) throw error
  return (data as RoutineDay[]) ?? []
}

export async function upsertRoutineDay(row: RoutineDay): Promise<void> {
  const userId = await uid()
  const { error } = await supabase
    .from('routine_days')
    .upsert({ ...row, user_id: userId }, { onConflict: 'user_id,day' })
  if (error) throw error
}
