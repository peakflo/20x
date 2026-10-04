self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { /* ignore malformed payload */ }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/'
  event.waitUntil(self.registration.showNotification(data.title || '20x', {
    body: data.body || 'Open 20x to view the update.',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: data.tag || undefined,
    data: { url }
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin)
  if (url.origin !== self.location.origin) return
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const existing = windows.find(client => new URL(client.url).origin === url.origin)
    if (existing) {
      await existing.navigate(url.href)
      return existing.focus()
    }
    return clients.openWindow(url.href)
  }))
})
