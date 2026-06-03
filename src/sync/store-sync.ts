import { supabase } from '../data/supabase'

const STORE_KEY  = 'mission2028'
const QUEUE_KEY  = 'mission2028_sync_queue'
const RETRY_KEY  = 'mission2028_sync_retries'
const MAX_RETRIES = 5      // discard write after 5 consecutive flush failures
const MAX_QUEUE   = 200    // max keys in queue — prevents localStorage overflow

let _uid     = ''
let _queue: Record<string, unknown> = JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}')
let _retries = parseInt(localStorage.getItem(RETRY_KEY) || '0')
let _timer:  ReturnType<typeof setTimeout> | null = null

/** Pull app_state from Supabase and hydrate localStorage before engine boots. */
export async function pull(uid: string): Promise<void> {
  _uid = uid
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('key, value')
      .eq('user_id', uid)
    if (error) throw error

    if (data && data.length > 0) {
      const cached = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
      const remote = Object.fromEntries(data.map(r => [r.key, r.value]))
      // Remote wins per key — last-write-wins for single user
      const merged = { ...cached, ...remote }
      localStorage.setItem(STORE_KEY, JSON.stringify(merged))
    }

    // Flush anything queued while offline
    if (Object.keys(_queue).length) void _flush()
  } catch {
    // Offline — proceed from localStorage cache, queue stays intact
  }
}

/** Called by the patched store.set — enqueues a debounced Supabase upsert. */
export function queuePush(key: string, value: unknown): void {
  // Guard against queue bloat (offline for a very long time)
  if (Object.keys(_queue).length >= MAX_QUEUE) {
    const oldest = Object.keys(_queue)[0]
    if (oldest) delete _queue[oldest]
  }
  _queue[key] = value
  localStorage.setItem(QUEUE_KEY, JSON.stringify(_queue))
  if (_timer) clearTimeout(_timer)
  _timer = setTimeout(() => void _flush(), 1500)
}

async function _flush(): Promise<void> {
  if (!_uid || !navigator.onLine || !Object.keys(_queue).length) return

  const snap = { ..._queue }
  _queue = {}
  localStorage.setItem(QUEUE_KEY, '{}')

  const rows = Object.entries(snap).map(([key, value]) => ({
    user_id: _uid,
    key,
    value,
  }))

  const { error } = await supabase
    .from('app_state')
    .upsert(rows, { onConflict: 'user_id,key' })

  if (error) {
    _retries++
    localStorage.setItem(RETRY_KEY, String(_retries))
    if (_retries >= MAX_RETRIES) {
      // Persistent failure — discard queue to prevent infinite loop; local data intact
      console.warn('[store-sync] Max retries reached; discarding sync queue.')
      _retries = 0
      localStorage.setItem(RETRY_KEY, '0')
      localStorage.setItem(QUEUE_KEY, '{}')
    } else {
      // Re-queue on transient failure
      _queue = { ...snap, ..._queue }
      localStorage.setItem(QUEUE_KEY, JSON.stringify(_queue))
    }
  } else {
    _retries = 0
    localStorage.setItem(RETRY_KEY, '0')
  }
}

// Flush the queue when the browser comes back online
window.addEventListener('online', () => void _flush())
