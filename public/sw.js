// Mission 2028 Service Worker v3
// Strategy: cache-first for assets, network-first for HTML/API, push notifications
const CACHE = 'mission2028-v3'
const ASSET_EXTS = ['.js', '.css', '.svg', '.webp', '.png', '.woff2', '.json']

// ── Install — skip waiting for instant activation ───────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting())
})

// ── Activate — clear ALL old caches ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// ── Fetch — tiered caching strategy ─────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)

  // Never cache: HTML, Supabase, Groq API, auth
  if (
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('groq.com') ||
    url.pathname.includes('/auth/')
  ) {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match('/index.html') ?? new Response('Offline', { status: 503 })
      )
    )
    return
  }

  // Cache-first for hashed assets in /assets/ (Vite output)
  const ext = url.pathname.slice(url.pathname.lastIndexOf('.'))
  if (ASSET_EXTS.includes(ext) && url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached =>
          cached ?? fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone())
            return res
          })
        )
      )
    )
    return
  }

  // Network-first for everything else (fonts, icons, constitution.json, etc.)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(e.request, clone))
        }
        return res
      })
      .catch(() =>
        caches.match(e.request).then(cached =>
          cached ?? new Response('Offline', { status: 503 })
        )
      )
  )
})

// ── Push Notifications ───────────────────────────────────────────────────────
// Handles push events from the Supabase Edge Function (future) and local triggers
self.addEventListener('push', e => {
  let data = { title: '⬡ JARVIS', body: 'Check your Mission 2028 dashboard.' }
  try { data = { ...data, ...e.data.json() } } catch { /* use defaults */ }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/icons/icon-192.png',
      badge:   '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      data:    { url: self.location.origin },
      actions: [
        { action: 'open',    title: '📖 Open App' },
        { action: 'dismiss', title: '✕ Dismiss'   },
      ],
    })
  )
})

// ── Notification Click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close()
  if (e.action === 'dismiss') return
  const target = e.notification.data?.url ?? self.location.origin
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client)
          return client.focus()
      }
      return clients.openWindow(target)
    })
  )
})

// ── Background Sync ───────────────────────────────────────────────────────────
// When back online, notify the app to flush its store queue
self.addEventListener('sync', e => {
  if (e.tag === 'sync-store') {
    e.waitUntil(
      clients.matchAll({ type: 'window' }).then(list =>
        list.forEach(c => c.postMessage({ type: 'SW_SYNC_READY' }))
      )
    )
  }
})

// ── Message Handling ──────────────────────────────────────────────────────────
// App sends messages to SW for notifications and sync registration
self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE_NOTIFICATION') {
    const { title, body, delay, tag } = e.data
    setTimeout(() => {
      self.registration.showNotification(title, {
        body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag,
      })
    }, delay ?? 0)
  }
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
