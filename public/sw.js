// Mission 2028 Service Worker — offline-first cache for the shell
const CACHE = 'mission2028-v1'

// App shell files to pre-cache
const PRECACHE = [
  '/',
  '/manifest.json',
  '/favicon.svg',
]

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  // Only handle GET requests for same-origin or CDN assets
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)

  // Network-first for API / Supabase calls (always fresh data)
  if (url.hostname.includes('supabase.co') || url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    )
    return
  }

  // Cache-first for assets (hashed filenames are immutable)
  if (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.svg')) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached ?? fetch(e.request).then(res => {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(e.request, clone))
          return res
        })
      )
    )
    return
  }

  // Stale-while-revalidate for everything else (HTML, constitution.json, etc.)
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request)
      const fetchPromise = fetch(e.request).then(res => {
        cache.put(e.request, res.clone())
        return res
      }).catch(() => null)
      return cached ?? await fetchPromise ?? new Response('Offline', { status: 503 })
    })
  )
})
