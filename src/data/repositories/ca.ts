import { supabase } from '../supabase'
import { effectiveUID } from '../effective-uid'

export interface CAEntry {
  id?:       string
  headline:  string
  note?:     string | null
  source?:   string | null
  ca_date:   string   // YYYY-MM-DD
  revise:    boolean
  gs_paper?: string | null  // GS1 | GS2 | GS3 | GS4 | CSAT | General
}

const uid = effectiveUID

export async function listCurrentAffairs(limit = 20): Promise<CAEntry[]> {
  const { data, error } = await supabase
    .from('current_affairs')
    .select('id, headline, note, source, ca_date, revise')
    .order('ca_date', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map(r => ({
    id: r.id, headline: r.headline, note: r.note,
    source: r.source, ca_date: r.ca_date, revise: r.revise ?? false,
  }))
}

export async function insertCAEntry(e: Omit<CAEntry, 'id'>): Promise<void> {
  const userId = await uid()
  const { error } = await supabase.from('current_affairs').insert({
    user_id:  userId,
    headline: e.headline,
    note:     e.note     ?? null,
    source:   e.source   ?? null,
    ca_date:  e.ca_date,
    revise:   e.revise,
  })
  if (error) throw error
}
