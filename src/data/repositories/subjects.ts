import { supabase } from '../supabase'
import { effectiveUID } from '../effective-uid'

export interface Subject {
  id: string
  name: string
  stage: string
  weightage: number
}

const uid = effectiveUID

/** Upsert subjects by name; returns a map of name (lowercased) → id. */
export async function upsertByNames(names: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names.map(n => n.trim()).filter(Boolean))]
  if (!unique.length) return new Map()

  const userId = await uid()

  // Fetch existing subjects for this user
  const { data: existing } = await supabase
    .from('subjects')
    .select('id, name')
    .eq('user_id', userId)
    .in('name', unique)

  const map = new Map<string, string>()
  const existingNames = new Set<string>()

  for (const s of existing ?? []) {
    map.set(s.name.toLowerCase(), s.id)
    existingNames.add(s.name)
  }

  // Create missing subjects
  const toCreate = unique.filter(n => !existingNames.has(n))
  if (toCreate.length) {
    const { data: created } = await supabase
      .from('subjects')
      .insert(toCreate.map((name, i) => ({ user_id: userId, name, stage: 'gs', sort: i })))
      .select('id, name')
    for (const s of created ?? []) {
      map.set(s.name.toLowerCase(), s.id)
    }
  }

  return map
}
