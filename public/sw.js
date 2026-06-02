// Mission 2028 Service Worker v2
// IMPORTANT: HTML is never cached — always fetched fresh so new deployments
// are picked up immediately without requiring the user to clear cache.
const CACHE = 'mission2028-v2'

const ASSET_EXTS = ['.js', '.css', '.svg', '.webp', '.png', '.woff2', '.json']

self.addEventListener('install', e => {
  // Skip waiting immediately so this version takes over right away
  e.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', e => {
  // Delete ALL old caches so stale code from previous broken deployments is gone
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)

  // Never cache: HTML pages, Supabase API calls, auth flows
  if (
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html') ||
    url.hostname.includes('supabase.co')
  ) {
    e.respondWith(fetch(e.request))
    return
  }

  // Cache-first for hashed static assets (JS, CSS, images, fonts)
  const ext = url.pathname.slice(url.pathname.lastIndexOf('.'))
  if (ASSET_EXTS.includes(ext) && url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached =>
          cached ?? fetch(e.request).then(res => {
            cache.put(e.request, res.clone())
            return res
          })
        )
      )
    )
    return
  }

  // Everything else: network with cache fallback (constitution.json, icons, etc.)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put(e.request, clone))
        return res
      })
      .catch(() => caches.match(e.request)
        .then(cached => cached ?? new Response('Offline', { status: 503 }))
      )
  )
})
