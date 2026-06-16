/**
 * effective-uid.ts
 *
 * Single-user app with two authorized emails:
 *   primary  = omshisodiya2603@gmail.com  (all data stored under their UID)
 *   secondary = princee.aditisingh@gmail.com  (same data, different JWT)
 *
 * When the secondary email is logged in, RLS on all tables allows them to read/write
 * the primary owner's rows (via the `secondary_access` policy in schema.sql).
 * But inserts must explicitly carry the *owner's* user_id so RLS `with check` passes.
 *
 * effectiveUID() returns the correct user_id to use for all data operations:
 *   - Primary email  → their own session UID (fast, no extra call)
 *   - Secondary email → owner's UID fetched via `owner_uid()` RPC, then cached
 */

import { supabase } from './supabase'

const SECONDARY_EMAIL = 'princee.aditisingh@gmail.com'  // keep in sync with auth-master.ts

let _cachedOwnerUID: string | null = null

export async function effectiveUID(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const email = (session.user.email ?? '').toLowerCase()
  if (email !== SECONDARY_EMAIL.toLowerCase()) {
    // Primary owner or unknown — always use their own UID
    return session.user.id
  }

  // Secondary email: we need the primary owner's UID
  if (!_cachedOwnerUID) {
    const { data } = await supabase.rpc('owner_uid')
    _cachedOwnerUID = (data as string | null)
  }

  // Fall back to secondary's own UID if owner hasn't signed up yet
  return _cachedOwnerUID ?? session.user.id
}

/** Pre-warm the cache (called once after secondary-email login). */
export async function prewarmEffectiveUID(): Promise<string | null> {
  try {
    const { data } = await supabase.rpc('owner_uid')
    _cachedOwnerUID = data as string | null
  } catch {
    // DB function not yet created or offline — cache stays null
  }
  return _cachedOwnerUID
}
