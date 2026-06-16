import { supabase } from '../supabase'
import type { PlanDay, PlanBlock } from '../../services/planner'
import { effectiveUID } from '../effective-uid'

const uid = effectiveUID

/** Upsert plan_days + plan_blocks for a computed plan. Replaces future days only. */
export async function savePlan(days: PlanDay[], today: string): Promise<void> {
  const userId = await uid()

  // Delete existing future plan_days (past logged days are kept)
  const { error: delErr } = await supabase
    .from('plan_days')
    .delete()
    .eq('user_id', userId)
    .gte('day', today)
  if (delErr) throw delErr

  if (days.length === 0) return

  // Insert plan_days
  const dayRows = days.map(d => ({
    user_id:      userId,
    day:          d.date,
    capacity_min: d.capacityMins,
    generated_at: new Date().toISOString(),
  }))
  const { data: insertedDays, error: dayErr } = await supabase
    .from('plan_days')
    .insert(dayRows)
    .select('id, day')
  if (dayErr) throw dayErr

  // Build plan_blocks from inserted day IDs
  const dayIdMap = new Map((insertedDays ?? []).map(r => [r.day, r.id]))
  const blockRows: object[] = []

  for (const d of days) {
    const planDayId = dayIdMap.get(d.date)
    if (!planDayId) continue
    d.blocks.forEach((b, i) => {
      blockRows.push({
        user_id:     userId,
        plan_day_id: planDayId,
        lecture_id:  b.lectureId,
        label:       b.label,
        subject:     b.subject,
        minutes:     b.minutes,
        kind:        b.kind,
        sort:        i,
        done:        false,
      })
    })
  }

  if (blockRows.length > 0) {
    const CHUNK = 200
    for (let i = 0; i < blockRows.length; i += CHUNK) {
      const { error } = await supabase.from('plan_blocks').insert(blockRows.slice(i, i + CHUNK))
      if (error) throw error
    }
  }
}

/** Load today's plan blocks from Supabase (for display without re-running). */
export async function loadTodayPlan(today: string): Promise<PlanBlock[]> {
  const userId = await uid()
  const { data: dayRow } = await supabase
    .from('plan_days')
    .select('id')
    .eq('user_id', userId)
    .eq('day', today)
    .maybeSingle()
  if (!dayRow) return []

  const { data: blocks } = await supabase
    .from('plan_blocks')
    .select('lecture_id, label, subject, minutes, kind')
    .eq('plan_day_id', dayRow.id)
    .order('sort')
  return (blocks ?? []).map(b => ({
    lectureId: b.lecture_id ?? '',
    label: b.label, subject: b.subject ?? '',
    minutes: b.minutes, kind: 'learn' as const,
  }))
}
